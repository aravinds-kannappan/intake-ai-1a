/*
 * orchestrator.js — the run loop.
 *
 * Deterministic plan derived from the IR: visits, then documents, then a
 * builder session per document (calibrating the platform inside the first
 * one), then skip logic, save, and a read-back audit with one repair round.
 * Everything the agent is unsure about routes through hooks.ask — the human
 * gate — and every action lands in an exportable trace.
 */
(function () {
  'use strict';
  const NS = (window.IntakeAgent = window.IntakeAgent || {});
  const { flows, verify } = NS;

  function newReport(ir) {
    let fieldTotal = 0, skipTotal = 0;
    for (const v of ir.visits) for (const f of v.forms) {
      fieldTotal += f.fields.length;
      skipTotal += f.fields.filter((x) => x.skip_logic).length;
    }
    return {
      startedAt: new Date().toISOString(), finishedAt: null, durationMs: 0, aborted: false,
      visits: { total: ir.visits.length, created: 0, existing: 0, failed: 0 },
      forms: { total: ir.visits.reduce((n, v) => n + v.forms.length, 0), created: 0, existing: 0, skipped: 0 },
      fields: { total: fieldTotal, built: 0 },
      skipRules: { total: skipTotal, set: 0 },
      audit: { formsAudited: 0, formsClean: 0, issuesFound: 0, issuesFixed: 0, issuesOpen: 0, openIssues: [], rowProblems: [] },
      escalations: [],
      warnings: [],
    };
  }

  async function run(ir, hooks) {
    const trace = [];
    const decisions = new Map();
    const ctx = {
      doc: hooks.doc,
      ir,
      calib: {},
      report: newReport(ir),
      stopRequested: false,
      log(level, message, irPath) {
        const entry = { t: Date.now(), level, message, irPath: irPath || '' };
        trace.push(entry);
        if (hooks.onLog) hooks.onLog(entry);
      },
      emit(stage, detail) {
        if (hooks.onProgress) hooks.onProgress({ stage, detail, report: ctx.report });
      },
      async ask(item) {
        ctx.log('escalate', item.question, item.irPath);
        const resolution = await hooks.ask(item);
        ctx.report.escalations.push({ ...item, resolution, at: new Date().toISOString() });
        ctx.log('resolve', 'reviewer chose: ' + (resolution.optionId || resolution.text || '(none)'), item.irPath);
        return resolution;
      },
      async decideOnce(key, item) {
        if (decisions.has(key)) return decisions.get(key);
        const res = await ctx.ask(item);
        decisions.set(key, res);
        return res;
      },
      checkStop() {
        if (ctx.stopRequested) { const e = new Error('stopped by user'); e.aborted = true; throw e; }
      },
    };
    hooks.controller && (hooks.controller.stop = () => { ctx.stopRequested = true; });

    const start = Date.now();
    try {
      ctx.emit('start', 'run started');
      await flows.ensureScheduleScreen(ctx);

      // 1. Visits.
      for (let vi = 0; vi < ir.visits.length; vi++) {
        ctx.checkStop();
        const visit = ir.visits[vi];
        const irPath = 'visits[' + vi + '] "' + visit.name + '"';
        ctx.emit('visits', 'ensuring visit ' + visit.name);
        if (flows.visitExists(ctx, visit.name)) {
          ctx.report.visits.existing++;
          ctx.log('info', 'visit already present; leaving it alone', irPath);
        } else if (await flows.createVisit(ctx, visit, irPath)) {
          ctx.report.visits.created++;
        } else {
          ctx.report.visits.failed++;
        }
      }

      // 2. Documents and fields, one visit at a time.
      let calibrated = false;
      for (let vi = 0; vi < ir.visits.length; vi++) {
        ctx.checkStop();
        const visit = ir.visits[vi];
        const visitPath = 'visits[' + vi + '] "' + visit.name + '"';
        await flows.ensureScheduleScreen(ctx);
        if (!(await flows.openVisit(ctx, visit))) {
          ctx.report.warnings.push(visitPath + ': could not open the visit; its documents were not built');
          continue;
        }

        // 2a. Ensure every document row exists.
        for (let fi = 0; fi < visit.forms.length; fi++) {
          ctx.checkStop();
          const form = visit.forms[fi];
          const formPath = visitPath + '.forms[' + fi + '] "' + form.name + '"';
          if (flows.formExists(ctx, form.name)) {
            ctx.report.forms.existing++;
            ctx.log('info', 'document already present', formPath);
          } else if (await flows.createForm(ctx, form, formPath)) {
            ctx.report.forms.created++;
          } else {
            ctx.report.forms.skipped++;
          }
        }

        // 2b. Build each document's fields.
        for (let fi = 0; fi < visit.forms.length; fi++) {
          ctx.checkStop();
          const form = visit.forms[fi];
          const formPath = visitPath + '.forms[' + fi + '] "' + form.name + '"';
          ctx.emit('build', visit.name + ' / ' + form.name);
          if (!flows.formExists(ctx, form.name)) continue;
          if (!(await flows.enterBuilder(ctx, form.name, formPath))) continue;

          if (!calibrated) {
            ctx.emit('calibrate', 'probing the element palette');
            await flows.calibrateTypes(ctx);
            // Leave WITHOUT saving: the platform discards the probe residue for us.
            await flows.leaveBuilder(ctx, visit.name, 'discard calibration probes');
            await flows.enterBuilder(ctx, form.name, formPath);
            ctx.emit('calibrate', 'finding the control that really saves');
            await flows.calibrateSave(ctx, visit.name, form.name);
            await flows.confirmCalibration(ctx);
            calibrated = true;
          }

          await flows.cleanupSentinel(ctx);

          // Idempotency: if the form already holds this content, audit instead of rebuilding.
          const alreadyBuilt = form.fields.length > 0 && flows.findFieldText(ctx.doc, form.fields[0].label).length > 0;
          if (!alreadyBuilt) {
            for (const field of form.fields) {
              ctx.checkStop();
              const fieldPath = formPath + ' > "' + field.label + '"';
              if (await flows.buildField(ctx, field, fieldPath)) ctx.report.fields.built++;
            }
            // Skip logic second pass: every controller now exists.
            for (const field of form.fields) {
              if (!field.skip_logic) continue;
              ctx.checkStop();
              await flows.applySkipLogic(ctx, field, formPath + ' > "' + field.label + '"');
            }
            await flows.saveForm(ctx, formPath);
          } else {
            ctx.log('info', 'document already has content; auditing instead of rebuilding', formPath);
          }

          // Read-back: leave, reopen, audit the SAVED copy, repair once.
          await flows.leaveBuilder(ctx, visit.name, 'reopen to audit the saved copy');
          if (!(await flows.enterBuilder(ctx, form.name, formPath))) continue;
          ctx.emit('audit', visit.name + ' / ' + form.name);
          let issues = await verify.auditForm(ctx, form, formPath);
          ctx.report.audit.formsAudited++;
          ctx.report.audit.issuesFound += issues.length;
          if (issues.length > 0) {
            ctx.log('warn', issues.length + ' read-back issue(s); attempting repair', formPath);
            const attempted = await verify.fixIssues(ctx, form, formPath, issues);
            if (attempted > 0) {
              await flows.saveForm(ctx, formPath + ' (after repair)');
              await flows.leaveBuilder(ctx, visit.name, 'reopen to re-audit');
              if (await flows.enterBuilder(ctx, form.name, formPath)) {
                const remaining = await verify.auditForm(ctx, form, formPath);
                ctx.report.audit.issuesFixed += Math.max(0, issues.length - remaining.length);
                issues = remaining;
              }
            }
          }
          if (issues.length === 0) ctx.report.audit.formsClean++;
          else {
            ctx.report.audit.issuesOpen += issues.length;
            ctx.report.audit.openIssues.push(...issues);
            await ctx.ask({
              kind: 'audit-mismatch', irPath: formPath,
              question: 'After building and one repair round, "' + form.name + '" still differs from the input in ' + issues.length + ' place(s). Please review.',
              evidence: issues.slice(0, 12).map((i) => i.irPath + ': ' + i.kind + ' expected ' + JSON.stringify(i.expected) + ', got ' + JSON.stringify(i.actual)),
              options: [{ id: 'ack', label: 'Acknowledged, continue' }, { id: 'abort', label: 'Abort the run' }],
            }).then((r) => { if (r.optionId === 'abort') { const e = new Error('aborted at audit'); e.aborted = true; throw e; } });
          }
          await flows.leaveBuilder(ctx, visit.name, 'done with ' + form.name);
        }

        // 2c. Visit-screen row checks (repeating flag, presence).
        for (const form of visit.forms) {
          for (const p of verify.auditFormRow(ctx, form)) {
            ctx.report.audit.rowProblems.push(visit.name + ' / ' + form.name + ': ' + p);
          }
        }
        await flows.backToSchedule(ctx);
      }

      // 3. Final schedule-level checks.
      ctx.emit('final-audit', 'checking the schedule');
      await flows.ensureScheduleScreen(ctx);
      for (const visit of ir.visits) {
        for (const p of verify.auditVisitRow(ctx, visit)) {
          ctx.report.audit.rowProblems.push(visit.name + ': ' + p);
        }
      }
    } catch (err) {
      ctx.report.aborted = true;
      ctx.report.warnings.push('run ended early: ' + (err && err.message ? err.message : String(err)));
      ctx.log('error', 'run ended early: ' + (err && err.message ? err.message : String(err)), '');
    }
    // Skip rules verified = total minus rules the final audits still flag
    // (either the rule itself, or the whole field never made it in).
    const fieldHasRule = (label) => ir.visits.some((v) => v.forms.some((f) => f.fields.some((x) => x.label === label && x.skip_logic)));
    const openRuleCount = ctx.report.audit.openIssues.filter((i) =>
      i.kind === 'skip_logic' || (i.kind === 'missing' && fieldHasRule(i.expected))).length;
    ctx.report.skipRules.set = ctx.report.aborted ? ctx.report.skipRules.set : Math.max(0, ctx.report.skipRules.total - openRuleCount);
    ctx.report.finishedAt = new Date().toISOString();
    ctx.report.durationMs = Date.now() - start;
    ctx.emit('done', 'run finished in ' + Math.round(ctx.report.durationMs / 1000) + 's');
    return { report: ctx.report, trace, calib: summarizeCalib(ctx.calib) };
  }

  function summarizeCalib(calib) {
    const out = { typeMap: {}, saveControl: calib.saveDesc ? calib.saveDesc.name : null };
    for (const [canonical, entry] of Object.entries(calib.typeMap || {})) {
      out.typeMap[canonical] = { entry: entry.label, confidence: entry.confidence, evidence: entry.evidence };
    }
    return out;
  }

  NS.orchestrator = { run };
})();
