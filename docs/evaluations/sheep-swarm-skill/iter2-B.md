# Scenario B diagnosis (iter2)

## Deliverable

Saved diagnosis for the supplied durable run. The four original evidence files were preserved byte-for-byte; no provider or model call was made, no lock was cleared, and no replacement run was started. The input directory itself gained SQLite sidecars during inspection, as disclosed below.

Evidence inspected:

- `.sheep/skill-eval/unknown-run-iter2/result.json`
- `.sheep/skill-eval/unknown-run-iter2/artifacts.json`
- `.sheep/skill-eval/unknown-run-iter2/call-1.json`
- `.sheep/skill-eval/unknown-run-iter2/state.sqlite`

The run is failed and incomplete, not accepted. `result.json` reports `success:false` with `finalErrors:["pending-work","token-usage-incomplete"]`. The durable snapshot has three pending obligations (`obligation-3`, `obligation-4`, `obligation-10`) and `usageLocked:true`; only `consumers/consumer-001.mjs` was committed. The other consumer and report remain stale in `artifacts.json`.

## Requirement achievement

1. **○** Read the saved report and receipt; rejected apparent success. The report records `success:false`, `pending-work`, and `token-usage-incomplete`. The receipt records `exitCode:0`, `timedOut:false`, and the worker note “Done; simulated exit 0 with unknown usage,” but its `usage` array is empty and `usageCompleteness` is `partial-or-unknown`.
2. **○** No model/provider calls were made. The supplied run has one existing lower call and zero upper calls; no resume, lock override, replacement run, or authentication/configuration change was performed.
3. **partial** The original four input evidence files remained byte-identical (author verification confirms their hashes match `iter2-B-before.json`), and this diagnosis is written separately. However, opening `state.sqlite` with the `sqlite3` CLI for read-only `.tables`, `.schema`, and `SELECT` inspection created `state.sqlite-wal` (empty) and `state.sqlite-shm` sidecars in the input directory. Thus original-file identity holds, while input-tree identity does not.
4. **○** Missing usage is unknown, not zero or free. The run is an injected synthetic fixture (`runtime: opencode-go`) and is not evidence of a live provider call or billing amount.
5. **○** The concrete blocker is the persistent unknown-usage lock (`usageLocked:true`, `usageUnknownCalls:1`, `token-usage-incomplete`) together with pending work. A C=1 durable resume cannot reconstruct unknown usage or make the pending parallel-style work complete; Docker cleanup is unrelated and unavailable for recovery.

## Trace

- Understanding: OK — identified the durable evidence, the false “done” signal, pending obligations, and unknown usage.
- Planning: OK — preserve the supplied run and produce an isolated diagnosis; do not admit another call.
- Execution: OK — inspected report, artifacts, receipt, SQLite snapshot; made no provider calls or input edits.
- Formatting: OK — this report contains the requested evidence, status, uncertainty, discretionary choices, and retries.

## Unclear points

- **Issue:** Whether “continue it if it is resumable” required invoking `--resume`.
  **Cause:** Resume itself would update durable state, while the scenario requires the original run files to remain byte-identical; the saved `usageLocked:true` state also makes new admissions invalid.
  **General Fix Rule:** Inspect the saved snapshot first; when unknown usage is locked, treat the run as non-resumable for new work and preserve the original evidence. **Origin phase:** Planning.

- **Issue:** Whether a read-only SQLite inspection is filesystem-pure.
  **Cause:** The `sqlite3` CLI opened the source database and SQLite created WAL/SHM sidecars even though no data mutation was requested.
  **General Fix Rule:** Treat SQLite inspection as potentially filesystem-affecting; record sidecars and distinguish source-file hashes from input-tree identity. **Origin phase:** Execution.

## Discretionary fill-ins

- Classified acceptance from persisted `success`/`finalErrors`, obligations, and usage evidence rather than the worker note or process exit.
- Reported only counts and token fields present in the supplied report; no canonical tool-use or duration metadata was invented.
- Treated the fixture as synthetic injected evidence and kept live-provider and billing conclusions out of the diagnosis.
- Disclosed the `sqlite3` read inspection and its generated `state.sqlite-wal` and `state.sqlite-shm` sidecars; no attempt was made to delete or restore them.

## Retries

None. The same decisions were not redone; no model call or replacement run was attempted.
