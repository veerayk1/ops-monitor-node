import { Router } from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ENV_PATH, isEmailConfigured, isProviderConfigured, settings, type ProviderName } from '../config.js';
import { BRAND } from '../branding.js';
import { anthropicProvider } from '../worker/providers/anthropic.js';
import { openaiProvider } from '../worker/providers/openai.js';
import { Resend } from 'resend';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  res.json({
    providers: {
      anthropic: {
        configured: isProviderConfigured('anthropic'),
        model: settings.anthropicModel,
        key_hint: settings.anthropicApiKey
          ? `${settings.anthropicApiKey.slice(0, 7)}…${settings.anthropicApiKey.slice(-4)}`
          : null,
      },
      openai: {
        configured: isProviderConfigured('openai'),
        model: settings.openaiModel,
        key_hint: settings.openaiApiKey
          ? `${settings.openaiApiKey.slice(0, 7)}…${settings.openaiApiKey.slice(-4)}`
          : null,
      },
    },
    primary: settings.aiPrimary,
    fallback: settings.aiFallback || null,
    scheduler: { timezone: settings.schedulerTz || 'system default' },
    browser: { mode: settings.browserMode, channel: settings.browserChannel },
    email: {
      configured: isEmailConfigured(),
      from: settings.notifyEmailFrom,
      from_name: settings.notifyEmailFromName,
      to: settings.notifyEmailTo,
      key_hint: settings.resendApiKey
        ? `${settings.resendApiKey.slice(0, 5)}…${settings.resendApiKey.slice(-4)}`
        : null,
    },
  });
});

// ── Helper: update a key=value line in .env (or append if missing) ──────
function updateEnvVar(key: string, value: string): void {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content);
}

/**
 * PUT /api/settings
 * Update AI provider keys, models, primary/fallback, browser, and scheduler settings.
 * Updates both in-memory settings and persists to .env.
 */
settingsRouter.put('/', (req, res) => {
  const body = req.body;
  const updated: string[] = [];

  // AI keys — only update if a non-empty value is provided (don't clear accidentally)
  if (body.anthropic_api_key && typeof body.anthropic_api_key === 'string') {
    const key = body.anthropic_api_key.trim();
    if (key) {
      settings.anthropicApiKey = key;
      updateEnvVar('ANTHROPIC_API_KEY', key);
      updated.push('ANTHROPIC_API_KEY');
    }
  }
  if (body.openai_api_key && typeof body.openai_api_key === 'string') {
    const key = body.openai_api_key.trim();
    if (key) {
      settings.openaiApiKey = key;
      updateEnvVar('OPENAI_API_KEY', key);
      updated.push('OPENAI_API_KEY');
    }
  }

  // Models
  if (body.anthropic_model && typeof body.anthropic_model === 'string') {
    settings.anthropicModel = body.anthropic_model.trim();
    updateEnvVar('ANTHROPIC_MODEL', settings.anthropicModel);
    updated.push('ANTHROPIC_MODEL');
  }
  if (body.openai_model && typeof body.openai_model === 'string') {
    settings.openaiModel = body.openai_model.trim();
    updateEnvVar('OPENAI_MODEL', settings.openaiModel);
    updated.push('OPENAI_MODEL');
  }

  // Primary / fallback
  if (body.primary && ['anthropic', 'openai'].includes(body.primary)) {
    settings.aiPrimary = body.primary as ProviderName;
    updateEnvVar('AI_PROVIDER_PRIMARY', body.primary);
    updated.push('AI_PROVIDER_PRIMARY');
  }
  if (body.fallback !== undefined) {
    const fb = body.fallback === '' || body.fallback === null ? '' : body.fallback;
    if (fb === '' || fb === 'anthropic' || fb === 'openai') {
      settings.aiFallback = fb as ProviderName | '';
      updateEnvVar('AI_PROVIDER_FALLBACK', fb);
      updated.push('AI_PROVIDER_FALLBACK');
    }
  }

  // Browser
  if (body.browser_mode && ['headed', 'headless'].includes(body.browser_mode)) {
    settings.browserMode = body.browser_mode as 'headed' | 'headless';
    updateEnvVar('BROWSER_MODE', body.browser_mode);
    updated.push('BROWSER_MODE');
  }
  if (body.browser_channel && typeof body.browser_channel === 'string') {
    settings.browserChannel = body.browser_channel.trim();
    updateEnvVar('BROWSER_CHANNEL', settings.browserChannel);
    updated.push('BROWSER_CHANNEL');
  }

  // Scheduler timezone
  if (body.scheduler_tz !== undefined && typeof body.scheduler_tz === 'string') {
    const tz = body.scheduler_tz.trim();
    if (tz) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        settings.schedulerTz = tz;
        updateEnvVar('SCHEDULER_TZ', tz);
        updated.push('SCHEDULER_TZ');
      } catch {
        return res.status(400).json({ ok: false, error: `Invalid timezone: "${tz}"` });
      }
    } else {
      settings.schedulerTz = '';
      updateEnvVar('SCHEDULER_TZ', '');
      updated.push('SCHEDULER_TZ');
    }
  }

  if (updated.length === 0) {
    return res.status(400).json({ ok: false, error: 'No valid settings provided' });
  }

  res.json({ ok: true, message: `Updated: ${updated.join(', ')}`, updated });
});

/**
 * POST /api/settings/test/:provider
 * Sends a tiny vision request to verify the key + reachability work end-to-end.
 */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * POST /api/settings/email-test
 * Sends a test email via Resend to verify the configuration works end-to-end.
 */
settingsRouter.post('/email-test', async (_req, res) => {
  if (!isEmailConfigured()) {
    return res.status(400).json({ ok: false, error: 'Email not configured — set RESEND_API_KEY and NOTIFY_EMAIL_TO in .env' });
  }
  const client = new Resend(settings.resendApiKey);
  const from = settings.notifyEmailFromName
    ? `${settings.notifyEmailFromName} <${settings.notifyEmailFrom}>`
    : settings.notifyEmailFrom;
  try {
    const result = await client.emails.send({
      from,
      to: settings.notifyEmailTo,
      subject: `[${BRAND.name}] Test email — configuration is working`,
      html: `<!doctype html><html><body style="font-family:-apple-system,sans-serif;padding:24px;background:#f9fafb;">
        <div style="max-width:480px;margin:0 auto;background:#fff;padding:24px;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="margin:0 0 12px;color:#10b981;">✓ ${BRAND.name} email alerts are configured</h2>
          <p style="color:#4b5563;font-size:14px;line-height:1.5;margin:0;">
            This is a test message confirming the Resend integration is working.
            From now on you'll receive emails whenever a workflow run fails its
            health rules or hits a system error.
          </p>
        </div></body></html>`,
    });
    if (result?.error) {
      return res.status(500).json({ ok: false, error: `Resend rejected: ${result.error.message || result.error.name}` });
    }
    res.json({ ok: true, message: `Test email sent to ${settings.notifyEmailTo}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Send failed: ${(e as Error).message}` });
  }
});

settingsRouter.post('/test/:provider', async (req, res) => {
  const provider = req.params.provider as ProviderName;
  if (provider !== 'anthropic' && provider !== 'openai') {
    return res.status(400).json({ ok: false, error: 'Unknown provider' });
  }
  if (!isProviderConfigured(provider)) {
    return res.status(400).json({ ok: false, error: `${provider}: API key not configured` });
  }

  const tmpPath = join(tmpdir(), `ops_test_${Date.now()}.png`);
  try {
    writeFileSync(tmpPath, Buffer.from(TINY_PNG_B64, 'base64'));
    const impl = provider === 'anthropic' ? anthropicProvider : openaiProvider;
    try {
      await impl.extract(tmpPath);
    } catch (e) {
      const msg = (e as Error).message;
      if (/JSON|parse|unexpected token/i.test(msg)) {
        return res.json({ ok: true, message: `${provider}: API reachable and authenticated.` });
      }
      throw e;
    }
    res.json({ ok: true, message: `${provider}: API reachable and authenticated.` });
  } catch (e) {
    res.status(500).json({ ok: false, error: `${provider}: ${(e as Error).message}` });
  } finally {
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(tmpPath);
    } catch { /* ignore */ }
  }
});
