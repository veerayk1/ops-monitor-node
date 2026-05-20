import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';
import type { Job, Run, Rule, RuleResult, Steps, Extracted, RunStatus, AiProviderOverride, SourceType } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  username_enc    TEXT NOT NULL,
  password_enc    TEXT NOT NULL,
  steps_json      TEXT NOT NULL,
  rules_json      TEXT NOT NULL,
  schedule_cron   TEXT NOT NULL DEFAULT '0 9-18 * * 1-5',
  enabled         INTEGER NOT NULL DEFAULT 1,
  ai_provider     TEXT NOT NULL DEFAULT 'system',
  source_type     TEXT NOT NULL DEFAULT 'browser',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL,
  screenshot_path TEXT,
  recheck_screenshot_path TEXT,
  extracted_json  TEXT,
  rule_results_json TEXT,
  summary         TEXT,
  error_message   TEXT,
  ai_provider_used TEXT,
  ai_model_used   TEXT,
  ai_cost_cents   REAL,
  ai_fallback_notes TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id, started_at DESC);
`;

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

// Lightweight migration: add columns if upgrading from a pre-multi-provider DB.
function safeAddColumn(table: string, col: string, def: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  } catch {
    /* column already exists */
  }
}
safeAddColumn('jobs', 'ai_provider',     "TEXT NOT NULL DEFAULT 'system'");
safeAddColumn('jobs', 'source_type',     "TEXT NOT NULL DEFAULT 'browser'");
safeAddColumn('runs', 'ai_provider_used', 'TEXT');
safeAddColumn('runs', 'ai_model_used',    'TEXT');
safeAddColumn('runs', 'ai_cost_cents',    'REAL');
safeAddColumn('runs', 'ai_fallback_notes', 'TEXT');

interface JobRow {
  id: number;
  name: string;
  url: string;
  username_enc: string;
  password_enc: string;
  steps_json: string;
  rules_json: string;
  schedule_cron: string;
  enabled: number;
  ai_provider: string;
  source_type: string;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  screenshot_path: string | null;
  recheck_screenshot_path: string | null;
  extracted_json: string | null;
  rule_results_json: string | null;
  summary: string | null;
  error_message: string | null;
  ai_provider_used: string | null;
  ai_model_used: string | null;
  ai_cost_cents: number | null;
  ai_fallback_notes: string | null;
}

function safeJsonParse<T>(json: string, fallback: T, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (e) {
    console.error(`Failed to parse ${label}:`, e);
    return fallback;
  }
}

const rowToJob = (r: JobRow): Job => ({
  id: r.id,
  name: r.name,
  url: r.url,
  username_enc: r.username_enc,
  password_enc: r.password_enc,
  steps: safeJsonParse<Steps>(r.steps_json, { filter_text: null, ensure_columns: [], page_path: '/#/queues' }, `steps_json for job ${r.id}`),
  rules: safeJsonParse<Rule[]>(r.rules_json, [], `rules_json for job ${r.id}`),
  schedule_cron: r.schedule_cron,
  enabled: !!r.enabled,
  ai_provider: (r.ai_provider as AiProviderOverride) ?? 'system',
  source_type: ((r.source_type as SourceType) ?? 'browser'),
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const rowToRun = (r: RunRow): Run => ({
  id: r.id,
  job_id: r.job_id,
  started_at: r.started_at,
  finished_at: r.finished_at,
  status: r.status as RunStatus,
  screenshot_path: r.screenshot_path,
  recheck_screenshot_path: r.recheck_screenshot_path,
  extracted: r.extracted_json ? safeJsonParse<Extracted>(r.extracted_json, null as unknown as Extracted, `extracted_json for run ${r.id}`) : null,
  rule_results: r.rule_results_json ? safeJsonParse<RuleResult[]>(r.rule_results_json, [], `rule_results_json for run ${r.id}`) : null,
  summary: r.summary,
  error_message: r.error_message,
  ai_provider_used: r.ai_provider_used,
  ai_model_used: r.ai_model_used,
  ai_cost_cents: r.ai_cost_cents,
  ai_fallback_notes: r.ai_fallback_notes,
});

// --- Jobs --------------------------------------------------------------

export function insertJob(args: {
  name: string;
  url: string;
  username_enc: string;
  password_enc: string;
  steps: Steps;
  rules: Rule[];
  schedule_cron: string;
  enabled: boolean;
  ai_provider: AiProviderOverride;
  source_type: SourceType;
}): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO jobs (name, url, username_enc, password_enc, steps_json, rules_json, schedule_cron, enabled, ai_provider, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    args.name, args.url, args.username_enc, args.password_enc,
    JSON.stringify(args.steps), JSON.stringify(args.rules),
    args.schedule_cron, args.enabled ? 1 : 0, args.ai_provider, args.source_type, now, now,
  );
  return info.lastInsertRowid as number;
}

export function updateJob(jobId: number, args: {
  name: string;
  url: string;
  username_enc: string;
  password_enc: string;
  steps: Steps;
  rules: Rule[];
  schedule_cron: string;
  enabled: boolean;
  ai_provider: AiProviderOverride;
  source_type: SourceType;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE jobs SET name=?, url=?, username_enc=?, password_enc=?, steps_json=?, rules_json=?,
     schedule_cron=?, enabled=?, ai_provider=?, source_type=?, updated_at=? WHERE id=?`,
  ).run(
    args.name, args.url, args.username_enc, args.password_enc,
    JSON.stringify(args.steps), JSON.stringify(args.rules),
    args.schedule_cron, args.enabled ? 1 : 0, args.ai_provider, args.source_type, now, jobId,
  );
}

export function getJob(jobId: number): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobs(): Job[] {
  const rows = db.prepare('SELECT * FROM jobs ORDER BY id ASC').all() as JobRow[];
  return rows.map(rowToJob);
}

export function deleteJob(jobId: number): void {
  db.prepare('DELETE FROM jobs WHERE id=?').run(jobId);
}

// --- Runs --------------------------------------------------------------

export function insertRun(jobId: number, status: RunStatus = 'running'): number {
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO runs (job_id, started_at, status) VALUES (?, ?, ?)').run(jobId, now, status);
  return info.lastInsertRowid as number;
}

export function updateRun(runId: number, fields: {
  status?: RunStatus;
  finished_at?: string;
  screenshot_path?: string;
  recheck_screenshot_path?: string;
  extracted?: Extracted;
  rule_results?: RuleResult[];
  summary?: string;
  error_message?: string;
  ai_provider_used?: string;
  ai_model_used?: string;
  ai_cost_cents?: number;
  ai_fallback_notes?: string;
}): void {
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (fields.status !== undefined) { sets.push('status=?'); vals.push(fields.status); }
  if (fields.finished_at !== undefined) { sets.push('finished_at=?'); vals.push(fields.finished_at); }
  if (fields.screenshot_path !== undefined) { sets.push('screenshot_path=?'); vals.push(fields.screenshot_path); }
  if (fields.recheck_screenshot_path !== undefined) { sets.push('recheck_screenshot_path=?'); vals.push(fields.recheck_screenshot_path); }
  if (fields.extracted !== undefined) { sets.push('extracted_json=?'); vals.push(JSON.stringify(fields.extracted)); }
  if (fields.rule_results !== undefined) { sets.push('rule_results_json=?'); vals.push(JSON.stringify(fields.rule_results)); }
  if (fields.summary !== undefined) { sets.push('summary=?'); vals.push(fields.summary); }
  if (fields.error_message !== undefined) { sets.push('error_message=?'); vals.push(fields.error_message); }
  if (fields.ai_provider_used !== undefined) { sets.push('ai_provider_used=?'); vals.push(fields.ai_provider_used); }
  if (fields.ai_model_used !== undefined) { sets.push('ai_model_used=?'); vals.push(fields.ai_model_used); }
  if (fields.ai_cost_cents !== undefined) { sets.push('ai_cost_cents=?'); vals.push(fields.ai_cost_cents); }
  if (fields.ai_fallback_notes !== undefined) { sets.push('ai_fallback_notes=?'); vals.push(fields.ai_fallback_notes); }

  if (sets.length === 0) return;
  vals.push(runId);
  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}

export function listRunsForJob(jobId: number, limit = 100): Run[] {
  const rows = db.prepare(
    'SELECT * FROM runs WHERE job_id=? ORDER BY started_at DESC LIMIT ?',
  ).all(jobId, limit) as RunRow[];
  return rows.map(rowToRun);
}

export function getRun(runId: number): Run | null {
  const row = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}
