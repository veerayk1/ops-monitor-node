import { Router } from 'express';
import { encrypt, decrypt } from '../crypto.js';
import {
  deleteJob, getJob, insertJob, listJobs, listRunsForJob, updateJob,
} from '../database.js';
import { JobInputSchema } from '../types.js';
import { isValidCron, scheduleJob, triggerNow, unscheduleJob } from '../scheduler.js';

export const jobsRouter = Router();

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function jobOut(jobId: number, includeCredentials = false) {
  const job = getJob(jobId);
  if (!job) return null;
  const runs = listRunsForJob(jobId, 1);
  const last = runs[0];
  return {
    id: job.id,
    name: job.name,
    url: job.url,
    username: decrypt(job.username_enc),
    // Never return the actual password — only indicate whether one is stored
    has_password: Boolean(job.password_enc),
    steps: job.steps,
    rules: job.rules,
    schedule_cron: job.schedule_cron,
    enabled: job.enabled,
    ai_provider: job.ai_provider,
    source_type: job.source_type,
    created_at: job.created_at,
    updated_at: job.updated_at,
    last_status: last?.status ?? null,
    last_run_at: last?.started_at ?? null,
    last_finished_at: last?.finished_at ?? null,
    last_summary: last?.summary ?? null,
    last_provider: last?.ai_provider_used ?? null,
    last_cost_cents: last?.ai_cost_cents ?? null,
    last_rule_results: last?.rule_results ?? null,
  };
}

jobsRouter.get('/', (_req, res) => {
  const jobs = listJobs().map((j) => jobOut(j.id)).filter(Boolean);
  res.json(jobs);
});

jobsRouter.get('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid job ID' });
  const out = jobOut(id);
  if (!out) return res.status(404).json({ error: 'Job not found' });
  res.json(out);
});

jobsRouter.post('/', (req, res) => {
  const parsed = JobInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const p = parsed.data;
  if (!isValidCron(p.schedule_cron)) {
    return res.status(400).json({ error: 'Invalid cron expression — needs 5 valid fields' });
  }
  const id = insertJob({
    name: p.name,
    url: p.url,
    username_enc: encrypt(p.username),
    password_enc: encrypt(p.password),
    steps: p.steps,
    rules: p.rules,
    schedule_cron: p.schedule_cron,
    enabled: p.enabled,
    ai_provider: p.ai_provider,
    source_type: p.source_type,
  });
  const job = getJob(id);
  if (job) scheduleJob(job);
  res.json(jobOut(id));
});

jobsRouter.put('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid job ID' });
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  const parsed = JobInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const p = parsed.data;
  if (!isValidCron(p.schedule_cron)) {
    return res.status(400).json({ error: 'Invalid cron expression — needs 5 valid fields' });
  }
  updateJob(id, {
    name: p.name,
    url: p.url,
    username_enc: encrypt(p.username),
    password_enc: encrypt(p.password),
    steps: p.steps,
    rules: p.rules,
    schedule_cron: p.schedule_cron,
    enabled: p.enabled,
    ai_provider: p.ai_provider,
    source_type: p.source_type,
  });
  const job = getJob(id);
  if (job) scheduleJob(job);
  res.json(jobOut(id));
});

jobsRouter.delete('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid job ID' });
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  unscheduleJob(id);
  deleteJob(id);
  res.json({ ok: true });
});

jobsRouter.post('/:id/run', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid job ID' });
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  triggerNow(id).catch((e) => console.error(`Manual run failed for job ${id}:`, e));
  res.json({ ok: true, message: `Run scheduled for job ${id}` });
});
