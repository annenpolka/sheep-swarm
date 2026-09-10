# Iteration 5 — Scenario A

## Deliverable

Command executed once from the sheep-swarm checkout:

```sh
npm run swarm -- --runtime codex --worker-model gpt-5.6-luna \
  --workers 2 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 \
  --max-rounds 6 --timeout-ms 120000 --output .sheep/skill-eval/iter5-smoke
```

The process exited 0 and wrote [`.sheep/skill-eval/iter5-smoke/result.json`](../../../.sheep/skill-eval/iter5-smoke/result.json), `artifacts.json`, `calls.json`, three `call-*.json` receipts, and three transcript outputs. `result.success` is `true`, `finalErrors` is empty, and `completedArtifacts`/`writableArtifacts` are both 3. The synthetic migration fixture's actual artifacts were accepted by the kernel.

## Requirement achievement

1. **○** Real bounded `swarm` execution: requested runtime `codex`, worker model `gpt-5.6-luna`, N=2, C=1, size=2, max lower calls=4, upper calls=0, max rounds=6, timeout=120000 ms, and one fresh output directory. Exactly one run was launched; no provider/model substitution or whole-run retry.
2. **○** Evidence inspection: `result.json`, `artifacts.json`, `calls.json`, all three call receipts, and all three transcript outputs were inspected. Acceptance is based on saved result and artifact counts, not worker text or process exit alone.
3. **○** Counts are separated: lower calls=3, upper calls=0, registered workers N=2, maximum concurrency C=1, observed maximum active workers=1, maximum concurrent model calls=1, rounds=4.
4. **○** Usage is distinct from zero: each receipt has `turn.completed`, exitCode=0, no timeout/cancellation, and exactly one normalized usage row. Fallback known totals are call-1 18,988 input / 193 output, call-2 18,987 / 260, call-3 19,403 / 240; aggregate 57,378 input / 693 output. The saved `usageCompleteness` and `effectiveModelEvidence` fields are null, so requested Luna is reported separately from unverified effective identity. Canonical `usage.tool_uses` and `usage.duration_ms` are unavailable; the saved 32,674 ms is only an executor observation.
5. **○** This proves the synthetic `measurement-migration-v1` fixture only. It does not show that an arbitrary user repository was edited, nor establish scale or cost superiority.

## Trace

Understanding: OK
Planning: OK
Execution: OK
Formatting: OK

## Actual task failures and evidence limitations

No task failure occurred: the bounded run completed and the three generated artifacts were accepted. Evidence limitations are that the saved `usageCompleteness` and `effectiveModelEvidence` markers are null, and canonical collaboration `usage.tool_uses`/`usage.duration_ms` are unavailable. The receipt fallback still establishes the three final token rows as known; effective model identity remains unverified.

## Instruction ambiguities

The phrase “usage completeness” can mean the raw saved marker or the skill's receipt-based fallback. This report gives both so a null marker is not misreported as unknown usage or as zero.

## Structured unclear points

| Phase | Issue | Cause | General Fix Rule |
|---|---|---|---|
| Evidence reading | `usageCompleteness` and `effectiveModelEvidence` are null despite complete terminal receipts. | The saved CLI schema omits those markers for this Codex adapter; the skill separately defines a receipt-based fallback. | Report raw marker fields and fallback conclusion separately; never turn absent identity into confirmed identity or absent usage into zero. |
| Reporting | The run contains `durationMs`, while the evaluation asks for canonical duration metadata unavailable from the collaboration API. | Executor output and canonical collaboration metrics are different sources. | Label saved wall time as an observation and record unavailable canonical metrics; do not invent `tool_uses` or `duration_ms`. |

## Discretionary fill-ins

- Used the skill's standard bounded smoke profile with the scenario's exact limits and a new supplied output path.
- Inspected all saved evidence files present under the output directory.
- Did not run `npm ci`; dependencies were available and the task did not change them.

## Retries

Whole-run retries: 0. Model-call retries: 0. Additional provider runs: 0.
