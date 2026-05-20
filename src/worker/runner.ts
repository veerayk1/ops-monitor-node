import { join, relative } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PROJECT_ROOT, SCREENSHOTS_DIR } from '../config.js';
import { decrypt } from '../crypto.js';
import { getJob, insertRun, updateRun } from '../database.js';
import { notify } from '../notifications.js';
import { runWorkflow } from './browser.js';
import { evaluateScreenshot, type EvaluationOutcome } from './evaluator.js';
import { fetchRabbitMqQueues } from './rabbitmq.js';
import { evaluateRules, overallStatus, rulesNeedingRecheck } from './rules.js';
import type { Extracted, Job, RuleResult } from '../types.js';

function tsFilename(prefix: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `${prefix}_${ts}.png`;
}

function jobScreenshotDir(jobId: number): string {
  const d = join(SCREENSHOTS_DIR, `job_${jobId}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function relativeFromPublic(absPath: string): string {
  const publicDir = join(PROJECT_ROOT, 'public');
  return relative(publicDir, absPath).replace(/\\/g, '/');
}

function buildSummary(status: 'ok' | 'alert', results: RuleResult[], extracted: Extracted): string {
  const qcount = extracted.row_count ?? extracted.queues?.length ?? 0;
  if (status === 'ok') return `All ${results.length} rules passed across ${qcount} queue(s).`;
  const failing = results.filter((r) => !r.passed);
  return `${failing.length} of ${results.length} rule(s) failed across ${qcount} queue(s): ` +
    failing.map((r) => r.message).join('; ');
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

interface PassResult {
  extracted: Extracted;
  /** Absolute path. Only set when source_type='browser'. */
  screenshotPath?: string;
  /** Only set when source_type='browser'. */
  outcome?: EvaluationOutcome;
}

async function runOnePass(job: Job, username: string, password: string, screenshotDir: string, prefix: string): Promise<PassResult> {
  const { steps } = job;

  if (job.source_type === 'rabbitmq_api') {
    const extracted = await fetchRabbitMqQueues({
      url: job.url,
      username,
      password,
      vhost: steps.vhost,
      filterText: steps.filter_text ?? null,
    });
    return { extracted };
  }

  const screenshotPath = join(screenshotDir, tsFilename(prefix));
  await runWorkflow({
    url: job.url,
    username,
    password,
    filterText: steps.filter_text ?? null,
    ensureCols: steps.ensure_columns ?? [],
    pagePath: steps.page_path ?? '/#/queues',
    screenshotPath,
  });
  const outcome = await evaluateScreenshot(screenshotPath, job.ai_provider);
  return { extracted: outcome.extracted, screenshotPath, outcome };
}

export async function runJob(jobId: number): Promise<number> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const runId = insertRun(jobId, 'running');
  console.log(`Run ${runId} started for job ${jobId} (${job.name}) source=${job.source_type}`);

  let totalCostCents = 0;
  let lastOutcome: EvaluationOutcome | null = null;

  try {
    const username = decrypt(job.username_enc);
    const password = decrypt(job.password_enc);
    const { rules } = job;
    const dir = jobScreenshotDir(jobId);

    // ── First pass ────────────────────────────────────────
    let pass = await runOnePass(job, username, password, dir, 'run');
    if (pass.outcome) {
      lastOutcome = pass.outcome;
      totalCostCents += pass.outcome.estimatedCostCents;
    }

    if (pass.extracted.page_loaded_correctly === false) {
      updateRun(runId, {
        status: 'system_error',
        finished_at: new Date().toISOString(),
        screenshot_path: pass.screenshotPath ? relativeFromPublic(pass.screenshotPath) : undefined,
        extracted: pass.extracted,
        summary: 'Source did not return the expected queues data.',
        error_message: 'page_loaded_correctly=false',
        ai_provider_used: pass.outcome?.providerUsed,
        ai_model_used: pass.outcome?.modelUsed,
        ai_cost_cents: totalCostCents > 0 ? totalCostCents : undefined,
        ai_fallback_notes: pass.outcome?.fallbackFromErrors.length
          ? JSON.stringify(pass.outcome.fallbackFromErrors) : undefined,
      });
      notify({
        jobName: job.name,
        summary: 'Source did not return the expected queues data.',
        severity: 'system_error',
        details: { runId },
      });
      return runId;
    }

    let ruleResults = evaluateRules(pass.extracted, rules);
    let firstStatus = overallStatus(ruleResults);

    // ── Wait-and-confirm pass ──────────────────────────────
    const recheckRules = rulesNeedingRecheck(rules, ruleResults);
    let recheckScreenshotPath: string | undefined;
    if (firstStatus === 'alert' && recheckRules.length > 0) {
      const waitMinutes = Math.max(...recheckRules.map((r) => r.wait_minutes ?? 5));
      updateRun(runId, {
        status: 'pending_recheck',
        screenshot_path: pass.screenshotPath ? relativeFromPublic(pass.screenshotPath) : undefined,
        extracted: pass.extracted,
        rule_results: ruleResults,
        summary: `Initial check failed; re-checking in ${waitMinutes} minute(s) before alerting.`,
        ai_provider_used: pass.outcome?.providerUsed,
        ai_model_used: pass.outcome?.modelUsed,
      });
      console.log(`Run ${runId} entering wait-and-confirm: ${waitMinutes} minutes`);
      await sleep(waitMinutes * 60_000);

      const recheck = await runOnePass(job, username, password, dir, 'recheck');
      if (recheck.outcome) {
        lastOutcome = recheck.outcome;
        totalCostCents += recheck.outcome.estimatedCostCents;
      }
      recheckScreenshotPath = recheck.screenshotPath;
      pass = recheck;
      ruleResults = evaluateRules(pass.extracted, rules);
    }

    const finalStatus = overallStatus(ruleResults);
    const summary = buildSummary(finalStatus, ruleResults, pass.extracted);

    updateRun(runId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      screenshot_path: pass.screenshotPath ? relativeFromPublic(pass.screenshotPath) : undefined,
      recheck_screenshot_path: recheckScreenshotPath ? relativeFromPublic(recheckScreenshotPath) : undefined,
      extracted: pass.extracted,
      rule_results: ruleResults,
      summary,
      ai_provider_used: pass.outcome?.providerUsed ?? (job.source_type === 'rabbitmq_api' ? 'rabbitmq_api' : undefined),
      ai_model_used: pass.outcome?.modelUsed,
      ai_cost_cents: totalCostCents > 0 ? totalCostCents : (job.source_type === 'rabbitmq_api' ? 0 : undefined),
      ai_fallback_notes: pass.outcome?.fallbackFromErrors.length
        ? JSON.stringify(pass.outcome.fallbackFromErrors) : undefined,
    });

    if (finalStatus === 'alert') {
      notify({ jobName: job.name, summary, severity: 'alert', details: { runId, ruleResults } });
    }

    return runId;
  } catch (e) {
    const err = e as Error;
    console.error(`Run ${runId} failed:`, err);
    updateRun(runId, {
      status: 'system_error',
      finished_at: new Date().toISOString(),
      error_message: `${err.name}: ${err.message}`,
      summary: 'Run failed before producing a verdict.',
      ai_provider_used: lastOutcome?.providerUsed,
      ai_model_used: lastOutcome?.modelUsed,
      ai_cost_cents: totalCostCents > 0 ? totalCostCents : undefined,
    });
    notify({
      jobName: job?.name ?? `job ${jobId}`,
      summary: `Run failed: ${err.name}: ${err.message}`,
      severity: 'system_error',
      details: { runId },
    });
    return runId;
  }
}
