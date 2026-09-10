# Iteration 4 — Scenario A

## Deliverable

Executed the one authorized real Codex/Luna run from the sheep-swarm checkout:

```sh
npm run swarm -- --runtime codex --worker-model gpt-5.6-luna \
  --workers 2 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 \
  --max-rounds 6 --timeout-ms 120000 --output .sheep/skill-eval/iter4-smoke
```

Saved evidence: `.sheep/skill-eval/iter4-smoke/` (`result.json`, `artifacts.json`, `calls.json`, `call-*.json`, `kernel-state.json`, and transcripts).

Actual fixture artifacts were accepted: `result.json.success=true`, `finalErrors=[]`, `completedArtifacts=3`, `writableArtifacts=3`, and `kernel-state.json` records `validation-8`, `validation-14`, and `validation-20` with `ok=true`, followed by `completion` with `ok=true`. All three lower calls have `outcome=committed`; no upper call occurred.

## Requirement achievement

1. **○** Real `swarm` CLI executed with the frozen profile: requested Luna, N=2, C=1, size=2, max 4 lower calls, zero upper calls, six rounds, 120000 ms timeout, and the fresh output path. It made 3 lower calls and no retry or model substitution.
2. **○** Acceptance was determined from saved evidence: three committed/writable artifacts, three passing validations, and a passing kernel completion. This is independent of the workers' text and the process result alone.
3. **○** Counts are separated: lower calls 3; upper calls 0; registered workers N=2; configured/observed maximum concurrency C=1; observed active workers 1 and `maxConcurrentModelCalls=1`.
4. **○** Each receipt has one `turn.completed` event and one normalized usage row with nonnegative integers: input/output tokens are (18991, 206), (18990, 215), and (19421, 256), totaling input 57402 and output 677. The saved `usageCompleteness` fields and `effectiveModelEvidence` are null; therefore effective model identity remains unknown, while terminal evidence makes these three final token counts known under the skill's Codex fallback rule. Unknown identity/marker is not reported as zero.
5. **○** This is the synthetic `measurement-migration-v1` fixture only. It does not demonstrate editing an arbitrary user repository, general dependency discovery, scale benefits, or cost superiority.

## Trace / phase checks

Trace understanding: **OK** (dependency obligations, versions, evidence epochs, leases, validations, and completion were present).

Planning: **OK** (the frozen profile was followed; no extra run).

Execution: **OK** (all lower calls completed, committed, and passed kernel validation; upper cap remained zero).

Formatting: **OK** (saved result, artifacts, calls, per-call receipts, kernel state, and transcripts are readable JSON artifacts).

## Structured unclear points

| Issue | Cause | General Fix Rule | Phase |
|---|---|---|---|
| `usageCompleteness` and `effectiveModelEvidence` are null in saved call records despite complete terminal receipts. | The Codex adapter does not emit those optional markers/evidence fields. | Classify usage from terminal execution, cancellation/timeout state, and exactly one normalized usage row; keep effective identity unknown unless emitted. | Reporting |
| Codex emitted a non-fatal “skill descriptions were shortened” event and stderr contained state-db fallback warnings. | Enclosing runtime state was noisy during app-server initialization; model calls still had terminal completion and no errors. | Treat these as evidence limitations/warnings unless they prevent terminal evidence or acceptance; do not retry solely for them. | Execution / Reporting |

These are instruction/evidence ambiguities or environment warnings, separate from the task result: the fixture itself passed its acceptance checks. No task failure was observed.

## Discretionary fill-ins

- Recorded runner-reported duration as an observation: 26380 ms; no canonical collaboration `usage.tool_uses` or `usage.duration_ms` was invented (unavailable).
- Reported actual observed activity separately from registered worker count and configured concurrency.
- Kept the requested model (`gpt-5.6-luna`) distinct from absent effective-model evidence.

## Retries

None. One bounded real run was executed.
