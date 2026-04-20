import type { Extracted } from '../../types.js';

export interface ExtractionResult {
  extracted: Extracted;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost of this single call, in US cents (e.g. 4.5 = $0.045). */
  estimatedCostCents: number;
  modelUsed: string;
}

export interface VisionProvider {
  name: 'anthropic' | 'openai';
  /** Throws on any failure (network, 4xx, 5xx, malformed response). */
  extract(screenshotPath: string): Promise<ExtractionResult>;
}

export const EXTRACTION_PROMPT = `You are looking at a screenshot of the RabbitMQ Management UI's Queues page.

Extract the queue table contents into JSON. Each row in the table is a queue.

For each queue, return:
- "name": the queue name shown in the Name column (string)
- "type": the value in the Type column, e.g. "quorum" or "classic" (string)
- "consumer_count": the integer value shown in the Consumers (or "Consumer count") column
- "ready_messages": the integer value shown in the "Ready" column under "Messages"
- "unacked_messages": the integer value shown in the "Unacked" or "Unacknowledged" column
- "total_messages": the integer value shown in the "Total" column under "Messages", if present
- "state": the text shown in the State column, e.g. "running" or "idle"

Also return:
- "row_count": total number of queue rows visible
- "filter_text_visible": the text inside the Filter input, if visible (string, may be empty)
- "page_loaded_correctly": true if you can see a queues table; false if the page shows a login form, error, or unrelated content

Return ONLY valid JSON in this exact shape:
{
  "page_loaded_correctly": true,
  "filter_text_visible": "blue",
  "row_count": 6,
  "queues": [
    {"name": "...", "type": "...", "consumer_count": 1, "ready_messages": 0, "unacked_messages": 0, "total_messages": 0, "state": "running"}
  ]
}

If a value is not visible or not applicable, use null. Do not include any prose, markdown, or commentary outside the JSON.`;

/** Strip code fences and extract the JSON body from a model response. */
export function parseExtractionJson(text: string): Extracted {
  let body = text.trim();
  if (body.startsWith('```')) {
    body = body.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  }
  // Find the first { and last } in case there's surrounding prose
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    body = body.slice(first, last + 1);
  }
  return JSON.parse(body) as Extracted;
}
