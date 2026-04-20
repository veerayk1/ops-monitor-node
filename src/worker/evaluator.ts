import { providerOrder, type ProviderName } from '../config.js';
import { anthropicProvider } from './providers/anthropic.js';
import { openaiProvider } from './providers/openai.js';
import type { ExtractionResult, VisionProvider } from './providers/types.js';

const PROVIDERS: Record<ProviderName, VisionProvider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

export interface EvaluationOutcome extends ExtractionResult {
  providerUsed: ProviderName;
  /** Empty if primary succeeded; populated with details of any failures we recovered from. */
  fallbackFromErrors: { provider: ProviderName; error: string }[];
}

/**
 * Run vision extraction against the configured provider chain.
 *
 *  - If `workflowOverride` is set (and not 'system'), only that provider is tried — no fallback.
 *  - If 'system' / null / undefined, the system primary is tried, and on failure the system fallback.
 *
 * Throws if EVERY configured provider fails.
 */
export async function evaluateScreenshot(
  screenshotPath: string,
  workflowOverride?: ProviderName | 'system' | null,
): Promise<EvaluationOutcome> {
  const order = providerOrder(workflowOverride);
  if (order.length === 0) {
    throw new Error(
      'No AI providers configured. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY in your .env file.',
    );
  }

  const errors: { provider: ProviderName; error: string }[] = [];
  for (const name of order) {
    const provider = PROVIDERS[name];
    try {
      const result = await provider.extract(screenshotPath);
      return {
        ...result,
        providerUsed: name,
        fallbackFromErrors: errors,
      };
    } catch (e) {
      const err = e as Error;
      console.error(`[evaluator] ${name} failed: ${err.message}`);
      errors.push({ provider: name, error: `${err.name}: ${err.message}` });
    }
  }

  const summary = errors.map((e) => `${e.provider}: ${e.error}`).join(' | ');
  throw new Error(`All AI providers failed. ${summary}`);
}
