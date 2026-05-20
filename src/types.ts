import { z } from 'zod';

export const RuleSchema = z.object({
  id: z.string(),
  description: z.string(),
  target: z.enum(['primary', 'dlq', 'all']),
  metric: z.enum(['consumer_count', 'ready_messages', 'unacked_messages', 'row_count']),
  operator: z.enum(['>=', '>', '==', '<=', '<', '!=']),
  threshold: z.number(),
  wait_and_confirm: z.boolean().default(false),
  wait_minutes: z.number().int().min(1).max(60).default(5),
});
export type Rule = z.infer<typeof RuleSchema>;

export const StepsSchema = z.object({
  filter_text: z.string().nullable().optional(),
  ensure_columns: z.array(z.string()).default([]),
  expected_row_count: z.number().int().nullable().optional(),
  page_path: z.string().default('/#/queues'),
  /** RabbitMQ vhost (only used when source_type='rabbitmq_api'). Defaults to '/'. */
  vhost: z.string().optional(),
});
export type Steps = z.infer<typeof StepsSchema>;

export const SourceTypeSchema = z.enum(['browser', 'rabbitmq_api']).default('browser');
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** Per-workflow AI provider override.
 *  'system' = use the configured system primary + fallback chain.
 *  'anthropic' / 'openai' = use ONLY this provider, no fallback. */
export const AiProviderOverrideSchema = z.enum(['system', 'anthropic', 'openai']).default('system');
export type AiProviderOverride = z.infer<typeof AiProviderOverrideSchema>;

export const JobInputSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  username: z.string(),
  password: z.string(),
  steps: StepsSchema,
  rules: z.array(RuleSchema),
  schedule_cron: z.string().default('0 9-18 * * 1-5'),
  enabled: z.boolean().default(true),
  ai_provider: AiProviderOverrideSchema,
  source_type: SourceTypeSchema,
});
export type JobInput = z.infer<typeof JobInputSchema>;

export interface Job {
  id: number;
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
  created_at: string;
  updated_at: string;
}

export interface ExtractedQueue {
  name: string;
  type: string | null;
  consumer_count: number | null;
  ready_messages: number | null;
  unacked_messages: number | null;
  total_messages: number | null;
  state: string | null;
}

export interface Extracted {
  page_loaded_correctly: boolean;
  filter_text_visible: string;
  row_count: number;
  queues: ExtractedQueue[];
}

export interface RuleResult {
  id: string;
  description: string;
  passed: boolean;
  offending: { name: string; value: number | null }[];
  message: string;
  /** Observed values for this rule on the run — present even when passed,
   *  so the UI can show "actual vs threshold" without re-deriving from extracted data. */
  observed?: {
    /** Number of queues the rule was evaluated against (row_count rule omits). */
    queues?: number;
    /** Minimum non-null value across targeted queues (or the row_count itself). */
    min?: number;
    /** Maximum non-null value across targeted queues. */
    max?: number;
    /** Single value for row_count-style rules. */
    value?: number;
  };
}

export type RunStatus = 'running' | 'ok' | 'alert' | 'system_error' | 'pending_recheck';

export interface Run {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  screenshot_path: string | null;
  recheck_screenshot_path: string | null;
  extracted: Extracted | null;
  rule_results: RuleResult[] | null;
  summary: string | null;
  error_message: string | null;
  /** Which AI provider actually produced the verdict. */
  ai_provider_used: string | null;
  ai_model_used: string | null;
  /** Estimated cost of the AI call(s) for this run, in US cents. */
  ai_cost_cents: number | null;
  /** JSON-serialized array of {provider, error} when fallback kicked in. */
  ai_fallback_notes: string | null;
}
