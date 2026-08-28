# Assumptions and questions for a clinical SME

The assignment says to write questions down rather than guess silently. These are the calls I made, why, and what I would ask a subject matter expert.

## Assumptions made

1. **Form reuse vs rebuild.** The IR repeats identical form definitions at multiple visits. Neither mock offers a way to attach an existing definition to a second visit, so the agent uses ensure-semantics: check whether a document with that name already exists under the visit, build it only if absent. On a platform that auto-attaches shared definitions the presence check would see them and skip. The agent never assumes either way; it looks.
2. **Activation is not part of "matching the input".** The IR has no lifecycle concept. Activating all 28 documents adds risk (active documents resist editing and deletion) with no fidelity gain, so built documents are left in Draft. The lifecycle machinery is still handled where it gates editing: if a document row offers no edit control, the agent looks for a new-version affordance and proceeds through it.
3. **Visit windows are entered as the raw day numbers** from the IR (for example -28 and -1), in whatever inputs match start and end concepts. No date arithmetic is attempted.
4. **Skip-logic comparison values are entered verbatim**: the option code for coded controllers, Yes or No for booleans, exactly as the IR specifies and the data README documents.
5. **Field order.** Fields are created in IR order on a single page; neither mock required explicit reordering. If a platform inserts out of order, the audit currently verifies presence and configuration but only weakly verifies order (this is a known gap, listed in the README).
6. **A re-run means verify and reconcile,** not rebuild: skip what matches, repair what differs, escalate what cannot be repaired.
7. **The paste format for bulk value entry** is guessed as `code=Label` per line only when no per-row editor exists, and the result is judged by read-back, never trusted.

## Questions I would ask a clinical SME

1. When the same form appears at four visits and the platform supports shared definitions, should an amendment to one visit's copy propagate to all visits? (Determines whether reuse is ever safe without sponsor sign-off.)
2. Is leaving built documents in Draft acceptable for study-build handoff, or does your workflow require Active before UAT? If Active is required, is activation order significant?
3. For `calculated` fields, should the formula be entered exactly as written in the protocol IR even when the platform has its own expression syntax, or should it be translated? (The agent currently enters it verbatim and flags nothing; a syntax mismatch would only surface at runtime.)
4. The IR marks some coded fields `required: false` while their skip logic makes them conditionally visible. Should "required" mean "required when visible" on this platform, and is that the regulatory expectation?
5. Are the mock's visit windows inclusive on both ends, and is day 0 baseline or first dose? (Affects nothing in the build, but a real system might validate windows.)
6. When a platform's element library has no analog for a canonical type (no time-only control, say), what is the preferred fallback: nearest richer type (datetime), a text field with a format hint, or stop and escalate? The agent currently escalates.
