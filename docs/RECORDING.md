# Screen recording

The submission calls for a 2 to 3 minute unedited recording of one end-to-end run including the human gate. A full run takes about 2 minutes, so it fits in one take.

Suggested script (macOS: QuickTime Player, File > New Screen Recording, or Cmd+Shift+5):

1. Start with the extension loaded and the mock open at http://localhost:5173/ (empty Visit Schedule visible).
2. Open the side panel, load `takehome/data/abc-101-study.ir.json`, and press **Run against this tab**.
3. Let it run. Narration is optional; the trace panel shows what it is doing (calibration probes, the save persistence probe, per-form builds and audits).
4. To guarantee the human gate appears on camera even on a clean run, either:
   - run against `site/mock-a2` (three type-mapping cards appear naturally and show the evidence UI), or
   - answer any escalation card that appears during calibration.
5. End on the final report (learned type map, 28/28 clean audits) and click through one built form in the mock.

The same take can be captured with zero setup on the hosted demo page (`demo.html`), which shows the identical gate and report; the extension version is the one the assignment asks for.

Recording file, once captured, goes here as `docs/recording.mp4` (or a link to a hosted video).
