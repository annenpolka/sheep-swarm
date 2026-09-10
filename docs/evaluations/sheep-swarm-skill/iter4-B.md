# Scenario B diagnosis (iter4)

## Deliverable

Saved diagnosis for `.sheep/skill-eval/unknown-run-iter4`. The supplied durable fixture is a failed, usage-locked run. No provider/model call, resume, lock clearing, replacement run, or mutation of the input directory was performed.

Evidence read:

- `.sheep/skill-eval/unknown-run-iter4/result.json`
- `.sheep/skill-eval/unknown-run-iter4/call-1.json`
- `.sheep/skill-eval/unknown-run-iter4/artifacts.json`

The input files were preserved byte-for-byte during this diagnosis. `result.json` records `success:false`, `finalErrors:["pending-work","token-usage-incomplete"]`, `lowerCalls:1`, `upperCalls:0`, `resumes:0`, and `usageUnknownCalls:1`. The worker response says “Done; simulated exit 0 with unknown usage”, while the receipt has `exitCode:0`, an empty `usage` array, empty transcript events/usage, and `usageCompleteness:"partial-or-unknown"`.

## Requirement achievement

1. **○** Read the saved report and receipt; report apparent success does not establish acceptance and identify the usage failure. Evidence: `result.json` has `success:false` and both `pending-work` and `token-usage-incomplete`; `call-1.json` has `exitCode:0` but no usage and partial/unknown completeness. The response text is treated as an unverified claim.
2. **○** Do not make calls, clear the lock, override the profile, or start a replacement run. Evidence: no execution beyond read-only inspection and this separate report; no resume or provider admission was attempted.
3. **○** Preserve original evidence and write diagnosis separately. Evidence: diagnosis is this file; input paths are named above. The supplied run directory was not edited.
4. **○** Treat missing usage as unknown, not zero/free, and distinguish the injected fixture from live provider evidence. Evidence: `inputTokens:null`/`outputTokens:null`, empty usage, and `usageUnknownCalls:1`; the receipt explicitly says simulated/non-network behavior. The observed token totals of zero are therefore not a usage or cost claim.
5. **○** Explain why resume/cleanup cannot recover this run and identify the block. Evidence: the saved limitations say the durable runner uses C=1 and is separate from a parallel scale runner, and unknown usage stops further admissions. The concrete block is incomplete token usage (`token-usage-incomplete`) together with pending work; a durable C=1 resume or Docker cleanup cannot reconstruct unknown provider usage or convert this fixture into an accepted parallel run.

## Trace

- Understanding: OK — identified this as Scenario B, a supplied failed fixture with apparent process success but incomplete usage.
- Planning: OK — read saved JSON/receipt, avoided resume and provider calls, and wrote a separate diagnosis.
- Execution: OK — read-only inspection completed; no input mutation or retry.
- Formatting: OK — evidence, requirement results, limitations, ambiguities, and retries are separated.

## Actual task failure and evidence limitations

The run itself failed acceptance because it records `pending-work` and `token-usage-incomplete`; only `sheep-1` has one committed call while `sheep-2` has zero calls. Usage cannot be reconstructed from the empty receipt. This is an explicitly injected non-network fixture, so it does not establish live provider behavior, billing, or a real worker's successful execution. `artifacts.json` contains apparent generated content, but the saved result does not mark the run successful or establish that all writable artifacts passed acceptance.

## Instruction ambiguities

| Issue | Cause | General Fix Rule | Phase |
|---|---|---|---|
| “Continue it if it is resumable” could invite a resume attempt | Resumability is not inferable from the worker's done text or process exit | Classify the saved result first; if usage is unknown/incomplete or the run is locked, diagnose without resuming | Planning |
| Zero observed tokens could be mistaken for free execution | Missing usage is represented alongside numeric observed totals | Report usage completeness independently and label missing/unknown usage explicitly; never treat zero observations as provider usage | Formatting |
| The fixture's injected response could be mistaken for live provider evidence | The receipt intentionally simulates `exitCode:0` with no network transcript | Identify the fixture/injection boundary and make no live-provider or billing claim | Understanding |

## Discretionary fill-ins

Reported the requested/effective worker model as `gpt-5.6-luna` only because both saved files contain that evidence. Reported N/C as `workers:2` and `concurrency:1` from the saved configuration; observed activity is separate (`lowerCalls:1`, `sheep-2:0`). No metadata absent from the files was invented. Canonical collaboration metrics such as tool-use count and duration are unavailable; the receipt's `durationMs:1` is retained only as executor-supplied fixture evidence.

## Retries

None. A replacement run or resume would violate Scenario B and would not repair unknown usage.
