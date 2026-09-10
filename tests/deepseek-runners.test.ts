import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexCallOptions, CodexCallResult, CodexUsage } from "../src/codex-worker.ts";
import { runComparison, type ComparisonCaller, type ComparisonResponse } from "../src/comparison.ts";
import type { DurableModelCaller } from "../src/durable-run.ts";
import { runDurableSwarm } from "../src/durable-run.ts";
import { createFixture } from "../src/fixture.ts";
import { createHeldoutFixture } from "../src/heldout-fixture.ts";
import { SqliteJournal } from "../src/journal.ts";
import { runMechanism } from "../src/mechanism-run.ts";

const DEEPSEEK_MODEL = "deepseek-v4.1-flash-expires-on-0910";
const knownUsage: readonly CodexUsage[] = [{ event: { type: "test-usage" }, inputTokens: 10, outputTokens: 20, totalTokens: 30 }];

function parsePrompt(prompt: string): { files: Record<string, string>; extra: Record<string, unknown> } {
  const match = /CONTEXT_JSON\n([^\n]+)\nEXTRA_JSON\n([^\n]+)$/.exec(prompt);
  assert.ok(match, "prompt context");
  return { files: JSON.parse(match[1]!) as Record<string, string>, extra: JSON.parse(match[2]!) as Record<string, unknown> };
}

function comparisonResult(options: CodexCallOptions, value: ComparisonResponse,
  completeness: "complete" | "partial-or-unknown" = "complete"): CodexCallResult<ComparisonResponse> {
  return {
    result: value,
    requestedModel: options.model,
    usage: completeness === "complete" ? knownUsage : [],
    transcript: {
      events: [], usage: completeness === "complete" ? knownUsage : [], requestedModel: options.model,
      effectiveModelEvidence: "deepseek-flash", usageCompleteness: completeness,
      stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
    } as CodexCallResult<ComparisonResponse>["transcript"],
  };
}

test("single-worker DeepSeek comparison completes, keeps the provider alias and bounds each call", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-deepseek-runners-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated" });
  const caller: ComparisonCaller = async options => {
    assert.equal((options as { maxTokens?: number }).maxTokens, 2048);
    parsePrompt(options.prompt);
    assert.equal(options.model, DEEPSEEK_MODEL);
    if (!options.prompt.startsWith("Solve the complete")) throw new Error("unexpected DeepSeek role");
    return comparisonResult(options, {
      writes: [...fixture.writableIds, fixture.specId].map(id => ({ id, content: fixture.artifacts[id]! })),
      targets: [], note: "Complete DeepSeek migration.",
    });
  };
  const report = await runComparison({
    method: "single-worker", runtime: "deepseek", workerModel: DEEPSEEK_MODEL, maxTokensPerCall: 2048,
    size: 4, workers: 1, concurrency: 1, maxCalls: 10, maxTokens: 10_000, reserveTokensPerCall: 100,
    outputDirectory: join(root, "single"),
  }, caller);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.upperCalls, 0);
  assert.ok(report.lowerCalls >= 1);
  assert.equal(report.configuration.runtime, "deepseek");
  assert.equal(report.configuration.workerModel, DEEPSEEK_MODEL);
  assert.equal(report.configuration.maxTokensPerCall, 2048);
  assert.ok(report.calls.every(call => call.role === "worker" && call.model === DEEPSEEK_MODEL));
  assert.ok(report.calls.every(call => call.effectiveModelEvidence === "deepseek-flash"));
});

test("comparison rejects a wrong requested identity but retains the provider alias as evidence", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-deepseek-runners-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runComparison({
    method: "single-worker", runtime: "deepseek", workerModel: DEEPSEEK_MODEL, maxAttempts: 1,
    size: 4, workers: 1, concurrency: 1, maxCalls: 2, maxTokens: 10_000, reserveTokensPerCall: 100,
    outputDirectory: join(root, "wrong-identity"),
  }, async options => ({
    ...comparisonResult(options, { writes: [], targets: [], note: "identity probe" }),
    requestedModel: "provider-other-model",
  }));
  assert.equal(report.success, false);
  assert.equal(report.calls[0]!.effectiveModelEvidence, "deepseek-flash");
  assert.equal(report.calls[0]!.outcome, "error");
  assert.match(report.calls[0]!.errors.join("\n"), /identity/);
});

test("upper-call counting follows the role even when lower and upper model ids are identical", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-deepseek-runners-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated" });
  const caller: ComparisonCaller = async options => {
    const { extra } = parsePrompt(options.prompt);
    assert.equal(options.model, DEEPSEEK_MODEL);
    if (options.prompt.startsWith("Manage local workers")) {
      const ready = extra.readyTargets as string[];
      return comparisonResult(options, { writes: [], targets: ready.slice(0, extra.concurrency as number), note: "Manage." });
    }
    const id = extra.target as string;
    return comparisonResult(options, { writes: [{ id, content: fixture.artifacts[id]! }], targets: [], note: "Local update." });
  };
  const report = await runComparison({
    method: "manager-local", runtime: "deepseek", metaRuntime: "deepseek",
    workerModel: DEEPSEEK_MODEL, metaModel: DEEPSEEK_MODEL,
    size: 4, workers: 4, concurrency: 4, maxCalls: 30, maxTokens: 100_000, reserveTokensPerCall: 100,
    outputDirectory: join(root, "shared-id"),
  }, caller);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.ok(report.lowerCalls > 0, "worker role counted despite an identical model id");
  assert.ok(report.upperCalls > 0, "upper role counted despite an identical model id");
  assert.equal(report.calls.length, report.lowerCalls + report.upperCalls);
});

function durableModel(size: number, completeness: "complete" | "partial-or-unknown" = "complete"): DurableModelCaller {
  const migrated = createFixture({ size, variant: "migrated" });
  return async options => {
    const prompt = JSON.parse(options.prompt) as { target: string };
    return {
      result: { content: migrated.artifacts[prompt.target]!, note: "deepseek durable fixture" },
      requestedModel: options.model,
      usage: completeness === "complete" ? [{ event: {}, inputTokens: 10, outputTokens: 5 }] : [],
      transcript: {
        events: [], usage: [], requestedModel: options.model, effectiveModelEvidence: "deepseek-flash",
        usageCompleteness: completeness, stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
      } as CodexCallResult<{ content: string; note: string }>["transcript"],
    };
  };
}

test("DeepSeek durable run persists its profile, then a completed resume makes zero calls and rejects overrides", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-deepseek-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "run");
  const first = await runDurableSwarm({
    directory, size: 2, workers: 2, runtime: "deepseek", workerModel: DEEPSEEK_MODEL, maxTokensPerCall: 4096,
  }, durableModel(2));
  assert.equal(first.success, true, first.finalErrors.join("\n"));
  assert.equal(first.configuration.runtime, "deepseek");
  assert.equal(first.configuration.metaRuntime, "codex");
  assert.equal(first.configuration.workerModel, DEEPSEEK_MODEL);
  assert.equal(first.configuration.maxTokensPerCall, 4096);
  const resumed = await runDurableSwarm({ directory, resume: true }, async () => { throw new Error("completed work was repeated"); });
  assert.equal(resumed.success, true);
  assert.equal(resumed.lowerCalls, first.lowerCalls);
  await assert.rejects(runDurableSwarm({ directory, resume: true, workerModel: "other-model" }, durableModel(2)),
    /resume configuration mismatch: workerModel/);
});

test("DeepSeek unknown usage locks the durable run and resume cannot clear it or spend again", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-deepseek-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "run");
  const first = await runDurableSwarm({ directory, size: 2, workers: 2, maxCalls: 6, maxMetaCalls: 0,
    runtime: "deepseek", workerModel: DEEPSEEK_MODEL }, durableModel(2, "partial-or-unknown"));
  assert.equal(first.success, false);
  assert.equal(first.lowerCalls, 1);
  assert.ok(first.finalErrors.includes("token-usage-incomplete"));
  const resumed = await runDurableSwarm({ directory, resume: true }, async () => { throw new Error("locked run spent again"); });
  assert.equal(resumed.success, false);
  assert.equal(resumed.lowerCalls, first.lowerCalls);
  assert.ok(resumed.finalErrors.includes("token-usage-incomplete"));
});

test("a legacy format-1 durable snapshot resumes with documented runtime defaults", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-deepseek-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "run");
  await runDurableSwarm({ directory, size: 2, workers: 2 }, durableModel(2));
  const journal = new SqliteJournal(join(directory, "state.sqlite"));
  const loaded = journal.load()!;
  const application = loaded.state.application as { configuration: Record<string, unknown> };
  delete application.configuration.runtime;
  delete application.configuration.metaRuntime;
  delete application.configuration.maxTokensPerCall;
  journal.save(loaded.state, loaded.generation);
  journal.close();
  const resumed = await runDurableSwarm({ directory, resume: true }, async () => { throw new Error("legacy completed work repeated"); });
  assert.equal(resumed.success, true, resumed.finalErrors.join("\n"));
  assert.equal(resumed.configuration.runtime, "codex");
  assert.equal(resumed.configuration.metaRuntime, "codex");
  assert.equal(resumed.configuration.maxTokensPerCall, 30_000);
});

test("the mechanism credit budget rejects DeepSeek before issuing any paid call", async () => {
  await assert.rejects(runMechanism({
    method: "sheep", family: "static", runtime: "deepseek", workerModel: DEEPSEEK_MODEL,
    outputDirectory: join(tmpdir(), "sheep-deepseek-mechanism-unused"),
  }, async () => { throw new Error("DeepSeek mechanism call was attempted"); }),
    /use --budget-mode tokens/);
});
