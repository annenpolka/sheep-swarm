import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexCallOptions, CodexCallResult, CodexUsage } from "../src/codex-worker.ts";
import { runComparison, type ComparisonCaller } from "../src/comparison.ts";
import { runDurableSwarm, type DurableModelCaller } from "../src/durable-run.ts";
import { createFixture } from "../src/fixture.ts";
import { SqliteJournal } from "../src/journal.ts";
import { runMechanism } from "../src/mechanism-run.ts";

const MODEL = "gpt-5.6-luna";
const usage: readonly CodexUsage[] = [{ event: {}, inputTokens: 10, outputTokens: 5, totalTokens: 15 }];
const result = <T>(options: CodexCallOptions, value: T): CodexCallResult<T> => ({ result: value,
  requestedModel: options.model, usage, transcript: { events: [], usage, requestedModel: options.model,
    effectiveModelEvidence: "provider-alias", stdout: "", stderr: "", exitCode: 0, signal: null,
    timedOut: false, cancelled: false, durationMs: 1, usageCompleteness: "complete", runtime: "opencode-go" } as never });

test("OpenCode Go comparison dispatches worker and upper roles with stable distinct sessions", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-opencode-go-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = (await import("../src/heldout-fixture.ts")).createHeldoutFixture({ size: 4, variant: "migrated" });
  const sessions: string[] = [];
  const caller: ComparisonCaller = async options => {
    sessions.push(options.sessionId!);
    if (options.model === MODEL) {
      const target = /[\"']target[\"']\s*:\s*[\"']([^\"']+)/.exec(options.prompt)?.[1];
      return result(options, { writes: target && fixture.artifacts[target] ? [{ id: target, content: "invalid" }] : [], targets: [], note: "worker" });
    }
    return result(options, { writes: [], targets: fixture.writableIds, note: "upper" });
  };
  const report = await runComparison({ method: "manager-local", runtime: "opencode-go", workerModel: MODEL,
    metaRuntime: "opencode-go", metaModel: "grok-4.6", size: 4, workers: 2, concurrency: 1, maxCalls: 8,
    maxUpperCalls: 2, maxTokens: 20_000, reserveTokensPerCall: 100, maxTokensPerCall: 2048, outputDirectory: join(root, "run") }, caller);
  const workerReport = await runComparison({ method: "single-worker", runtime: "opencode-go", workerModel: MODEL,
    size: 2, maxCalls: 1, maxTokens: 2_000, reserveTokensPerCall: 100, maxTokensPerCall: 2048, outputDirectory: join(root, "worker") }, caller);
  assert.ok(sessions.length > 0); assert.ok(sessions.every(Boolean));
  assert.ok(report.upperCalls > 0); assert.ok(workerReport.lowerCalls > 0);
  const lower = sessions.filter(id => id.includes(":worker:")); const upper = sessions.filter(id => id.includes(":upper:"));
  assert.ok(lower.length > 0, JSON.stringify(sessions)); assert.ok(upper.length > 0); assert.equal(new Set(upper).size, 1);
  assert.equal(new Set(lower).size, 1); assert.notEqual(lower[0], upper[0]);
  assert.equal(report.configuration.runtime, "opencode-go");
});

function durableCaller(size: number, sessions: string[]): DurableModelCaller {
  const migrated = createFixture({ size, variant: "migrated" });
  return async options => { sessions.push(options.sessionId!); const target = (JSON.parse(options.prompt) as { target: string }).target;
    return result(options, { content: migrated.artifacts[target]!, note: "go durable" }); };
}

test("durable OpenCode Go persists its session seed across resume", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-opencode-go-durable-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "run"); const sessions: string[] = [];
  let interrupted = false; let beforeCalls = 0;
  const first = await runDurableSwarm({ directory, size: 2, workers: 1, runtime: "opencode-go", workerModel: MODEL, maxCalls: 8,
    checkpoint: async name => { if (name === "before-call" && ++beforeCalls > 1 && !interrupted) { interrupted = true; throw new Error("pause"); } } }, durableCaller(2, sessions)).catch(error => { assert.match(String(error), /pause/); return null; });
  assert.ok(interrupted); assert.ok(first === null); assert.ok(sessions.length > 0);
  const journal = new SqliteJournal(join(directory, "state.sqlite")); const state = journal.load()!.state;
  const app = state.application as { sessionSeed: string }; assert.match(app.sessionSeed, /^[0-9a-f-]{36}$/); journal.close();
  const resumedSessions: string[] = [];
  const resumed = await runDurableSwarm({ directory, resume: true }, durableCaller(2, resumedSessions));
  assert.equal(resumedSessions.length, 0); assert.equal(resumed.success, false);
});

test("modern Go snapshots without a session seed are rejected, while pre-Go DeepSeek snapshots migrate", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-opencode-go-migrate-")); t.after(() => rm(root, { recursive: true, force: true }));
  const goDir = join(root, "go"); await runDurableSwarm({ directory: goDir, size: 2, workers: 2, runtime: "opencode-go", workerModel: MODEL, maxCalls: 1, maxMetaCalls: 0 }, durableCaller(2, []));
  const goJournal = new SqliteJournal(join(goDir, "state.sqlite")); const goLoaded = goJournal.load()!; delete (goLoaded.state.application as Record<string, unknown>).sessionSeed; goJournal.save(goLoaded.state, goLoaded.generation); goJournal.close();
  await assert.rejects(runDurableSwarm({ directory: goDir, resume: true }), /missing.*session seed/);
  const dsDir = join(root, "deepseek"); await runDurableSwarm({ directory: dsDir, size: 2, workers: 2, runtime: "deepseek", workerModel: "deepseek-v4.1-flash-expires-on-0910", maxCalls: 1, maxMetaCalls: 0 }, durableCaller(2, []));
  const dsJournal = new SqliteJournal(join(dsDir, "state.sqlite")); const dsLoaded = dsJournal.load()!; delete (dsLoaded.state.application as Record<string, unknown>).sessionSeed; dsJournal.save(dsLoaded.state, dsLoaded.generation); dsJournal.close();
  const migrated = await runDurableSwarm({ directory: dsDir, resume: true }); assert.equal(migrated.configuration.runtime, "deepseek");
});

test("mechanism rejects OpenCode Go in credit mode before invoking its caller", async () => {
  await assert.rejects(runMechanism({ family: "static", method: "sheep", runtime: "opencode-go", workerModel: MODEL,
    outputDirectory: join(tmpdir(), "sheep-opencode-go-credit") }, async () => { throw new Error("called"); }), /budget-mode tokens/);
});

test("unknown OpenCode Go usage locks token admission", async () => {
  let calls = 0;
  const report = await runMechanism({ family: "static", method: "sheep", runtime: "opencode-go", workerModel: MODEL,
    budgetMode: "tokens", maxTokens: 10_000, reserveTokensPerCall: 100, maxCalls: 4, maxMetaCalls: 0, workers: 1, concurrency: 1,
    outputDirectory: join(tmpdir(), `sheep-opencode-go-unknown-${Date.now()}`) }, async options => {
      calls++;
      return { ...result(options, { writes: [], readRequests: [], note: "unknown" }), usage: [], transcript: { ...result(options, { writes: [], readRequests: [], note: "unknown" }).transcript, usage: [], usageCompleteness: "partial-or-unknown" } as never };
    });
  assert.equal(calls, 1); assert.equal(report.success, false); assert.equal(report.budget.unknownUsageCalls, 1);
});
