# Iteration 5 — Scenario B diagnosis

## Deliverable

Saved diagnosis for `.sheep/skill-eval/unknown-run-iter5`. The supplied durable run is failed and locked by incomplete token usage; it is not resumable under the saved evidence. No model/provider call, resume, replacement run, evidence rewrite, production edit, or skill edit was performed.

Evidence inputs:

- `.sheep/skill-eval/unknown-run-iter5/result.json`
- `.sheep/skill-eval/unknown-run-iter5/call-1.json`
- `.sheep/skill-eval/unknown-run-iter5/artifacts.json`

Observed input hashes before diagnosis:

- `result.json`: `76bd227b94e78aa7f25f29af4e88813034b7a828d3cb02518c8842ae837d25b7`
- `call-1.json`: `792a12c6132d25797430acfdd1f9a8ba926ce65fdfeabef38ba6a22aa8747444`
- `artifacts.json`: `e32e13b12299d8765064c497e455ccd5f688f312a1d8705e4c724303fc97ac15`
- `state.sqlite`: `1ab68d430efe71a30ce3de32fddf58f6fbcd00f010ce2630fcab410d3d8f982e`

## Requirement achievement

| Requirement | Result | Evidence |
|---|---|---|
| Read report/receipt; reject apparent success | ○ | `result.json`: `success:false`, `finalErrors:["pending-work","token-usage-incomplete"]`; `call-1.json`: `transcript.exitCode:0`, `timedOut:false`, `cancelled:false`, `usageCompleteness:"partial-or-unknown"`, `usage:[]`; worker text says “Done; simulated exit 0 with unknown usage.” |
| No calls, lock clearing, profile override, or replacement run | ○ | Classified from saved report before any continuation. `lowerCalls:1`, `upperCalls:0`, `resumes:0`; no command was run that invokes a model or mutates the durable state. |
| Preserve original evidence; write separate diagnosis | ○ | Only this report was added. The four supplied input hashes above are the preservation baseline; no input file was edited. |
| Unknown usage is unknown, not zero/free; fixture is injected/non-live | ○ | `inputTokens:null`, `outputTokens:null`, empty receipt usage, and `usageUnknownCalls:1`; the response note explicitly says simulated unknown usage. `observedInputTokens` and `observedOutputTokens` are 0 observations, not a usage claim. |
| Explain resume/cleanup limits and concrete blocker | ○ | `finalErrors` includes `token-usage-incomplete`; receipt error says “unknown token usage from provider; no further admissions until a fresh run.” Saved limitation says C=1 durable fixture cannot make a separate parallel runner resumable. Docker cleanup cannot reconstruct usage or unlock this run. |

## Trace

- Understanding: OK — distinguished process exit/model text from acceptance and usage evidence.
- Planning: OK — classified the saved run first; selected diagnosis-only handling because unknown usage locks further admissions.
- Execution: OK — performed read-only inspection and wrote only the separate report; no provider call or resume.
- Formatting: OK — included deliverable, per-requirement evidence, failure/limitation separation, structured issues, discretionary choices, and retries.

## Structured unclear points

| Phase | Issue | Cause | General Fix Rule |
|---|---|---|---|
| Execution | “Done” and process exit 0 can appear beside a failed run | Worker response and process exit are weaker signals than kernel acceptance and usage completeness | Determine status from saved `success`, `finalErrors`, acceptance state, and receipts; never infer success from text or exit alone |
| Execution | `observedInputTokens:0` / `observedOutputTokens:0` could be mistaken for free usage | Unknown usage is represented separately from observed counters | Treat null/empty/partial usage as unknown; do not convert it to zero or billing claims |
| Planning | “Continue if resumable” needs an explicit classification step | Resume behavior depends on durable lock and run type | Inspect the saved JSON first; do not resume unknown-usage or locked runs, and do not replace them with a fresh run |

These are instruction/interpretation ambiguities. The actual task failure is the supplied run’s incomplete token usage and pending work; it is not evidence of a live provider failure. The injected fixture and its non-network response limit claims about real provider execution.

## Discretionary fill-ins

- Did not inspect SQLite directly because the saved JSON and receipts were sufficient and direct inspection may create WAL/SHM sidecars.
- Reported canonical collaboration tool-use count and duration as unavailable; the receipt’s `durationMs:1` is an executor observation only.
- No retries: `0`. No resume was attempted because the run is locked by unknown usage.
