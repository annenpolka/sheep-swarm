import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture } from "../src/fixture.ts";
import { runDurableSwarm, type DurableModelCaller } from "../src/durable-run.ts";
import { SqliteJournal } from "../src/journal.ts";

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "deepseek-durable-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "run");
}

const correct = createFixture({ size: 2, variant: "migrated" });
const mismatchedCaller: DurableModelCaller = async options => {
  const target = (JSON.parse(options.prompt) as { target: string }).target;
  const usage = [{ event: {}, inputTokens: 10, outputTokens: 2, totalTokens: 12 }];
  return { result: { content: correct.artifacts[target]!, note: "fixed caller oracle" }, requestedModel: options.model, usage,
    transcript: { requestedModel: "different-requested-model", effectiveModelEvidence: "provider-alias", events: [], usage,
      stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 } };
};

test("durable DeepSeek must reject a conflicting requested model inside its transcript", async t => {
  const result = await runDurableSwarm({ directory: await directory(t), runtime: "deepseek", workerModel: "deepseek-requested",
    size: 2, workers: 1, maxCalls: 1, maxMetaCalls: 0 }, mismatchedCaller);
  assert.equal(result.calls[0]?.status, "error");
  assert.equal(result.success, false);
});

test("legacy durable migration does not legitimize a tampered original upper identity", async t => {
  const dir = await directory(t);
  await assert.rejects(runDurableSwarm({ directory: dir, size: 2, workers: 1, maxCalls: 1, maxMetaCalls: 0,
    checkpoint: async name => { if (name === "initialized") throw new Error("pause before any calls"); } }, mismatchedCaller), /pause/);
  const journal = new SqliteJournal(join(dir, "state.sqlite"));
  try {
    const loaded = journal.load()!;
    const app = loaded.state.application as Record<string, unknown>;
    const config = app.configuration as Record<string, unknown>;
    for (const key of ["runtime", "metaRuntime", "maxTokensPerCall"]) delete config[key];
    delete app.usageLocked; app.format = 1; config.metaModel = "tampered-upper";
    journal.save(loaded.state, loaded.generation);
  } finally { journal.close(); }
  let calls = 0;
  await assert.rejects(runDurableSwarm({ directory: dir, resume: true }, async options => {
    calls++; return mismatchedCaller(options);
  }));
  assert.equal(calls, 0);
});

test("a DeepSeek process lost after reservation cannot regain admission on resume", async t => {
  const dir = await directory(t);
  let actualCalls = 0;
  const caller: DurableModelCaller = async options => { actualCalls++; return mismatchedCaller(options); };
  await assert.rejects(runDurableSwarm({ directory: dir, runtime: "deepseek", workerModel: "deepseek-requested",
    size: 2, workers: 1, maxCalls: 5, maxMetaCalls: 0,
    checkpoint: async name => { if (name === "before-call") throw new Error("crash after reservation"); } }, caller), /crash/);
  const resumed = await runDurableSwarm({ directory: dir, resume: true }, caller);
  assert.equal(actualCalls, 0, "unknown provider execution must lock new spending");
  assert.equal(resumed.success, false);
  assert.equal(resumed.unknownCalls, 1);
});

test("durable migration distinguishes old snapshots from damaged modern fields", async t => {
  for (const mutation of ["missing-legacy-model", "partial-runtime", "invalid-lock"] as const) {
    const dir = await directory(t);
    await assert.rejects(runDurableSwarm({ directory: dir, size: 2, workers: 1, maxCalls: 1, maxMetaCalls: 0,
      checkpoint: async name => { if (name === "initialized") throw new Error("pause"); } }, mismatchedCaller), /pause/);
    const journal = new SqliteJournal(join(dir, "state.sqlite"));
    try {
      const loaded = journal.load()!, app = loaded.state.application as Record<string, unknown>;
      const config = app.configuration as Record<string, unknown>;
      if (mutation === "missing-legacy-model") {
        for (const key of ["runtime", "metaRuntime", "maxTokensPerCall", "metaModel"]) delete config[key];
        delete app.usageLocked;
      } else if (mutation === "partial-runtime") delete config.runtime;
      else app.usageLocked = "false";
      journal.save(loaded.state, loaded.generation);
    } finally { journal.close(); }
    await assert.rejects(runDurableSwarm({ directory: dir, resume: true }, mismatchedCaller), mutation);
  }
});
