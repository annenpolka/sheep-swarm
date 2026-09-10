# Iteration 2 — Scenario A

## Deliverable

Executed the single bounded real Codex/Luna smoke from the sheep-swarm checkout.

Command:

```sh
npm run swarm -- --runtime codex --worker-model gpt-5.6-luna \
  --workers 2 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 \
  --max-rounds 6 --timeout-ms 120000 \
  --output .sheep/skill-eval/iter2-smoke
```

Output: `.sheep/skill-eval/iter2-smoke/`

## Requirement achievement

1. **○** Exact requested profile was executed once: Codex runtime, requested Luna model, N=2, C=1, size=2, lower cap 4, upper cap 0, six rounds, 120 seconds per call, fresh output path. No whole-run retry or model substitution.
2. **○** Actual saved evidence was inspected: `result.json` records `success: true`, `finalErrors: []`, `completedArtifacts: 3`, and `writableArtifacts: 3`; `artifacts.json` contains all three generated artifacts; `calls.json` and `call-1.json` through `call-3.json` contain receipts, each with `exitCode: 0`, `timedOut: false`, and `outcome: committed`.
3. **○** Counts are kept distinct: lower calls 3, upper calls 0, interventions 0; registered workers N=2, configured concurrency C=1, observed `maxActiveWorkers`=1 and `maxConcurrentModelCalls`=1.
4. **○** Usage is reported without inventing metadata. Observed lower input tokens: 57,424; observed output tokens: 758 (reasoning output fields sum to 187). Receipt `usageCompleteness` is null and effective model evidence is null, so completeness and effective identity are unavailable; these nulls are not treated as zero.
5. **○** This is the synthetic `measurement-migration-v1` fixture. It demonstrates acceptance for this known dependency graph only; it does not show arbitrary repository editing, general dependency discovery, scale benefit, or cost superiority.

## Trace

Understanding: OK. Planning: OK. Execution: OK. Formatting: OK.

## Unclear points

- **Issue:** Effective provider model identity is unavailable in the receipts (`effectiveModelEvidence: null`). **Cause:** The runner records the requested model but this Codex CLI invocation emitted no effective identity field. **General Fix Rule:** Preserve requested and effective model fields separately and report effective identity as unavailable when absent. **Origin phase:** Execution/evidence inspection.
- **Issue:** Usage completeness is unavailable (`usageCompleteness: null`). **Cause:** The receipts contain observed input/output token fields but no completeness marker. **General Fix Rule:** Report observed tokens and unknown completeness separately; never infer complete usage or zero usage. **Origin phase:** Execution/evidence inspection.

## Discretionary fill-ins

- Used the exact supplied output directory and retained all generated evidence files.
- Used the narrowly scoped elevated execution permission required for Codex state initialization in this environment; worker profile and limits were unchanged.
- Process wall time was approximately 27.2 seconds (`durationMs: 27195` in the saved result).

## Retries

None. The bounded run was executed once.
