/*
 * snapshot.js — perception.
 *
 * Reads a Document into a list of affordances (things the agent could act on)
 * plus the visible text, using only universal signals: tag semantics, ARIA
 * roles, accessible names, and containment. No platform CSS classes, ids, or
 * label strings are consulted here.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden]')) return false;
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    if (!win) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function directText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent;
    }
    return out.trim();
  }

  /** Accessible-name computation, simplified but honest about priority. */
  function accName(el) {
    const doc = el.ownerDocument;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map((id) => {
        const ref = doc.getElementById(id);
        return ref ? ref.textContent.trim() : '';
      });
      const joined = parts.join(' ').trim();
      if (joined) return joined;
    }
    if (el.id) {
      const forLabel = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel && forLabel.textContent.trim()) return forLabel.textContent.trim();
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) {
      const t = wrap.textContent.trim();
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'BUTTON' || el.getAttribute('role') === 'button' || tag === 'A' || el.getAttribute('role') === 'tab') {
      const t = el.textContent.trim();
      if (t) return t;
    }
    if (el.placeholder) return String(el.placeholder).trim();
    if (el.title) return String(el.title).trim();
    if (tag === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) return el.value.trim();
    return '';
  }

  /** Nearest heading / legend / dialog title that scopes this element. */
  function context(el) {
    const bits = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.tagName === 'FIELDSET') {
        const legend = node.querySelector(':scope > legend');
        if (legend) bits.push(legend.textContent.trim());
      }
      if (node.tagName === 'ASIDE' || node.tagName === 'SECTION' || node.tagName === 'NAV' ||
          node.getAttribute('role') === 'dialog' || node.tagName === 'TABLE' || node.tagName === 'FORM' ||
          node.tagName === 'HEADER' || node.tagName === 'MAIN' || node.tagName === 'DIV') {
        // First heading inside this container, if it precedes our element.
        const heading = node.querySelector('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
        if (heading && heading.textContent.trim() &&
            (heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          bits.push(heading.textContent.trim());
        }
        const ariaLabel = node.getAttribute && node.getAttribute('aria-label');
        if (ariaLabel) bits.push(ariaLabel);
      }
      // Stop widening once we hit a dialog boundary; a modal is its own world.
      if (node.getAttribute && node.getAttribute('aria-modal') === 'true') break;
      node = node.parentElement;
    }
    // Dedup while keeping inner-first order.
    return [...new Set(bits)];
  }

  function kindOf(el) {
    const tag = el.tagName;
    const role = el.getAttribute('role');
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit') return 'button';
      return 'textbox';
    }
    if (tag === 'BUTTON' || role === 'button' || role === 'tab' || role === 'menuitem') return 'button';
    if (tag === 'A') return 'button';
    if (role === 'checkbox') return 'checkbox';
    if (role === 'combobox' || role === 'listbox') return 'select';
    if (role === 'textbox') return 'textbox';
    return null;
  }

  const SELECTOR = 'button, a, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="combobox"], [role="listbox"], [role="textbox"]';

  /** Take a full snapshot of the document's actionable surface. */
  function snapshot(doc) {
    const affordances = [];
    const nodes = doc.querySelectorAll(SELECTOR);
    let i = 0;
    for (const el of nodes) {
      const kind = kindOf(el);
      if (!kind) continue;
      if (!isVisible(el)) continue;
      const explicitLabel = !!(
        (el.id && doc.querySelector('label[for="' + CSS.escape(el.id) + '"]')) ||
        (el.closest && el.closest('label'))
      );
      const aff = {
        el,
        kind,
        explicitLabel,
        name: accName(el),
        text: kind === 'button' ? el.textContent.trim() : '',
        value: 'value' in el ? String(el.value) : '',
        checked: 'checked' in el ? !!el.checked : undefined,
        inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : null,
        placeholder: el.placeholder ? String(el.placeholder) : '',
        options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })) : null,
        disabled: !!el.disabled,
        context: context(el),
        inModal: !!el.closest('[aria-modal="true"], [role="dialog"], dialog'),
        index: i++,
      };
      aff.signature = aff.kind + '|' + aff.name + '|' + aff.context.join('>');
      affordances.push(aff);
    }
    return { doc, affordances, takenAt: Date.now() };
  }

  /** Affordances present in `after` whose signature was absent from `before`. */
  function appeared(before, after) {
    const seen = new Map();
    for (const a of before.affordances) seen.set(a.signature, (seen.get(a.signature) || 0) + 1);
    const out = [];
    for (const a of after.affordances) {
      const n = seen.get(a.signature) || 0;
      if (n > 0) seen.set(a.signature, n - 1);
      else out.push(a);
    }
    return out;
  }

  /** All visible elements whose own text equals `text` exactly (normalized). */
  function findExactText(doc, text) {
    const eq = NS.lexicon.equalsNormalized;
    const out = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (!isVisible(node)) continue;
      const dt = directText(node);
      if (dt && eq(dt, text)) out.push(node);
    }
    return out;
  }

  /** Live status / alert messages currently on screen (toasts, notices). */
  function statusMessages(doc) {
    const out = [];
    for (const el of doc.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) {
      if (isVisible(el) && el.textContent.trim()) out.push(el.textContent.trim());
    }
    return out;
  }

  /**
   * Re-resolve a previously seen affordance descriptor against the current
   * DOM. Descriptors survive re-renders that destroy node identity.
   */
  function resolve(doc, desc) {
    const snap = snapshot(doc);
    const matches = snap.affordances.filter(
      (a) => a.kind === desc.kind && NS.lexicon.equalsNormalized(a.name, desc.name),
    );
    if (matches.length === 0) return null;
    if (desc.nth != null && matches[desc.nth]) return matches[desc.nth];
    return matches[0];
  }

  function describe(aff) {
    return { kind: aff.kind, name: aff.name, nth: null };
  }

  NS.snapshot = { snapshot, appeared, findExactText, statusMessages, resolve, describe, isVisible, accName, directText };
})();
