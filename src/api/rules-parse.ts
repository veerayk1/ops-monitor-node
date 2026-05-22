/**
 * POST /api/rules/parse
 *
 * Converts plain-English rule descriptions into structured Rule objects.
 *
 * Why this exists:
 *   The current Job Builder requires the operator to choose a target, metric,
 *   operator, threshold, and wait-and-confirm settings for every rule from
 *   dropdowns. That's reliable but stiff — operators describe what they want
 *   in natural language ("alert me if any primary queue has no consumers for
 *   more than 5 minutes"). This endpoint lets the operator paste that text
 *   and get back fully-formed structured rules ready to drop into the form.
 *
 * How it works:
 *   1. Validate the input (zod).
 *   2. If ANTHROPIC_API_KEY is missing → return 503 with an actionable error.
 *      (The feature degrades gracefully — the manual rule builder still works.)
 *   3. Call Claude with a tool definition that mirrors the Rule schema EXACTLY
 *      (enums for target/metric/operator). The model is forced to use the tool,
 *      and it can invoke it MULTIPLE TIMES IN ONE TURN to emit several rules
 *      from one paragraph of text.
 *   4. Filter out any tool invocations that don't pass our zod re-validation,
 *      so a malformed model output never reaches the rest of the pipeline.
 *   5. Return { rules: Rule[], notes?: string[] }.
 */
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { settings } from '../config.js';
import { RuleSchema, type Rule } from '../types.js';

export const rulesParseRouter = Router();

const RequestSchema = z.object({
  text: z.string().min(1, 'text is required').max(5000, 'text too long (max 5000 chars)'),
});

/**
 * Default to Haiku — this is a small structured-extraction task, doesn't need Opus.
 * Operator can override via env (RULES_PARSER_MODEL).
 */
const RULES_PARSER_MODEL = process.env.RULES_PARSER_MODEL ?? 'claude-haiku-4-5-20251001';

/**
 * Hard upper bound on rules per request — prevents a runaway model from
 * generating dozens of rules from a vague sentence and overwhelming the UI.
 */
const MAX_RULES_PER_REQUEST = 12;

const SYSTEM_PROMPT = `You convert plain-English monitoring-rule descriptions into structured rules for a queue-monitoring system.

Each rule has these fields:
- description: human-readable label. Use the operator's own words when possible — keep it short and clear.
- target:  'primary' (non-DLQ queues), 'dlq' (dead-letter queues, name ends in .dlq), or 'all'.
- metric:
    'consumer_count'     — number of active worker processes reading from a queue.
    'ready_messages'     — messages sitting in the queue waiting to be processed.
    'unacked_messages'   — messages currently being processed but not yet acknowledged.
    'row_count'          — total number of queues matching the filter (NOT a per-queue value).
- operator: one of '>=', '>', '==', '<=', '<', '!='.
- threshold: a number.
- wait_and_confirm: true if the operator wants the system to RE-CHECK after a wait period before alerting.
    Set true when text mentions "if it stays bad for", "wait", "re-check", "confirm", "give it time".
    Default to false for explicit failure conditions like DLQ overflow.
- wait_minutes: 1–60. Default 5 when wait_and_confirm is true, else 5 (ignored when false).

Conventions:
- "at least N" → operator '>=' with threshold N.
- "no more than N" / "must not exceed N" / "should be under N" → '<=' with threshold N.
- "exactly N" → '==' with threshold N.
- If the operator says "every queue" or doesn't specify primary/DLQ, default target to 'primary' for consumer/ready/unacked metrics, 'all' for row_count.
- A statement about a SPECIFIC queue name (e.g. "the orders queue must…") still maps to one of primary/dlq/all by inferring from the name's .dlq suffix.

Call the add_rule tool ONCE PER DISTINCT RULE you find in the text. Skip ambiguous content rather than guessing — operators can add missing rules manually.

Examples:
  "Every primary queue must have at least 1 consumer."
    → add_rule({ description: "Every primary queue must have at least 1 consumer", target: "primary", metric: "consumer_count", operator: ">=", threshold: 1, wait_and_confirm: false, wait_minutes: 5 })

  "Alert me if any DLQ has more than 10 ready messages, but wait 5 minutes to confirm first."
    → add_rule({ description: "DLQs must not exceed 10 ready messages (with 5-min recheck)", target: "dlq", metric: "ready_messages", operator: "<=", threshold: 10, wait_and_confirm: true, wait_minutes: 5 })

  "We should have exactly 6 queues."
    → add_rule({ description: "Filter must show exactly 6 queues", target: "all", metric: "row_count", operator: "==", threshold: 6, wait_and_confirm: false, wait_minutes: 5 })`;

interface AddRuleToolInput {
  description: string;
  target: 'primary' | 'dlq' | 'all';
  metric: 'consumer_count' | 'ready_messages' | 'unacked_messages' | 'row_count';
  operator: '>=' | '>' | '==' | '<=' | '<' | '!=';
  threshold: number;
  wait_and_confirm: boolean;
  wait_minutes: number;
}

const ADD_RULE_TOOL: Anthropic.Tool = {
  name: 'add_rule',
  description: 'Add a single structured monitoring rule. Call this once per distinct rule found in the user\'s text.',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Human-readable label for this rule' },
      target:      { type: 'string', enum: ['primary', 'dlq', 'all'] },
      metric:      { type: 'string', enum: ['consumer_count', 'ready_messages', 'unacked_messages', 'row_count'] },
      operator:    { type: 'string', enum: ['>=', '>', '==', '<=', '<', '!='] },
      threshold:   { type: 'number' },
      wait_and_confirm: { type: 'boolean' },
      wait_minutes:     { type: 'number', minimum: 1, maximum: 60 },
    },
    required: ['description', 'target', 'metric', 'operator', 'threshold', 'wait_and_confirm', 'wait_minutes'],
  },
};

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!settings.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client ??= new Anthropic({ apiKey: settings.anthropicApiKey });
  return _client;
}

rulesParseRouter.post('/', async (req, res) => {
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  if (!settings.anthropicApiKey) {
    return res.status(503).json({
      error: 'AI rule conversion requires ANTHROPIC_API_KEY in .env',
      hint: 'Set ANTHROPIC_API_KEY in your .env file and restart. You can still add rules manually below.',
    });
  }

  try {
    const response = await client().messages.create({
      model: RULES_PARSER_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: [ADD_RULE_TOOL],
      tool_choice: { type: 'any', disable_parallel_tool_use: false },
      messages: [{ role: 'user', content: parsed.data.text }],
    });

    const toolCalls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'add_rule',
    );

    const rules: Rule[] = [];
    const notes: string[] = [];

    for (const [idx, call] of toolCalls.slice(0, MAX_RULES_PER_REQUEST).entries()) {
      // Re-validate the model's output against our Zod schema, so a hallucinated
      // enum value or bad threshold can never reach the rest of the pipeline.
      const input = call.input as AddRuleToolInput;
      const candidate = {
        id: `ai_${Date.now()}_${idx}`,
        description: input.description,
        target: input.target,
        metric: input.metric,
        operator: input.operator,
        threshold: input.threshold,
        wait_and_confirm: input.wait_and_confirm,
        wait_minutes: input.wait_minutes,
      };
      const validated = RuleSchema.safeParse(candidate);
      if (validated.success) {
        rules.push(validated.data);
      } else {
        notes.push(`Skipped rule #${idx + 1} (validation failed): ${JSON.stringify(input).slice(0, 120)}`);
      }
    }

    if (toolCalls.length > MAX_RULES_PER_REQUEST) {
      notes.push(`Model produced ${toolCalls.length} rules; only the first ${MAX_RULES_PER_REQUEST} were kept.`);
    }

    if (rules.length === 0) {
      return res.status(422).json({
        error: 'Could not extract any structured rules from the text',
        hint: 'Try being more specific — e.g. "every primary queue must have at least 1 consumer" or "no DLQ may exceed 10 ready messages."',
        notes,
      });
    }

    res.json({ rules, notes: notes.length ? notes : undefined, model: RULES_PARSER_MODEL });
  } catch (e) {
    const err = e as Error;
    console.error('[rules-parse] Anthropic call failed:', err);
    res.status(502).json({
      error: `AI rule conversion failed: ${err.message}`,
    });
  }
});
