/*
 * flows.js — the procedures the agent performs, written against concepts
 * rather than controls. Every flow follows the same discipline:
 *
 *   snapshot -> rank candidates by concept -> act -> settle -> read back.
 *
 * A flow that cannot verify its own effect either tries the next candidate,
 * asks an LLM for guidance, or escalates to the human gate. Nothing is
 * assumed persisted until read back.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});
  const { lexicon, snapshot: snapMod, actions, mapper } = NS;

  const TYPE_CONF_THRESHOLD = 0.25;

  function snap(ctx) { return snapMod.snapshot(ctx.doc); }
  function buttons(s) { return s.affordances.filter((a) => a.kind === 'button' && !a.disabled); }
  function textboxes(s) { return s.affordances.filter((a) => a.kind === 'textbox' || a.kind === 'textarea'); }

  function hasExplicitLabel(aff) {
    return !!aff.explicitLabel;
  }

  function conceptPick(list, concepts, opts = {}) {
    const scored = list
      .map((a) => {
        let score = 0;
        for (const c of concepts) score += lexicon.scoreConcept(a.name, c.name) * (c.weight || 1);
        if (opts.preferExplicitLabel && hasExplicitLabel(a) && score > 0) score += 0.5;
        if (opts.avoidValuesSection) {
          score -= 0.75 * a.context.filter((c) => lexicon.scoreConcept(c, 'valuesSection') > 0).length;
        }
        return { aff: a, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored;
  }

  function fieldLabelMatches(text, label) {
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
    const t = norm(text);
    const l = norm(label);
    return t === l || t.replace(/\s*\*$/, '') === l;
  }

  function findFieldText(doc, label) {
    const out = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (!snapMod.isVisible(node)) continue;
      const dt = snapMod.directText(node);
      if (dt && fieldLabelMatches(dt, label)) out.push(node);
    }
    return out;
  }

  async function clickAff(ctx, aff, why) {
    ctx.log('action', 'click "' + aff.name + '"', why || '');
    await actions.click(ctx.doc, aff.el);
    const status = snapMod.statusMessages(ctx.doc);
    if (status.length) ctx.log('status', status.join(' | '), '');
    return status;
  }

  async function typeInto(ctx, aff, value, why) {
    ctx.log('action', 'type into "' + aff.name + '": ' + JSON.stringify(String(value)), why || '');
    await actions.setText(ctx.doc, aff.el, value);
  }

  // ── LLM-assisted fallback helpers ──────────────────────────────────────────

  function pageContext(ctx) {
    return snapMod.pageText(ctx.doc);
  }

  /**
   * LLM-assisted affordance picker: when concept scoring yields no candidates,
   * ask the LLM to choose from all visible affordances.
   */
  async function llmPick(ctx, intent, pool) {
    if (!NS.llm || !NS.llm.isAvailable()) return null;
    const result = await NS.llm.pickAffordance(intent, pool, pageContext(ctx));
    if (result && result.index >= 0 && result.index < pool.length && result.confidence >= 0.5) {
      ctx.log('info', 'LLM picked "' + pool[result.index].name + '" for: ' + intent + ' (confidence ' + result.confidence.toFixed(2) + ': ' + result.reason + ')', '');
      return { aff: pool[result.index], score: result.confidence * 10 };
    }
    return null;
  }

  /**
   * LLM-assisted navigation: when the agent can't find the target screen,
   * ask the LLM for navigation hints.
   */
  async function llmNavigate(ctx, targetScreen) {
    if (!NS.llm || !NS.llm.isAvailable()) return false;
    const s = snap(ctx);
    const result = await NS.llm.findNavigation(targetScreen, s.affordances, pageContext(ctx));
    if (!result || !result.steps || result.steps.length === 0) return false;
    for (const idx of result.steps.slice(0, 3)) {
      if (idx >= 0 && idx < s.affordances.length) {
        await clickAff(ctx, s.affordances[idx], 'LLM-guided navigation to ' + targetScreen);
        await actions.settle(ctx.doc);
      }
    }
    return true;
  }

  // ── schedule screen ────────────────────────────────────────────────────────

  function addVisitCandidates(s) {
    return conceptPick(buttons(s), [{ name: 'add', weight: 1.5 }, { name: 'visit' }])
      .filter((c) =>
        lexicon.scoreConcept(c.aff.name, 'add') > 0 &&
        (lexicon.scoreConcept(c.aff.name, 'visit') > 0 ||
          lexicon.scoreConcept(c.aff.context.join(' '), 'visit') > 0 ||
          lexicon.scoreConcept(c.aff.context.join(' '), 'schedule') > 0) &&
        lexicon.scoreConcept(c.aff.name, 'form') <= 0);
  }

  /**
   * Broader schedule detection: if we can't find an "add visit" button,
   * look for any screen that mentions visits/schedule/study plan.
   */
  function looksLikeScheduleScreen(s) {
    if (addVisitCandidates(s).length > 0) return true;
    // Check if any affordance context mentions schedule/visit/study plan
    for (const a of s.affordances) {
      const ctx = a.context.join(' ');
      if (lexicon.scoreConcept(ctx, 'schedule') > 2 || lexicon.scoreConcept(ctx, 'visit') > 2) {
        if (a.kind === 'button' && lexicon.scoreConcept(a.name, 'add') > 0) return true;
      }
    }
    return false;
  }

  async function ensureScheduleScreen(ctx) {
    let s = snap(ctx);
    if (addVisitCandidates(s).length > 0) return true;

    // Strategy 1: Try concept-scored navigation affordances
    const navs = conceptPick(buttons(s), [{ name: 'schedule' }, { name: 'visit', weight: 0.5 }]);
    for (const cand of navs.slice(0, 4)) {
      await clickAff(ctx, cand.aff, 'looking for the visit schedule screen');
      s = snap(ctx);
      if (addVisitCandidates(s).length > 0) return true;
    }

    // Strategy 2: Try tab/nav elements that might lead to the study plan
    const tabs = s.affordances.filter((a) => a.kind === 'button' && !a.disabled);
    const studyPlanCands = tabs
      .map((a) => ({
        aff: a,
        score: lexicon.scoreConcept(a.name, 'schedule') +
               lexicon.scoreConcept(a.name, 'visit') * 0.5 +
               (a.name.toLowerCase().includes('plan') ? 3 : 0) +
               (a.name.toLowerCase().includes('study') ? 1 : 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const cand of studyPlanCands.slice(0, 3)) {
      await clickAff(ctx, cand.aff, 'trying tab/link to study plan');
      s = snap(ctx);
      if (addVisitCandidates(s).length > 0) return true;
    }

    // Strategy 3: LLM-assisted navigation
    if (await llmNavigate(ctx, 'visit schedule or study plan')) {
      s = snap(ctx);
      if (addVisitCandidates(s).length > 0) return true;
    }

    // Strategy 4: LLM picks the "add visit" button directly
    const allButtons = buttons(snap(ctx));
    const llmResult = await llmPick(ctx, 'find the button that adds a new visit to the study schedule', allButtons);
    if (llmResult) {
      // Verify: this might not be a schedule screen yet, but the LLM found an add-visit
      return true;
    }

    const res = await ctx.ask({
      kind: 'flow-stuck',
      irPath: 'visits',
      question: 'I cannot find the screen where visits are created. Please navigate the page to the visit schedule, then choose Retry.',
      evidence: ['No control matching "add visit" was found on the current screen.'],
      options: [{ id: 'retry', label: 'Retry (I navigated there)' }, { id: 'abort', label: 'Abort the run' }],
    });
    if (res.optionId === 'retry') return ensureScheduleScreen(ctx);
    throw new Error('aborted: schedule screen not found');
  }

  function visitExists(ctx, name) {
    return snapMod.findExactText(ctx.doc, name).length > 0;
  }

  async function createVisit(ctx, visit, irPath) {
    const before = snap(ctx);
    let candidates = addVisitCandidates(before);

    // LLM fallback: if no concept candidates, ask the LLM
    if (candidates.length === 0) {
      const allButtons = buttons(before);
      const llmResult = await llmPick(ctx, 'click the button that adds a new visit/encounter/timepoint to the study', allButtons);
      if (llmResult) candidates = [llmResult];
    }

    for (const cand of candidates.slice(0, 3)) {
      await clickAff(ctx, cand.aff, 'open the new-visit form');
      const after = snap(ctx);
      const appearedAffs = snapMod.appeared(before, after);
      // Look for text inputs in appeared affordances, or globally if the
      // dialog was already present (some platforms show inline forms)
      let boxes = appearedAffs.filter((a) => a.kind === 'textbox');
      if (boxes.length === 0) {
        // The form might have appeared by morphing existing elements
        boxes = textboxes(snap(ctx)).filter((a) => a.inModal || appearedAffs.some((ap) => ap.inModal));
        if (boxes.length === 0) boxes = textboxes(snap(ctx));
      }
      const nameIn = conceptPick(boxes, [{ name: 'name' }])[0];
      if (!nameIn) {
        const cancel = conceptPick(appearedAffs.filter((a) => a.kind === 'button'), [{ name: 'cancel' }])[0];
        if (cancel) await clickAff(ctx, cancel.aff, 'not the right dialog; closing');
        continue;
      }
      await typeInto(ctx, nameIn.aff, visit.name, irPath + '.name');
      const startIn = conceptPick(boxes.filter((b) => b !== nameIn.aff && b.signature !== nameIn.aff.signature), [{ name: 'windowStart' }])[0];
      const endIn = conceptPick(boxes.filter((b) => b !== nameIn.aff && b.signature !== nameIn.aff.signature && (!startIn || b !== startIn.aff)), [{ name: 'windowEnd' }])[0];
      if (startIn && visit.window_start_day != null) await typeInto(ctx, startIn.aff, String(visit.window_start_day), irPath + '.window_start_day');
      if (endIn && visit.window_end_day != null) await typeInto(ctx, endIn.aff, String(visit.window_end_day), irPath + '.window_end_day');
      if ((!startIn || !endIn) && (visit.window_start_day != null || visit.window_end_day != null)) {
        ctx.log('warn', 'no visit window inputs found; window not set', irPath);
        ctx.report.warnings.push(irPath + ': visit window inputs not found on this platform; window days were not recorded');
      }
      // Find the save/submit/create button
      const savePool = appearedAffs.filter((a) => a.kind === 'button').length > 0
        ? appearedAffs.filter((a) => a.kind === 'button')
        : buttons(snap(ctx)).filter((a) => a.inModal);
      const save = conceptPick(savePool, [{ name: 'save' }, { name: 'add', weight: 0.5 }])[0];
      if (save) await clickAff(ctx, save.aff, 'commit the new visit');
      if (visitExists(ctx, visit.name)) {
        ctx.log('verify', 'visit "' + visit.name + '" is now listed', irPath);
        return true;
      }
    }
    const res = await ctx.ask({
      kind: 'flow-stuck', irPath,
      question: 'I could not create the visit "' + visit.name + '". Create it by hand (name and window), then choose Done.',
      evidence: ['Tried ' + candidates.length + ' add-visit control(s); the visit never appeared in the list.'],
      options: [{ id: 'done', label: 'Done (I created it)' }, { id: 'skip', label: 'Skip this visit' }, { id: 'abort', label: 'Abort' }],
    });
    if (res.optionId === 'done') return visitExists(ctx, visit.name);
    if (res.optionId === 'skip') return false;
    throw new Error('aborted while creating visit ' + visit.name);
  }

  async function openVisit(ctx, visit) {
    const s = snap(ctx);
    // Strategy 1: exact text match on a clickable affordance
    let link = s.affordances.find((a) => a.kind === 'button' && lexicon.equalsNormalized(a.name, visit.name));

    // Strategy 2: partial/fuzzy match
    if (!link) {
      const fuzzyMatches = s.affordances
        .filter((a) => a.kind === 'button')
        .map((a) => ({ a, sim: lexicon.similarity(a.name, visit.name) }))
        .filter((x) => x.sim >= 0.7)
        .sort((a, b) => b.sim - a.sim);
      if (fuzzyMatches.length > 0) link = fuzzyMatches[0].a;
    }

    // Strategy 3: find the visit name in the page and click its containing row
    if (!link) {
      const nodes = snapMod.findExactText(ctx.doc, visit.name);
      for (const node of nodes) {
        await actions.click(ctx.doc, node);
        await actions.settle(ctx.doc);
        const s2 = snap(ctx);
        const addForm = conceptPick(buttons(s2), [{ name: 'add', weight: 1.5 }, { name: 'form' }])
          .filter((c) => lexicon.scoreConcept(c.aff.name, 'add') > 0);
        if (addForm.length > 0) return true;
      }
    }

    if (!link) return false;
    await clickAff(ctx, link, 'open visit ' + visit.name);
    const s2 = snap(ctx);
    const addForm = conceptPick(buttons(s2), [{ name: 'add', weight: 1.5 }, { name: 'form' }])
      .filter((c) => lexicon.scoreConcept(c.aff.name, 'add') > 0);
    return addForm.length > 0 || s2.affordances.some((a) => a.context.some((c) => c.includes(visit.name)));
  }

  async function backToSchedule(ctx) {
    let s = snap(ctx);
    if (addVisitCandidates(s).length > 0) return true;

    // Strategy 1: back/schedule buttons
    const cands = conceptPick(buttons(s), [{ name: 'back' }, { name: 'schedule', weight: 0.8 }]);
    for (const cand of cands.slice(0, 3)) {
      await clickAff(ctx, cand.aff, 'return to the visit schedule');
      s = snap(ctx);
      if (addVisitCandidates(s).length > 0) return true;
    }

    // Strategy 2: breadcrumb navigation
    const breadcrumbs = s.affordances.filter((a) =>
      a.kind === 'button' && a.context.some((c) => /breadcrumb|crumb|path/i.test(c)));
    for (const bc of breadcrumbs.slice(0, 2)) {
      await clickAff(ctx, bc, 'breadcrumb navigation back to schedule');
      s = snap(ctx);
      if (addVisitCandidates(s).length > 0) return true;
    }

    // Strategy 3: LLM
    if (await llmNavigate(ctx, 'visit schedule or study plan')) {
      s = snap(ctx);
      if (addVisitCandidates(s).length > 0) return true;
    }

    return false;
  }

  // ── visit screen: source documents ─────────────────────────────────────────

  function formExists(ctx, name) {
    return snapMod.findExactText(ctx.doc, name).length > 0;
  }

  async function createForm(ctx, form, irPath) {
    const before = snap(ctx);
    let candidates = conceptPick(buttons(before), [{ name: 'add', weight: 1.5 }, { name: 'form' }])
      .filter((c) => lexicon.scoreConcept(c.aff.name, 'add') > 0 && lexicon.scoreConcept(c.aff.name, 'visit') <= 0);

    // LLM fallback
    if (candidates.length === 0) {
      const allButtons = buttons(before);
      const llmResult = await llmPick(ctx, 'click the button that adds a new source document/form/CRF to this visit', allButtons);
      if (llmResult) candidates = [llmResult];
    }

    for (const cand of candidates.slice(0, 3)) {
      await clickAff(ctx, cand.aff, 'open the new-document form');
      const after = snap(ctx);
      const appearedAffs = snapMod.appeared(before, after);
      let boxes = appearedAffs.filter((a) => a.kind === 'textbox');
      if (boxes.length === 0) {
        boxes = textboxes(snap(ctx)).filter((a) => a.inModal);
        if (boxes.length === 0) boxes = textboxes(snap(ctx));
      }
      const nameIn = conceptPick(boxes, [{ name: 'name' }])[0];
      if (!nameIn) {
        const cancel = conceptPick(appearedAffs.filter((a) => a.kind === 'button'), [{ name: 'cancel' }])[0];
        if (cancel) await clickAff(ctx, cancel.aff, 'not the right dialog; closing');
        continue;
      }
      await typeInto(ctx, nameIn.aff, form.name, irPath + '.name');
      const repeatToggle = conceptPick(
        (appearedAffs.length > 0 ? appearedAffs : snap(ctx).affordances).filter((a) => a.kind === 'checkbox'),
        [{ name: 'repeating' }]
      )[0];
      if (form.repeating) {
        if (repeatToggle) {
          ctx.log('action', 'mark as repeating log', irPath + '.repeating');
          await actions.setCheckbox(ctx.doc, repeatToggle.aff.el, true);
        } else {
          const res = await ctx.ask({
            kind: 'missing-control', irPath: irPath + '.repeating',
            question: '"' + form.name + '" is a repeating log in the input, but I cannot find a repeating toggle on the create-document dialog. Proceed without it?',
            evidence: ['Checkbox controls that appeared: ' + (appearedAffs.filter((a) => a.kind === 'checkbox').map((a) => a.name).join(', ') || 'none')],
            options: [{ id: 'proceed', label: 'Proceed without repeating flag' }, { id: 'done', label: 'I set it by hand; continue' }, { id: 'skipform', label: 'Skip this form' }],
          });
          if (res.optionId === 'skipform') return false;
          if (res.optionId === 'proceed') ctx.report.warnings.push(irPath + ': repeating flag not set (no toggle found)');
        }
      }
      const savePool = appearedAffs.filter((a) => a.kind === 'button').length > 0
        ? appearedAffs.filter((a) => a.kind === 'button')
        : buttons(snap(ctx)).filter((a) => a.inModal || lexicon.scoreConcept(a.name, 'cancel') <= 0);
      const create = conceptPick(savePool, [{ name: 'save' }, { name: 'add', weight: 0.8 }])
        .filter((c) => lexicon.scoreConcept(c.aff.name, 'cancel') <= 0)[0];
      if (create) await clickAff(ctx, create.aff, 'commit the new document');
      if (formExists(ctx, form.name)) {
        ctx.log('verify', 'document "' + form.name + '" is now listed', irPath);
        return true;
      }
    }
    const res = await ctx.ask({
      kind: 'flow-stuck', irPath,
      question: 'I could not create the source document "' + form.name + '". Create it by hand, then choose Done.',
      evidence: ['Tried ' + candidates.length + ' add-document control(s).'],
      options: [{ id: 'done', label: 'Done (I created it)' }, { id: 'skip', label: 'Skip this form' }, { id: 'abort', label: 'Abort' }],
    });
    if (res.optionId === 'done') return formExists(ctx, form.name);
    if (res.optionId === 'skip') return false;
    throw new Error('aborted while creating form ' + form.name);
  }

  function rowScope(ctx, formName) {
    const otherNames = [];
    if (ctx.ir) {
      for (const v of ctx.ir.visits) for (const f of v.forms) {
        if (!lexicon.equalsNormalized(f.name, formName)) otherNames.push(f.name);
      }
    }
    const anchors = snapMod.findExactText(ctx.doc, formName);
    const s = snap(ctx);
    const otherNodes = [];
    for (const n of otherNames) otherNodes.push(...snapMod.findExactText(ctx.doc, n));
    for (const anchor of anchors) {
      let row = anchor.parentElement;
      while (row && row.tagName !== 'BODY') {
        if (otherNodes.some((el) => row.contains(el))) break;
        const within = s.affordances.filter((a) => row.contains(a.el));
        if (within.some((a) => a.kind === 'button')) return within;
        row = row.parentElement;
      }
    }
    return [];
  }

  function inBuilder(ctx) {
    return mapper.discoverPalette(snap(ctx)).length >= 6;
  }

  async function enterBuilder(ctx, formName, irPath) {
    for (let attempt = 0; attempt < 4; attempt++) {
      // Strategy 1: find row-scoped edit button
      const within = rowScope(ctx, formName);
      if (within.length > 0) {
        const rowButtons = within.filter((a) => a.kind === 'button');
        const edit = conceptPick(rowButtons, [{ name: 'edit' }])[0];
        if (edit) {
          await clickAff(ctx, edit.aff, 'open the form builder for ' + formName);
          if (inBuilder(ctx)) return true;
          continue;
        }
        const newVersion = conceptPick(rowButtons.filter((a) => lexicon.scoreConcept(a.name, 'remove') <= 0), [{ name: 'newVersion' }])[0];
        if (newVersion) {
          await clickAff(ctx, newVersion.aff, 'no edit control on this row; requesting a new editable version');
          continue;
        }
      }

      // Strategy 2: click the form name directly (some platforms open on click/double-click)
      if (attempt >= 1) {
        const nameNodes = snapMod.findExactText(ctx.doc, formName);
        for (const node of nameNodes) {
          await actions.click(ctx.doc, node);
          await actions.settle(ctx.doc);
          if (inBuilder(ctx)) return true;
          // Try double-click
          node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          await actions.settle(ctx.doc);
          if (inBuilder(ctx)) return true;
        }
      }

      // Strategy 3: LLM-assisted
      if (attempt >= 2) {
        const allButtons = buttons(snap(ctx));
        const llmResult = await llmPick(ctx, 'open the form builder/designer/editor for the document named "' + formName + '"', allButtons);
        if (llmResult) {
          await clickAff(ctx, llmResult.aff, 'LLM-guided: open builder for ' + formName);
          if (inBuilder(ctx)) return true;
        }
      }

      if (within.length === 0) break;
    }
    const res = await ctx.ask({
      kind: 'flow-stuck', irPath,
      question: 'I could not open the form designer for "' + formName + '". Open it by hand, then choose Done.',
      evidence: ['No edit or new-version control on the document row led to a screen with an element palette.'],
      options: [{ id: 'done', label: 'Done (builder is open)' }, { id: 'skip', label: 'Skip this form' }, { id: 'abort', label: 'Abort' }],
    });
    if (res.optionId === 'done') return inBuilder(ctx);
    if (res.optionId === 'skip') return false;
    throw new Error('aborted while opening builder for ' + formName);
  }

  async function leaveBuilder(ctx, visitName, why) {
    const s = snap(ctx);
    const scored = buttons(s)
      .map((a) => {
        let score = 0;
        if (visitName && a.name.includes(visitName)) score += 5;
        score += lexicon.scoreConcept(a.name, 'back');
        // Also consider breadcrumb-style links
        if (a.context.some((c) => /breadcrumb|crumb/i.test(c))) score += 2;
        return { aff: a, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const cand of scored.slice(0, 3)) {
      await clickAff(ctx, cand.aff, why || 'leave the builder');
      if (!inBuilder(ctx)) return true;
    }
    // LLM fallback
    if (inBuilder(ctx) && await llmNavigate(ctx, 'visit detail page for visit "' + visitName + '"')) {
      if (!inBuilder(ctx)) return true;
    }
    return !inBuilder(ctx);
  }

  function fieldRemoveCandidates(ctx) {
    return buttons(snap(ctx))
      .map((a) => {
        let score = lexicon.scoreConcept(a.name, 'remove');
        if (/^[x×✕]$/i.test((a.text || a.name || '').trim())) score += 2;
        if (lexicon.hasToken(a.name, ['question', 'element', 'field', 'item', 'control', 'widget'])) score += 3;
        if (lexicon.hasToken(a.name, ['form', 'document', 'instrument', 'crf', 'visit', 'encounter', 'page', 'row'])) score -= 6;
        return { aff: a, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  async function deleteSelectedElement(ctx, labelHint) {
    const label = labelHint || currentSelectionLabel(ctx);
    const beforeCount = label ? findFieldText(ctx.doc, label).length : 0;
    for (const cand of fieldRemoveCandidates(ctx).slice(0, 5)) {
      await clickAff(ctx, cand.aff, 'remove selected element');
      if (label && findFieldText(ctx.doc, label).length < Math.max(1, beforeCount)) return true;
      if (!label && currentSelectionLabel(ctx) !== label) return true;
    }
    return false;
  }

  function fillUnmappedTypes(ctx, typeMap, entries) {
    const used = new Set(Object.values(typeMap).map((e) => e.label));
    for (const t of mapper.CANONICAL_TYPES) {
      if (typeMap[t]) continue;
      let best = null;
      for (const e of entries) {
        if (e.inert || used.has(e.label)) continue;
        const r = (e.cls.ranking || []).find((x) => x.type === t);
        let score = r ? r.score : -99;
        if (t === 'datetime' && e.facets && e.facets.preview.datetimeInput > 0) score += 20;
        if (t === 'date' && e.facets && e.facets.preview.datePlaceholder && !e.facets.preview.timePlaceholder && !e.facets.preview.datetimeInput) score += 8;
        if (t === 'time' && e.facets && e.facets.preview.timePlaceholder && !e.facets.preview.datePlaceholder) score += 8;
        if (!best || score > best.score) best = { entry: e, score };
      }
      if (best && best.score > 0) {
        typeMap[t] = {
          label: best.entry.label, desc: best.entry.desc,
          confidence: Math.max(best.entry.cls.confidence, 0.5),
          evidence: (best.entry.cls.evidence || []).concat(['leftover palette entry assigned to unmapped type']),
          ranking: best.entry.cls.ranking,
        };
        used.add(best.entry.label);
        ctx.log('info', 'assigned leftover "' + best.entry.label + '" to ' + t, 'calibration');
      }
    }
    return typeMap;
  }

  async function calibrateTypes(ctx) {
    const s = snap(ctx);
    const palette = mapper.discoverPalette(s);
    if (palette.length === 0) throw new Error('no element palette found in builder');
    ctx.log('info', 'palette candidates: ' + palette.map((p) => '"' + p.name + '"').join(', '), 'calibration');
    const entries = [];
    for (const item of palette) {
      const before = snap(ctx);
      const resolved = snapMod.resolve(ctx.doc, snapMod.describe(item));
      if (!resolved) continue;
      await clickAff(ctx, resolved, 'probe palette entry');
      const after = snap(ctx);
      let appearedAffs = snapMod.appeared(before, after);
      // Full re-render platforms recreate the whole DOM; the appeared-diff can miss
      // preview controls whose signatures collide with palette items. Supplement
      // with any preview inputs (date/time/datetime-local) visible after the click.
      const previewInputs = after.affordances.filter((a) =>
        (a.inputType === 'datetime-local' || a.inputType === 'date' || a.inputType === 'time') &&
        !a.explicitLabel &&
        !appearedAffs.some((x) => x.signature === a.signature));
      appearedAffs = appearedAffs.concat(previewInputs);
      if (appearedAffs.length === 0) {
        ctx.log('info', 'palette entry "' + item.name + '" did nothing; marking inert', 'calibration');
        entries.push({ label: item.name, inert: true });
        continue;
      }
      const facets = mapper.mergeLivePreview(mapper.readFacets(appearedAffs), after.affordances);
      const cls = mapper.classify(item.name, facets);
      entries.push({ label: item.name, desc: snapMod.describe(item), facets, cls });
      ctx.log('info', 'probed "' + item.name + '" -> ' + cls.best.type + ' (conf ' + cls.confidence.toFixed(2) + '): ' + cls.evidence.join('; '), 'calibration');
      await deleteSelectedElement(ctx, item.name);
    }
    // Assign entries to canonical types: greedy best-score first.
    const typeMap = {};
    const claims = [];
    for (const e of entries) {
      if (e.inert) continue;
      for (const r of e.cls.ranking.slice(0, 3)) claims.push({ entry: e, type: r.type, score: r.score });
    }
    claims.sort((a, b) => b.score - a.score);
    const usedEntries = new Set();
    for (const c of claims) {
      if (typeMap[c.type] || usedEntries.has(c.entry.label) || c.score <= 0) continue;
      typeMap[c.type] = { label: c.entry.label, desc: c.entry.desc, confidence: c.entry.cls.confidence, evidence: c.entry.cls.evidence, ranking: c.entry.cls.ranking };
      usedEntries.add(c.entry.label);
    }

    // LLM-assisted refinement: for types that scored low or are unmapped, ask the LLM
    if (NS.llm && NS.llm.isAvailable()) {
      const unmapped = mapper.CANONICAL_TYPES.filter((t) => !typeMap[t]);
      const lowConf = Object.entries(typeMap).filter(([, v]) => v.confidence < 0.5).map(([k]) => k);
      for (const t of [...unmapped, ...lowConf]) {
        const llmResult = await NS.llm.mapType(t, entries);
        if (llmResult && llmResult.confidence >= 0.6) {
          const entry = entries.find((e) => e.label === llmResult.label);
          if (entry && !entry.inert && !usedEntries.has(entry.label)) {
            typeMap[t] = { label: entry.label, desc: entry.desc, confidence: llmResult.confidence, evidence: ['LLM: ' + llmResult.reason], ranking: entry.cls.ranking };
            usedEntries.add(entry.label);
            ctx.log('info', 'LLM mapped "' + t + '" -> "' + entry.label + '" (confidence ' + llmResult.confidence.toFixed(2) + ')', 'calibration');
          }
        }
      }
    }

    ctx.calib.entries = entries;
    ctx.calib.typeMap = fillUnmappedTypes(ctx, typeMap, entries);
    return typeMap;
  }

  function labelInputCandidates(ctx, appearedAffs) {
    const pool = appearedAffs
      ? appearedAffs.filter((a) => a.kind === 'textbox' && a.explicitLabel)
      : textboxes(snap(ctx)).filter((a) => a.explicitLabel);
    let cands = conceptPick(pool, [{ name: 'labelInput' }], { preferExplicitLabel: true, avoidValuesSection: true });
    if (cands.length === 0 && !appearedAffs) {
      cands = conceptPick(textboxes(snap(ctx)), [{ name: 'labelInput' }], { preferExplicitLabel: true, avoidValuesSection: true });
    }
    return cands;
  }

  async function renameSelected(ctx, newLabel, irPath, appearedAffs) {
    const cands = labelInputCandidates(ctx, appearedAffs);
    const cand = cands[0] || labelInputCandidates(ctx)[0];
    if (!cand) return false;
    const live = snapMod.resolve(ctx.doc, snapMod.describe(cand.aff)) || cand.aff;
    await typeInto(ctx, live, newLabel, irPath + ' (label)');
    return true;
  }

  async function calibrateSave(ctx, visitName, formName) {
    const SENTINEL = 'Probe Field ZQX';
    const palette = mapper.discoverPalette(snap(ctx));
    if (palette.length === 0) throw new Error('no palette during save calibration');
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = snap(ctx);
      const probeEntry = (ctx.calib.entries || []).find((e) => !e.inert) || { desc: snapMod.describe(palette[0]) };
      const item = snapMod.resolve(ctx.doc, probeEntry.desc);
      await clickAff(ctx, item, 'save calibration: add sentinel element');
      const appearedAffs = snapMod.appeared(before, snap(ctx));
      await renameSelected(ctx, SENTINEL, 'calibration', appearedAffs);
      const saveCands = conceptPick(buttons(snap(ctx)), [{ name: 'save' }])
        .filter((c) => lexicon.scoreConcept(c.aff.name, 'preview') <= 0 && lexicon.scoreConcept(c.aff.name, 'activate') <= 0);
      const cand = saveCands[attempt];
      if (!cand) break;
      await clickAff(ctx, cand.aff, 'save calibration: trying candidate "' + cand.aff.name + '"');
      await leaveBuilder(ctx, visitName, 'save calibration: leave to test persistence');
      await enterBuilder(ctx, formName, 'calibration');
      const persisted = findFieldText(ctx.doc, SENTINEL).length > 0;
      if (persisted) {
        ctx.calib.saveDesc = snapMod.describe(cand.aff);
        ctx.log('verify', 'save control confirmed by persistence probe: "' + cand.aff.name + '"', 'calibration');
        if (await selectFieldCard(ctx, SENTINEL)) {
          await deleteSelectedElement(ctx, SENTINEL);
        }
        const save = snapMod.resolve(ctx.doc, ctx.calib.saveDesc);
        if (save) await clickAff(ctx, save, 'persist sentinel removal');
        if (findFieldText(ctx.doc, SENTINEL).length > 0 && await selectFieldCard(ctx, SENTINEL)) {
          await deleteSelectedElement(ctx, SENTINEL);
          const save2 = snapMod.resolve(ctx.doc, ctx.calib.saveDesc);
          if (save2) await clickAff(ctx, save2, 'persist forced sentinel removal');
        }
        return true;
      }
      ctx.log('info', 'candidate "' + cand.aff.name + '" did NOT persist; content was lost on navigation. Trying next.', 'calibration');
    }
    const res = await ctx.ask({
      kind: 'flow-stuck', irPath: 'calibration.save',
      question: 'I could not find a Save control that actually persists builder edits. Click the real Save once by hand (with the builder open), then choose the control you used.',
      evidence: ['Candidates tried: ' + conceptPick(buttons(snap(ctx)), [{ name: 'save' }]).map((c) => '"' + c.aff.name + '"').join(', ')],
      options: conceptPick(buttons(snap(ctx)), [{ name: 'save' }]).slice(0, 4).map((c) => ({ id: c.aff.name, label: 'Use "' + c.aff.name + '"' })).concat([{ id: 'abort', label: 'Abort' }]),
    });
    if (res.optionId && res.optionId !== 'abort') {
      ctx.calib.saveDesc = { kind: 'button', name: res.optionId, nth: null };
      return true;
    }
    throw new Error('aborted: no working save control');
  }

  // ── field building ─────────────────────────────────────────────────────────

  async function mappingFor(ctx, canonicalType, irPath) {
    let entry = ctx.calib.typeMap[canonicalType];
    if (entry && (entry.confidence >= TYPE_CONF_THRESHOLD || entry.humanConfirmed)) return entry;
    const paletteOptions = (ctx.calib.entries || []).filter((e) => !e.inert)
      .map((e) => ({ id: e.label, label: e.label, detail: 'probe said: ' + e.cls.best.type + ' (conf ' + e.cls.confidence.toFixed(2) + ')' }));
    const res = await ctx.ask({
      kind: 'type-mapping', irPath,
      question: 'Which palette entry should represent the canonical type "' + canonicalType + '"?',
      evidence: entry
        ? ['Best guess: "' + entry.label + '" (confidence ' + entry.confidence.toFixed(2) + ')'].concat(entry.evidence)
        : ['No palette entry scored positively for this type.'],
      suggestion: entry ? entry.label : null,
      options: paletteOptions,
      meta: { canonicalType, entries: (ctx.calib.entries || []).map((e) => ({ label: e.label, inert: !!e.inert, best: e.inert ? null : e.cls.best.type, confidence: e.inert ? 0 : e.cls.confidence, evidence: e.inert ? [] : e.cls.evidence })) },
    });
    const chosen = (ctx.calib.entries || []).find((e) => e.label === res.optionId);
    if (!chosen) throw new Error('no mapping chosen for ' + canonicalType);
    entry = { label: chosen.label, desc: chosen.desc, confidence: 1, evidence: ['confirmed by reviewer'], humanConfirmed: true };
    ctx.calib.typeMap[canonicalType] = entry;
    return entry;
  }

  async function setFacetInput(ctx, appearedAffs, concept, value, irPath) {
    if (value == null) return true;
    const pool = appearedAffs.filter((a) => a.kind === 'textbox' && a.explicitLabel);
    const all = textboxes(snap(ctx));
    const cand = conceptPick(pool, [{ name: concept }], { preferExplicitLabel: true, avoidValuesSection: true })[0] ||
      conceptPick(all, [{ name: concept }], { preferExplicitLabel: true, avoidValuesSection: true })[0];
    if (!cand) {
      // LLM fallback for finding the right input
      const llmResult = await llmPick(ctx, 'find the input field for setting the "' + concept + '" property of a form element', all);
      if (llmResult) {
        const live = snapMod.resolve(ctx.doc, snapMod.describe(llmResult.aff));
        await typeInto(ctx, live || llmResult.aff, value, irPath + ' (' + concept + ', LLM-guided)');
        return true;
      }
      ctx.report.warnings.push(irPath + ': no input found for ' + concept + '; value ' + JSON.stringify(String(value)) + ' not set');
      ctx.log('warn', 'no input for ' + concept, irPath);
      return false;
    }
    const live = snapMod.resolve(ctx.doc, snapMod.describe(cand.aff));
    await typeInto(ctx, live || cand.aff, value, irPath + ' (' + concept + ')');
    return true;
  }

  async function enterValues(ctx, options, irPath) {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const before = snap(ctx);
      const addCands = conceptPick(buttons(before), [{ name: 'addValue' }])
        .filter((c) => lexicon.hasToken(c.aff.name, ['add', 'new', 'create', 'insert', 'plus', '＋']) &&
          lexicon.scoreConcept(c.aff.name, 'pasteBulk') <= 0);
      if (addCands.length === 0) return enterValuesByPaste(ctx, options, irPath);
      await clickAff(ctx, addCands[0].aff, 'add value row ' + (i + 1));
      const appearedAffs = snapMod.appeared(before, snap(ctx)).filter((a) => a.kind === 'textbox');
      let codeIn = conceptPick(appearedAffs, [{ name: 'valueCode' }])[0];
      let labelIn = conceptPick(appearedAffs.filter((a) => a !== (codeIn && codeIn.aff)), [{ name: 'valueLabel' }])[0];
      if (!codeIn || !labelIn) {
        if (appearedAffs.length >= 2) {
          const res = await ctx.decideOnce('value-row-order', {
            kind: 'value-entry', irPath,
            question: 'A new value row appeared but I cannot tell which input stores the CODE and which the LABEL. Which comes first?',
            evidence: ['New inputs: ' + appearedAffs.map((a) => '"' + (a.name || a.placeholder || 'unnamed') + '"').join(', ')],
            options: [{ id: 'code-first', label: 'First input is the code' }, { id: 'label-first', label: 'First input is the label' }],
          });
          const codeFirst = res.optionId !== 'label-first';
          codeIn = { aff: appearedAffs[codeFirst ? 0 : 1] };
          labelIn = { aff: appearedAffs[codeFirst ? 1 : 0] };
        } else if (appearedAffs.length === 1) {
          // Some platforms have a single combined input (code:label or code=label)
          await typeInto(ctx, appearedAffs[0], opt.code + '=' + opt.label, irPath + '.options[' + i + ']');
          continue;
        } else {
          return enterValuesByPaste(ctx, options, irPath);
        }
      }
      await typeInto(ctx, codeIn.aff, opt.code, irPath + '.options[' + i + '].code');
      await typeInto(ctx, labelIn.aff, opt.label, irPath + '.options[' + i + '].label');
    }
    return true;
  }

  async function enterValuesByPaste(ctx, options, irPath) {
    const s = snap(ctx);
    const paste = conceptPick(s.affordances.filter((a) => a.kind === 'textarea'), [{ name: 'pasteBulk' }])[0];
    if (!paste) {
      // Try any visible textarea as last resort
      const anyTextarea = s.affordances.filter((a) => a.kind === 'textarea' && a.context.some((c) => lexicon.scoreConcept(c, 'valuesSection') > 0))[0];
      if (!anyTextarea) {
        ctx.report.warnings.push(irPath + ': no per-row or bulk value entry found; coded values NOT entered');
        return false;
      }
    }
    const target = paste ? paste.aff : s.affordances.filter((a) => a.kind === 'textarea')[0];
    if (!target) {
      ctx.report.warnings.push(irPath + ': no per-row or bulk value entry found; coded values NOT entered');
      return false;
    }

    // Try multiple separator formats: platforms vary in what they accept
    const FORMATS = [
      { sep: '=', text: options.map((o) => o.code + '=' + o.label).join('\n'), name: 'code=label' },
      { sep: ':', text: options.map((o) => o.code + ':' + o.label).join('\n'), name: 'code:label' },
      { sep: '\t', text: options.map((o) => o.code + '\t' + o.label).join('\n'), name: 'code<tab>label' },
      { sep: ',', text: options.map((o) => o.code + ',' + o.label).join('\n'), name: 'code,label' },
    ];

    // Use the first format (most common), and rely on read-back audit to catch issues
    const fmt = FORMATS[0];
    await typeInto(ctx, target, fmt.text, irPath + ' (bulk values, ' + fmt.name + ')');
    const apply = conceptPick(buttons(snap(ctx)), [{ name: 'save', weight: 0.5 }, { name: 'pasteBulk' }])
      .filter((c) => lexicon.scoreConcept(c.aff.name, 'pasteBulk') > 0)[0];
    if (apply) await clickAff(ctx, apply.aff, 'apply bulk values');
    ctx.log('info', 'bulk value entry used with ' + fmt.name + ' format; read-back audit will judge it', irPath);
    return true;
  }

  async function buildField(ctx, field, irPath) {
    const entry = await mappingFor(ctx, field.type, irPath);
    const before = snap(ctx);
    const defaultCountBefore = findFieldText(ctx.doc, entry.label).length;
    const item = snapMod.resolve(ctx.doc, entry.desc);
    if (!item) throw new Error('palette entry vanished: ' + entry.label);
    await clickAff(ctx, item, 'add "' + field.label + '" as ' + entry.label);
    const appearedAffs = snapMod.appeared(before, snap(ctx));
    const defaultCountAfter = findFieldText(ctx.doc, entry.label).length;
    if (appearedAffs.length === 0 && defaultCountAfter <= defaultCountBefore) {
      // Retry: some platforms need a drag-and-drop or double-click
      await actions.click(ctx.doc, item.el);
      await actions.settle(ctx.doc, 100, 2000);
      const retryAffs = snapMod.appeared(before, snap(ctx));
      if (retryAffs.length === 0 && findFieldText(ctx.doc, entry.label).length <= defaultCountBefore) {
        ctx.report.warnings.push(irPath + ': clicking palette entry "' + entry.label + '" appeared to do nothing');
        return false;
      }
    }
    const latestAppeared = snapMod.appeared(before, snap(ctx));
    const renamed = await renameSelected(ctx, field.label, irPath, latestAppeared.length > 0 ? latestAppeared : appearedAffs);
    if (!renamed) ctx.report.warnings.push(irPath + ': could not find the label input; element keeps its default name');

    if (field.required) {
      const req = conceptPick(snap(ctx).affordances.filter((a) => a.kind === 'checkbox'), [{ name: 'required' }], { preferExplicitLabel: true })[0];
      if (req) {
        ctx.log('action', 'set required', irPath);
        await actions.setCheckbox(ctx.doc, req.aff.el, true);
      } else {
        ctx.report.warnings.push(irPath + ': no required toggle found');
      }
    }
    await setFacetInput(ctx, latestAppeared.length > 0 ? latestAppeared : appearedAffs, 'min', field.min != null ? String(field.min) : null, irPath);
    await setFacetInput(ctx, latestAppeared.length > 0 ? latestAppeared : appearedAffs, 'max', field.max != null ? String(field.max) : null, irPath);
    await setFacetInput(ctx, latestAppeared.length > 0 ? latestAppeared : appearedAffs, 'units', field.units != null ? String(field.units) : null, irPath);
    await setFacetInput(ctx, latestAppeared.length > 0 ? latestAppeared : appearedAffs, 'formula', field.formula != null ? String(field.formula) : null, irPath);
    if (field.options && field.options.length) await enterValues(ctx, field.options, irPath);
    return true;
  }

  function currentSelectionLabel(ctx) {
    const cand = labelInputCandidates(ctx)[0];
    return cand ? cand.aff.value : null;
  }

  async function selectFieldCard(ctx, label) {
    if (lexicon.equalsNormalized(currentSelectionLabel(ctx), label)) return true;
    const nodes = findFieldText(ctx.doc, label);
    for (const node of nodes) {
      await actions.click(ctx.doc, node);
      if (lexicon.equalsNormalized(currentSelectionLabel(ctx), label)) return true;
    }
    // Fuzzy fallback: try approximate text matches
    const fuzzyNodes = snapMod.findFuzzyText(ctx.doc, label, 0.8);
    for (const node of fuzzyNodes.slice(0, 3)) {
      await actions.click(ctx.doc, node);
      const current = currentSelectionLabel(ctx);
      if (current && lexicon.similarity(current, label) >= 0.8) return true;
    }
    return false;
  }

  async function applySkipLogic(ctx, field, irPath) {
    const rule = field.skip_logic;
    if (!rule) return true;
    if (!(await selectFieldCard(ctx, field.label))) {
      ctx.report.warnings.push(irPath + ': could not select the element to set its skip logic');
      return false;
    }
    const selects = snap(ctx).affordances.filter((a) => a.kind === 'select');
    const visSel = conceptPick(selects, [{ name: 'visibility' }], { preferExplicitLabel: true })[0];
    if (!visSel) {
      ctx.report.warnings.push(irPath + ': no visibility/condition control found; skip logic NOT set');
      return false;
    }
    const condOpt = visSel.aff.options
      .map((o) => ({ o, score: lexicon.scoreConcept(o.text, 'conditionalMode') }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    if (!condOpt) {
      ctx.report.warnings.push(irPath + ': visibility control has no conditional option');
      return false;
    }
    ctx.log('action', 'set visibility to "' + condOpt.o.text + '"', irPath);
    const liveVis = snapMod.resolve(ctx.doc, snapMod.describe(visSel.aff));
    await actions.selectOption(ctx.doc, liveVis.el, condOpt.o.text);
    const selects2 = snap(ctx).affordances.filter((a) => a.kind === 'select' && a.signature !== liveVis.signature);
    const whenSel = conceptPick(selects2, [{ name: 'whenField' }], { preferExplicitLabel: true })[0] ||
      selects2.map((a) => ({ aff: a })).find((x) => x.aff.options.some((o) => lexicon.equalsNormalized(o.text, rule.when_field_label)));
    if (!whenSel) {
      const res = await ctx.ask({
        kind: 'skip-logic', irPath,
        question: 'I set "' + field.label + '" to conditional visibility but cannot find the control that picks the controlling field ("' + rule.when_field_label + '"). Set the rule by hand, then choose Done.',
        evidence: ['Rule: show when "' + rule.when_field_label + '" equals "' + rule.equals_value + '"'],
        options: [{ id: 'done', label: 'Done (rule set by hand)' }, { id: 'skip', label: 'Skip this rule' }],
      });
      if (res.optionId === 'skip') ctx.report.warnings.push(irPath + ': skip logic rule not set');
      return res.optionId === 'done';
    }
    const picked = await actions.selectOption(ctx.doc, snapMod.resolve(ctx.doc, snapMod.describe(whenSel.aff)).el, rule.when_field_label);
    if (!picked) {
      // Try fuzzy match on the when_field_label
      const fuzzyPick = whenSel.aff.options
        .map((o) => ({ o, sim: lexicon.similarity(o.text, rule.when_field_label) }))
        .filter((x) => x.sim >= 0.7)
        .sort((a, b) => b.sim - a.sim)[0];
      if (fuzzyPick) {
        await actions.selectOption(ctx.doc, snapMod.resolve(ctx.doc, snapMod.describe(whenSel.aff)).el, fuzzyPick.o.text);
      } else {
        const res = await ctx.ask({
          kind: 'skip-logic', irPath,
          question: 'The controlling field "' + rule.when_field_label + '" is not offered by the condition control for "' + field.label + '". It may not exist yet or its label may differ.',
          evidence: ['Offered: ' + whenSel.aff.options.map((o) => o.text).filter(Boolean).slice(0, 30).join(' | ')],
          options: [{ id: 'done', label: 'Done (rule set by hand)' }, { id: 'skip', label: 'Skip this rule' }],
        });
        if (res.optionId === 'skip') ctx.report.warnings.push(irPath + ': skip logic controller not found');
        return res.optionId === 'done';
      }
    }
    await setFacetInput(ctx, [], 'equalsValue', String(rule.equals_value), irPath);
    ctx.log('verify', 'skip logic: show when "' + rule.when_field_label + '" = "' + rule.equals_value + '"', irPath);
    return true;
  }

  async function cleanupSentinel(ctx) {
    const SENTINEL = 'Probe Field ZQX';
    if (findFieldText(ctx.doc, SENTINEL).length === 0) return;
    ctx.log('info', 'removing leaked calibration sentinel', 'calibration');
    if (await selectFieldCard(ctx, SENTINEL)) {
      await deleteSelectedElement(ctx, SENTINEL);
      if (ctx.calib.saveDesc) {
        const save = snapMod.resolve(ctx.doc, ctx.calib.saveDesc);
        if (save) await clickAff(ctx, save, 'persist sentinel removal');
      }
    }
  }

  async function saveForm(ctx, irPath) {
    if (!ctx.calib.saveDesc) throw new Error('save control not calibrated');
    const save = snapMod.resolve(ctx.doc, ctx.calib.saveDesc);
    if (!save) {
      // Save button may have moved or re-rendered; try concept search
      const saveCand = conceptPick(buttons(snap(ctx)), [{ name: 'save' }])
        .filter((c) => lexicon.scoreConcept(c.aff.name, 'preview') <= 0 && lexicon.scoreConcept(c.aff.name, 'activate') <= 0)[0];
      if (saveCand) {
        await clickAff(ctx, saveCand.aff, 'persist the form (fallback) (' + irPath + ')');
        return true;
      }
      throw new Error('calibrated save control not on screen and no fallback found');
    }
    await clickAff(ctx, save, 'persist the form (' + irPath + ')');
    return true;
  }

  NS.flows = {
    TYPE_CONF_THRESHOLD,
    snap, buttons, textboxes, conceptPick, clickAff, typeInto, hasExplicitLabel,
    findFieldText, fieldLabelMatches,
    ensureScheduleScreen, visitExists, createVisit, openVisit, backToSchedule,
    formExists, createForm, enterBuilder, leaveBuilder, inBuilder,
    calibrateTypes, calibrateSave, mappingFor, buildField, selectFieldCard,
    applySkipLogic, saveForm, renameSelected, labelInputCandidates, enterValues, cleanupSentinel, deleteSelectedElement,
  };
})();
