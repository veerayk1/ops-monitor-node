/**
 * Email notifier — sends an HTML email via Resend whenever a workflow run
 * produces an "alert" or "system_error" verdict.
 *
 * Safe to register even when RESEND_API_KEY is blank: it short-circuits with
 * a console warning instead of throwing, so missing config never breaks a run.
 */
import { Resend } from 'resend';
import { BRAND } from '../branding.js';
import { isEmailConfigured, settings } from '../config.js';
import type { Notifier } from '../notifications.js';

interface RuleResultLite {
  description?: string;
  passed?: boolean;
  message?: string;
}

const SEVERITY_LABEL: Record<string, string> = {
  alert: '🔴 ALERT',
  system_error: '⚠️ SYSTEM ERROR',
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildSubject(args: { jobName: string; severity: string; summary: string }): string {
  const tag = SEVERITY_LABEL[args.severity] || args.severity.toUpperCase();
  // Subject lines should be informative but compact (Gmail truncates around 70 chars)
  const head = `[${BRAND.name}] ${tag} · ${args.jobName}`;
  // Don't append summary if it would make the subject unreadable
  if (head.length > 80) return head;
  const tail = ' — ' + args.summary;
  return (head + tail).slice(0, 140);
}

function buildHtml(args: {
  jobName: string;
  severity: string;
  summary: string;
  runId?: number;
  ruleResults?: RuleResultLite[];
  errorMessage?: string;
}): string {
  const tag = SEVERITY_LABEL[args.severity] || args.severity.toUpperCase();
  const color = args.severity === 'alert' ? '#f87171' : '#fbbf24';
  const dim = args.severity === 'alert' ? '#fee2e2' : '#fef3c7';

  const failing = (args.ruleResults || []).filter((r) => r.passed === false);
  const failingHtml = failing.length
    ? `<h3 style="margin:24px 0 8px;font-size:14px;color:#374151;">Failing rules</h3>
       <ul style="margin:0;padding-left:20px;color:#4b5563;font-size:13px;line-height:1.6;">
         ${failing.map((r) => `<li><strong>${esc(r.description)}</strong><br><span style="color:#6b7280;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;">${esc(r.message)}</span></li>`).join('')}
       </ul>`
    : '';

  const errorHtml = args.errorMessage
    ? `<h3 style="margin:24px 0 8px;font-size:14px;color:#374151;">Error</h3>
       <pre style="margin:0;padding:12px;background:#f3f4f6;border-radius:6px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#374151;white-space:pre-wrap;word-break:break-word;">${esc(args.errorMessage)}</pre>`
    : '';

  const linkBase = settings.publicBaseUrl || `http://${settings.host}:${settings.port}`;
  const runLink = args.runId
    ? `<p style="margin:24px 0 0;font-size:13px;"><a href="${esc(linkBase)}/runs/${args.runId}" style="color:#7c3aed;text-decoration:none;font-weight:500;">View run #${args.runId} on ${esc(BRAND.name)} →</a></p>`
    : '';

  return `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">
    <tr>
      <td style="padding:4px;background:${color};"></td>
    </tr>
    <tr>
      <td style="padding:28px 28px 8px;">
        <div style="display:inline-block;padding:4px 10px;background:${dim};color:${color};font-size:11px;font-weight:600;border-radius:999px;letter-spacing:0.04em;">${tag}</div>
        <h1 style="margin:14px 0 6px;font-size:20px;font-weight:600;color:#111827;">${esc(args.jobName)}</h1>
        <p style="margin:0;color:#4b5563;font-size:14px;line-height:1.5;">${esc(args.summary)}</p>
        ${failingHtml}
        ${errorHtml}
        ${runLink}
      </td>
    </tr>
    <tr>
      <td style="padding:18px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;">
        Sent by ${esc(BRAND.name)} · ${esc(BRAND.longTagline)}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

let resendClient: Resend | null = null;

export const emailNotifier: Notifier = {
  name: 'email',
  send(args) {
    if (!isEmailConfigured()) return; // silently skip when unconfigured

    // Lazy-init the client so a missing key at startup doesn't break imports.
    if (!resendClient) resendClient = new Resend(settings.resendApiKey);

    // Only email on "wrong" states — never on "ok" or "running"
    if (!['alert', 'system_error'].includes(args.severity)) return;

    const ruleResults = (args.details?.ruleResults as RuleResultLite[] | undefined) ?? undefined;
    const runId = (args.details?.runId as number | undefined) ?? undefined;
    const errorMessage = (args.details?.error_message as string | undefined) ?? undefined;

    const subject = buildSubject({ jobName: args.jobName, severity: args.severity, summary: args.summary });
    const html = buildHtml({
      jobName: args.jobName,
      severity: args.severity,
      summary: args.summary,
      ruleResults,
      runId,
      errorMessage,
    });

    const from = settings.notifyEmailFromName
      ? `${settings.notifyEmailFromName} <${settings.notifyEmailFrom}>`
      : settings.notifyEmailFrom;

    // Fire-and-forget. We never want a slow/failing email service to block a run.
    resendClient.emails
      .send({ from, to: settings.notifyEmailTo, subject, html })
      .then((res) => {
        if (res?.error) {
          console.error('[email] Resend rejected message:', res.error);
        } else {
          console.log(`[email] Sent ${args.severity} email for "${args.jobName}" to ${settings.notifyEmailTo}`);
        }
      })
      .catch((err) => {
        console.error('[email] Send failed:', err?.message || err);
      });
  },
};
