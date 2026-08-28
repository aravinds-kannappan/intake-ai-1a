# Intake Take-Home 1a: a study-builder agent for any eSource

A Chrome extension that reads a study specification (IR JSON) and builds the whole study inside an eSource platform through its UI: visits, source documents, all 195 fields with types, labels, required flags, coded values, ranges, units, formulas, and skip logic. It is written against *concepts*, not against any particular platform's DOM. The same extension, with no code changes, produces a byte-identical study on three different platform surfaces (the assignment mock, a mutated version of it, and a second mock I wrote with different vocabulary, layout, and navigation).

**Live demo (no install needed):** the `site/` directory is deployed on Vercel and runs the identical agent core against either mock in an iframe, with the human gate, trace, and report fully working in the browser. Open `demo.html` there, pick a mock, press Run.

- `extension/` the Chrome extension (Manifest V3, plain JS, no build step)
- `site/` the hosted demo site (static; the same core files, a demo page, both mocks)
- `site/mock-b/` a second eSource platform I wrote as generalization evidence
- `docs/` assumptions, SME questions, and by-hand verification results
- `takehome/` the provided assignment materials (mock A and the input file)

## Running it

### The extension (the actual deliverable)

1. Run the provided mock:
   ```bash
   cd takehome/esource-mock && npm install && npm run dev
   ```
   and open http://localhost:5173/.
2. In Chrome: `chrome://extensions`, enable Developer mode, **Load unpacked**, select the `extension/` folder.
3. Open (or reload) the mock's tab, then click the extension's toolbar icon to open the side panel.
4. Load `takehome/data/abc-101-study.ir.json` in the panel and press **Run against this tab**.

The panel shows live progress, a trace of every action, escalation cards when the agent wants a human decision, and a final report with the learned type map and audit results. Report and trace are downloadable as JSON.

Optional: an Anthropic API key can be entered in the panel. When present, type-mapping escalations are first offered to Claude (claude-sonnet-5 by default) with exactly the evidence a human would see; confident answers are taken, everything else still comes to the human. The agent is fully functional without it; all results below were produced without an API key.

### The web demo

Serve `site/` with any static server (`python3 -m http.server` works) or use the Vercel deployment. `demo.html` runs the same seven core files the extension loads, against `mock-a`, `mock-a2`, or `mock-b` in an iframe. `test.html` is the raw development harness.

## Architecture: perceive, decide, act, confirm

The core is seven dependency-free JS files shared verbatim between the extension and the site (`extension/core/`, mirrored in `site/agent/`).

**Perceive** (`snapshot.js`). The page is read into a list of *affordances*: every visible interactive element with its role kind (button, textbox, select, checkbox...), its accessible name (aria-label, `label[for]`, wrapping label, text content, placeholder), its current value and options, whether it has an explicit label association, whether it is in a modal, and a context chain of the headings and fieldset legends that scope it. There is not a single CSS class, element id, or hardcoded control label anywhere in perception. Two derived operations do most of the work: an *appeared diff* (which affordances exist now that did not exist before the last action) and exact-text search for names coming from the IR.

**Decide** (`lexicon.js`, `flows.js`). Actions are chosen by scoring affordance names against concept vocabularies: *visit* (visit, encounter, timepoint...), *form* (form, document, instrument, crf...), *save* (save, commit, apply... with negatives for template, preview, activate, local, draft), *values*, *condition*, and about twenty-five more. Candidates are ranked; only positive-margin matches are acted on; ambiguity below a threshold becomes an escalation. IR names (visit names, form names, field labels) are always matched by exact text, never substring, so "Concomitant Medications" cannot match inside "Prior and Concomitant Medications".

**Act** (`actions.js`). Clicks and typing dispatch real event sequences (pointer/mouse events, native value setters plus input/change) so framework-bound pages hear them. Every control is re-resolved by kind and accessible name at act time, because platforms re-render freely and node identity is worthless. After each action the agent waits for DOM mutations to go quiet. Waiting is built on MessageChannel tasks rather than timers, because background tabs clamp `setTimeout` to a second or more and a run should not slow down thirtyfold when the user switches tabs.

**Confirm** (`verify.js`). Nothing is assumed persisted. After a form is built and saved, the agent leaves the builder, reopens it, selects every field on the canvas, and reads the whole configuration back out of the live controls: label, type, required, min/max/units, formula, every value row's code and label in order, and the visibility rule. Differences from the IR become issues; fixable ones are repaired in place, saved, and re-audited once; anything that survives becomes an escalation and stays in the report as an open issue.

**Orchestration** (`orchestrator.js`). Visits first, then all documents under each visit, then a builder session per document. Fields are built in IR order with the type chosen at creation time and never changed afterwards, because platforms silently discard values, ranges, and formulas on type changes. Skip logic is a second pass per form, after every controller already exists, which dissolves the build-order problem. Every action, verification, and decision lands in an exportable trace with the IR path it came from, so each built element is traceable to the input entry that caused it.

## Type mapping: an experiment, not a string match

On entering the first form designer the agent runs a calibration phase:

1. **Palette discovery.** It looks for a cluster of six or more sibling clickable items whose container context smells like an element library, with a fallback to any large button cluster.
2. **Probing.** It clicks every entry once and watches what appears: a coded values editor? min/max inputs? a decimal-places input? a formula box? What does the preview control render (a select, radio inputs, one tick box, a textarea, yes/no buttons, date or time entry)? Config controls are excluded from preview evidence by two independent signals (explicit label wiring, and config-concept names per control kind). Entries that do nothing are marked inert, which is how the trap "Import From Library..." entries get filtered out. Each probe is deleted afterwards, and the whole calibration happens in a working copy that is deliberately abandoned by navigating away, so the platform's own discard-on-navigate behavior cleans up anything that could not be deleted.
3. **Classification.** Observed facets place an entry in a semantic group (coded, numeric, formula, plain); the label lexicon and preview evidence disambiguate within the group; the margin between the top two candidates becomes a confidence. Low confidence goes to the human gate with the evidence spelled out.

This is what defeats the deliberate adjacencies. "Check List" vs "Checkbox": one grows a values editor, the other renders a single tick and no values section. "Number (Decimal)" vs "Number (Whole)": one shows a decimal-places input. On mock B, "Tally Counter" and "Measurement" have no useful tokens at all and are classified purely by probe behavior; "Moment Picker" is classified by its `datetime-local` preview input.

**Saving is calibrated the same way.** The agent builds a sentinel field, renames it, clicks the best save candidate, leaves the builder, reopens it, and checks whether the sentinel survived. "Save As Template" and "Store Draft Locally" both fail this probe; the control that actually persists gets memoized for the rest of the run. The word "save" is never trusted: on the mutated mock the real control is called "Apply Changes" and is found anyway.

## The human gate

Principle: **confident work proceeds; everything else pauses with evidence.** The agent escalates:

- a type mapping whose confidence margin is below threshold, showing the probe evidence for every palette entry and its own suggestion;
- a missing control it needs (no repeating toggle on the create dialog, no visible range inputs, no visibility editor), with the options it did see;
- a skip-logic controller that is not offered by the condition editor;
- a flow it cannot complete (cannot find the schedule screen, cannot create a visit, cannot open a designer), with what it tried, plus "I did it by hand, continue" options;
- any form that still differs from the input after building, one repair round, and a re-audit.

The reviewer sees one card at a time: the question, the IR path, the evidence, and concrete options with the suggestion marked. Decisions that recur (for example which of two unlabeled inputs is the code column) are asked once and remembered for the run. Every escalation and its resolution is recorded in the report. On both mocks a clean run needs zero interventions, so a reviewer's queue contains only real problems, not 195 confirmations.

## Generalization: what I did and the evidence it works

What generalizes it: concept vocabularies instead of selectors, exact-name matching for IR content, appeared-diffs instead of assumed screen layouts, empirical calibration (probe the palette, probe the save button) instead of trusting labels, read-back instead of trusting actions, and re-resolution of every control at act time.

Evidence, all with the same code and the same input file:

| | Mock A (assignment) | Mock A2 (mutated A) | Mock B (mine, unseen shape) |
|---|---|---|---|
| Surface differences | baseline | palette renamed ("Select One (Menu)", "Fraction Number", "Tick Box"...), save renamed "Apply Changes" and moved, screen retitled | everything: Encounters/Instruments/Question Palette, cards + `role="button"` divs instead of tables/buttons, modals, wrapped labels, "Commit Changes" + fake "Store Draft Locally", full re-render on every interaction, no type selector in the options panel |
| Visits / forms / fields built | 4/4, 28/28, 195/195 | 4/4, 28/28, 195/195 | 4/4, 28/28, 195/195 |
| Skip rules | 13/13 | 13/13 | 13/13 |
| Forms passing read-back audit | 28/28 | 28/28 | 28/28 |
| Ground-truth diff vs input (via each mock's `__readState`, used only for verification by hand, never by the agent) | 0 differences | 0 differences | 0 differences |
| Escalations raised | 0 | 3 type mappings (each resolved by accepting the agent's own suggestion, all correct) | 0 |
| Duration | about 2 min | about 2 min | about 2 min |

A second run over an already-built study creates no duplicates: 0 fields rebuilt, 28/28 forms re-audited clean in about 25 seconds. That is what a re-run means here: verify everything, touch nothing that matches, repair what does not.

Honest note: mock B was written by me, so it shares my blind spots even though I wrote it to be adversarial (it caught five real bugs in the agent before it passed; see `docs/VERIFICATION.md` for the list). The two hardest known gaps for a genuinely foreign platform are listed under "Where it breaks".

## By-hand verification

For each mock I ran the extension end to end, then compared `__readState()` output against the input file with a field-by-field diff (visit windows, repeating flags, labels, types, required, min/max/units, formulas, value code+label pairs in order, skip-logic controller and comparison value, plus extra-element detection). Result: zero differences on all three surfaces, and no extra elements. The diff tooling lives in `site/test.html`; full notes in `docs/VERIFICATION.md`.

## Where it breaks, and what it does when it breaks

Known limits, found by testing, not hypothesized:

- **Custom widgets with no semantics.** Perception keys on roles and accessible names. A palette of bare `<div>`s with no `role` and no labels is invisible; the run escalates "no element palette found" and stops that form. It cannot silently build the wrong thing there, but it cannot build anything either.
- **Canvas-only builders.** If the field list is a `<canvas>` or image (some commercial designers), text-based perception is blind. The gate fires; a human builds by hand.
- **Bulk value entry formats.** Per-row entry is preferred because it is structural. If a platform only offers a bulk paste box, the agent guesses `code=Label` lines and lets the read-back audit judge the outcome; a wrong guess becomes a values mismatch that is repaired row by row or escalated. On an exotic format with no per-row editor it would escalate every coded field, which is slow but safe.
- **Iframed or shadow-DOM builders.** The extension operates on the top document. A designer inside a cross-origin iframe or closed shadow roots is out of reach today (open shadow roots and same-origin frames are a listed next step).
- **Async platforms with silent background saves.** Settle-detection waits for DOM quiet up to a timeout. A platform that acknowledges saves seconds later with no DOM change could be read back too early; the audit would flag the mismatch, possibly spuriously.
- **The repair loop is deliberately conservative.** During development an over-eager repair once deleted a field it meant to fix (a phantom "values row" reading). Repairs are now guarded (strong-token thresholds, monotonic progress checks, never clicking element-level delete controls while clearing rows), and anything not clearly fixable is escalated instead of retried.

Failure behavior is always one of: try the next candidate, escalate to the human with evidence, or record an open issue in the report. It does not silently continue past a failed verification.

## How long a full run takes

About 2 minutes per mock for the full study (4 visits, 28 forms, 195 fields, 13 skip rules), including calibration, per-form read-back audits, and the final schedule audit. A verification-only re-run is about 25 seconds. Runs keep full speed in background tabs (waits are MessageChannel-based, so timer throttling does not apply).

## What I would build next with two more weeks

1. **An LLM fallback tier for perception,** not just for escalation triage: when concept scoring finds nothing (the bare-div palette case), send the distilled affordance snapshot to a model and let it nominate candidates, which the same probe-and-verify machinery then confirms. Calibration stays empirical; the model only proposes.
2. **Shadow DOM and same-origin iframe traversal** in the snapshot layer.
3. **Batch review UX:** group similar escalations (all 26 single-select mappings) into one decision, and a post-run review screen that walks the reviewer through open issues with deep links into the platform.
4. **Resumable runs:** persist the trace and calibration so a crashed or stopped run continues from the last verified form instead of re-auditing from the top.
5. **A conformance suite of hostile mocks** (canvas palette, async saves, paginated forms, virtualized lists, drag-to-add designers) run in CI against the core.
6. **Property-based IR fuzzing:** generate random studies, build them, read them back, diff.

## AI tools used

The agent itself is deterministic (lexicons, probes, read-back); the optional Claude escalation assist is clearly labeled and off by default. The code, the second mock, and these documents were written with Claude (Anthropic) as the coding assistant, iterating against live runs in a browser harness. Where it helped: writing the concept lexicons and the probe classifier quickly, and relentless test-fix loops against the mocks (five distinct real bugs found and fixed in an afternoon: a schedule-screen false positive that silently skipped three visits, renames landing in inert preview inputs, a repair loop that deleted a field via a phantom values-row reading, palette detection failing on card layouts, and an explicit-label bonus that promoted zero-scoring candidates). Where it got in the way: early drafts leaned on the appeared-diff for things that are not guaranteed to appear (the label input when a panel persists between elements), which looked clever and was wrong; the fix in every case was less cleverness and more read-back.

## Screen recording

`docs/RECORDING.md` describes the 2 to 3 minute end-to-end recording (one full run with the human gate exercised). If the video file is not in the repo yet, record it by following those steps; the demo page makes it a one-take job.
