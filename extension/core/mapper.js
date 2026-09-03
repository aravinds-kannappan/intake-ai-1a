/*
 * mapper.js — semantic type mapping by experiment, not by string match.
 *
 * The platform's element palette speaks its own dialect. We calibrate once per
 * run, inside the first form builder we open: click every palette entry,
 * watch what configuration surface appears (a values editor? min/max? a
 * formula box?), watch what preview control renders, then DELETE the probe.
 * The observed facets place the entry in a semantic group; the lexicon and
 * preview evidence disambiguate within the group; the margin between the top
 * two candidates becomes a confidence the human gate can act on.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});
  const { lexicon } = NS;

  const CANONICAL_TYPES = ['text', 'textarea', 'integer', 'decimal', 'date', 'time', 'datetime', 'boolean', 'single_select', 'multi_select', 'radio', 'checkbox', 'calculated'];

  /**
   * Find palette candidates: visible buttons that live in a cluster of many
   * sibling-like buttons within one container whose context smells like an
   * element library. Falls back to any repeated button cluster when no
   * context matches, because some platform will label the palette something
   * we never thought of.
   */
  function discoverPalette(snap) {
    const buttons = snap.affordances.filter((a) => a.kind === 'button' && !a.inModal);
    // Group buttons by their nearest list-ish container.
    const groups = new Map();
    for (const a of buttons) {
      const container = a.el.parentElement && a.el.parentElement.closest('ul, ol, aside, nav, [role="list"], [role="toolbar"], [role="tablist"], section, div, menu');
      if (!container) continue;
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push(a);
    }
    let clusters = [...groups.entries()]
      .map(([container, items]) => ({ container, items }))
      .filter((g) => g.items.length >= 6);

    // Fallback: if no cluster >= 6, try >= 4 (smaller palettes exist)
    if (clusters.length === 0) {
      clusters = [...groups.entries()]
        .map(([container, items]) => ({ container, items }))
        .filter((g) => g.items.length >= 4);
    }

    if (clusters.length === 0) return [];
    // Prefer the cluster whose context scores highest for the palette concept.
    clusters.sort((a, b) => paletteScore(b) - paletteScore(a));
    return clusters[0].items;
  }

  function paletteScore(cluster) {
    const ctxText = cluster.items[0].context.join(' ');
    let score = lexicon.scoreConcept(ctxText, 'palette') * 2;
    // Palettes are lists of short noun labels; long verbs argue against.
    const avgLen = cluster.items.reduce((s, i) => s + i.name.length, 0) / cluster.items.length;
    if (avgLen < 30) score += 1;
    score += Math.min(cluster.items.length, 16) / 8;
    return score;
  }

  /** Read semantic facets out of the affordances that appeared after a probe click. */
  function readFacets(appearedAffs) {
    const facets = {
      hasFormula: false, hasMin: false, hasMax: false, hasUnits: false,
      hasDecimalPlaces: false, hasValuesEditor: false,
      preview: { select: 0, radio: 0, checkbox: 0, textarea: 0, textbox: 0, yesNoButtons: 0, datePlaceholder: false, timePlaceholder: false },
      appearedCount: appearedAffs.length,
    };
    const labelled = appearedAffs.filter((a) => a.name);
    for (const a of labelled) {
      if (a.kind === 'textbox' || a.kind === 'textarea') {
        if (lexicon.scoreConcept(a.name, 'formula') >= 3) facets.hasFormula = true;
        if (lexicon.scoreConcept(a.name, 'min') >= 3) facets.hasMin = true;
        if (lexicon.scoreConcept(a.name, 'max') >= 3) facets.hasMax = true;
        if (lexicon.scoreConcept(a.name, 'units') >= 3) facets.hasUnits = true;
        if (lexicon.scoreConcept(a.name, 'decimalPlaces') >= 3) facets.hasDecimalPlaces = true;
        if (lexicon.scoreConcept(a.name, 'pasteBulk') >= 3) facets.hasValuesEditor = true;
      }
      if (a.kind === 'button' && lexicon.scoreConcept(a.name, 'addValue') >= 3 && lexicon.scoreConcept(a.name, 'add') > 0) {
        facets.hasValuesEditor = true;
      }
    }
    // Which concepts mark a control as configuration depends on what kind of
    // control it is: "question" in a SELECT's name suggests a controlling-field
    // chooser, but in a text input's name it is probably just the element's
    // own (preview) label.
    const CONFIG_BY_KIND = {
      select: ['typeSelect', 'visibility', 'whenField'],
      checkbox: ['required', 'repeating', 'visibility'],
      radio: ['required', 'visibility'],
      textbox: ['labelInput', 'min', 'max', 'units', 'decimalPlaces', 'formula', 'equalsValue', 'valueCode', 'valueLabel', 'pasteBulk'],
      textarea: ['pasteBulk', 'labelInput'],
    };
    const isConfigLike = (a) => {
      if (!a.name) return false;
      const concepts = CONFIG_BY_KIND[a.kind] || [];
      return concepts.some((c) => lexicon.scoreConcept(a.name, c) >= 2);
    };
    for (const a of appearedAffs) {
      // Configuration surface is not the element's preview: counting the
      // panel's own selects and toggles would credit every probe with them.
      // Two independent signals mark config controls: an explicit <label>
      // wiring, or an accessible name that reads as a config concept.
      if (a.explicitLabel || isConfigLike(a)) continue;
      const ph = (a.placeholder || '').toLowerCase();
      const dateish = /y{2,4}|d{2}|m{2,3}/.test(ph) && /[-/ ]/.test(ph);
      const timeish = /h{1,2}[:.]m{1,2}/.test(ph);
      if (a.kind === 'select') facets.preview.select++;
      else if (a.kind === 'radio') facets.preview.radio++;
      else if (a.kind === 'checkbox') facets.preview.checkbox++;
      else if (a.kind === 'textarea') facets.preview.textarea++;
      else if (a.kind === 'textbox') {
        facets.preview.textbox++;
        if (dateish) facets.preview.datePlaceholder = true;
        if (timeish) facets.preview.timePlaceholder = true;
      } else if (a.kind === 'button' && /^(yes|no|true|false|on|off)$/i.test(a.name.trim())) {
        facets.preview.yesNoButtons++;
      }
      if (a.inputType === 'date') facets.preview.datePlaceholder = true;
      if (a.inputType === 'time') facets.preview.timePlaceholder = true;
      if (a.inputType === 'datetime-local') { facets.preview.datePlaceholder = true; facets.preview.timePlaceholder = true; }
    }
    return facets;
  }

  /** Score each canonical type for one palette entry given label + facets. */
  function classify(entryLabel, facets) {
    const scores = {};
    for (const t of CANONICAL_TYPES) scores[t] = lexicon.scoreType(entryLabel, t);
    const evidence = [];

    if (facets) {
      const numeric = facets.hasMin && facets.hasMax;
      if (facets.hasFormula) {
        bump(scores, ['calculated'], 8);
        evidence.push('probe: a formula/expression input appeared');
      }
      if (numeric) {
        bump(scores, facets.hasDecimalPlaces ? ['decimal'] : ['integer'], 7);
        penalize(scores, CANONICAL_TYPES.filter((t) => t !== 'integer' && t !== 'decimal'), 4);
        evidence.push('probe: min/max range inputs appeared' + (facets.hasDecimalPlaces ? ' with decimal places' : ''));
      }
      if (facets.hasValuesEditor) {
        bump(scores, ['single_select', 'multi_select', 'radio'], 6);
        penalize(scores, ['checkbox', 'boolean', 'text', 'textarea'], 5);
        evidence.push('probe: a coded values editor appeared');
        if (facets.preview.select > 0) { bump(scores, ['single_select'], 4); evidence.push('probe: preview renders a dropdown control'); }
        if (facets.preview.radio > 0) { bump(scores, ['radio'], 5); evidence.push('probe: preview renders radio inputs'); }
        if (facets.preview.checkbox > 0) { bump(scores, ['multi_select'], 5); evidence.push('probe: preview renders checkbox inputs'); }
      } else {
        penalize(scores, ['single_select', 'multi_select', 'radio'], 5);
        if (facets.preview.checkbox === 1 && !numeric && !facets.hasFormula) {
          bump(scores, ['checkbox'], 5);
          evidence.push('probe: preview renders a single tick box and no values editor');
        }
        if (facets.preview.yesNoButtons >= 2) { bump(scores, ['boolean'], 6); evidence.push('probe: preview renders yes/no controls'); }
        if (facets.preview.textarea > 0) { bump(scores, ['textarea'], 5); evidence.push('probe: preview renders a multi-line text control'); }
        if (facets.preview.datePlaceholder && facets.preview.timePlaceholder) { bump(scores, ['datetime'], 6); evidence.push('probe: preview hints at date and time entry'); }
        else if (facets.preview.datePlaceholder) { bump(scores, ['date'], 5); evidence.push('probe: preview hints at date entry'); }
        else if (facets.preview.timePlaceholder) { bump(scores, ['time'], 5); evidence.push('probe: preview hints at time entry'); }
      }
    }

    const ranking = CANONICAL_TYPES
      .map((t) => ({ type: t, score: scores[t] }))
      .sort((a, b) => b.score - a.score);
    const confidence = lexicon.margin(ranking.map((r) => ({ score: r.score })));
    return { ranking, best: ranking[0], second: ranking[1], confidence, evidence };
  }

  function bump(scores, types, amount) { for (const t of types) scores[t] += amount; }
  function penalize(scores, types, amount) { for (const t of types) scores[t] -= amount; }

  NS.mapper = { CANONICAL_TYPES, discoverPalette, readFacets, classify };
})();
