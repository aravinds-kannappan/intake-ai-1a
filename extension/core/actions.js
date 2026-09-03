/*
 * actions.js — the agent's hands.
 *
 * Every action re-queries the DOM at act time (platforms re-render freely and
 * node identity is worthless), performs the interaction with synthetic events
 * a framework-bound page will hear, then waits for the document to settle.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});

  /**
   * Timer-free delay. Background tabs clamp setTimeout to >= 1s, which would
   * stretch a run from minutes to an hour the moment the tab loses focus;
   * MessageChannel tasks are not throttled that way.
   */
  function delay(ms) {
    return new Promise((resolveWait) => {
      const start = performance.now();
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (performance.now() - start >= ms) resolveWait();
        else channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
    });
  }

  /** Wait until DOM mutations go quiet (or a hard timeout). */
  async function settle(doc, quietMs = 50, maxMs = 1200) {
    const start = performance.now();
    let lastMutation = start;
    const observer = new MutationObserver(() => { lastMutation = performance.now(); });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    for (;;) {
      await delay(10);
      const now = performance.now();
      if (now - lastMutation >= quietMs || now - start >= maxMs) break;
    }
    observer.disconnect();
  }

  function fire(el, type, EventCtor = Event) {
    el.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true }));
  }

  async function click(doc, el) {
    el.scrollIntoView({ block: 'center' });
    const win = doc.defaultView;
    const opts = { bubbles: true, cancelable: true, view: win };
    el.dispatchEvent(new win.MouseEvent('pointerdown', opts));
    el.dispatchEvent(new win.MouseEvent('mousedown', opts));
    el.dispatchEvent(new win.MouseEvent('pointerup', opts));
    el.dispatchEvent(new win.MouseEvent('mouseup', opts));
    el.click();
    await settle(doc);
  }

  async function setText(doc, el, text) {
    el.scrollIntoView({ block: 'center' });
    el.focus();

    // Handle contenteditable elements
    if (el.getAttribute('contenteditable') != null) {
      el.textContent = String(text);
      fire(el, 'input', doc.defaultView.Event);
      fire(el, 'change', doc.defaultView.Event);
      el.blur();
      await settle(doc);
      return;
    }

    const proto = el.tagName === 'TEXTAREA'
      ? doc.defaultView.HTMLTextAreaElement.prototype
      : doc.defaultView.HTMLInputElement.prototype;
    // Use the native setter so framework value tracking (React et al) notices.
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, String(text));
    } else {
      el.value = String(text);
    }
    fire(el, 'input', doc.defaultView.Event);
    fire(el, 'change', doc.defaultView.Event);
    el.blur();
    await settle(doc);
  }

  async function setCheckbox(doc, el, checked) {
    if (!!el.checked !== !!checked) {
      el.scrollIntoView({ block: 'center' });
      el.click();
      // Some platforms only listen to change, not click.
      if (!!el.checked !== !!checked) {
        el.checked = !!checked;
        fire(el, 'change', doc.defaultView.Event);
      }
      await settle(doc);
    }
  }

  /** Select the option whose text or value matches; returns the option text or null. */
  async function selectOption(doc, el, wanted) {
    const eq = NS.lexicon.equalsNormalized;

    // Native <select>
    if (el.tagName === 'SELECT') {
      let target = [...el.options].find((o) => eq(o.textContent, wanted)) ||
        [...el.options].find((o) => eq(o.value, wanted));
      // Fuzzy fallback for approximate matches
      if (!target && NS.lexicon.similarity) {
        const fuzzy = [...el.options]
          .map((o) => ({ o, sim: Math.max(NS.lexicon.similarity(o.textContent, wanted), NS.lexicon.similarity(o.value, wanted)) }))
          .filter((x) => x.sim >= 0.7)
          .sort((a, b) => b.sim - a.sim);
        if (fuzzy.length > 0) target = fuzzy[0].o;
      }
      if (!target) return null;
      el.scrollIntoView({ block: 'center' });
      el.value = target.value;
      fire(el, 'change', doc.defaultView.Event);
      await settle(doc);
      return target.textContent.trim();
    }

    // Custom select (role=combobox/listbox): click to open, then click the option
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'listbox') {
      await click(doc, el);
      await settle(doc, 50, 500);
      const opts = doc.querySelectorAll('[role="option"]');
      for (const opt of opts) {
        if (eq(opt.textContent, wanted) || eq(opt.getAttribute('data-value'), wanted)) {
          await click(doc, opt);
          return opt.textContent.trim();
        }
      }
      return null;
    }

    return null;
  }

  NS.actions = { settle, click, setText, setCheckbox, selectOption, delay };
})();
