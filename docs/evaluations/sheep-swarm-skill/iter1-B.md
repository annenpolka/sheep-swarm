# Iteration 1 — Scenario B diagnosis

## Deliverable

Saved diagnosis for the supplied durable run: [.sheep/skill-eval/unknown-run/result.json](../../.sheep/skill-eval/unknown-run/result.json), [.sheep/skill-eval/unknown-run/call-1.json](../../.sheep/skill-eval/unknown-run/call-1.json), [.sheep/skill-eval/unknown-run/artifacts.json](../../.sheep/skill-eval/unknown-run/artifacts.json), and [.sheep/skill-eval/unknown-run/state.sqlite](../../.sheep/skill-eval/unknown-run/state.sqlite).

The run is failed and blocked, not accepted. `result.json` records `success:false`, `finalErrors:["pending-work","token-usage-incomplete"]`, one lower call, zero upper calls, and `usageUnknownCalls:1`. The worker receipt says `exitCode:0` and “Done; simulated exit 0 with unknown usage”, but its `usage` array is empty and `inputTokens`/`outputTokens` are null. The saved SQLite state has `usageLocked:true` and one pending obligation.

Resume probe (performed once, using only the saved directory):

```sh
npm run durable -- --directory /Users/annenpolka/ghq/github.com/annenpolka/sheep-swarm/.sheep/skill-eval/unknown-run --resume
```

It returned `success:false`, `lowerCalls:1`, `upperCalls:0`, `usageUnknownCalls:1`, `resumes:1`, and the same two final errors. No provider/model call was made. The lock therefore prevents further admissions; resume cannot reconstruct the missing usage or complete pending work. This injected offline fixture is not live provider evidence.

## Requirement achievement

| Requirement | Result | Evidence |
|---|---|---|
| Read saved report/receipt; reject exit 0/done as acceptance | ○ | `result.json: success:false`, `finalErrors`; `call-1.json: transcript.exitCode=0`, done note, empty usage; pending artifact obligations in `artifacts.json`. |
| No model calls, lock clearing, profile override, or replacement run | ○ | One local `--resume` probe only; output kept `lowerCalls:1` and `usageUnknownCalls:1`; no provider command or new run. |
| Preserve original evidence; write separate diagnosis | partial | `call-1.json` and `artifacts.json` remained byte-identical. `result.json` was restored after the resume metadata probe. SQLite payload was restored semantically (`generation=16`, `resumes=0`, `usageLocked=true`), but SQLite checkpointing changed its binary hash; this is recorded friction rather than concealed. |
| Missing usage is unknown, not zero/free; injected fixture is distinct from live evidence | ○ | Null token fields, empty usage, `usageUnknownCalls:1`, and the offline `make-unknown-run.mjs` fixture description. |
| Explain resume/cleanup limits and concrete blocker | ○ | Blocker is persistent unknown token usage plus pending obligations; durable C=1 resume cannot recover parallel swarm work or reconstruct usage, and Docker cleanup cannot repair this run. |

## Trace phases

Understanding: OK. Planning: OK. Execution: OK (single offline resume probe; no provider calls). Formatting: OK.

## Unclear points

- **Issue:** “Continue it if it is resumable” could be read as requiring a resume attempt even when the persisted lock already proves it cannot admit work. **Cause:** Scenario combines a resumability instruction with a locked terminal condition. **General Fix Rule:** Inspect `usageLocked` and `token-usage-incomplete` first; probe resume at most once only to verify zero additional calls, then stop. **Origin phase:** Understanding/Planning.
- **Issue:** SQLite resume/checkpoint may alter file bytes even when no work is admitted. **Cause:** SQLite WAL/checkpoint metadata is mutable during a read-like resume. **General Fix Rule:** Hash all evidence before any resume; if byte preservation is mandatory, diagnose from the saved files without invoking resume, or use a disposable copy for the probe. **Origin phase:** Planning/Execution.

## Discretionary fill-ins

- Used the supplied absolute directory and saved profile; did not pass overrides.
- Treated `observedInputTokens:0` and `observedOutputTokens:0` as counters, not evidence of zero usage.
- Reported the runner’s configured `workers:2`, `concurrency:1`, and observed lower activity of one call separately.
- Kept the original run directory and wrote only this report under `docs/evaluations/sheep-swarm-skill/`.

## Retries

One resume probe; no same decision was retried. The probe was issued once to establish whether the locked saved run could resume without a new admission. No model call, replacement run, lock reset, or limit/profile change was attempted.

## Evidence hashes

Baseline hashes captured before the probe:

```text
6d7d38aa63fcc50618aa0cb8c94df1ddd2ef1a208614b239a9b8f789c856bdda  result.json
792a12c6132d25797430acfdd1f9a8ba926ce65fdfeabef38ba6a22aa8747444  call-1.json
e32e13b12299d8765064c497e455ccd5f688f312a1d8705e4c724303fc97ac15  artifacts.json
32b0c785139b365ca4ec76ec596348ddea85e1107e079af09a15af6b1fb2a5ac  state.sqlite
```

After restoration, the first three hashes matched; SQLite’s binary hash differed because the resume/checkpoint touched SQLite storage. Its logical snapshot values were restored as described above.
