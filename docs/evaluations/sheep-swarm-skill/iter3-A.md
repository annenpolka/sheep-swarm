# Iteration 3 — Scenario A

## Deliverable

Executed the single bounded real Codex/Luna smoke from the sheep-swarm checkout.

Command:

```sh
npm run swarm -- --runtime codex --worker-model gpt-5.6-luna \
  --workers 2 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 \
  --max-rounds 6 --timeout-ms 120000 \
  --output .sheep/skill-eval/iter3-smoke
```

Output: `.sheep/skill-eval/iter3-smoke/`

Status: accepted. The run is the synthetic `measurement-migration-v1` fixture; its actual saved artifacts were accepted by the kernel.

## Requirement achievement

1. **○** Exact requested profile was executed once: Codex runtime, requested Luna model, N=2, C=1, size=2, lower cap 4, upper cap 0, six rounds, 120 seconds per call, and the supplied fresh output path. No whole-run retry or model substitution.
2. **○** Acceptance was determined from saved evidence: `result.json` records `success:true`, `finalErrors:[]`, `completedArtifacts:3`, and `writableArtifacts:3`; `artifacts.json` contains the three generated artifacts; `calls.json` and `call-1.json` through `call-3.json` contain receipts with `outcome:committed`, `exitCode:0`, `timedOut:false`, and `cancelled:false`.
3. **○** Counts remain distinct: lower calls 3, upper calls 0, interventions 0; registered workers N=2, configured concurrency C=1, observed `maxActiveWorkers`=1 and `maxConcurrentModelCalls`=1.
4. **○** Observed lower input tokens total 57,401 and output tokens total 646 (reasoning output fields total 198). Each receipt has one usage event, but `usageCompleteness:null` and `effectiveModelEvidence:null`; completeness and effective model identity are therefore unavailable, and unknown values are not treated as zero. Canonical collaboration `usage.tool_uses` and `usage.duration_ms` are unavailable.
5. **○** This is the synthetic migration fixture with a known dependency graph. It provides no evidence that an arbitrary user repository was edited, or that scale or cost superiority was demonstrated.

## Trace

Understanding: OK. Planning: OK. Execution: OK. Formatting: OK.

## Structured unclear points

- **Issue:** Effective provider model identity is unavailable in the receipts (`effectiveModelEvidence:null`). **Cause:** The runner records the requested model, while this Codex CLI invocation emitted no effective identity field. **General Fix Rule:** Preserve requested and effective model fields separately; report effective identity as unavailable when absent. **Phase:** Execution/evidence inspection.
- **Issue:** Usage completeness is unavailable (`usageCompleteness:null`). **Cause:** Receipts contain observed token fields and usage events but no completeness marker. **General Fix Rule:** Report observed tokens and unknown completeness separately; never infer complete usage or zero usage. **Phase:** Execution/evidence inspection.
- **Issue:** The CLI summary's activity count could be conflated with configured registration. **Cause:** The run registers two workers but observed activity is bounded by C=1. **General Fix Rule:** Report registered N, configured C, and observed activity as separate values. **Phase:** Understanding.

## Discretionary fill-ins

- Used the exact supplied output directory and retained the run evidence files.
- Used narrowly scoped elevated permission for the exact command because Codex state initialization requires access outside the enclosing sandbox; worker model, tools, and limits were unchanged.
- Saved runner duration was 31,664 ms; this is an observed run value, not canonical `usage.duration_ms`.

## Retries of same decisions

None. The bounded run was executed once; no provider or whole-run retry was made.
