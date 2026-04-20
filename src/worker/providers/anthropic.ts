import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { settings } from '../../config.js';
import { EXTRACTION_PROMPT, parseExtractionJson, type ExtractionResult, type VisionProvider } from './types.js';

// Approximate per-million-token pricing in cents.
// Source: Anthropic public pricing as of build time. Update if prices change.
// These are intentionally conservative — actual cost may be slightly lower.
const PRICING_CENTS_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-4-5':         { input: 1500, output: 7500 },  // $15 / $75 per 1M
  'claude-sonnet-4-6':       { input: 300,  output: 1500 },  // $3  / $15 per 1M
  'claude-haiku-4-5-20251001': { input: 100,  output: 500  }, // $1  / $5  per 1M
};

function priceFor(model: string): { input: number; output: number } {
  return PRICING_CENTS_PER_MTOK[model] ?? PRICING_CENTS_PER_MTOK['claude-opus-4-5'];
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!settings.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  _client ??= new Anthropic({ apiKey: settings.anthropicApiKey });
  return _client;
}

export const anthropicProvider: VisionProvider = {
  name: 'anthropic',
  async extract(screenshotPath: string): Promise<ExtractionResult> {
    const imageB64 = readFileSync(screenshotPath).toString('base64');
    const model = settings.anthropicModel;

    const response = await client().messages.create({
      model,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } },
            { type: 'text', text: EXTRACTION_PROMPT },
          ],
        },
      ],
    });

    const text = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const extracted = parseExtractionJson(text);

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const price = priceFor(model);
    const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;

    return {
      extracted,
      inputTokens,
      outputTokens,
      estimatedCostCents: cost,
      modelUsed: model,
    };
  },
};
