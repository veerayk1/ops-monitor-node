/* Dashboard — fetches workflows, renders rich cards with step-flow visualization. */
(() => {
  const list = document.getElementById('workflow-list');
  const eyebrow = document.getElementById('dash-count');

  const STATUS_LABELS = {
    ok: 'healthy', alert: 'alert', system_error: 'system error',
    pending_recheck: 'rechecking', running: 'running', never: 'never run',
  };

  const _toDate = (iso) => {
    if (!iso) return null;
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
    return new Date(hasTz ? iso : iso + 'Z');
  };
  const fmtRel = (iso) => {
    const d = _toDate(iso); if (!d) return '—';
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return `${Math.floor(s)}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return d.toLocaleDateString();
  };
  const fmtAbs = (iso) => {
    const d = _toDate(iso); if (!d) return '—';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtCost = (cents) => {
    if (cents === null || cents === undefined) return '—';
    if (cents < 1) return `${(cents).toFixed(2)}¢`;
    return `$${(cents / 100).toFixed(3)}`;
  };
  // All user-sourced values pass through esc() before being placed in markup,
  // preventing XSS. This is the application's HTML-entity encoding layer.
  const esc = (s) => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

  /** Build the step-flow visualization for a workflow's configured steps. */
  function renderSteps(job) {
    const steps = [];
    let n = 1;
    const u = new URL(job.url);

    if (job.source_type === 'rabbitmq_api') {
      steps.push({ n: n++, label: 'GET /api/queues', detail: u.host });
      steps.push({ n: n++, label: 'Basic auth', detail: job.username });
      if (job.steps?.filter_text) {
        steps.push({ n: n++, label: 'Filter', detail: `name ⊃ "${job.steps.filter_text}"` });
      }
      const expectsRows = job.steps?.expected_row_count;
      steps.push({ n: n++, label: 'Parse JSON', detail: expectsRows ? `expect ${expectsRows} rows` : 'queue list' });
      steps.push({ n: n++, label: 'Apply rules', detail: `${job.rules.length} rule${job.rules.length === 1 ? '' : 's'}` });
    } else {
      steps.push({ n: n++, label: 'Open URL', detail: u.host });
      steps.push({ n: n++, label: 'Login', detail: job.username });
      if (job.steps?.filter_text) {
        steps.push({ n: n++, label: 'Filter', detail: `"${job.steps.filter_text}"` });
      }
      if (job.steps?.ensure_columns?.length) {
        steps.push({ n: n++, label: 'Show columns', detail: job.steps.ensure_columns.join(', ') });
      }
      const expectsRows = job.steps?.expected_row_count;
      steps.push({ n: n++, label: 'Screenshot', detail: expectsRows ? `expect ${expectsRows} rows` : 'capture page' });
      const provLabel = job.ai_provider === 'system'
        ? 'AI extract'
        : (job.ai_provider === 'anthropic' ? 'Claude extract' : 'GPT extract');
      steps.push({ n: n++, label: provLabel, detail: 'queue data' });
      steps.push({ n: n++, label: 'Apply rules', detail: `${job.rules.length} rule${job.rules.length === 1 ? '' : 's'}` });
    }

    const html = steps.map((s, i) => {
      const stepHtml = `
        <div class="step">
          <div class="step-num">${s.n}</div>
          <div class="step-label">${esc(s.label)}</div>
          <div class="step-detail">${esc(s.detail)}</div>
        </div>`;
      const lineHtml = i < steps.length - 1 ? '<div class="step-line"></div>' : '';
      return stepHtml + lineHtml;
    }).join('');
    return `
      <div class="flow-wrap">
        <div class="flow-label">Workflow steps</div>
        <div class="flow" tabindex="0" role="region" aria-label="Workflow steps">${html}</div>
      </div>`;
  }

  function renderRules(rules, lastRuleResults) {
    const resultsById = new Map((lastRuleResults || []).map(r => [r.id, r]));
    return `
      <div class="wf-block">
        <h4>Health rules · ${rules.length}</h4>
        ${rules.map(r => {
          const opSym = ({'>=':'≥','<=':'≤','==':'=','!=':'≠','>':'>','<':'<'})[r.operator] || r.operator;
          const res = resultsById.get(r.id);
          let observedHtml = '';
          if (res) {
            const o = res.observed || {};
            let valTxt = '—';
            if (typeof o.value === 'number') {
              valTxt = String(o.value);
            } else if (typeof o.min === 'number' && typeof o.max === 'number') {
              valTxt = o.min === o.max ? String(o.min) : `${o.min}–${o.max}`;
            } else if (typeof o.queues === 'number' && o.queues === 0) {
              valTxt = 'no queues';
            }
            const tone = res.passed ? 'ok' : 'alert';
            const icon = res.passed ? '✓' : '!';
            observedHtml = `<span class="rule-observed ${tone}" title="${esc(res.message || '')}">observed ${esc(valTxt)} ${icon}</span>`;
          }
          return `<div class="rule-row">
            <span class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/></svg></span>
            <span>${esc(r.description)}</span>
            ${observedHtml}
            <code>${opSym} ${r.threshold}</code>
          </div>`;
        }).join('')}
      </div>`;
  }

  function renderMeta(job, nextRunAt) {
    const cadence = describeCron(job.schedule_cron);
    const waitCount = job.rules.filter(r => r.wait_and_confirm).length;
    return `
      <div class="wf-block">
        <h4>Schedule &amp; AI</h4>
        <div class="meta-rows">
          <div><div class="meta-l">Cron</div><div class="meta-v mono">${esc(job.schedule_cron)}</div></div>
          <div><div class="meta-l">Cadence</div><div class="meta-v">${cadence}</div></div>
          <div><div class="meta-l">Last run</div><div class="meta-v">${fmtRel(job.last_run_at)}</div></div>
          <div><div class="meta-l">Next run</div><div class="meta-v">${fmtAbs(nextRunAt)}</div></div>
          <div><div class="meta-l">Wait &amp; confirm</div><div class="meta-v">${waitCount} of ${job.rules.length} rule${job.rules.length === 1 ? '' : 's'}</div></div>
          <div><div class="meta-l">AI provider</div><div class="meta-v">${providerLabel(job.ai_provider)}</div></div>
          ${job.last_provider ? `<div><div class="meta-l">Last by</div><div class="meta-v">${esc(job.last_provider)}</div></div>` : ''}
          ${job.last_cost_cents !== null ? `<div><div class="meta-l">Last cost</div><div class="meta-v mono">${fmtCost(job.last_cost_cents)}</div></div>` : ''}
        </div>
      </div>`;
  }

  function providerLabel(v) {
    if (v === 'anthropic') return 'Anthropic only';
    if (v === 'openai')    return 'OpenAI only';
    return 'System default';
  }

  function describeCron(c) {
    const parts = (c || '').trim().split(/\s+/);
    if (parts.length !== 5) return 'Custom';
    const [m, h, dom, mon, dow] = parts;
    if (m === '0' && h === '9-18' && dom === '*' && mon === '*' && dow === '1-5') return 'Hourly, 9 AM–6 PM, weekdays';
    if (m === '0' && h === '*'    && dom === '*' && mon === '*' && dow === '*')   return 'Hourly, every day';
    return 'Custom schedule';
  }

  /** Compact strip showing the last ~20 runs as colored dots so a glance proves
   *  there have been recent successful checks (not just a stale "healthy" badge). */
  function renderRunStrip(recentRuns) {
    if (!recentRuns || !recentRuns.length) {
      return `
        <div class="run-strip">
          <div class="run-strip-label">Recent runs</div>
          <div class="run-strip-dots"><span class="run-strip-empty">No runs yet</span></div>
        </div>`;
    }
    // Newest first from the API — render oldest-left → newest-right for readability
    const ordered = recentRuns.slice().reverse();
    const dots = ordered.map(r => {
      const cls = `run-dot run-dot-${esc(r.status)}`;
      const label = `${STATUS_LABELS[r.status] || r.status} · ${fmtAbs(r.started_at)}${r.summary ? ' — ' + r.summary : ''}`;
      return `<a href="/runs/${r.id}" class="${cls}" title="${esc(label)}" aria-label="${esc(label)}"></a>`;
    }).join('');
    const passed = recentRuns.filter(r => r.status === 'ok').length;
    return `
      <div class="run-strip">
        <div class="run-strip-label">Recent runs <span class="run-strip-count">${passed}/${recentRuns.length} healthy</span></div>
        <div class="run-strip-dots">${dots}</div>
      </div>`;
  }

  /** A run is "stale" when the scheduler should have produced a new one by now
   *  but didn't — proves the difference between "healthy=last run passed" and
   *  "healthy=scheduler stopped firing 3 days ago". */
  function staleWarning(job, nextRunAt) {
    if (!job.last_run_at || !nextRunAt) return '';
    const next = _toDate(nextRunAt);
    if (!next) return '';
    const overdueMs = Date.now() - next.getTime();
    const graceMs = 5 * 60 * 1000; // 5 min grace for cron jitter
    if (overdueMs <= graceMs) return '';
    const overdueText = overdueMs > 3600_000
      ? `${Math.floor(overdueMs / 3600_000)}h overdue`
      : `${Math.floor(overdueMs / 60_000)}m overdue`;
    return `<div class="wf-info" style="color:var(--warn);background:var(--warn-dim);border-color:var(--warn-ring);">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      No run since scheduled time (${overdueText}). Scheduler may have stopped — investigate before trusting the "healthy" badge.
    </div>`;
  }

  function renderEmptyHistory(job) {
    if (job.last_run_at) {
      const isOk = job.last_status === 'ok';
      const isErr = job.last_status === 'system_error';
      const color = isOk ? 'var(--ok)' : isErr ? 'var(--warn)' : 'var(--alert)';
      const dim   = isOk ? 'var(--ok-dim)' : isErr ? 'var(--warn-dim)' : 'var(--alert-dim)';
      const ring  = isOk ? 'var(--ok-ring)' : isErr ? 'var(--warn-ring)' : 'var(--alert-ring)';
      return `<div class="wf-info" style="color:${color};background:${dim};border-color:${ring};">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>
        ${esc(job.last_summary || 'Run completed.')}
      </div>`;
    }
    return `<div class="wf-info">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      Hasn't run yet — click "Run now" to capture the first screenshot, or wait for the next scheduled run.
    </div>`;
  }

  function renderCard(job, nextRunAt, recentRuns) {
    const status = job.last_status || 'never';
    const statusLabel = STATUS_LABELS[status] || status;
    const card = document.createElement('div');
    card.className = 'wf reveal';
    card.dataset.status = status;
    card.dataset.jobId = job.id;

    // All dynamic values are escaped via esc() to prevent XSS
    card.innerHTML = `
      <div class="wf-bar"></div>
      <div class="wf-head">
        <div>
          <h3 class="wf-name">${esc(job.name)}</h3>
          <div class="wf-url">${esc(job.url)}${esc(job.steps?.page_path || '')}</div>
        </div>
        <span class="badge" data-status="${esc(status)}"><span class="dot"></span><span class="badge-label">${esc(statusLabel)}</span></span>
      </div>

      ${renderSteps(job)}

      ${renderRunStrip(recentRuns)}

      <div class="wf-body">
        ${renderRules(job.rules, job.last_rule_results)}
        ${renderMeta(job, nextRunAt)}
      </div>

      ${staleWarning(job, nextRunAt)}
      ${renderEmptyHistory(job)}

      <div class="wf-foot">
        <button class="btn" data-act="run" aria-label="Run workflow now">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Run now
        </button>
        <button class="btn btn-ghost" data-act="history">View history</button>
        <a class="btn btn-ghost" href="/builder/${job.id}" style="margin-left:auto;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </a>
      </div>

      <div class="wf-history" data-history-wrap style="display:none;"></div>
    `;

    card.querySelector('[data-act="run"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Running…';
      try {
        const r = await apiFetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
        if (!r.ok) throw new Error(await r.text());
        showToast(`Run triggered for "${job.name}"`, 'success');
        setTimeout(loadAll, 2000);
      } catch (err) {
        showToast(`Failed to trigger run: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run now';
      }
    });

    card.querySelector('[data-act="history"]').addEventListener('click', async () => {
      const wrap = card.querySelector('[data-history-wrap]');
      const open = wrap.style.display !== 'none';
      wrap.style.display = open ? 'none' : 'block';
      if (!open) {
        try {
          const res = await apiFetch(`/api/runs/job/${job.id}?limit=20`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!data.runs || !data.runs.length) {
            wrap.innerHTML = '<div class="wf-info" style="margin: 0;">No runs in history yet.</div>';
          } else {
            // All dynamic values are entity-escaped via esc()
            wrap.innerHTML = data.runs.map(run => `
              <a href="/runs/${run.id}" class="hist-row">
                <span class="ts">${fmtAbs(run.started_at)}</span>
                <span class="badge" data-status="${esc(run.status)}"><span class="dot"></span><span class="badge-label">${esc(STATUS_LABELS[run.status] || run.status)}</span></span>
                <span class="summary">${esc(run.summary || '—')}</span>
                <span class="ts mono">${run.ai_cost_cents !== null ? fmtCost(run.ai_cost_cents) : ''}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;color:var(--fg-faint);"><path d="M9 18l6-6-6-6"/></svg>
              </a>
            `).join('');
          }
        } catch (err) {
          wrap.textContent = '';
          const errDiv = document.createElement('div');
          errDiv.className = 'wf-info';
          errDiv.style.cssText = 'margin:0;color:var(--alert);';
          errDiv.textContent = 'Failed to load history: ' + err.message;
          wrap.appendChild(errDiv);
        }
      }
    });

    return card;
  }

  let isLoading = false;
  async function loadAll() {
    if (isLoading) return;
    isLoading = true;
    try {
      const res = await apiFetch('/api/jobs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const jobs = await res.json();
      if (!Array.isArray(jobs)) throw new Error('Unexpected response format');

      eyebrow.textContent = `Dashboard · ${jobs.length} workflow${jobs.length === 1 ? '' : 's'}`;
      list.innerHTML = '';

      if (!jobs.length) {
        list.innerHTML = `
          <div class="empty">
            <h3>No workflows yet</h3>
            <p>Create your first monitoring workflow to start watching what matters.</p>
            <a href="/builder" class="btn btn-primary" style="margin-top:16px;">Create a workflow</a>
          </div>`;
        return;
      }

      const results = await Promise.all(jobs.map(async (j) => {
        try {
          const r = await apiFetch(`/api/runs/job/${j.id}?limit=20`);
          if (!r.ok) return { job: j, nextRunAt: null, recentRuns: [] };
          const data = await r.json();
          return { job: j, nextRunAt: data.next_run_at, recentRuns: data.runs || [] };
        } catch {
          return { job: j, nextRunAt: null, recentRuns: [] };
        }
      }));
      results.forEach(({ job, nextRunAt, recentRuns }) => list.appendChild(renderCard(job, nextRunAt, recentRuns)));
    } catch (err) {
      list.textContent = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'empty';
      const h3 = document.createElement('h3');
      h3.textContent = "Couldn't load workflows";
      const p = document.createElement('p');
      p.textContent = err.message;
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => location.reload());
      errDiv.appendChild(h3);
      errDiv.appendChild(p);
      errDiv.appendChild(retryBtn);
      list.appendChild(errDiv);
    } finally {
      isLoading = false;
    }
  }

  loadAll();
  setInterval(loadAll, 30_000);
})();
