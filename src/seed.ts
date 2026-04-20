import { encrypt } from './crypto.js';
import { insertJob, listJobs } from './database.js';

const BLUEYONDER_JOB = {
  name: 'RabbitMQ — blueYonder Queues',
  url: 'http://canldsaav01d:15672',
  username: 'amruthapriyanka.thallam',
  password: 'n0BCvqzZsBnWI27', // Test credentials per user — rotate before production use
  steps: {
    filter_text: 'blueyonder',
    ensure_columns: ['Consumer count'],
    expected_row_count: 6,
    page_path: '/#/queues',
  },
  rules: [
    { id: 'r1', description: 'Primary queues must have at least 1 consumer (alert if 0)',
      target: 'primary' as const, metric: 'consumer_count' as const, operator: '>=' as const,
      threshold: 1, wait_and_confirm: true, wait_minutes: 5 },
    { id: 'r2', description: 'Primary queues: ready messages must not exceed 50',
      target: 'primary' as const, metric: 'ready_messages' as const, operator: '<=' as const,
      threshold: 50, wait_and_confirm: true, wait_minutes: 5 },
    { id: 'r3', description: 'DLQ queues: ready messages must not exceed 10',
      target: 'dlq' as const, metric: 'ready_messages' as const, operator: '<=' as const,
      threshold: 10, wait_and_confirm: false, wait_minutes: 5 },
    { id: 'r4', description: 'Filter must show exactly 6 queues (3 primary + 3 DLQ)',
      target: 'all' as const, metric: 'row_count' as const, operator: '==' as const,
      threshold: 6, wait_and_confirm: false, wait_minutes: 5 },
  ],
  schedule_cron: '0 9-18 * * 1-5',
  enabled: true,
  ai_provider: 'system' as const,
};

export function seedIfEmpty(): void {
  if (listJobs().length > 0) return;
  const j = BLUEYONDER_JOB;
  insertJob({
    name: j.name,
    url: j.url,
    username_enc: encrypt(j.username),
    password_enc: encrypt(j.password),
    steps: j.steps,
    rules: j.rules,
    schedule_cron: j.schedule_cron,
    enabled: j.enabled,
    ai_provider: j.ai_provider,
  });
}
