# AI Capabilities — Current State and Future Roadmap

This document describes how Argus AI uses (and could use) artificial intelligence today and across the next quarters. It is the companion to the main [README](../README.md) and is intended to be a clear, manager-facing reference for the AI value proposition of the platform.

---

## Guiding principle

Argus is built on a strict rule: **AI is invoked only where it produces measurable value, and never in the critical monitoring path itself**. The scheduled health checks that watch our RabbitMQ queues use a direct HTTP API call — no AI, no inference cost, no extra latency. AI capabilities are designed as *layers on top* of the recorded data: they enrich, summarize, and explain — but the underlying monitoring loop remains deterministic and reliable.

This means every AI capability described below is **strictly additive**: turning it off or losing the API key never breaks monitoring.

---

## Current state — what is running today

### Active: Plain-English rule writer

When an operator opens the Job Builder and types a description of monitoring rules in plain English — for example, *"Every primary queue must have at least one consumer. If any DLQ exceeds 10 ready messages, alert me after a 5-minute confirmation wait."* — Argus calls Anthropic's Claude API to convert that text into structured rules ready to save.

- **Trigger**: a human clicks the "Convert to rules" button. Never runs automatically.
- **Cost**: approximately one cent per conversion. A team that writes hundreds of rule descriptions per month spends less than a dollar.
- **Safety**: the model is constrained by a JSON Schema tool definition; every output is re-validated against our Zod schema before being accepted into the form. Malformed rules are filtered out and reported.
- **Degrades gracefully**: if no API key is configured, the manual rule builder still works fully.

### Dormant (in code, not active for our workflows): Vision mode

The platform ships with a complete "vision fallback" implementation that uses Microsoft Edge (via Playwright) plus Anthropic Claude or OpenAI GPT to monitor *any* web admin UI, even systems with no API. For our RabbitMQ workflow this is not used because the direct API is faster, free, and more reliable. Vision mode is documented in [README-VISION.md](../README-VISION.md) and is available to switch on per-workflow at any time.

---

## Planned AI capabilities

The capabilities below are scoped, prioritized, and designed against the existing architecture. Each one is independent — we can ship them in any order without redesigning the platform.

### 1. Daily / Weekly Executive Digest

**Business value.** A one-page automated narrative report delivered to inboxes every Monday morning. Designed for leadership and on-call rotations who do not want to log into the dashboard every day but still need a clear status picture of the queue infrastructure.

**Example content.**

> *"Week of 19–25 May — 247 runs across 1 workflow, 99.2% healthy. The orders.dlq queue saw two transient spikes (Wed 14:00 and Thu 09:00) that recovered after the 5-minute wait-and-confirm window — no operator action required. Average consumer count trended down 18% over the week (from 3.4 to 2.8). At the current rate of decline, the primary rule (>= 1 consumer) will not be at risk for at least 3 weeks, but worth investigating root cause."*

**How it works.** A weekly cron job pulls the last seven days of runs from SQLite, summarizes the structured data into a compact table, and sends it to Claude with a prompt asking for an executive-tone narrative. The output is sent as an HTML email via the existing Resend integration.

**Estimated cost.** Approximately five US cents per weekly digest. Annual cost for one team: under three dollars.

**Prerequisites.** ANTHROPIC_API_KEY. None of the existing code changes — uses the same Anthropic SDK already imported and the same email pipeline already in production.

---

### 2. Root-Cause Hints in Alert Emails

**Business value.** When a rule fails, the on-call engineer currently receives an email that says *"DLQ ready_messages > 10 (orders.dlq=47)"*. Useful, but it still requires the engineer to open the dashboard, look at trends, and form a hypothesis. AI-augmented alerts include that hypothesis directly in the email — saving the first 5–10 minutes of triage on every incident.

**Example alert.**

> **Subject**: [Argus AI] ALERT · blueYonder — orders.dlq exceeded threshold (47 vs 10 max)
>
> **AI context**: This DLQ has been climbing steadily for the past four hours, from 0 at 09:00 to 47 at 13:00. Other DLQs in this workflow (inventory.dlq, shipping.dlq) remain at 0, so the issue is isolated to the orders processing path. Last similar incident: 12 days ago, resolved when the orders-consumer service was restarted after a memory leak.

**How it works.** When the runner records an alert, it triggers a Claude call with the failing rule, the current observed values, and the last 30 days of run history for the same workflow. The model produces a short paragraph that the email notifier inserts into the alert body.

**Estimated cost.** Approximately one cent per alert email. Real alerts are rare (the wait-and-confirm window filters transients), so realistic monthly cost is under one dollar.

**Prerequisites.** ANTHROPIC_API_KEY. The notifier interface already supports rich HTML email bodies.

---

### 3. Trend-Based Anomaly Detection

**Business value.** Rules catch breaches: *"ready_messages exceeded 50."* But many real failures are slow drifts — a queue's consumer count slowly bleeding from 3 to 2 to 1 over a week is a problem long before it hits zero. Trend-based AI analysis catches these drifts *before* a rule fires.

**Example finding.**

> *"Unacked_messages on the inventory queue has drifted upward from a 30-day baseline of 2 to a current average of 15. This is still well below the alert threshold of 50, but the trend is consistent (no daily/weekly seasonality) and suggests a slow leak in the inventory-consumer's acknowledgement path. Recommend reviewing consumer logs."*

**How it works.** A daily background job extracts the last 30 days of per-rule observed values from the runs table, sends a compact time-series table to Claude with a prompt asking for trends, anomalies, and recommendations. Findings are surfaced on the dashboard as a separate "Insights" card.

**Estimated cost.** Approximately ten cents per day of analysis. Less than four dollars per month.

**Prerequisites.** ANTHROPIC_API_KEY. A new lightweight UI panel on the dashboard for insights.

---

### 4. Natural-Language Query Interface

**Business value.** The runs table in SQLite is a rich source of information about queue behavior over time. Today, answering a question like *"how many alerts did we have on the orders workflow last month?"* requires writing SQL. AI lets operators ask questions in English.

**Example interactions.**

> *"How many alerts on the orders workflow in the last 30 days?"*
> → 4 alerts (3 on 2026-04-22, 1 on 2026-05-08). Click each for details.
>
> *"Which queue has the most pending_recheck states?"*
> → blueyonder.orders.dlq (7 pending_recheck states in the last 30 days, all resolved within the wait window).
>
> *"Show me the consumer_count trend for the inventory queue this week."*
> → [renders a sparkline chart]

**How it works.** A chat box on the dashboard. The operator's question, along with the database schema description, is sent to Claude via tool-use. The model emits a tool call with a read-only SQL query, which the server runs against SQLite in a sandboxed mode (SELECT only, no writes). Results are formatted as a table or chart and returned to the operator.

**Estimated cost.** Less than one cent per query. Even at 100 queries per day, monthly cost stays under thirty dollars.

**Prerequisites.** ANTHROPIC_API_KEY. A new chat UI on the dashboard. A SQL-injection-safe read-only execution layer (already trivial given that we use better-sqlite3 with parameterized queries).

---

### 5. Auto-Suggested Rules from Historical Data

**Business value.** After a workflow has accumulated 50–100 runs, Argus has enough data to suggest sensible new rules that the operator may not have thought of. This improves monitoring coverage over time without manual effort.

**Example suggestion.**

> *"Over the past 60 days, the DLQs have stayed under 5 ready messages 98% of the time. The current alert threshold is 10 (a good emergency level). Consider adding an early-warning rule at 7 — this would have surfaced the May 8 incident two hours earlier."*

**How it works.** A periodic task analyzes the distribution of observed values for each rule, sends a summary to Claude, and asks for sensible additional rules with explanations. Suggestions appear on the dashboard with a one-click "Add this rule" button.

**Estimated cost.** Approximately two cents per suggestion batch (weekly).

**Prerequisites.** ANTHROPIC_API_KEY. A small UI on the Job Builder that surfaces suggestions.

---

### 6. Incident Postmortem Helper

**Business value.** Postmortems are valuable but rarely written because they take 30–60 minutes per incident. AI drafts a templated postmortem the moment an alert is acknowledged, capturing the timeline, the failing rule, the observed values, the trend leading up to the failure, and any human comments. The engineer reviews and ships in five minutes.

**Example template.**

> **Incident 2026-05-22 14:00 — orders.dlq overflow**
> - Rule failed: DLQ ready_messages ≤ 10 (observed 47).
> - Detected: 14:00, after a 5-minute wait-and-confirm window.
> - Trend leading up: ready_messages climbed from 0 → 47 between 10:00 and 14:00, indicating a sustained issue rather than a burst.
> - Other queues in the same workflow: unaffected, suggesting isolation to the orders path.
> - Resolution: [to be filled in by engineer]
> - Lessons learned: [to be filled in by engineer]

**How it works.** When a run record is updated with `status='alert'`, an asynchronous task generates the postmortem template via Claude and stores it in a new `postmortems` table. The dashboard surfaces it as a downloadable Markdown file from the run-detail page.

**Estimated cost.** Approximately five cents per incident.

**Prerequisites.** ANTHROPIC_API_KEY. A new `postmortems` table in SQLite. A small UI link on the run-detail page.

---

## Total estimated cost — all six capabilities active

Assuming current operational volume (one workflow, 10 runs/day, ~2 real alerts per month, 5 queries per day):

| Capability | Monthly cost (USD) |
|---|---|
| Plain-English rule writer (existing) | < $1 |
| Daily/Weekly digest | < $1 |
| Root-cause hints | < $1 |
| Trend anomaly detection | $3–5 |
| Natural-language query | $2–5 |
| Auto-suggested rules | < $1 |
| Incident postmortem helper | < $1 |
| **Estimated total** | **$10–15/month** |

For comparison, a single hour of on-call engineering time recovered (one avoided incident or one fewer triage cycle) covers a year of AI costs.

---

## Architecture readiness

The platform was designed with AI extensibility in mind:

- The **Notifier interface** is pluggable. Email is one sink today; AI-augmented email or Slack/Teams sinks are drop-in additions.
- **Run records are stored as structured JSON in SQLite**, fully queryable by SQL — the prerequisite for both the digest and the natural-language query feature.
- The **Anthropic SDK is already a dependency** and integrated; new AI features reuse the same client and patterns.
- The **Plain-English rule writer** already proves the tool-use integration pattern (strict JSON Schema constraints + Zod re-validation), and that pattern is reused by every capability above.
- The **Rule engine emits structured observed values** (min, max, count) — ideal input for trend analysis prompts.

In other words: the foundation is laid. Each new capability is two to five days of focused work, not a redesign.

---

## How to enable AI features in this platform

All future capabilities share the same dependency: an Anthropic API key in `.env`.

```ini
ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```

Each capability is independently configurable via additional environment variables (e.g. `ENABLE_DIGEST_EMAIL=true`, `DIGEST_SCHEDULE_CRON='0 9 * * 1'`) so the team can roll them out incrementally and observe their value before enabling the next one.
