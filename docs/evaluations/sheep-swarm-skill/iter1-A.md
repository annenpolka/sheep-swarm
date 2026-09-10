# Iteration 1 — Scenario A

## Deliverable

- Command profile: `npm run swarm -- --runtime codex --worker-model gpt-5.6-luna --workers 2 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 --max-rounds 6 --timeout-ms 120000 --output .sheep/skill-eval/iter1-smoke`
- Output: `.sheep/skill-eval/iter1-smoke`
- Status: failed / incomplete; actual artifacts were not accepted.
- Evidence: `result.json` has `success:false`, `finalErrors:["pending-work","blocking-claims"]`, `completedArtifacts:0`, and `writableArtifacts:3`.
- Synthetic task: `measurement-migration-v1` migration fixture. This run edited no user's arbitrary repository and does not show scale or cost superiority.

## Requirement achievement

1. **○** Exact bounded real run: requested runtime/model, N=2, C=1, size=2, lower cap=4, upper cap=0, six-round cap, 120000ms timeout, and unique supplied output were used. No whole-run retry or model substitution.
2. **○** Evidence inspection and honest acceptance decision: inspected `result.json`, `artifacts.json`, `calls.json`, all four `call-*.json` receipts, `individuals.json`, and `kernel-state.json`. All four calls recorded `nonzero-exit`; receipts explain Codex CLI initialization failure (`readonly database` / `Operation not permitted`), with no stdout/events. Acceptance is therefore failed/incomplete, not inferred from the CLI summary.
3. **○** Counts are separated: lower calls=4, upper calls=0, registered workers N=2, configured/max observed concurrency C=1, observed `maxActiveWorkers`=1 and `maxConcurrentModelCalls`=1.
4. **○** Usage is incomplete/unknown: every call has `inputTokens:null`, `outputTokens:null`, `usageCompleteness:null`, and `effectiveModelEvidence:null`. Requested model is recorded as `gpt-5.6-luna`; effective model is unavailable. Null/unknown is not treated as zero.
5. **○** The report identifies this as the synthetic migration fixture and makes no claim of arbitrary-repository editing, general support, scale benefit, or cost superiority.

## Trace

Understanding: OK. Planning: OK. Execution: OK. Formatting: OK.

## Unclear points

- **Issue:** Why did all provider attempts fail before producing model events or usage?
  **Cause:** Codex CLI could not initialize its in-process app-server because `/Users/annenpolka/.codex/state_5.sqlite` was read-only; receipt also reports PATH alias permission failure. This is an execution-environment failure, not worker acceptance evidence. **General Fix Rule:** Preserve the failed receipts and stop at the bounded cap; report provider/kernel success separately from environmental failure. **Origin phase:** Execution.
- **Issue:** The output contains `writableArtifacts:3` but no accepted artifact.
  **Cause:** The kernel input artifact was staged, while worker obligations remained pending and blocking claims stayed open (`completedArtifacts:0`). **General Fix Rule:** Determine acceptance from completed artifacts, obligations/claims, and saved receipts, never from writable/staged content alone. **Origin phase:** Understanding.

## Discretionary fill-ins

- Kept the requested output directory exactly as supplied rather than adding a timestamp.
- Reported executor wall duration (`durationMs:1542`) only as saved run evidence; no unavailable canonical tool-use or duration metric was invented.

## Retries

- Whole-run retries: **0**.
- Same decision/target retries inside the single bounded run: `consumer-001.mjs` was attempted 3 times total (2 repeats after the same nonzero-exit); `consumer-002.mjs` was attempted once. These were runner assignments consumed under the requested lower-call cap, not new runs. No retry was made after inspecting the failure.
