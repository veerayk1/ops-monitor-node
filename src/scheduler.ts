import cron, { type ScheduledTask } from 'node-cron';
import { listJobs } from './database.js';
import { runJob } from './worker/runner.js';
import { settings } from './config.js';
import type { Job } from './types.js';

const tasks = new Map<number, ScheduledTask>();
const nextRunTimes = new Map<number, Date | null>();
const runningJobs = new Set<number>(); // Prevent concurrent runs of the same job

function computeNextRun(cronExpr: string): Date | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  const matches = (val: number, expr: string): boolean => {
    if (expr === '*') return true;
    for (const piece of expr.split(',')) {
      if (piece.includes('-')) {
        const [a, b] = piece.split('-').map(Number);
        if (val >= a && val <= b) return true;
      } else if (piece.includes('/')) {
        const [base, step] = piece.split('/');
        const baseNum = base === '*' ? 0 : Number(base);
        if ((val - baseNum) % Number(step) === 0 && val >= baseNum) return true;
      } else if (Number(piece) === val) return true;
    }
    return false;
  };

  const now = new Date();
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 8; i += 1) {
    if (
      matches(candidate.getMinutes(), m) &&
      matches(candidate.getHours(), h) &&
      matches(candidate.getDate(), dom) &&
      matches(candidate.getMonth() + 1, mon) &&
      matches(candidate.getDay(), dow)
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/** Validate a cron expression before scheduling. */
export function isValidCron(expr: string): boolean {
  if (!cron.validate(expr)) return false;
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

export function scheduleJob(job: Job): void {
  // Stop existing task first (atomically replace)
  const existing = tasks.get(job.id);
  if (existing) { existing.stop(); tasks.delete(job.id); }
  nextRunTimes.delete(job.id);

  if (!job.enabled) return;
  if (!isValidCron(job.schedule_cron)) {
    console.warn(`Job ${job.id} (${job.name}) has invalid cron: ${job.schedule_cron} — skipping`);
    return;
  }

  const cronOpts: Parameters<typeof cron.schedule>[2] = {};
  if (settings.schedulerTz) cronOpts.timezone = settings.schedulerTz;

  const task = cron.schedule(
    job.schedule_cron,
    () => {
      // Prevent overlapping runs of the same job
      if (runningJobs.has(job.id)) {
        console.warn(`Job ${job.id} is already running, skipping scheduled execution`);
        return;
      }
      runningJobs.add(job.id);
      runJob(job.id)
        .catch((e) => {
          console.error(`Scheduled run of job ${job.id} failed:`, e);
        })
        .finally(() => {
          runningJobs.delete(job.id);
          nextRunTimes.set(job.id, computeNextRun(job.schedule_cron));
        });
    },
    cronOpts,
  );
  tasks.set(job.id, task);
  nextRunTimes.set(job.id, computeNextRun(job.schedule_cron));
  console.log(`Scheduled job ${job.id} (${job.name}) with cron ${job.schedule_cron}${settings.schedulerTz ? ` [${settings.schedulerTz}]` : ''}`);
}

export function unscheduleJob(jobId: number): void {
  const t = tasks.get(jobId);
  if (t) { t.stop(); tasks.delete(jobId); }
  nextRunTimes.delete(jobId);
}

export function reloadAll(): void {
  for (const [id, t] of tasks) { t.stop(); tasks.delete(id); }
  nextRunTimes.clear();
  for (const job of listJobs()) {
    try { scheduleJob(job); } catch (e) { console.error(`Failed to schedule job ${job.id}:`, e); }
  }
}

export function nextRunFor(jobId: number): string | null {
  const d = nextRunTimes.get(jobId);
  return d ? d.toISOString() : null;
}

export function triggerNow(jobId: number): Promise<number> {
  return runJob(jobId);
}
