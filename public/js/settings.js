/* Settings — render provider configuration with editable fields and test buttons. */
(() => {
  const body = document.getElementById('settings-body');

  function createField(label, id, type, value, placeholder, hint) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const lbl = document.createElement('label');
    lbl.setAttribute('for', id);
    lbl.textContent = label;
    wrapper.appendChild(lbl);
    const input = document.createElement('input');
    input.id = id;
    input.type = type || 'text';
    input.className = 'mono';
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    wrapper.appendChild(input);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'hint';
      h.textContent = hint;
      wrapper.appendChild(h);
    }
    return wrapper;
  }

  function createSelect(label, id, options, selected) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const lbl = document.createElement('label');
    lbl.setAttribute('for', id);
    lbl.textContent = label;
    wrapper.appendChild(lbl);
    const sel = document.createElement('select');
    sel.id = id;
    options.forEach(([val, text]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      if (val === selected) opt.selected = true;
      sel.appendChild(opt);
    });
    wrapper.appendChild(sel);
    return wrapper;
  }

  apiFetch('/api/settings')
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((s) => {
      body.textContent = '';
      const grid = document.createElement('div');
      grid.className = 'settings-grid';

      // ── AI Providers Section ──────────────────────────────────
      const aiSection = document.createElement('div');
      aiSection.className = 'settings-section';

      const aiH2 = document.createElement('h2');
      aiH2.textContent = 'AI Providers';
      aiSection.appendChild(aiH2);

      const aiSub = document.createElement('p');
      aiSub.className = 'sub';
      aiSub.textContent = 'Configure your AI provider API keys and models. Changes take effect immediately — no restart needed.';
      aiSection.appendChild(aiSub);

      // OpenAI card
      const openaiCard = document.createElement('div');
      openaiCard.className = 'provider-card';
      const openaiTitle = document.createElement('h3');
      openaiTitle.textContent = 'OpenAI — GPT';
      openaiCard.appendChild(openaiTitle);

      const openaiStatus = document.createElement('div');
      openaiStatus.style.cssText = 'margin-bottom:12px;';
      const openaiDot = document.createElement('span');
      openaiDot.className = 'badge';
      openaiDot.dataset.status = s.providers.openai.configured ? 'ok' : 'never';
      const d1 = document.createElement('span');
      d1.className = 'dot';
      const l1 = document.createElement('span');
      l1.className = 'badge-label';
      l1.textContent = s.providers.openai.configured ? 'configured' : 'not configured';
      openaiDot.appendChild(d1);
      openaiDot.appendChild(l1);
      openaiStatus.appendChild(openaiDot);
      openaiCard.appendChild(openaiStatus);

      openaiCard.appendChild(createField(
        'API Key', 'f-openai-key', 'password',
        '', s.providers.openai.key_hint || 'sk-…',
        s.providers.openai.configured ? 'Leave blank to keep current key' : 'Paste your OpenAI API key'
      ));
      openaiCard.appendChild(createField(
        'Model', 'f-openai-model', 'text',
        s.providers.openai.model, 'gpt-4o',
        null
      ));

      const openaiActions = document.createElement('div');
      openaiActions.className = 'provider-actions';
      openaiActions.style.marginTop = '12px';
      const testOpenai = document.createElement('button');
      testOpenai.className = 'btn';
      testOpenai.textContent = 'Test connection';
      testOpenai.dataset.test = 'openai';
      openaiActions.appendChild(testOpenai);
      openaiCard.appendChild(openaiActions);
      aiSection.appendChild(openaiCard);

      // Anthropic card
      const anthropicCard = document.createElement('div');
      anthropicCard.className = 'provider-card';
      const anthropicTitle = document.createElement('h3');
      anthropicTitle.textContent = 'Anthropic — Claude';
      anthropicCard.appendChild(anthropicTitle);

      const anthropicStatus = document.createElement('div');
      anthropicStatus.style.cssText = 'margin-bottom:12px;';
      const anthropicDot = document.createElement('span');
      anthropicDot.className = 'badge';
      anthropicDot.dataset.status = s.providers.anthropic.configured ? 'ok' : 'never';
      const d2 = document.createElement('span');
      d2.className = 'dot';
      const l2 = document.createElement('span');
      l2.className = 'badge-label';
      l2.textContent = s.providers.anthropic.configured ? 'configured' : 'not configured';
      anthropicDot.appendChild(d2);
      anthropicDot.appendChild(l2);
      anthropicStatus.appendChild(anthropicDot);
      anthropicCard.appendChild(anthropicStatus);

      anthropicCard.appendChild(createField(
        'API Key', 'f-anthropic-key', 'password',
        '', s.providers.anthropic.key_hint || 'sk-ant-…',
        s.providers.anthropic.configured ? 'Leave blank to keep current key' : 'Paste your Anthropic API key'
      ));
      anthropicCard.appendChild(createField(
        'Model', 'f-anthropic-model', 'text',
        s.providers.anthropic.model, 'claude-opus-4-5',
        null
      ));

      const anthropicActions = document.createElement('div');
      anthropicActions.className = 'provider-actions';
      anthropicActions.style.marginTop = '12px';
      const testAnthropic = document.createElement('button');
      testAnthropic.className = 'btn';
      testAnthropic.textContent = 'Test connection';
      testAnthropic.dataset.test = 'anthropic';
      anthropicActions.appendChild(testAnthropic);
      anthropicCard.appendChild(anthropicActions);
      aiSection.appendChild(anthropicCard);

      // Provider chain
      const chainCard = document.createElement('div');
      chainCard.className = 'provider-card';
      const chainH4 = document.createElement('h3');
      chainH4.textContent = 'Provider Chain';
      chainCard.appendChild(chainH4);

      const chainRow = document.createElement('div');
      chainRow.className = 'field-row';
      chainRow.style.cssText = 'display:flex;gap:16px;';

      chainRow.appendChild(createSelect('Primary provider', 'f-primary', [
        ['openai', 'OpenAI'],
        ['anthropic', 'Anthropic'],
      ], s.primary));

      chainRow.appendChild(createSelect('Fallback provider', 'f-fallback', [
        ['', 'None (fail hard)'],
        ['openai', 'OpenAI'],
        ['anthropic', 'Anthropic'],
      ], s.fallback || ''));

      chainCard.appendChild(chainRow);

      const chainHint = document.createElement('span');
      chainHint.className = 'hint';
      chainHint.textContent = 'If the primary fails (network, rate limit), the system automatically tries the fallback.';
      chainCard.appendChild(chainHint);
      aiSection.appendChild(chainCard);

      grid.appendChild(aiSection);

      // ── Browser & Scheduler Section ──────────────────────────
      const sysSection = document.createElement('div');
      sysSection.className = 'settings-section';

      const sysH2 = document.createElement('h2');
      sysH2.textContent = 'Browser & Scheduler';
      sysSection.appendChild(sysH2);

      const browserCard = document.createElement('div');
      browserCard.className = 'provider-card';
      const browserTitle = document.createElement('h3');
      browserTitle.textContent = 'Browser Automation';
      browserCard.appendChild(browserTitle);

      const browserRow = document.createElement('div');
      browserRow.className = 'field-row';
      browserRow.style.cssText = 'display:flex;gap:16px;';

      browserRow.appendChild(createSelect('Mode', 'f-browser-mode', [
        ['headed', 'Headed (visible)'],
        ['headless', 'Headless (invisible)'],
      ], s.browser.mode));

      browserRow.appendChild(createSelect('Browser', 'f-browser-channel', [
        ['chromium', 'Chromium'],
        ['msedge', 'Microsoft Edge'],
      ], s.browser.channel));

      browserCard.appendChild(browserRow);

      const browserHint = document.createElement('span');
      browserHint.className = 'hint';
      browserHint.textContent = '"Headed" shows the browser window during runs — great for demos. "Headless" runs silently.';
      browserCard.appendChild(browserHint);
      sysSection.appendChild(browserCard);

      const schedCard = document.createElement('div');
      schedCard.className = 'provider-card';
      const schedTitle = document.createElement('h3');
      schedTitle.textContent = 'Scheduler';
      schedCard.appendChild(schedTitle);
      schedCard.appendChild(createField(
        'Timezone', 'f-scheduler-tz', 'text',
        s.scheduler.timezone === 'system default' ? '' : s.scheduler.timezone,
        'e.g. America/Toronto',
        'IANA timezone name. Leave blank to use system default.'
      ));
      sysSection.appendChild(schedCard);

      grid.appendChild(sysSection);
      body.appendChild(grid);

      // ── Save bar ──────────────────────────────────────────────
      const saveBar = document.createElement('div');
      saveBar.className = 'save-bar';
      saveBar.style.cssText = 'margin-top:24px;';

      const saveInfo = document.createElement('span');
      saveInfo.className = 'info';
      saveInfo.textContent = 'Changes are saved to .env and take effect immediately.';
      saveBar.appendChild(saveInfo);

      const saveActions = document.createElement('div');
      saveActions.className = 'actions';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn btn-primary';
      saveBtn.textContent = 'Save settings';
      saveBtn.id = 'save-settings-btn';
      saveActions.appendChild(saveBtn);
      saveBar.appendChild(saveActions);
      body.appendChild(saveBar);

      // ── Shared save logic ────────────────────────────────────────
      async function saveAllSettings() {
        const payload = {};
        const openaiKey = document.getElementById('f-openai-key').value.trim();
        const anthropicKey = document.getElementById('f-anthropic-key').value.trim();
        if (openaiKey) payload.openai_api_key = openaiKey;
        if (anthropicKey) payload.anthropic_api_key = anthropicKey;

        payload.openai_model = document.getElementById('f-openai-model').value.trim();
        payload.anthropic_model = document.getElementById('f-anthropic-model').value.trim();
        payload.primary = document.getElementById('f-primary').value;
        payload.fallback = document.getElementById('f-fallback').value;
        payload.browser_mode = document.getElementById('f-browser-mode').value;
        payload.browser_channel = document.getElementById('f-browser-channel').value;
        payload.scheduler_tz = document.getElementById('f-scheduler-tz').value.trim();

        const r = await apiFetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!data.ok) throw new Error(data.error || 'Save failed');
        return data;
      }

      // ── Save handler ──────────────────────────────────────────
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving\u2026';
        try {
          const data = await saveAllSettings();
          showToast(data.message || 'Settings saved', 'success');
          setTimeout(() => location.reload(), 800);
        } catch (err) {
          showToast('Save failed: ' + err.message, 'error');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save settings';
        }
      });

      // ── Test connection handlers ──────────────────────────────
      // Auto-saves any entered keys first, then tests the connection
      body.querySelectorAll('[data-test]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const provider = btn.getAttribute('data-test');
          btn.disabled = true;
          const orig = btn.textContent;

          // Check if there's a new key typed in — save it first
          const keyField = document.getElementById(provider === 'openai' ? 'f-openai-key' : 'f-anthropic-key');
          const hasNewKey = keyField && keyField.value.trim();

          try {
            if (hasNewKey) {
              btn.textContent = 'Saving key\u2026';
              await saveAllSettings();
              showToast('Settings saved', 'success');
            }

            btn.textContent = 'Testing\u2026';
            const r = await apiFetch(`/api/settings/test/${provider}`, { method: 'POST' });
            const data = await r.json();
            if (data && data.ok) {
              showToast(typeof data.message === 'string' ? data.message : 'Connection successful', 'success');
              // Reload to update status badges
              setTimeout(() => location.reload(), 1200);
            } else {
              showToast(typeof data.error === 'string' ? data.error : 'Test failed', 'error');
            }
          } catch (e) {
            showToast('Test failed: ' + e.message, 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = orig;
          }
        });
      });
    })
    .catch(err => {
      body.textContent = '';
      const errP = document.createElement('p');
      errP.style.color = 'var(--alert)';
      errP.textContent = 'Failed to load settings: ' + err.message;
      body.appendChild(errP);
    });
})();
