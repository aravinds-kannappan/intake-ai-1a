/* panel.js — the reviewer's seat: load the IR, run, answer escalations. */
(function () {
  'use strict';
  let ir = null;
  let tabId = null;
  let lastResult = null;
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');

  function line(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    logEl.prepend(d);
    while (logEl.children.length > 600) logEl.lastChild.remove();
  }

  // ── input file ─────────────────────────────────────────────────────────────
  $('irFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      ir = JSON.parse(await file.text());
      const forms = ir.visits.reduce((n, v) => n + v.forms.length, 0);
      const fields = ir.visits.reduce((n, v) => n + v.forms.reduce((m, f) => m + f.fields.length, 0), 0);
      $('irSummary').textContent = (ir.study && (ir.study.protocol_id || ir.study.title) || 'study') +
        ': ' + ir.visits.length + ' visits, ' + forms + ' forms, ' + fields + ' fields.';
      $('run').disabled = false;
    } catch (err) {
      $('irSummary').textContent = 'Could not parse that file: ' + err.message;
      ir = null;
      $('run').disabled = true;
    }
  });

  // ── persisted Claude-assist settings ───────────────────────────────────────
  chrome.storage.local.get(['apiKey', 'model']).then((v) => {
    if (v.apiKey) $('apiKey').value = v.apiKey;
    if (v.model) $('model').value = v.model;
  });
  for (const id of ['apiKey', 'model']) {
    $(id).addEventListener('change', () => chrome.storage.local.set({ [id]: $(id).value }));
  }

  // ── run / stop ─────────────────────────────────────────────────────────────
  $('run').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    tabId = tab.id;
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    } catch (err) {
      $('status').textContent = 'The agent is not loaded in this tab. Reload the eSource tab once (the content script attaches on load), then run again.';
      return;
    }
    logEl.innerHTML = '';
    $('reportBox').hidden = true;
    $('run').disabled = true;
    $('stop').disabled = false;
    $('status').textContent = 'running…';
    const res = await chrome.tabs.sendMessage(tabId, { type: 'run', ir });
    if (!res || !res.ok) {
      $('status').textContent = 'Could not start: ' + ((res && res.error) || 'unknown');
      $('run').disabled = false;
      $('stop').disabled = true;
    }
  });

  $('stop').addEventListener('click', async () => {
    if (tabId != null) await chrome.tabs.sendMessage(tabId, { type: 'stop' }).catch(() => {});
    $('status').textContent = 'stop requested; finishing the current step…';
  });

  // ── agent events ───────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'agentLog') {
      const e = msg.entry;
      if (e.level !== 'action') line(e.level, e.level + '  ' + e.message + (e.irPath ? '   [' + e.irPath + ']' : ''));
      else line('action', e.message);
    }
    if (msg.type === 'agentProgress') {
      $('status').textContent = msg.stage + ': ' + msg.detail;
      renderCounters(msg.report);
    }
    if (msg.type === 'agentAsk') handleAsk(msg.askId, msg.item);
    if (msg.type === 'agentDone') {
      $('run').disabled = !ir;
      $('stop').disabled = true;
      $('gate').hidden = true;
      lastResult = msg.result;
      if (msg.result && msg.result.report) {
        renderCounters(msg.result.report);
        $('status').textContent = 'done in ' + Math.round(msg.result.report.durationMs / 1000) + 's' +
          (msg.result.report.aborted ? ' (ended early)' : '');
        $('reportBox').hidden = false;
        $('reportSummary').textContent = summarize(msg.result);
      } else {
        $('status').textContent = 'ended: ' + ((msg.result && msg.result.error) || 'unknown error');
      }
    }
  });

  function renderCounters(r) {
    if (!r) return;
    $('counters').innerHTML = '';
    const items = [
      ['Visits', r.visits.created + r.visits.existing + ' / ' + r.visits.total],
      ['Forms', r.forms.created + r.forms.existing + ' / ' + r.forms.total],
      ['Fields built', r.fields.built + ' / ' + r.fields.total],
      ['Skip rules', r.skipRules.set + ' / ' + r.skipRules.total],
      ['Audit clean', r.audit.formsClean + ' / ' + r.audit.formsAudited],
      ['Open issues', String(r.audit.issuesOpen)],
    ];
    for (const [k, v] of items) {
      const d = document.createElement('div');
      d.className = 'counter';
      d.innerHTML = '<b></b><span class="muted"></span>';
      d.querySelector('b').textContent = v;
      d.querySelector('span').textContent = k;
      $('counters').appendChild(d);
    }
  }

  function summarize(result) {
    const r = result.report;
    const bits = [
      'Duration: ' + Math.round(r.durationMs / 1000) + 's',
      'Visits: ' + (r.visits.created + r.visits.existing) + '/' + r.visits.total,
      'Forms: ' + (r.forms.created + r.forms.existing) + '/' + r.forms.total,
      'Fields built: ' + r.fields.built + '/' + r.fields.total,
      'Skip rules verified: ' + r.skipRules.set + '/' + r.skipRules.total,
      'Forms passing read-back audit: ' + r.audit.formsClean + '/' + r.audit.formsAudited,
      'Issues found ' + r.audit.issuesFound + ', fixed ' + r.audit.issuesFixed + ', open ' + r.audit.issuesOpen,
      'Escalations answered: ' + r.escalations.length,
      'Warnings: ' + r.warnings.length,
    ];
    if (result.calib && result.calib.typeMap) {
      bits.push('', 'Type map learned from this platform:');
      for (const [canonical, m] of Object.entries(result.calib.typeMap)) {
        bits.push('  ' + canonical + '  ->  "' + m.entry + '"  (confidence ' + Number(m.confidence).toFixed(2) + ')');
      }
      bits.push('Save control: "' + result.calib.saveControl + '" (verified by persistence probe)');
    }
    if (r.audit.openIssues.length) {
      bits.push('', 'Open issues:');
      for (const i of r.audit.openIssues.slice(0, 20)) bits.push('  ' + i.irPath + ': ' + i.kind + ' expected ' + JSON.stringify(i.expected) + ', got ' + JSON.stringify(i.actual));
    }
    if (r.warnings.length) {
      bits.push('', 'Warnings:');
      for (const w of r.warnings.slice(0, 20)) bits.push('  ' + w);
    }
    return bits.join('\n');
  }

  // ── the human gate ─────────────────────────────────────────────────────────
  async function handleAsk(askId, item) {
    // Optional Claude assist: only for mapping-style questions, and only when
    // the answer comes back clearly; everything else lands on the human.
    const key = $('apiKey').value.trim();
    if (key && (item.kind === 'type-mapping' || item.kind === 'confirm-mapping')) {
      try {
        const llm = await askClaude(key, $('model').value.trim() || 'claude-sonnet-5', item);
        if (llm && llm.confidence >= 0.8 && item.options.some((o) => o.id === llm.choice)) {
          line('escalate', 'gate: "' + item.question + '" answered by Claude: ' + llm.choice + ' (' + llm.confidence + ') — ' + llm.reason);
          chrome.tabs.sendMessage(tabId, { type: 'resolveAsk', askId, resolution: { optionId: llm.choice, by: 'claude' } });
          return;
        }
      } catch (err) {
        line('warn', 'Claude assist failed (' + err.message + '); asking you instead.');
      }
    }
    renderGate(askId, item, null);
  }

  function renderGate(askId, item, llmNote) {
    $('gate').hidden = false;
    const card = $('gateCard');
    card.innerHTML = '';
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = item.question;
    card.appendChild(q);
    if (item.irPath) {
      const p = document.createElement('div');
      p.className = 'evidence';
      p.textContent = item.irPath;
      card.appendChild(p);
    }
    if (item.evidence && item.evidence.length) {
      const ev = document.createElement('div');
      ev.className = 'evidence';
      ev.textContent = item.evidence.join('\n');
      card.appendChild(ev);
    }
    if (llmNote) {
      const n = document.createElement('div');
      n.className = 'llm-note';
      n.textContent = llmNote;
      card.appendChild(n);
    }
    for (const opt of item.options || []) {
      const b = document.createElement('button');
      b.innerHTML = '<span></span><div class="detail"></div>';
      b.querySelector('span').textContent = opt.label;
      if (opt.detail) b.querySelector('.detail').textContent = opt.detail;
      if (item.suggestion && opt.id === item.suggestion) b.querySelector('span').textContent += '  (suggested)';
      b.addEventListener('click', () => {
        $('gate').hidden = true;
        chrome.tabs.sendMessage(tabId, { type: 'resolveAsk', askId, resolution: { optionId: opt.id, by: 'human' } });
      });
      card.appendChild(b);
    }
  }

  async function askClaude(apiKey, model, item) {
    const prompt = [
      'You are helping map canonical clinical form field types onto an eSource platform\'s element palette.',
      'Question: ' + item.question,
      'Evidence:',
      ...(item.evidence || []).map((e) => '- ' + e),
      item.meta && item.meta.entries ? 'All palette entries with probe results:\n' + JSON.stringify(item.meta.entries, null, 1) : '',
      'Options (answer with the exact id):',
      ...(item.options || []).map((o) => '- id: ' + JSON.stringify(o.id) + (o.detail ? ' (' + o.detail + ')' : '')),
      'Reply with ONLY a JSON object: {"choice": "<option id>", "confidence": 0..1, "reason": "<one sentence>"}',
    ].join('\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error('API ' + res.status);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }

  // ── downloads ──────────────────────────────────────────────────────────────
  function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = name;
    a.click();
  }
  $('dlReport').addEventListener('click', () => lastResult && download('run-report.json', { report: lastResult.report, calib: lastResult.calib }));
  $('dlTrace').addEventListener('click', () => lastResult && download('run-trace.json', lastResult.trace));
})();
