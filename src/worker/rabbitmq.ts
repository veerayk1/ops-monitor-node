import type { Extracted, ExtractedQueue } from '../types.js';

interface RabbitQueue {
  name: string;
  vhost?: string;
  type?: string;
  state?: string;
  consumers?: number;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
}

export interface FetchRabbitMqParams {
  /** Management API base URL, e.g. http://canldsaav01d:15672 (may include a /#/path which is stripped). */
  url: string;
  username: string;
  password: string;
  /** Optional vhost name. If set, queries /api/queues/{vhost}. */
  vhost?: string;
  /** Case-insensitive substring filter on queue name. */
  filterText?: string | null;
  /** Abort the HTTP request after this many milliseconds. Default 15000. */
  timeoutMs?: number;
}

function baseUrl(url: string): string {
  const hashIdx = url.indexOf('#');
  const trimmed = (hashIdx === -1 ? url : url.slice(0, hashIdx)).replace(/\/+$/, '');
  return trimmed;
}

function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function mapQueue(q: RabbitQueue): ExtractedQueue {
  return {
    name: q.name,
    type: q.type ?? null,
    consumer_count: typeof q.consumers === 'number' ? q.consumers : null,
    ready_messages: typeof q.messages_ready === 'number' ? q.messages_ready : null,
    unacked_messages: typeof q.messages_unacknowledged === 'number' ? q.messages_unacknowledged : null,
    total_messages: typeof q.messages === 'number' ? q.messages : null,
    state: q.state ?? null,
  };
}

/**
 * Fetch queue stats directly from the RabbitMQ Management plugin's HTTP API.
 * Returns the same Extracted shape the rule engine consumes, so it's a drop-in
 * replacement for the screenshot + AI pipeline.
 */
export async function fetchRabbitMqQueues(params: FetchRabbitMqParams): Promise<Extracted> {
  const base = baseUrl(params.url);
  const path = params.vhost
    ? `/api/queues/${encodeURIComponent(params.vhost)}`
    : '/api/queues';
  const endpoint = `${base}${path}`;
  const timeoutMs = params.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Authorization: basicAuth(params.username, params.password),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      throw new Error(`RabbitMQ API request timed out after ${timeoutMs}ms (${endpoint})`);
    }
    throw new Error(`RabbitMQ API request failed (${endpoint}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`RabbitMQ API ${response.status} ${response.statusText} from ${endpoint}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as RabbitQueue[];
  if (!Array.isArray(payload)) {
    throw new Error(`RabbitMQ API returned non-array body from ${endpoint}`);
  }

  const filter = (params.filterText ?? '').trim().toLowerCase();
  const filtered = filter
    ? payload.filter((q) => (q.name ?? '').toLowerCase().includes(filter))
    : payload;

  const queues = filtered.map(mapQueue);
  return {
    page_loaded_correctly: true,
    filter_text_visible: params.filterText ?? '',
    row_count: queues.length,
    queues,
  };
}
