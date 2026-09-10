import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMechanismFixture } from "../src/mechanism-fixture.ts";
import { runMechanism, type MechanismCaller, type MechanismResponse, type MechanismFamily } from "../src/mechanism-run.ts";
import type { CodexCallOptions, CodexCallResult } from "../src/codex-worker.ts";

const DEEPSEEK_MODEL = "deepseek-v4.1-flash-expires-on-0910";

function supplied(options: CodexCallOptions) {
  const serialized = options.prompt.split("PUBLIC_INPUT_JSON\n")[1]; assert.ok(serialized);
  return JSON.parse(serialized) as { stage: number; target: string | null; role: string;
    context: { contents: Record<string, string> }; readyTargets?: string[] };
}
function deepseekReceipt(options: CodexCallOptions, result: MechanismResponse,
  completeness: "complete" | "partial-or-unknown" = "complete"): CodexCallResult<MechanismResponse> {
  return { result, requestedModel: options.model, usage: [],
    transcript: { runtime: "deepseek", events: [], usage: [], requestedModel: options.model, effectiveModelEvidence: "deepseek-flash",
      usageCompleteness: completeness, httpStatus: 200,
      rawUsage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340,
        prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 300 },
      stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 } } as CodexCallResult<MechanismResponse>;
}
async function directory(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), "sheep-mechanism-token-"));
  t.after(() => rm(root, { recursive: true, force: true })); return join(root, name);
}
function deepseekCaller(family: MechanismFamily, firstCompleteness: "complete" | "partial-or-unknown" = "complete"): MechanismCaller {
  const fixture = createMechanismFixture({ family, groups: 1 });
  let calls = 0;
  return async options => {
    const input = supplied(options), current = input.context.contents;
    const completeness = calls++ === 0 ? firstCompleteness : "complete";
    assert.equal(options.model, DEEPSEEK_MODEL);
    assert.equal((options as { maxTokens?: number }).maxTokens, 4096);
    if (input.role === "meta") return deepseekReceipt(options, { writes: [{ id: fixture.guidanceId,
      content: `${current[fixture.guidanceId]}\nFollow the current normative revision ${input.stage}.\n` }], readRequests: [], note: "Correct advisory guidance." }, completeness);
    const target = input.target ?? input.readyTargets?.[0]; assert.ok(target);
    return deepseekReceipt(options, { writes: [{ id: target, content: fixture.goldForStage(input.stage)[target]! }],
      readRequests: [], note: "Current contract applied." }, completeness);
  };
}
const tokenOptions = { groups: 1, workers: 2, concurrency: 2, maxCalls: 100, maxTokensPerCall: 4096,
  budgetMode: "tokens" as const, maxTokens: 1_000_000, reserveTokensPerCall: 100_000 };

test("token budget completes DeepSeek sheep and single-worker runs with metered usage", async t => {
  for (const method of ["sheep", "single-worker"] as const) {
    const outputDirectory = await directory(t, method);
    const report = await runMechanism({ ...tokenOptions, method, family: "static", outputDirectory,
      runtime: "deepseek", metaRuntime: "deepseek", workerModel: DEEPSEEK_MODEL, metaModel: DEEPSEEK_MODEL },
      deepseekCaller("static"));
    assert.equal(report.success, true, `${method}: ${report.finalErrors.join("\n")}`);
    assert.ok("unit" in report.budget);
    assert.equal(report.budget.unit, "tokens");
    assert.equal(report.budget.unknownUsageCalls, 0);
    assert.ok(report.budget.observedTokens >= report.calls.length * 340);
    assert.ok(report.calls.every(call => call.tokens === 340));
    assert.ok(report.calls.every(call => call.credits === null));
    assert.equal(report.configuration.budgetMode, "tokens");
    assert.equal(report.upperCalls, 0);
  }
});

test("unknown token usage locks the token budget and stops the run", async t => {
  const outputDirectory = await directory(t, "unknown");
  const report = await runMechanism({ ...tokenOptions, workers: 1, concurrency: 1, method: "sheep", family: "static", outputDirectory,
    runtime: "deepseek", metaRuntime: "deepseek", workerModel: DEEPSEEK_MODEL, metaModel: DEEPSEEK_MODEL },
    deepseekCaller("static", "partial-or-unknown"));
  assert.equal(report.success, false);
  assert.ok("unit" in report.budget);
  assert.equal(report.budget.unknownUsageCalls, 1);
  assert.equal(report.budget.locked, true);
  assert.equal(report.calls.length, 1);
  assert.ok(report.finalErrors.includes("budget-or-boundary-unverified"));
});

test("token and credit budget options cannot be mixed", async t => {
  const outputDirectory = await directory(t, "mixed");
  await assert.rejects(runMechanism({ ...tokenOptions, method: "sheep", family: "static", outputDirectory,
    maxCredits: 5 }, async () => { throw new Error("unreachable"); }),
    /cannot be combined/);
  await assert.rejects(runMechanism({ method: "sheep", family: "static", outputDirectory,
    maxTokens: 10, reserveTokensPerCall: 5 }, async () => { throw new Error("unreachable"); }),
    /cannot be combined/);
});
