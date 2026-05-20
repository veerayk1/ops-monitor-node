/* Job Builder — load existing workflow, add/remove rules, save.
 * Note: The only innerHTML usage is ruleList.innerHTML = '' which is safe (clearing). */
(() => {
  const form = document.getElementById('job-form');
  const ruleList = document.getElementById('rule-list');
  const titleEl = document.getElementById('builder-title');
  const deleteBtn = document.getElementById('delete-btn');
  const runNowBtn = document.getElementById('run-now-btn');
  const ruleTpl = document.getElementById('rule-template');
  let ruleCounter = 0;
  let listenersAttached = false;
  // Round-trip the workflow's source_type so editing/saving doesn't revert
  // a rabbitmq_api workflow back to 'browser' (the schema default).
  let loadedSourceType = 'browser';

  window.addRule = (rule) => {
    ruleCounter += 1;
    const node = ruleTpl.content.firstElementChild.cloneNode(true);
    node.dataset.ruleId = rule?.id || `r${ruleCounter}`;
    if (rule) {
      node.querySelector('[data-field="description"]').value = rule.description || '';
      node.querySelector('[data-field="target"]').value     = rule.target || 'primary';
      node.querySelector('[data-field="metric"]').value     = rule.metric || 'consumer_count';
      node.querySelector('[data-field="operator"]').value   = rule.operator || '>=';
      node.querySelector('[data-field="threshold"]').value  = rule.threshold ?? 1;
      node.querySelector('[data-field="wait_and_confirm"]').checked = !!rule.wait_and_confirm;
      node.querySelector('[data-field="wait_minutes"]').value = rule.wait_minutes ?? 5;
    }
    ruleList.appendChild(node);
  };

  const collectRules = () => {
    const rules = [];
    ruleList.querySelectorAll('[data-rule]').forEach((card, i) => {
      rules.push({
        id: card.dataset.ruleId || `r${i + 1}`,
        description: card.querySelector('[data-field="description"]').value,
        target:      card.querySelector('[data-field="target"]').value,
        metric:      card.querySelector('[data-field="metric"]').value,
        operator:    card.querySelector('[data-field="operator"]').value,
        threshold:   parseFloat(card.querySelector('[data-field="threshold"]').value),
        wait_and_confirm: card.querySelector('[data-field="wait_and_confirm"]').checked,
        wait_minutes:     parseInt(card.querySelector('[data-field="wait_minutes"]').value, 10) || 5,
      });
    });
    return rules;
  };

  const populate = (job) => {
    titleEl.textContent = `Edit: ${job.name}`;
    document.getElementById('f-name').value     = job.name;
    document.getElementById('f-url').value      = job.url;
    document.getElementById('f-username').value = job.username;
    document.getElementById('f-password').value = '';
    document.getElementById('f-password').placeholder = job.has_password ? '(unchanged — leave blank to keep)' : '';
    document.getElementById('f-password').required = !job.has_password;
    document.getElementById('f-page-path').value = job.steps.page_path || '/#/queues';
    document.getElementById('f-filter').value    = job.steps.filter_text || '';
    document.getElementById('f-columns').value   = (job.steps.ensure_columns || []).join(', ');
    document.getElementById('f-expected-count').value = job.steps.expected_row_count ?? '';
    document.getElementById('f-cron').value      = job.schedule_cron;
    document.getElementById('f-enabled').checked = job.enabled;
    document.getElementById('f-ai-provider').value = job.ai_provider || 'system';
    loadedSourceType = job.source_type || 'browser';

    // Safe: only clearing child nodes
    while (ruleList.firstChild) ruleList.removeChild(ruleList.firstChild);
    (job.rules || []).forEach((r) => addRule(r));

    deleteBtn.style.display = '';
    runNowBtn.style.display = '';

    // Only attach listeners once to prevent stacking
    if (!listenersAttached) {
      listenersAttached = true;

      runNowBtn.addEventListener('click', async () => {
        runNowBtn.disabled = true;
        runNowBtn.textContent = 'Triggering…';
        try {
          const r = await apiFetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
          if (!r.ok) throw new Error(await r.text());
          showToast('Run triggered. Returning to dashboard…', 'success');
          setTimeout(() => location.href = '/', 800);
        } catch (err) {
          showToast(`Failed to trigger run: ${err.message}`, 'error');
        } finally {
          runNowBtn.disabled = false;
          runNowBtn.textContent = 'Run now';
        }
      });

      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${job.name}" and all its run history?`)) return;
        try {
          const r = await apiFetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
          if (r.ok) location.href = '/'; else showToast('Delete failed', 'error');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      });
    }
  };

  const buildPayload = () => {
    const cols = document.getElementById('f-columns').value
      .split(',').map(s => s.trim()).filter(Boolean);
    const expectedCountRaw = document.getElementById('f-expected-count').value;
    const expectedCount = expectedCountRaw === '' ? null : parseInt(expectedCountRaw, 10);

    const rules = collectRules();
    if (expectedCount !== null && !isNaN(expectedCount)) {
      const idx = rules.findIndex(r => r.metric === 'row_count' && r.operator === '==');
      const auto = {
        id: 'auto_row_count', description: `Filter must show exactly ${expectedCount} rows`,
        target: 'all', metric: 'row_count', operator: '==', threshold: expectedCount,
        wait_and_confirm: false, wait_minutes: 5,
      };
      if (idx === -1) rules.push(auto); else rules[idx] = { ...rules[idx], threshold: expectedCount, description: auto.description };
    }

    return {
      name: document.getElementById('f-name').value,
      url:  document.getElementById('f-url').value,
      username: document.getElementById('f-username').value,
      password: document.getElementById('f-password').value,
      steps: {
        filter_text: document.getElementById('f-filter').value || null,
        ensure_columns: cols,
        expected_row_count: expectedCount,
        page_path: document.getElementById('f-page-path').value || '/#/queues',
      },
      rules,
      schedule_cron: document.getElementById('f-cron').value,
      enabled: document.getElementById('f-enabled').checked,
      ai_provider: document.getElementById('f-ai-provider').value || 'system',
      source_type: loadedSourceType,
    };
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Validate cron expression before submitting
    const cronVal = document.getElementById('f-cron').value.trim();
    const cronParts = cronVal.split(/\s+/);
    if (cronParts.length !== 5) {
      showToast('Invalid cron expression — needs 5 fields: minute hour day month weekday', 'error');
      return;
    }

    const payload = buildPayload();
    const url = window.JOB_ID ? `/api/jobs/${window.JOB_ID}` : '/api/jobs';
    const method = window.JOB_ID ? 'PUT' : 'POST';
    try {
      const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (r.ok) {
        showToast('Workflow saved', 'success');
        setTimeout(() => location.href = '/', 600);
      } else {
        const txt = await r.text();
        showToast(`Save failed: ${txt}`, 'error');
      }
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    }
  });

  // Live cron description
  const cronInput = document.getElementById('f-cron');
  const cronHint = document.getElementById('cron-hint');
  cronInput.addEventListener('input', () => {
    const parts = (cronInput.value || '').trim().split(/\s+/);
    if (parts.length !== 5) { cronHint.textContent = 'Invalid cron — needs 5 fields: minute hour day month weekday'; return; }
    const [m, h] = parts;
    const md = m === '*' ? 'every minute' : (m === '0' ? 'top of the hour' : `at minute ${m}`);
    const hd = h === '*' ? 'every hour' : `hours ${h}`;
    cronHint.textContent = `${md}, ${hd}`;
  });

  if (window.JOB_ID) {
    apiFetch(`/api/jobs/${window.JOB_ID}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(populate)
      .catch(err => showToast(`Failed to load workflow: ${err.message}`, 'error'));
  } else {
    addRule({
      description: 'Primary queues must have at least 1 consumer',
      target: 'primary', metric: 'consumer_count', operator: '>=',
      threshold: 1, wait_and_confirm: true, wait_minutes: 5,
    });
  }
})();
