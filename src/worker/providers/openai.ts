import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { settings } from '../../config.js';
import { EXTRACTION_PROMPT, parseExtractionJson, type ExtractionResult, type VisionProvider } from './types.js';

// Approximate per-million-token pricing in cents.
// Source: OpenAI public pricing as of build time.
const PRICING_CENTS_PER_MTOK: Record<string, { input: number; output: number }> = {
  'gpt-4o':        { input: 250,  output: 1000 },  // $2.50 / $10 per 1M
  'gpt-4o-mini':   { input: 15,   output: 60   },  // $0.15 / $0.60 per 1M
  'gpt-4-turbo':   { input: 1000, output: 3000 },
  'gpt-5':         { input: 1250, output: 10000 }, // placeholder for newer models
};

function priceFor(model: string): { input: number; output: number } {
  return PRICING_CENTS_PER_MTOK[model] ?? PRICING_CENTS_PER_MTOK['gpt-4o'];
}

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!settings.openaiApiKey) throw new Error('OPENAI_API_KEY is not set');
  _client ??= new OpenAI({ apiKey: settings.openaiApiKey });
  return _client;
}

export const openaiProvider: VisionProvider = {
  name: 'openai',
  async extract(screenshotPath: string): Promise<ExtractionResult> {
    const imageB64 = readFileSync(screenshotPath).toString('base64');
    const model = settings.openaiModel;

    const response = await client().chat.completions.create({
      model,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EXTRACTION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${imageB64}`, detail: 'high' },
            },
          ],
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    const extracted = parseExtractionJson(text);

    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
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
