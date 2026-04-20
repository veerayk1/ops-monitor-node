# Project Context — Ops Monitor POC (Node + multi-provider)

> Read this first if you're a new AI assistant or developer picking up the project.

---

## The mission

Build a POC that demonstrates an **agentic, browser-driven monitoring system** for repetitive operational checks. The user is doing this to prove value to their manager. If the POC succeeds, it becomes a real project that scales to a team.

**Demo deadline:** ASAP (within the week).

---

## Hard constraints — DO NOT violate these

1. **Browser-only access.** No direct API calls to monitored systems. Even if a monitored system has a perfectly good REST API on the same port with the same credentials (e.g. RabbitMQ Management API on port 15672), it cannot be used. **This is a policy/security constraint, not a technical one.** The user was very clear and was frustrated when challenged on it. Everything must happen through the actual browser UI.

2. **Regulated environment.** The work computer where this eventually runs is locked down. The user is NOT an admin, but can clone GitHub repos and run things in an IDE.

3. **Open source preferred for code.** Paid AI APIs (Claude/OpenAI) are acceptable.

4. **Microsoft Edge specifically.** Not Chrome, not Firefox. Use Playwright with `channel: 'msedge'`.

5. **Internal hostnames only.** The actual target (`canldsaav01d:15672`) is only reachable from inside the corporate network. End-to-end testing must happen on the work machine.

6. **Work hours only.** The work computer is on only during work hours. No 24/7 scheduling.

7. **No Python on the work machine.** Has Node 20.19.6, npm 10.8.2, Java, and Angular CLI 9.1.5 (very old). The original Python build was rewritten to Node for this reason.

8. **GitHub private repo.** User wants to push to a private GitHub repo. Maximum security. Keys must NEVER be in code, NEVER committed.

---

## The first workflow (RabbitMQ blueYonder)

This is the **single concrete workflow** captured during requirements. The system supports many more like it through a configurable Job Builder.

### Manual steps the user does today

1. Open Microsoft Edge
2. Navigate to `http://canldsaav01d:15672/#/queues`
3. Enter username + password (test creds in seed.ts — should be rotated)
4. Click Login
5. Navigate to the **Queues** tab
6. Type `blueyonder` in the **Filter** input
7. **If the Consumers column isn't visible:** click `+/-` at top-right of the table → check **"Consumer count"** (note the panel labels it "Consumer count", but the column header says "Consumers")
8. Wait for the table to settle
9. Look at the queues — there should be exactly 6 (3 primary + 3 DLQ):
   - blueYonder.inbound.invoice + .dlq
   - blueYonder.inbound.orderNotification + .dlq
   - blueYonder.inbound.receiptNotification + .dlq
10. Apply the rules to decide if anything's wrong

### The rules

| # | Target | Metric | Rule | Wait-and-confirm? |
|---|---|---|---|---|
| 1 | Primary queues | Consumer count | Must be ≥ 1 (alert if 0). Per user: "anything 1+ is fine" — only 0 is the problem. | Yes, 5 min |
| 2 | Primary queues | Ready messages | Must be ≤ 50 | Yes, 5 min |
| 3 | DLQ queues | Ready messages | Must be ≤ 10 | No (alert immediately) |
| 4 | All | Row count | Must equal exactly 6 | No |

### IMPORTANT: The wait-and-confirm pattern

The user explained this with an analogy: "If you check at 9 AM and see 100 messages when there shouldn't be that many, **don't immediately throw an alert**. Wait a few minutes — those messages might just have arrived in a normal burst. Re-check after the wait. If it's still bad, THEN alert."

Per-rule toggle. Implementation: when any rule fails on the first pass AND has wait_and_confirm enabled, the worker sleeps `wait_minutes`, re-runs the entire workflow, re-extracts, re-evaluates. Final verdict comes from the second pass. The first screenshot is kept as evidence of the initial detection.

---

## Multi-provider AI architecture

The user wanted "an intelligent system, not a dumb one." Both Anthropic (Claude) AND OpenAI (GPT) keys can be configured simultaneously.

### How it works

- **Two providers** wired in: `src/worker/providers/anthropic.ts` and `src/worker/providers/openai.ts`. Both implement the `VisionProvider` interface in `providers/types.ts`.
- **Dispatcher** in `src/worker/evaluator.ts` calls them based on the configured chain.
- **System default chain:** Try `AI_PROVIDER_PRIMARY` first; if it throws (network error, 4xx/5xx, malformed JSON), retry with `AI_PROVIDER_FALLBACK`.
- **Per-workflow override:** Set a workflow's `ai_provider` to `"anthropic"` or `"openai"` to lock it to one provider with no fallback. Default `"system"` uses the system chain.
- **Cost tracking:** Each provider returns `inputTokens`, `outputTokens`, and a `estimatedCostCents` based on baked-in pricing tables. Stored on the `runs` row.
- **Fallback notes:** If the primary failed, the run record stores `ai_fallback_notes` JSON with the error from each failed provider.
- **When BOTH providers fail:** Run is marked `system_error`, surfaced loudly on the dashboard, but the schedule keeps running (next slot tries again). No auto-disabling — that surprises users.

### Adding a new provider later

Drop a new file in `src/worker/providers/` implementing `VisionProvider`. Register it in `src/worker/evaluator.ts`'s `PROVIDERS` map. Add its name to the `ProviderName` union in `src/config.ts`. That's it.

---

## Security model (user pushed for max security)

- API keys live in `.env` only. `.gitignore` excludes `.env`. Never in code, never in DB, never displayed in UI (Settings page shows masked hint like `sk-ant-…xxxx`).
- Workflow credentials (the username/password used to log into monitored sites) are AES-256-GCM encrypted in SQLite. Encryption key auto-generated on first run, written to `.env`.
- **If the encryption key is lost,** all stored credentials become unreadable. Document this for whoever inherits the project.
- No web UI auth yet — single-operator POC. App binds to `127.0.0.1` by default; do NOT expose externally without adding auth.

---

## Stack decisions and why

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript on Node 20 | Work machine has Node, not Python. Aligns with team's eventual Angular migration. |
| HTTP framework | Express | Battle-tested, minimal. |
| Browser library | Playwright (not Puppeteer) | Reliable auto-waiting, official Edge channel support. |
| AI evaluation | **Provider abstraction with fallback.** AI extracts structured data only; rules applied deterministically in TS. | Numeric rules shouldn't depend on AI judgment. |
| Storage | better-sqlite3 + filesystem | Zero-setup. Synchronous API = cleaner code. |
| Scheduling | node-cron with optional `SCHEDULER_TZ` | In-process, no daemon. |
| Validation | Zod | Runtime type safety + great TS inference. |
| Notifications | Pluggable Notifier interface, dashboard-only for v1 | Email/Teams/Slack later. |
| Credentials | AES-256-GCM via Node `crypto`, key auto-gen to `.env` | Good enough for POC. Vault later. |
| Frontend | Server-rendered EJS + vanilla JS + Geist + custom CSS | No build step. Ships fast. **Angular migration is v2.** |
| Browser mode | Headed by default | Manager watches the browser drive itself in the demo. Toggle to headless for prod. |
| Screenshot retention | Keep all forever | Audit trail. Cleanup is a v2 concern. |
| Layout | Left sidebar nav (Dashboard / Settings / + New workflow) | User explicitly requested this. |
| Workflow card | Step-flow visualization at the top showing the actual configured steps | User explicitly requested. |

---

## What's done

- ✅ Express + TypeScript backend with full CRUD APIs (jobs, runs, settings)
- ✅ better-sqlite3 schema with safe ALTER-TABLE migrations on boot
- ✅ AES-256-GCM credential encryption with auto-generated key
- ✅ Playwright browser workflow (login → filter → ensure columns → screenshot)
- ✅ Multi-provider AI: Anthropic + OpenAI, with primary/fallback chain
- ✅ Per-workflow AI provider override
- ✅ Cost tracking per run (token-based estimation)
- ✅ Rule engine (primary/DLQ/all targets, multiple operators)
- ✅ Wait-and-confirm logic in the runner
- ✅ node-cron with timezone support
- ✅ Dashboard UI: sidebar nav, workflow cards with step-flow visualization, rules summary, schedule info, history expansion
- ✅ Job Builder UI (4 sections including AI provider override)
- ✅ Settings page with key-presence indicator + Test Connection buttons
- ✅ Run detail page with screenshots, rule results, extracted data, AI cost, fallback notes
- ✅ Pre-seeded blueYonder workflow with all 4 rules
- ✅ Notifier protocol stub for future email/Teams/Slack
- ✅ TypeScript compiles cleanly (`tsc --noEmit` returns zero errors)
- ✅ Rule engine, crypto, provider routing all verified with smoke tests

---

## What's NOT done — TODO list

### High priority (needed for the actual demo to work end-to-end)

1. **Verify Playwright selectors against the live RabbitMQ Management UI.** The selectors in `src/worker/browser.ts` use multiple fallbacks because RabbitMQ Management lacks stable test ids. Until tested against the real `canldsaav01d:15672`, expect to tweak `applyFilter()`, `ensureColumns()`, and `waitForTableSettle()`.
2. **Test full happy path on work machine:** install, configure both AI keys in `.env`, click Run now, confirm browser drives, screenshot captured, AI extracts, dashboard updates with cost.
3. **Confirm `api.anthropic.com` AND `api.openai.com` are reachable** from the work computer. If one is blocked, the system will gracefully fall back to the other. If both are blocked, IT involvement needed.
4. **Rotate the seeded test password** in `src/seed.ts` before any real use.

### Medium priority

5. Better cron UX in the Builder (presets + visual time-picker).
6. Multi-select for "Columns to ensure visible" (currently comma-separated text).
7. Run detail timeline view: when `pending_recheck` happened, show both screenshots side-by-side with "waited N minutes" annotation.
8. Per-workflow latest run thumbnail on dashboard cards (high demo impact).
9. Live toast when a run completes while dashboard is open.
10. Aggregate cost view: "AI spend this month: $X.XX across N runs."

### Low priority / future expansion

11. **Email/Teams/Slack notifiers** — implement the `Notifier` interface.
12. **All Runs view** — cross-workflow run history (sidebar already has the link, currently no-op).
13. **Screenshot retention policy** — when compliance dictates, add a node-cron cleanup job.
14. **Multi-user accounts + auth** — when scaling beyond POC.
15. **Per-rule severity levels** (warn vs critical).
16. **Workflow templates** — clone an existing workflow as a starting point for a new one.
17. **v2: Angular frontend** — once the team takes ownership. The JSON API doesn't change; only views/ and public/js need to be replaced.
18. **Vault integration** — replace AES-Fernet with HashiCorp Vault or similar for production secret management.

### Things to be careful about when extending

- **Edit-then-save flow:** `JobInputSchema` requires `password` on every PUT. Builder JS currently asks for re-entry on edit. A "leave blank to keep existing" pattern would be friendlier.
- **node-cron timezone:** Set `SCHEDULER_TZ` in `.env` to override system TZ.
- **Encryption key in `.env`:** if lost or rotated, all stored credentials become unreadable. Document.
- **better-sqlite3 is synchronous** — fine for single-user POC, may need pooling at scale.
- **Playwright Edge channel:** depends on Edge being installed at OS level. Use `channel: 'chromium'` on a CI box.
- **AI pricing tables in `providers/*.ts`** — update if Anthropic/OpenAI pricing changes.

---

## Stack reference (versions in `package.json`)

- Node 20+
- Express 4.21
- TypeScript 5.6
- Playwright 1.48 (Edge channel)
- better-sqlite3 11.5
- node-cron 3.0
- @anthropic-ai/sdk 0.32
- openai 4.73
- Zod 3.23
- EJS 3.1
- tsx (dev runner)

Frontend: Geist + Geist Mono via Google Fonts CDN, custom CSS, vanilla JS — no build step.

---

## Conversation history quick-reference

- User's role: position where this monitoring is currently manual, repetitive
- POC for personal use → demo to manager → if successful, scales to a team
- Approximate run frequency: 10× per day during work hours (configurable per workflow)
- All workflows configurable through the Job Builder UI; no hardcoded jobs
- The user wants the UI to look like "a 5th grader can use this" + "Apple-quality design"
- Communication preference: don't ask user to make technical decisions; they're a business person, not technical. Use your expertise.
- Original build was Python; rewrote to Node when we discovered the work machine doesn't have Python
- User explicitly requested: left sidebar nav, NO dummy data on dashboard, step-by-step workflow visualization on workflow cards
- User explicitly requested: support both Anthropic AND OpenAI keys with fallback ("intelligent system, not a dumb one")
- User explicitly requested: maximum security since they'll push to a private GitHub repo
