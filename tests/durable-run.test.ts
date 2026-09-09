import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFixture } from "../src/fixture.ts";
import { runDurableSwarm } from "../src/durable-run.ts";
import type { DurableModelCaller } from "../src/durable-run.ts";
import { SqliteJournal } from "../src/journal.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";

function model(size: number): DurableModelCaller {
  const migrated = createFixture({ size, variant: "migrated" });
  return async (options) => {
    const prompt = JSON.parse(options.prompt) as { target: string };
    return { result: { content: migrated.artifacts[prompt.target]!, note: "independent deterministic migrated fixture" },
      requestedModel: options.model, usage: [{ event: {}, inputTokens: 10, outputTokens: 5 }],
      transcript: { events: [], usage: [], requestedModel: options.model, effectiveModelEvidence: null, stdout: "", stderr: "", exitCode: 0,
        signal: null, timedOut: false, cancelled: false, durationMs: 1 } };
  };
}

test("durable fixture execution and reopening retain individuals and do not repeat committed calls", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sheep-durable-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "run");
  const first = await runDurableSwarm({ directory, size: 4, workers: 4 }, model(4));
  assert.equal(first.success, true);
  assert.equal(first.lowerCalls, 5);
  assert.equal(first.individuals.length, 4);
  assert.ok(first.individuals.every((individual) => individual.memory.length > 0));
  assert.equal(first.configuration.workerModel, "gpt-5.6-luna");
  assert.equal(first.configuration.metaModel, "gpt-6-astra");
  const evidence = JSON.parse(await readFile(join(directory, "call-1.json"), "utf8")) as { requestedModel: string; transcript: { exitCode: number } };
  assert.equal(evidence.requestedModel, "gpt-5.6-luna"); assert.equal(evidence.transcript.exitCode, 0);
  const resumed = await runDurableSwarm({ directory, resume: true }, async () => { throw new Error("completed work was repeated"); });
  assert.equal(resumed.success, true); assert.equal(resumed.lowerCalls, first.lowerCalls);
  assert.deepEqual(resumed.individuals, first.individuals); assert.equal(resumed.resumes, 1);
  const journal = new SqliteJournal(join(directory, "state.sqlite")); t.after(() => journal.close());
  const state = journal.load()!.state;
  const contents = Object.fromEntries(Object.entries(state.artifacts).map(([id, artifact]) => [id, artifact.content]));
  assert.equal((await createFixture({ size: 4 }).verify(contents)).ok, true);
  assert.equal(state.activeWork.length, 0);
  assert.ok(state.events.every((event) => event.delivered));
  assert.ok(state.obligations.every((work) => work.state === "handled"));
});

test("resuming an unknown model call preserves its consumed budget and unknown usage", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sheep-durable-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "run");
  let actualCalls = 0;
  await assert.rejects(runDurableSwarm({ directory, size: 2, workers: 2, maxCalls: 1, maxMetaCalls: 0,
    checkpoint: async (name) => { if (name === "before-call") throw new Error("interrupted after durable reservation"); } },
  async (options) => { actualCalls++; return model(2)(options); }), /interrupted after durable reservation/);
  const resumed = await runDurableSwarm({ directory, resume: true }, async (options) => { actualCalls++; return model(2)(options); });
  assert.equal(actualCalls, 0);
  assert.equal(resumed.success, false);
  assert.equal(resumed.lowerCalls, 1);
  assert.equal(resumed.unknownCalls, 1);
  assert.equal(resumed.usageUnknownCalls, 1);
  assert.equal(resumed.calls[0]!.inputTokens, null);
  assert.equal(resumed.calls[0]!.outputTokens, null);
});

test("resume cannot silently increase a persisted call budget", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sheep-durable-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "run");
  await runDurableSwarm({ directory, size: 2, workers: 2, maxCalls: 3, maxMetaCalls: 0 }, model(2));
  await assert.rejects(runDurableSwarm({ directory, resume: true, maxCalls: 100 }, model(2)), /resume configuration mismatch/);
});

test("transport failures exhaust worker retries without asking the upper model to rewrite semantics", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sheep-durable-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await runDurableSwarm({ directory: join(parent, "run"), size: 2, workers: 2, maxCalls: 6, maxMetaCalls: 2 },
    async () => { throw new Error("provider connection unavailable"); });
  assert.equal(result.success, false); assert.equal(result.lowerCalls, 6);
  assert.equal(result.upperCalls, 0); assert.equal(result.interventions, 0);
  assert.ok(result.calls.every((call) => call.status === "error"));
});

test("failed Codex calls retain the complete transcript separately from their database receipt", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "sheep-durable-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "run");
  const result = await runDurableSwarm({ directory, size: 2, workers: 2, maxCalls: 1, maxMetaCalls: 0 }, async (options) => {
    throw new CodexWorkerError("nonzero-exit", "provider failed", { events: [{ type: "error", message: "provider failed" }],
      usage: [{ event: {}, inputTokens: 17, outputTokens: 3 }], requestedModel: options.model, effectiveModelEvidence: null,
      stdout: "full provider event stream", stderr: "full provider stderr", exitCode: 1, signal: null,
      timedOut: false, cancelled: false, durationMs: 5 });
  });
  assert.equal(result.success, false); assert.equal(result.observedInputTokens, 17); assert.equal(result.observedOutputTokens, 3);
  const evidence = JSON.parse(await readFile(join(directory, "call-1.json"), "utf8")) as { error: string; transcript: { stdout: string; stderr: string } };
  assert.equal(evidence.error, "nonzero-exit");
  assert.equal(evidence.transcript.stdout, "full provider event stream");
  assert.equal(evidence.transcript.stderr, "full provider stderr");
});
