/*
 * verify.js — read-back. After a form is saved, the builder is reopened and
 * every IR field is selected on the canvas and read back out of the live
 * configuration surface. What the platform now holds is compared against the
 * input file; differences become fixable issues, and fixes are re-audited.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});
  const { lexicon, snapshot: snapMod, actions, flows } = NS;

  function valuesContextScore(aff) {
    return aff.context.filter((c) => lexicon.scoreConcept(c, 'valuesSection') > 0).length;
  }

  /** The element-label input: same ranking the build path uses. */
  function elementLabelInput(ctx) {
    const cand = flows.labelInputCandidates(ctx)[0];
    return cand ? cand.aff : null;
  }

  /** Read the selected element's coded values as [{code,label}] in row order. */
  function readValues(ctx) {
    const boxes = flows.textboxes(flows.snap(ctx));
    // A strong code token is required: weakly code-ish inputs elsewhere in the
    // panel (e.g. a condition's comparison value) must not read as value rows.
    const codeCands = boxes.filter((a) => lexicon.scoreConcept(a.name, 'valueCode') >= 2 && valuesContextScore(a) > 0);
    const rows = [];
    for (const code of codeCands) {
      let container = code.el.parentElement;
      let partner = null;
      while (container && container.tagName !== 'BODY') {
        const others = boxes.filter((b) => b !== code && container.contains(b.el));
        if (others.length >= 1) { partner = others.find((b) => lexicon.scoreConcept(b.name, 'valueLabel') > 0) || others[0]; break; }
        container = container.parentElement;
      }
      rows.push({ code: code.value, label: partner ? partner.value : '' });
    }
    return rows;
  }

  function readFacet(ctx, concept) {
    const cand = flows.conceptPick(flows.textboxes(flows.snap(ctx)), [{ name: concept }], { preferExplicitLabel: true, avoidValuesSection: true })[0];
    return cand ? cand.aff.value : null;
  }

  function readRequired(ctx) {
    const cand = flows.conceptPick(
      flows.snap(ctx).affordances.filter((a) => a.kind === 'checkbox'),
      [{ name: 'required' }],
      { preferExplicitLabel: true },
    )[0];
    return cand ? !!cand.aff.checked : null;
  }

  function readType(ctx) {
    const selects = flows.snap(ctx).affordances.filter((a) => a.kind === 'select');
    const typeSel = flows.conceptPick(selects, [{ name: 'typeSelect' }], { preferExplicitLabel: true })[0];
    if (!typeSel) return null;
    const selected = typeSel.aff.options.find((o) => o.selected);
    if (!selected) return null;
    const label = selected.text;
    for (const [canonical, entry] of Object.entries(ctx.calib.typeMap || {})) {
      if (lexicon.equalsNormalized(entry.label, label)) return { canonical, label };
    }
    return { canonical: null, label };
  }

  function readVisibility(ctx) {
    const selects = flows.snap(ctx).affordances.filter((a) => a.kind === 'select');
    const visSel = flows.conceptPick(selects, [{ name: 'visibility' }], { preferExplicitLabel: true })[0];
    if (!visSel) return null;
    const mode = visSel.aff.options.find((o) => o.selected);
    const conditional = mode ? lexicon.scoreConcept(mode.text, 'conditionalMode') > 0 : false;
    if (!conditional) return { conditional: false };
    const whenSel = flows.conceptPick(
      selects.filter((a) => a.signature !== visSel.aff.signature),
      [{ name: 'whenField' }],
      { preferExplicitLabel: true },
    )[0];
    const when = whenSel ? (whenSel.aff.options.find((o) => o.selected) || {}).text : null;
    const equals = readFacet(ctx, 'equalsValue');
    return { conditional: true, whenLabel: when || null, equals };
  }

  function normNum(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  /** Audit one form (builder must be open). Returns a list of issues. */
  async function auditForm(ctx, form, irPath) {
    const issues = [];
    for (let i = 0; i < form.fields.length; i++) {
      const field = form.fields[i];
      const path = irPath + '.fields[' + i + '] "' + field.label + '"';
      const selected = await flows.selectFieldCard(ctx, field.label);
      if (!selected) {
        issues.push({ irPath: path, kind: 'missing', expected: field.label, actual: null, fixable: 'rebuild' });
        continue;
      }
      const labelIn = elementLabelInput(ctx);
      if (labelIn && !lexicon.equalsNormalized(labelIn.value, field.label)) {
        issues.push({ irPath: path, kind: 'label', expected: field.label, actual: labelIn.value, fixable: 'patch' });
      }
      const type = readType(ctx);
      if (type && type.canonical && type.canonical !== field.type) {
        issues.push({ irPath: path, kind: 'type', expected: field.type, actual: type.canonical + ' ("' + type.label + '")', fixable: 'rebuild' });
        continue; // facet reads are meaningless on the wrong type
      }
      const req = readRequired(ctx);
      if (req != null && req !== !!field.required) {
        issues.push({ irPath: path, kind: 'required', expected: !!field.required, actual: req, fixable: 'patch' });
      }
      for (const facet of [['min', field.min], ['max', field.max], ['units', field.units], ['formula', field.formula]]) {
        if (facet[1] == null) continue;
        const actual = readFacet(ctx, facet[0]);
        if (actual == null) continue; // warned at build time
        if (normNum(actual) !== normNum(facet[1])) {
          issues.push({ irPath: path, kind: facet[0], expected: normNum(facet[1]), actual: normNum(actual), fixable: 'patch' });
        }
      }
      if (field.options && field.options.length) {
        const rows = readValues(ctx);
        const want = field.options.map((o) => o.code + '=' + o.label).join(' | ');
        const got = rows.map((r) => r.code + '=' + r.label).join(' | ');
        if (want !== got) {
          issues.push({ irPath: path, kind: 'values', expected: want, actual: got, fixable: 'patch' });
        }
      }
      if (field.skip_logic) {
        const vis = readVisibility(ctx);
        if (!vis || !vis.conditional) {
          issues.push({ irPath: path, kind: 'skip_logic', expected: 'when "' + field.skip_logic.when_field_label + '" = "' + field.skip_logic.equals_value + '"', actual: 'not conditional', fixable: 'patch' });
        } else if (!lexicon.equalsNormalized(vis.whenLabel, field.skip_logic.when_field_label) ||
                   normNum(vis.equals) !== normNum(field.skip_logic.equals_value)) {
          issues.push({ irPath: path, kind: 'skip_logic', expected: 'when "' + field.skip_logic.when_field_label + '" = "' + field.skip_logic.equals_value + '"', actual: 'when "' + (vis.whenLabel || '?') + '" = "' + (vis.equals || '') + '"', fixable: 'patch' });
        }
      }
    }
    return issues;
  }

  /** Try to repair the fixable issues in place. Returns how many were attempted. */
  async function fixIssues(ctx, form, irPath, issues) {
    let attempted = 0;
    for (const issue of issues) {
      const match = /fields\[(\d+)\]/.exec(issue.irPath);
      if (!match) continue;
      const field = form.fields[Number(match[1])];
      if (issue.fixable === 'rebuild') {
        attempted++;
        if (issue.kind !== 'missing') {
          // Wrong type: remove the element, then rebuild it from scratch.
          if (await flows.selectFieldCard(ctx, field.label)) {
            const del = flows.conceptPick(flows.buttons(flows.snap(ctx)), [{ name: 'remove' }])
              .filter((c) => lexicon.scoreConcept(c.aff.name, 'form') <= 0)[0];
            if (del) await flows.clickAff(ctx, del.aff, 'remove mistyped element before rebuild');
          }
        }
        await flows.buildField(ctx, field, issue.irPath);
        if (field.skip_logic) await flows.applySkipLogic(ctx, field, issue.irPath);
        continue;
      }
      if (!(await flows.selectFieldCard(ctx, field.label)) && !(await flows.selectFieldCard(ctx, issue.actual))) continue;
      attempted++;
      switch (issue.kind) {
        case 'label':
          await flows.renameSelected(ctx, field.label, issue.irPath);
          break;
        case 'required': {
          const cand = flows.conceptPick(flows.snap(ctx).affordances.filter((a) => a.kind === 'checkbox'), [{ name: 'required' }], { preferExplicitLabel: true })[0];
          if (cand) await actions.setCheckbox(ctx.doc, cand.aff.el, !!field.required);
          break;
        }
        case 'min': case 'max': case 'units': case 'formula': {
          const value = field[issue.kind];
          await flows.conceptPick(flows.textboxes(flows.snap(ctx)), [{ name: issue.kind }], { preferExplicitLabel: true })
            .slice(0, 1)
            .reduce(async (p, cand) => { await p; await flows.typeInto(ctx, cand.aff, String(value), issue.irPath); }, Promise.resolve());
          break;
        }
        case 'values': {
          // Remove existing rows, then re-enter cleanly. Row-remove controls
          // only: anything naming the element/document itself is off-limits,
          // and a click that does not shrink the row count stops the loop.
          let lastCount = readValues(ctx).length;
          for (let guard = 0; guard < lastCount + 2; guard++) {
            if (lastCount === 0) break;
            const removeBtns = flows.buttons(flows.snap(ctx)).filter((a) =>
              valuesContextScore(a) > 0 &&
              (lexicon.scoreConcept(a.name, 'remove') > 0 || /^[x×✕]$/i.test(a.text)) &&
              !lexicon.hasToken(a.name, ['element', 'field', 'question', 'control', 'document', 'form', 'page', 'visit']));
            if (removeBtns.length === 0) break;
            await flows.clickAff(ctx, removeBtns[0], 'clear wrong value row');
            const count = readValues(ctx).length;
            if (count >= lastCount) break;
            lastCount = count;
          }
          await flows.enterValues(ctx, field.options, issue.irPath);
          break;
        }
        case 'skip_logic':
          await flows.applySkipLogic(ctx, field, issue.irPath);
          break;
      }
    }
    return attempted;
  }

  /** Visit-level presence checks against the schedule and visit screens. */
  function auditVisitRow(ctx, visit) {
    const problems = [];
    const anchors = snapMod.findExactText(ctx.doc, visit.name);
    if (anchors.length === 0) { problems.push('visit missing from schedule'); return problems; }
    const row = anchors[0].closest('tr, li, [role="row"]');
    if (row && (visit.window_start_day != null)) {
      const text = row.textContent;
      if (!text.includes(String(visit.window_start_day)) || !text.includes(String(visit.window_end_day))) {
        problems.push('visit window "' + visit.window_start_day + '..' + visit.window_end_day + '" not visible on the row');
      }
    }
    return problems;
  }

  function auditFormRow(ctx, form) {
    const problems = [];
    const anchors = snapMod.findExactText(ctx.doc, form.name);
    if (anchors.length === 0) { problems.push('document missing from visit'); return problems; }
    const row = anchors[0].closest('tr, li, [role="row"]');
    if (row) {
      const repeatScore = lexicon.scoreConcept(row.textContent, 'repeating');
      const looksRepeating = repeatScore > 0;
      if (looksRepeating !== !!form.repeating) {
        problems.push('repeating flag looks ' + (looksRepeating ? 'ON' : 'OFF') + ' but the input says ' + (form.repeating ? 'ON' : 'OFF'));
      }
    }
    return problems;
  }

  NS.verify = { auditForm, fixIssues, auditVisitRow, auditFormRow, readValues, readType, readVisibility, elementLabelInput };
})();
