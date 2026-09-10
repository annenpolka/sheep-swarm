---
name: sheep-swarm
description: Run sheep-swarm's bounded CLI experiments, inspect saved run evidence, resume its durable runner, or prepare a trusted task adapter for scoped coding work. Use when asked to use sheep-swarm or a Luna swarm; arbitrary repository editing requires a task adapter.
---

# Use sheep-swarm

sheep-swarm schedules local work through versioned artifacts, fixed acceptance checks, and a kernel. Lower workers use Luna by default; an upper Astra model observes failures and intervenes when needed. Do not add worker-to-manager consultation or upper approval of every change.

## Locate and choose the path

Locate the sheep-swarm checkout from the current project or the user's supplied path. Run commands from that checkout, not the repository whose code the user eventually wants changed. Verify `git status --short`, `package.json`, and `README.md`. If the checkout is unknown, resolve it before running commands; the installed skill directory is not the checkout. Node must be >=24.12.0. Run `npm ci` if dependencies are absent or changed.

| Request | Entry point | Scope |
|---|---|---|
| Small swarm smoke / migration fixture | `npm run swarm -- …` | Built-in measurement task; `size` counts direct consumers, not all writable artifacts |
| Compare methods | `npm run compare -- …` | Separate thermal fixture; `single-luna`, `manager-local`, `sheep-fixed`, `sheep-full` |
| Static, semantic or staged experiment | `npm run mechanism -- …` | Fixed task families, token or credit admission |
| Crash-safe sequential work / resume | `npm run durable -- …` | Dedicated C=1 runner; cannot resume a parallel swarm output |
| Implement the user's code | Trusted `runSwarm(..., task)` adapter | Read [task-adapter.md](references/task-adapter.md); no generic `--repo` or free-text `--task` CLI exists |
| Inspect prior work | Read saved JSON and receipts | No model calls needed |

For ordinary use, read only the relevant CLI source (`src/cli.ts`, `src/compare-cli.ts`, `src/mechanism-cli.ts`, `src/durable-cli.ts`) if a flag is not covered here. These CLIs do not implement a help or dry-run mode; do not execute an incomplete command to discover defaults. For development, also read the checkout's `AGENTS.md` and its designated documents.

## Bounded execution

Honor the requested runtime, model, task, output location and limits. An execution request authorizes that bounded run; continue without asking again. For a planning-only request, produce a concrete command without calling models. Do not launch a full experiment series merely to check connectivity.

For a small first smoke, use a new output directory and an explicit call cap. This example calls real Luna through authenticated Codex CLI:

```sh
run_dir=".sheep/skill-smoke-$(date +%Y%m%d-%H%M%S)-$$"
npm run swarm -- --runtime codex --worker-model gpt-5.6-luna \
  --workers 2 --concurrency 1 --size 2 --max-calls 4 --max-meta-calls 0 \
  --max-rounds 6 --timeout-ms 120000 --output "$run_dir"
```

The zero upper-call cap is a connectivity smoke setting. Preserve upper intervention for normal swarm work (e.g. `--max-meta-calls 2`); record the change when comparing runs. Keep registered workers N, maximum concurrency C, and observed activity separate. Four workers test operation; they do not establish scale benefits.

`swarm` has call, round and timeout limits but no total `--max-tokens` flag. `compare` uses `--max-tokens`, `--reserve-tokens`, and **`--max-upper-calls`**. `mechanism` uses **`--max-meta-calls`** and supports `--budget-mode tokens --max-tokens … --reserve-tokens …`; credit options are a separate mode. Reservations control admission, not a provider-enforced spending ceiling. Do not silently increase exhausted limits.

## Runtime selection

| Runtime | Lower model / authentication | Tools and upper default |
|---|---|---|
| `codex` | `gpt-5.6-luna`, authenticated Codex CLI | Tool-less; upper Codex/Astra |
| `docker-agent` | `gpt-5.6-luna`, configured host proxy | `--worker-tools local` enables local read/edit/test; upper Docker/Astra |
| `deepseek` | Explicit raw API model ID; `DEEPSEEK_API_KEY` | Tool-less; upper **Codex/Astra**, unless explicitly changed |
| `opencode-go` | Explicit catalog ID such as `gpt-5.6-luna`; `OPENCODE_GO_API_KEY` | Tool-less; upper **Codex/Astra**, unless explicitly changed |

Do not prefix raw API IDs with provider names, silently substitute providers/models, or treat an expiring model ID as a permanent default. Keep keys out of commands, logs and artifacts; check presence without printing values. No automatic import of the OpenCode credential store is implemented.

Go/DeepSeek `mechanism` runs require token mode. Go tokens are not Codex credits or direct DeepSeek charges. For provider-specific setup read the checkout's `docs/opencode-go.md` or README DeepSeek section; for Docker read `docs/docker-agent-sandbox.md` before creating VMs. Local tools require Docker; API runtimes cannot use `--worker-tools local`.

For same-provider upper calls, specify both `--meta-runtime` and `--meta-model`. For no upper calls, use the runner's upper-call cap. Normal single-agent comparisons use Luna; do not start new Astra-only trials. Explicit DeepSeek trials remain a separately requested exception. Match runtime, tools, authority, acceptance and total budget for comparisons.

## Read the evidence and decide

Keep the original run directory intact. Read `result.json`, `artifacts.json`, call records and referenced `call-*.json` receipts. A process exit or model's “done” message does not prove acceptance. Distinguish an absent report (incomplete/unverified) from a recorded failed run.

For `swarm`, check `success`, `finalErrors`, `completedArtifacts` versus `writableArtifacts`, and actual generated content. Inspect `calls` for requested model, effective-model evidence, role, outcome, tokens and usage completeness. For `compare`, also inspect `qualityPass` and the budget. For `mechanism`, require all expected stages (three for `staged`), quality/protocol checks, completed termination, and a settled budget with no unknown usage or overrun. Docker receipts also need successful cleanup; saved summaries do not replace the independent acceptance checks.

For Docker mechanism reports only:

```sh
npm run summarize:docker-mechanism -- /absolute/run/result.json
```

Missing receipts, unknown/partial usage, provider throttling, verification infrastructure errors or cleanup failure require stopping new admissions. Keep already issued calls and their cleanup accounted for. Do not turn unknown usage into zero, retry the series in a fresh directory to evade its stop, or rewrite the report to match a positive console message. Observed token totals may be lower bounds; actual billing and subscription use cannot be inferred.

To resume a known durable run, use its existing directory and saved configuration:

```sh
npm run durable -- --directory /absolute/durable-run --resume
```

Inspect the saved result first. Completed runs should add no calls. Unknown usage locks persist across resume; do not clear the lock or change the model/limits to force progress. Docker VM recovery/reaping is resource cleanup, not a parallel run resume or missing-usage reconstruction.

Return the command/profile, output path, accepted or failed/incomplete status with evidence, lower/upper calls, N/C/observed activity, usage completeness, and remaining limitations. For coding tasks, review and validate the generated diff against the destination checkout before adopting it. A successful synthetic run proves only that fixture's acceptance, not arbitrary repository support, general dependency discovery or cost superiority.
