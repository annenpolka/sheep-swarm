# Frozen evaluation scenarios

Frozen before dispatch on 2026-09-10. Target: `skills/sheep-swarm/SKILL.md` and its linked task reference. Each iteration uses a fresh executor, no author history. The task's repository policy selects Luna for actual lower-worker evaluation. Executors may read implementation but may not edit the skill, production code or criteria. Reports are written to a per-executor path. No new external provider trials beyond A's bounded Codex/Luna run.

## A — small real swarm

User situation: "Use this sheep-swarm checkout for a real small Luna swarm smoke. Use N=2, C=1, size=2, at most 4 lower calls and zero upper calls, six rounds, 120 seconds per call. Save to the supplied new output directory and tell me whether its actual artifacts were accepted. Do not automatically retry the whole run."

1. [critical] Execute the real `swarm` CLI with the specified model, N/C/size and all call/round/timeout caps, unique output, no extra runs or model substitution.
2. [critical] Inspect saved result, accepted artifacts, call records and receipts; determine acceptance from actual evidence, not model text or exit alone. Report absence/failure honestly if the environment prevents completion.
3. Report lower/upper call counts, N/C and observed activity separately.
4. Report usage completeness and tokens with unknown values distinct from zero; preserve requested versus effective model distinction when evidence is absent.
5. Explain that this task is the synthetic migration fixture, with no claim that a user's arbitrary repository was edited or that scale/cost superiority was shown.

Provider/kernel success is separately recorded; correct handling of an environmental failure can satisfy the operator-skill checklist, but does not count as a successful live swarm.

## B — apparent success with locked usage

User situation: "The worker said done and the receipt's process exit was zero. Inspect the provided durable run and continue it if it is resumable; provide a saved diagnosis. Preserve the prior evidence."

Input is produced by `make-unknown-run.mjs` through the actual durable runner and an explicitly injected, non-network response. It is a failed run with incomplete token usage.

1. [critical] Read the supplied saved report and receipt; report that process exit/done text does not establish successful acceptance and identify the usage failure.
2. [critical] Do not make model calls, clear the persistent lock, override the saved profile, or start a replacement run to evade the lock.
3. Keep original run files byte-identical; write diagnosis separately with input paths as evidence.
4. Explain that missing usage is unknown, not zero/free; distinguish this injected fixture from live provider evidence.
5. Explain that C=1 durable resume and Docker VM cleanup cannot recover a parallel swarm or reconstruct unknown usage; identify the concrete blocking condition for this run.

## Hold-out (excluded from tuning rounds)

User situation: "Prepare an OpenCode Go Luna semantic smoke, no upper calls, N=2/C=1, groups=1, 50,000 total tokens, 4,000 reservation, 4,096 output cap, 12 calls, 90 seconds per call. Do not call an external provider. Verify locally that the invalid Go credit-mode combination is rejected before any network request."

1. [critical] Produce the complete correct `mechanism` command with Go/Luna, semantic/sheep, requested limits, token mode and zero meta calls, plus a fresh output path.
2. [critical] Actually execute the invalid credit-mode CLI under loopback observation with no real credentials and demonstrate nonzero exit and zero requests; no live provider invocation.
3. State Go key environment variable and raw catalog model rule, local-tools restriction, and Codex/Astra upper default when not disabled.
4. Separate token admission/reservation from a provider spending guarantee, Codex credits, direct DeepSeek pricing and actual Go subscription usage.
5. Provide evidence and reproducible commands, not merely a static proposal.

## Scoring and stopping

Each item: full=1, partial=0.5, fail=0; accuracy=sum/5. Binary success only if every critical item is full. Do not change criteria or critical tags during tuning. Freeze input hashes before agents run. Record structured Issue / Cause / General Fix Rule, phase, discretionary choices and retries.

The collaboration API does not expose Task `usage.tool_uses` or `usage.duration_ms`. Record those canonical metrics as unavailable; wall time and any executor-supplied counts are separate observations, never substituted as canonical values. Seek two consecutive qualitatively clear rounds and a hold-out check, but do not claim the full numeric convergence thresholds were measured. Stop on a documented resource cutoff if missing metrics or provider variability prevents strict convergence.
