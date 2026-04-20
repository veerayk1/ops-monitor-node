/* Run detail — render screenshot(s), verdict, rule results, extracted data, AI cost.
 *
 * Security: All user-sourced values pass through the esc() function which performs
 * HTML entity encoding (&, <, >, ") before insertion into the DOM, preventing XSS.
 * This is the standard pattern used throughout this application for rendering
 * server-provided data that originates from AI extraction and workflow configuration. */
(() => {
  const STATUS_LABELS = {
    ok: 'healthy', alert: 'alert', system_error: 'system error',
    pending_recheck: 'rechecking', running: 'running',
  };
  const esc = (s) => String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const fmtAbs = (iso) => {
    if (!iso) return '—';
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(iso);
    return new Date(hasTz ? iso : iso + 'Z').toLocaleString();
  };
  const fmtCost = (cents) => {
    if (cents === null || cents === undefined) return '—';
    if (cents < 1) return `${cents.toFixed(2)}¢`;
    return `$${(cents / 100).toFixed(3)}`;
  };

  function safeScreenshotSrc(path) {
    if (!path || path.includes('..') || path.startsWith('/')) return null;
    return `/static/${path}`;
  }

  apiFetch(`/api/runs/${window.RUN_ID}`)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((run) => {
      document.getElementById('run-summary').textContent = run.summary || 'No summary available.';

      const statusEl = document.getElementById('run-status');
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.status = run.status;
      badge.style.fontSize = '13px';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.className = 'badge-label';
      label.textContent = STATUS_LABELS[run.status] || run.status;
      badge.appendChild(dot);
      badge.appendChild(label);
      statusEl.textContent = '';
      statusEl.appendChild(badge);

      const screenshotSrc = safeScreenshotSrc(run.screenshot_path);
      if (screenshotSrc) {
        const img = document.getElementById('run-screenshot');
        img.src = screenshotSrc;
        img.onerror = () => { img.style.display = 'none'; };
        document.getElementById('run-screenshot-ts').textContent = fmtAbs(run.started_at);
      }
      const recheckSrc = safeScreenshotSrc(run.recheck_screenshot_path);
      if (recheckSrc) {
        document.getElementById('recheck-frame').style.display = '';
        const recheckImg = document.getElementById('recheck-screenshot');
        recheckImg.src = recheckSrc;
        recheckImg.onerror = () => { recheckImg.style.display = 'none'; };
        document.getElementById('recheck-screenshot-ts').textContent = fmtAbs(run.finished_at);
      }

      let fallbackNotes = [];
      if (run.ai_fallback_notes) {
        try {
          const parsed = JSON.parse(run.ai_fallback_notes);
          if (Array.isArray(parsed)) fallbackNotes = parsed;
        } catch { /* ignore malformed JSON */ }
      }

      const meta = document.getElementById('run-meta');
      const metaRows = [
        ['Started', fmtAbs(run.started_at)],
        ['Finished', fmtAbs(run.finished_at)],
        ['Status', STATUS_LABELS[run.status] || run.status],
      ];
      if (run.ai_provider_used) {
        const provText = run.ai_model_used ? `${run.ai_provider_used} (${run.ai_model_used})` : run.ai_provider_used;
        metaRows.push(['AI provider', provText]);
      }
      if (run.ai_cost_cents !== null) metaRows.push(['AI cost', fmtCost(run.ai_cost_cents)]);
      if (fallbackNotes.length) {
        metaRows.push(['Fallback', fallbackNotes.map(f => `${f.provider || '?'}: ${f.error || '?'}`).join(' → ')]);
      }
      if (run.error_message) metaRows.push(['Error', run.error_message]);

      meta.textContent = '';
      metaRows.forEach(([lbl, value]) => {
        const row = document.createElement('div');
        row.className = 'detail-row';
        const dt = document.createElement('dt');
        dt.textContent = lbl;
        const dd = document.createElement('dd');
        dd.textContent = value;
        if (lbl === 'AI cost') dd.className = 'mono';
        if (lbl === 'Fallback') dd.style.color = 'var(--warn)';
        if (lbl === 'Error') dd.style.color = 'var(--alert)';
        row.appendChild(dt);
        row.appendChild(dd);
        meta.appendChild(row);
      });

      const rules = document.getElementById('rule-results');
      if (run.rule_results && run.rule_results.length) {
        run.rule_results.forEach(r => {
          const wrapper = document.createElement('div');
          wrapper.className = `rule-result ${r.passed ? 'passed' : 'failed'}`;
          const icon = document.createElement('span');
          icon.className = 'icon';
          icon.textContent = r.passed ? '\u2713' : '!';
          const content = document.createElement('div');
          const desc = document.createElement('div');
          desc.className = 'desc';
          desc.textContent = r.description;
          const msg = document.createElement('div');
          msg.className = 'msg';
          msg.textContent = r.message;
          content.appendChild(desc);
          content.appendChild(msg);
          wrapper.appendChild(icon);
          wrapper.appendChild(content);
          rules.appendChild(wrapper);
        });
      } else {
        const reason = run.status === 'system_error' ? 'Error prevented rule evaluation.' : 'No rules were evaluated.';
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--fg-muted);font-size:13px;';
        p.textContent = reason;
        rules.appendChild(p);
      }

      const ed = document.getElementById('extracted-data');
      if (run.extracted && run.extracted.queues && run.extracted.queues.length) {
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'font-family:var(--font-mono); font-size:12px; color:var(--fg-faint);';
        headerDiv.textContent = `row_count: ${run.extracted.row_count ?? '—'} · filter: "${run.extracted.filter_text_visible || ''}"`;
        ed.appendChild(headerDiv);

        const table = document.createElement('table');
        table.className = 'queue-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['Name','Kind','Type','Consumers','Ready','Unacked','State'].forEach((h, i) => {
          const th = document.createElement('th');
          th.textContent = h;
          if (i >= 3 && i <= 5) th.className = 'num';
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        run.extracted.queues.forEach(q => {
          const tr = document.createElement('tr');
          const isDlq = (q.name || '').toLowerCase().endsWith('.dlq');
          const cells = [
            q.name || '?',
            null, // pill
            q.type || '—',
            String(q.consumer_count ?? '—'),
            String(q.ready_messages ?? '—'),
            String(q.unacked_messages ?? '—'),
            q.state || '—',
          ];
          cells.forEach((val, i) => {
            const td = document.createElement('td');
            if (i === 1) {
              const pill = document.createElement('span');
              pill.className = `pill ${isDlq ? 'dlq' : 'primary'}`;
              pill.textContent = isDlq ? 'DLQ' : 'primary';
              td.appendChild(pill);
            } else {
              td.textContent = val;
              if (i >= 3 && i <= 5) td.className = 'num';
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        ed.appendChild(table);
      } else {
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--fg-muted);font-size:13px;';
        p.textContent = 'No data was extracted.';
        ed.appendChild(p);
      }
    }).catch(err => {
      document.getElementById('run-summary').textContent = 'Failed to load run.';
      console.error(err);
    });
})();
