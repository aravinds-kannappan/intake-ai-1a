/*
 * content.js — bridges the side panel to the agent core running in the page's
 * content-script world. The panel sends {type:'run', ir}; the agent streams
 * progress/log events back and blocks on 'ask' round-trips (the human gate).
 */
(function () {
  'use strict';
  let running = false;
  let controller = {};
  const pendingAsks = new Map();
  let askSeq = 0;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'ping') {
      sendResponse({ ok: true, running });
      return;
    }
    if (msg.type === 'stop') {
      if (controller.stop) controller.stop();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'resolveAsk') {
      const resolver = pendingAsks.get(msg.askId);
      if (resolver) {
        pendingAsks.delete(msg.askId);
        resolver(msg.resolution || {});
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'run') {
      if (running) { sendResponse({ ok: false, error: 'already running' }); return; }
      running = true;
      controller = {};
      const send = (payload) => chrome.runtime.sendMessage(payload).catch(() => {});
      window.IntakeAgent.orchestrator
        .run(msg.ir, {
          doc: document,
          controller,
          onLog: (entry) => send({ type: 'agentLog', entry }),
          onProgress: (p) => send({ type: 'agentProgress', stage: p.stage, detail: p.detail, report: p.report }),
          ask: (item) =>
            new Promise((resolve) => {
              const askId = 'ask' + ++askSeq;
              pendingAsks.set(askId, resolve);
              send({ type: 'agentAsk', askId, item: { ...item, meta: item.meta || null } });
            }),
        })
        .then((result) => send({ type: 'agentDone', result }))
        .catch((err) => send({ type: 'agentDone', result: { error: String((err && err.message) || err) } }))
        .finally(() => { running = false; });
      sendResponse({ ok: true });
      return;
    }
  });
})();
