import type { Extracted, Rule, RuleResult } from '../types.js';

/**
 * Rule engine.
 *
 * Takes the structured queue data extracted from a screenshot and a list of
 * rule definitions, and returns per-rule pass/fail results.
 */

const OPS: Record<Rule['operator'], (a: number, b: number) => boolean> = {
  '>=': (a, b) => a >= b,
  '>':  (a, b) => a >  b,
  '==': (a, b) => a === b,
  '<=': (a, b) => a <= b,
  '<':  (a, b) => a <  b,
  '!=': (a, b) => a !== b,
};

function isDlq(name: string): boolean {
  return name.toLowerCase().endsWith('.dlq');
}

function filterQueues<T extends { name: string }>(queues: T[], target: Rule['target']): T[] {
  if (target === 'all') return queues;
  if (target === 'primary') return queues.filter((q) => !isDlq(q.name));
  if (target === 'dlq') return queues.filter((q) => isDlq(q.name));
  return [];
}

export function evaluateRules(extracted: Extracted, rules: Rule[]): RuleResult[] {
  const queues = extracted.queues ?? [];
  const rowCount = extracted.row_count ?? queues.length;

  return rules.map((rule) => {
    const op = OPS[rule.operator];
    const threshold = rule.threshold;

    if (rule.metric === 'row_count') {
      const value = rowCount;
      const passed = op(value, threshold);
      return {
        id: rule.id,
        description: rule.description,
        passed,
        offending: passed ? [] : [{ name: '<row count>', value }],
        message: `row count = ${value} (rule: ${rule.operator} ${threshold})`,
        observed: { value },
      };
    }

    const targeted = filterQueues(queues, rule.target);
    const offending: { name: string; value: number | null }[] = [];
    const observedNumbers: number[] = [];
    for (const q of targeted) {
      const value = q[rule.metric];
      if (value === null || value === undefined) {
        offending.push({ name: q.name ?? '?', value: null });
        continue;
      }
      observedNumbers.push(value);
      if (!op(value, threshold)) {
        offending.push({ name: q.name ?? '?', value });
      }
    }

    const passed = offending.length === 0;
    const message = passed
      ? `${rule.target}: all queues satisfy ${rule.metric} ${rule.operator} ${threshold}`
      : `${rule.target}: violation on ${rule.metric} ${rule.operator} ${threshold} (` +
        offending.map((o) => `${o.name}=${o.value}`).join(', ') + ')';

    const observed: NonNullable<RuleResult['observed']> = { queues: targeted.length };
    if (observedNumbers.length) {
      observed.min = Math.min(...observedNumbers);
      observed.max = Math.max(...observedNumbers);
    }

    return {
      id: rule.id,
      description: rule.description,
      passed,
      offending,
      message,
      observed,
    };
  });
}

export function overallStatus(results: RuleResult[]): 'ok' | 'alert' {
  return results.every((r) => r.passed) ? 'ok' : 'alert';
}

export function rulesNeedingRecheck(rules: Rule[], results: RuleResult[]): Rule[] {
  const failingIds = new Set(results.filter((r) => !r.passed).map((r) => r.id));
  return rules.filter((r) => failingIds.has(r.id) && r.wait_and_confirm);
}
