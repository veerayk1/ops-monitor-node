/**
 * Notifier abstraction.
 *
 * The dashboard is the v1 sink. Email / Teams / Slack adapters can be added
 * later by implementing this interface and pushing into `notifiers`.
 */

export interface Notifier {
  name: string;
  send(args: { jobName: string; summary: string; severity: string; details: Record<string, unknown> }): void;
}

class DashboardNotifier implements Notifier {
  name = 'dashboard';
  send(): void {
    // No-op: alerts are persisted to the runs table and shown on the dashboard.
  }
}

const notifiers: Notifier[] = [new DashboardNotifier()];

export function notify(args: {
  jobName: string;
  summary: string;
  severity: string;
  details: Record<string, unknown>;
}): void {
  for (const n of notifiers) {
    try { n.send(args); } catch { /* notifier failures must never break a run */ }
  }
}

export function registerNotifier(n: Notifier): void {
  notifiers.push(n);
}
