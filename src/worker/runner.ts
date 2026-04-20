import { join, relative } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PROJECT_ROOT, SCREENSHOTS_DIR } from '../config.js';
import { decrypt } from '../crypto.js';
import { getJob, insertRun, updateRun } from '../database.js';
import { notify } from '../notifications.js';
import { runWorkflow } from './browser.js';
import { evaluateScreenshot, type EvaluationOutcome } from './evaluator.js';
import { evaluateRules, overallStatus, rulesNeedingRecheck } from './rules.js';
import type { Extracted, RuleResult } from '../types.js';

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

export async function runJob(jobId: number): Promise<number> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const runId = insertRun(jobId, 'running');
  console.log(`Run ${runId} started for job ${jobId} (${job.name})`);

  // Aggregate AI cost across both pass-1 and pass-2 calls (if a recheck happens)
  let totalCostCents = 0;
  let lastOutcome: EvaluationOutcome | null = null;

  try {
    const username = decrypt(job.username_enc);
    const password = decrypt(job.password_enc);
    const { steps, rules } = job;

    // ── First pass ────────────────────────────────────────
    const dir = jobScreenshotDir(jobId);
    const screenshotPath = join(dir, tsFilename('run'));

    await runWorkflow({
      url: job.url,
      username,
      password,
      filterText: steps.filter_text ?? null,
      ensureCols: steps.ensure_columns ?? [],
      pagePath: steps.page_path ?? '/#/queues',
      screenshotPath,
    });

    let outcome = await evaluateScreenshot(screenshotPath, job.ai_provider);
    lastOutcome = outcome;
    totalCostCents += outcome.estimatedCostCents;
    let extracted = outcome.extracted;

    if (extracted.page_loaded_correctly === false) {
      updateRun(runId, {
        status: 'system_error',
        finished_at: new Date().toISOString(),
        screenshot_path: relativeFromPublic(screenshotPath),
        extracted,
        summary: 'Page did not load the expected queues table.',
        error_message: 'Vision extractor reported page_loaded_correctly=false',
        ai_provider_used: outcome.providerUsed,
        ai_model_used: outcome.modelUsed,
        ai_cost_cents: totalCostCents,
        ai_fallback_notes: outcome.fallbackFromErrors.length
          ? JSON.stringify(outcome.fallbackFromErrors) : undefined,
      });
      notify({
        jobName: job.name,
        summary: 'Page did not load the expected queues table.',
        severity: 'system_error',
        details: { runId },
      });
      return runId;
    }

    let ruleResults = evaluateRules(extracted, rules);
    let firstStatus = overallStatus(ruleResults);

    // ── Wait-and-confirm pass ──────────────────────────────
    const recheckRules = rulesNeedingRecheck(rules, ruleResults);
    let recheckScreenshotPath: string | null = null;
    if (firstStatus === 'alert' && recheckRules.length > 0) {
      const waitMinutes = Math.max(...recheckRules.map((r) => r.wait_minutes ?? 5));
      updateRun(runId, {
        status: 'pending_recheck',
        screenshot_path: relativeFromPublic(screenshotPath),
        extracted,
        rule_results: ruleResults,
        summary: `Initial check failed; re-checking in ${waitMinutes} minute(s) before alerting.`,
        ai_provider_used: outcome.providerUsed,
        ai_model_used: outcome.modelUsed,
      });
      console.log(`Run ${runId} entering wait-and-confirm: ${waitMinutes} minutes`);
      await sleep(waitMinutes * 60_000);

      recheckScreenshotPath = join(dir, tsFilename('recheck'));
      await runWorkflow({
        url: job.url,
        username,
        password,
        filterText: steps.filter_text ?? null,
        ensureCols: steps.ensure_columns ?? [],
        pagePath: steps.page_path ?? '/#/queues',
        screenshotPath: recheckScreenshotPath,
      });
      outcome = await evaluateScreenshot(recheckScreenshotPath, job.ai_provider);
      lastOutcome = outcome;
      totalCostCents += outcome.estimatedCostCents;
      extracted = outcome.extracted;
      ruleResults = evaluateRules(extracted, rules);
    }

    const finalStatus = overallStatus(ruleResults);
    const summary = buildSummary(finalStatus, ruleResults, extracted);

    updateRun(runId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      screenshot_path: relativeFromPublic(screenshotPath),
      recheck_screenshot_path: recheckScreenshotPath ? relativeFromPublic(recheckScreenshotPath) : undefined,
      extracted,
      rule_results: ruleResults,
      summary,
      ai_provider_used: outcome.providerUsed,
      ai_model_used: outcome.modelUsed,
      ai_cost_cents: totalCostCents,
      ai_fallback_notes: outcome.fallbackFromErrors.length
        ? JSON.stringify(outcome.fallbackFromErrors) : undefined,
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
