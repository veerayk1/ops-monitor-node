import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT = join(__dirname, '..');
export const DATA_DIR = join(PROJECT_ROOT, 'data');
export const SCREENSHOTS_DIR = join(PROJECT_ROOT, 'public', 'screenshots');
export const VIEWS_DIR = join(PROJECT_ROOT, 'views');
export const PUBLIC_DIR = join(PROJECT_ROOT, 'public');
export const DB_PATH = join(DATA_DIR, 'ops_monitor.db');
export const ENV_PATH = join(PROJECT_ROOT, '.env');

dotenvConfig({ path: ENV_PATH });

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

export type ProviderName = 'anthropic' | 'openai';

function parseProvider(value: string | undefined, fallback: ProviderName | ''): ProviderName | '' {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'anthropic' || v === 'openai') return v;
  if (v === '') return '';
  return fallback;
}

export const settings = {
  // AI providers
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-5',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o',
  aiPrimary: parseProvider(process.env.AI_PROVIDER_PRIMARY, 'anthropic') as ProviderName,
  aiFallback: parseProvider(process.env.AI_PROVIDER_FALLBACK, '') as ProviderName | '',

  // Encryption
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  encryptionSalt: process.env.ENCRYPTION_SALT ?? '',

  // Server
  host: process.env.HOST ?? '127.0.0.1',
  port: parseInt(process.env.PORT ?? '8000', 10),
  schedulerTz: process.env.SCHEDULER_TZ ?? '',

  // Browser
  browserMode: (process.env.BROWSER_MODE ?? 'headed') as 'headed' | 'headless',
  browserChannel: process.env.BROWSER_CHANNEL ?? 'msedge',

  // Email alerts (Resend)
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  notifyEmailFrom: process.env.NOTIFY_EMAIL_FROM ?? 'onboarding@resend.dev',
  notifyEmailFromName: process.env.NOTIFY_EMAIL_FROM_NAME ?? 'Argus AI',
  notifyEmailTo: process.env.NOTIFY_EMAIL_TO ?? '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
};

export type Settings = typeof settings;

/** Validate critical settings at startup — warns but doesn't crash for non-fatal issues. */
export function validateSettings(): void {
  const warnings: string[] = [];
  if (!settings.anthropicApiKey && !settings.openaiApiKey) {
    warnings.push('No AI provider keys configured — Vision mode disabled (RabbitMQ-API mode still works without keys)');
  }
  if (settings.resendApiKey && !settings.notifyEmailTo) {
    warnings.push('RESEND_API_KEY set but NOTIFY_EMAIL_TO is empty — email alerts will be skipped');
  }
  if (!settings.resendApiKey) {
    warnings.push('Email alerts disabled — set RESEND_API_KEY and NOTIFY_EMAIL_TO in .env to enable');
  }
  if (settings.port < 1 || settings.port > 65535 || !Number.isFinite(settings.port)) {
    warnings.push(`Invalid PORT: ${settings.port}, defaulting to 8000`);
    settings.port = 8000;
  }
  if (settings.schedulerTz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: settings.schedulerTz });
    } catch {
      warnings.push(`Invalid SCHEDULER_TZ: "${settings.schedulerTz}" — using system default`);
      settings.schedulerTz = '';
    }
  }
  for (const w of warnings) console.warn(`[config] ${w}`);
}

/** True if email alerts can actually be sent. */
export function isEmailConfigured(): boolean {
  return Boolean(settings.resendApiKey && settings.notifyEmailTo);
}

/** True if the given provider has a key configured. */
export function isProviderConfigured(provider: ProviderName): boolean {
  if (provider === 'anthropic') return Boolean(settings.anthropicApiKey);
  if (provider === 'openai') return Boolean(settings.openaiApiKey);
  return false;
}

/** Returns providers in the order they should be tried for a single run. */
export function providerOrder(workflowOverride?: ProviderName | 'system' | null): ProviderName[] {
  const order: ProviderName[] = [];

  // Per-workflow override: only use that one provider, no fallback
  if (workflowOverride && workflowOverride !== 'system') {
    if (isProviderConfigured(workflowOverride)) order.push(workflowOverride);
    return order;
  }

  // System default: primary then fallback
  if (settings.aiPrimary && isProviderConfigured(settings.aiPrimary)) {
    order.push(settings.aiPrimary);
  }
  if (
    settings.aiFallback &&
    settings.aiFallback !== settings.aiPrimary &&
    isProviderConfigured(settings.aiFallback as ProviderName)
  ) {
    order.push(settings.aiFallback as ProviderName);
  }
  return order;
}
