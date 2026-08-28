# By-hand verification results

Method for every run: reset the mock, run the agent end to end, then compare the mock's `__readState()` output against `abc-101-study.ir.json` with a field-by-field diff. The diff checks visit presence and windows, form presence and repeating flags, and for each of the 195 fields: label, canonical type, required, min, max, units, formula, every coded value's code and label in order, the skip-logic controller label and comparison value, plus detection of extra elements not in the input. The agent itself never touches `__readState`; it is used only here, to check the agent's work from outside.

The diff harness is `site/test.html` (`?mock=a`, `?mock=a2`, `?mock=b`). The interactive demo is `site/demo.html`.

## Final results (same agent build, no code changes between runs)

| Run | Result |
|---|---|
| Mock A, clean state | 4/4 visits, 28/28 forms, 195/195 fields, 13/13 skip rules. Read-back audit: 28/28 clean. Ground truth diff: 0 missing, 0 mismatches, 0 extras. 0 escalations, 0 warnings. 123 s. |
| Mock A, immediate re-run (idempotency) | 0 created, 0 rebuilt, no duplicates; 28/28 forms re-audited clean. 26 s. |
| Mock A2 (mutated A: palette renamed, save renamed "Apply Changes" and moved, screen retitled) | Same totals, 0 ground-truth differences. 3 type-mapping escalations raised; in each the agent's suggested entry was correct and accepted. 123 s. |
| Mock B (different platform written for this test) | Same totals, 0 ground-truth differences, 0 escalations. 107 s. |

Learned type map on A2 (all correct): calculated to "Derived Result", multi_select to "Multiple Answers", checkbox to "Tick Box", date to "Calendar Day", datetime to "Calendar Day + Clock", single_select to "Select One (Menu)", textarea to "Paragraph Box", decimal to "Fraction Number", integer to "Round Number", radio to "One-Choice Buttons", text to "One-Line Box", time to "Clock", boolean to "True/False Switch". Save control: "Apply Changes", confirmed by persistence probe.

## Bugs found on the way (kept here because the failures are the interesting part)

Each of these produced a bad run first and a fix second. All were found by the read-back audit or the ground-truth diff, not by reading code.

1. **Schedule-screen false positive.** Any button with an "add" word satisfied the "am I on the schedule screen" check, so after building visit 1 the agent thought the visit page was the schedule and silently skipped visits 2 through 4. Fixed by requiring visit-concept evidence in the control's name or context. Symptom in the bad run: 46/195 fields, three "could not open the visit" warnings.
2. **Renames landing in inert preview inputs.** After a re-render, the previous element's preview control (whose accessible name had just become that element's label) showed up in the appeared-diff and won the label-input ranking. The rename went into a dead input; audit later showed default-named elements and rebuild orphans. Fixed by excluding controls without explicit label association from the appeared pool and falling back to whole-document ranking.
3. **Repair loop deleted a field.** The audit's values reader counted the skip-logic "Equals Value" input as a phantom value row; the repair loop cleared real rows chasing it, ran out of row-remove buttons, clicked "Delete Element", and destroyed the field. Fixed three ways: strong-token threshold for code inputs, never clicking element-level delete controls while clearing rows, and stopping when the row count stops shrinking.
4. **Palette detection missed card layouts.** Cluster detection used `closest(...)` from the item itself, so `div[role="button"]` palette entries each matched themselves and no cluster formed on mock B. Fixed by starting from the parent.
5. **Explicit-label bonus promoted zero-score candidates.** A +0.5 preference for explicitly labelled inputs pushed concept-score-zero inputs past the positivity filter, so on mock B the first "Lowest Accepted" input that appeared received the field's label. Mock A had only been passing because its panel is named "Options", which a context penalty happened to catch. Fixed by making the bonus a tie-breaker that applies only to already-positive candidates.
6. **Skip-logic pass could not select the last-built field.** The mock does not repaint a card title while you type, so the final field of a form still displayed its default label when the skip pass tried to click it by name. Fixed by treating "the live config panel already shows this label" as selected.

## Remaining soft spots

- Field order within a form is only weakly verified (presence and configuration are strict; ordering is not diffed by the in-run audit, only by this external diff, which found no order problems on these mocks).
- Repeating-flag read-back on the visit screen is a text heuristic over the row; on both mocks it reads correctly, but a platform that displays the flag nowhere would leave creation-time tracing as the only evidence.
- `hidden` is set only when the IR implies it (it never does in this input); the mock's Hidden toggle is otherwise untouched.
