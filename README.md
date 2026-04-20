# Ops Monitor

Browser-driven, AI-evaluated operations monitoring. Logs into a web UI on a schedule, takes a screenshot, asks an AI (Claude OR GPT) to read it, applies your rules, and shows everything on a dashboard.

Built as a POC. Designed to scale to many workflows across many systems.

---

## What it does

You define a **workflow**: a URL, login credentials, a few browser steps (filter text, columns to ensure visible), and a list of **rules** (e.g. "primary queues must have ≥1 consumer", "DLQ ready messages must not exceed 10").

On the schedule you set, the system:

1. Opens Microsoft Edge via Playwright
2. Navigates to the URL, logs in
3. Performs your browser steps
4. Screenshots the page
5. Sends the screenshot to your **primary AI provider** (Claude or GPT). If that fails, automatically tries the **fallback** provider.
6. Applies your rules to the structured data the AI extracted
7. If a rule fails AND that rule has wait-and-confirm enabled, waits N minutes and re-checks before alerting
8. Records everything (screenshot, extracted data, rule results, verdict, AI cost) to SQLite
9. Updates the dashboard

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js 20 + Express + TypeScript |
| Browser | Playwright + Microsoft Edge |
| AI | Anthropic SDK (Claude) AND OpenAI SDK (GPT) — pluggable, with automatic fallback |
| Storage | better-sqlite3 + filesystem (screenshots) |
| Scheduler | node-cron with optional timezone override |
| Validation | Zod |
| Frontend | Server-rendered EJS + vanilla JS, Geist font, custom CSS, sidebar navigation |
| Encryption | Node `crypto` (AES-256-GCM) for stored workflow credentials |

Open-source code. AI providers are paid services; you bring your own keys.

---

## Setup

### 1. Install

```bash
git clone <your-repo-url> ops-monitor
cd ops-monitor

npm install
npm run playwright:install
# If Edge isn't installed: `npx playwright install chromium` and set BROWSER_CHANNEL=chromium in .env
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set **at least one** of these (both is better — the second becomes your fallback):

- `ANTHROPIC_API_KEY=sk-ant-...` — get from console.anthropic.com
- `OPENAI_API_KEY=sk-...` — get from platform.openai.com

Optional but recommended:

- `AI_PROVIDER_PRIMARY=anthropic` (or `openai`) — which to try first
- `AI_PROVIDER_FALLBACK=openai` (or `anthropic`, or empty to disable) — what to try if the primary fails

Other settings:

- `ENCRYPTION_KEY` — leave **blank** on first run; the app generates one and writes it back automatically.
- `BROWSER_MODE=headed` — visible window (recommended for demos). `headless` for production.
- `BROWSER_CHANNEL=msedge` for Edge, `chromium` if Edge isn't installed.
- `SCHEDULER_TZ=` — IANA timezone for cron (e.g. `America/Toronto`). Defaults to system.

### 3. Run

```bash
npm run dev   # Live-reloading dev mode
# OR
npm run build && npm start   # Compiled production mode
```

Open **http://localhost:8000**.

The blueYonder workflow is pre-seeded so you have something to see immediately.

### 4. Verify your AI keys work

In the UI, click **Settings** in the sidebar. Each configured provider shows a **"Test connection"** button — click it to send a tiny request and confirm the key + network reachability work.

---

## How the UI works

### Sidebar
Persistent left rail. **Dashboard** is the home view; **Settings** shows AI provider configuration; **+ New workflow** at the bottom.

### Dashboard (`/`)
A card per workflow, each showing:
- Status badge (healthy / alert / never run / system error)
- **Step-by-step flow visualization** of the configured browser steps
- All health rules with their thresholds
- Schedule, last run, next run, AI provider used
- "Run now" / "View history" / "Edit" actions

### Job Builder (`/builder`, `/builder/{id}`)
Four sections:

1. **Basics & connection** — name, URL, username, password (encrypted at rest)
2. **Browser steps** — page path, filter text, columns to ensure visible, expected row count
3. **Health rules** — add/remove dynamically. Each: target, metric, operator, threshold, optional wait-and-confirm
4. **Schedule & AI** — cron expression + per-workflow AI provider override (System default | Anthropic only | OpenAI only)

### Settings (`/settings`)
- Shows which providers are configured (key hint masked, never the full key)
- Shows the current primary → fallback chain
- "Test connection" button per configured provider
- Lists scheduler timezone and browser config

### Run detail (`/runs/{id}`)
- Captured screenshot(s) — if a recheck happened, both side-by-side
- The verdict, including which AI provider produced it and what it cost
- Per-rule pass/fail with reasoning
- Fallback notes if the primary AI provider failed
- Structured data table the AI extracted

---

## Architecture

```
ops-monitor/
├── src/
│   ├── server.ts            # Express entry point
│   ├── config.ts            # Settings + provider helpers
│   ├── crypto.ts            # AES-256-GCM credential encryption
│   ├── database.ts          # better-sqlite3 schema + CRUD + safe migrations
│   ├── types.ts             # TS types + Zod validation schemas
│   ├── notifications.ts     # Pluggable Notifier interface
│   ├── scheduler.ts         # node-cron with timezone support
│   ├── seed.ts              # Seeds blueYonder workflow on first run
│   ├── api/
│   │   ├── jobs.ts          # /api/jobs CRUD + manual run
│   │   ├── runs.ts          # /api/runs history
│   │   ├── settings.ts      # /api/settings + provider test
│   │   └── pages.ts         # HTML page routes
│   └── worker/
│       ├── browser.ts       # Playwright workflow steps
│       ├── rules.ts         # Rule engine
│       ├── runner.ts        # Orchestrates one full run, including wait-and-confirm
│       ├── evaluator.ts     # Provider dispatcher with fallback
│       └── providers/
│           ├── types.ts     # Shared interface + JSON parser
│           ├── anthropic.ts # Claude vision impl + cost tracking
│           └── openai.ts    # GPT vision impl + cost tracking
├── views/
│   ├── partials/{header,footer}.ejs   # Sidebar layout
│   ├── dashboard.ejs
│   ├── builder.ejs
│   ├── settings.ejs
│   └── run_detail.ejs
├── public/
│   ├── css/styles.css
│   ├── js/{dashboard,builder,settings,run_detail}.js
│   └── screenshots/         # All captured screenshots, kept indefinitely (audit trail)
├── data/ops_monitor.db      # SQLite (created on first run)
├── .env / .env.example
├── package.json
├── tsconfig.json
└── README.md / CONTEXT.md
```

### Multi-provider details

- **System default chain:** A workflow set to "system default" tries `AI_PROVIDER_PRIMARY` first; if it throws (network error, 4xx/5xx, malformed JSON), it automatically retries with `AI_PROVIDER_FALLBACK`.
- **Per-workflow override:** Set a workflow's AI provider to "Anthropic only" or "OpenAI only" to lock it to one provider — no fallback.
- **Run records track:** `ai_provider_used`, `ai_model_used`, `ai_cost_cents` (estimated from token counts), and `ai_fallback_notes` (which provider failed first, if any).
- **Cost estimation:** uses approximate per-million-token prices baked into each provider file. Update the price tables in `src/worker/providers/anthropic.ts` and `openai.ts` if pricing changes.

### Security model

- API keys live in `.env` only. Never committed (`.gitignore` excludes `.env`). Never displayed in the UI — Settings page shows a key hint like `sk-ant-…xxxx` for confirmation only.
- Workflow login credentials are encrypted with AES-256-GCM before being stored in SQLite. The encryption key itself lives in `.env`.
- No authentication on the web UI yet — single-operator POC. Bind to `127.0.0.1` and don't expose externally.

### Wait-and-confirm flow

When a run finishes the first pass:

- Every rule passes → status `ok`.
- A rule fails AND has `wait_and_confirm: true` → status temporarily `pending_recheck`, worker sleeps for the longest configured `wait_minutes`, then re-runs the entire workflow. Final verdict comes from pass two.
- Failing rules without wait-and-confirm → alert immediately on the first pass.

### Notifications

`src/notifications.ts` defines a `Notifier` interface. Dashboard is the v1 sink. To add email/Teams/Slack later, implement the interface and call `registerNotifier(...)`. The runner already calls `notify(...)` on alerts and system errors.

---

## Troubleshooting

**`npm install` fails on `better-sqlite3` with `node-gyp` errors** → you're missing native build tools. On Windows: install Visual Studio Build Tools. On macOS: `xcode-select --install`. On Linux: `apt install python3 make g++`. Or swap to pure-JS sqlite3 (slower but no compile).

**`npm run playwright:install` fails** → try `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium` in `.env`.

**Browser window doesn't appear** → set `BROWSER_MODE=headed` in `.env` and restart.

**"All AI providers failed" error** → check Settings page. Both keys may be missing or invalid. Use the Test connection buttons.

**"401 Unauthorized" from Anthropic/OpenAI** → wrong key. Edit `.env`, restart.

**Selectors fail mid-run** → RabbitMQ Management's HTML lacks stable test ids. The selectors in `src/worker/browser.ts` use multiple fallbacks, but if your version is different, edit the selector lists in `applyFilter()` and `ensureColumns()`.

---

## What's intentionally NOT in v1

- No multi-user accounts or auth.
- No external alert channels (email, Teams, Slack) — Notifier interface is in place for future addition.
- No screenshot retention policy — everything is kept on disk.
- No Angular frontend yet — the current EJS + vanilla JS frontend ships fast and looks great. Migration to Angular is planned for v2 once the team takes ownership; the JSON API is already Angular-ready.
