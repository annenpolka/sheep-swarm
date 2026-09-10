import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "../src/fixture.ts";
import type { CodexUsage } from "../src/codex-worker.ts";
import { runSwarm, type ModelCaller } from "../src/swarm.ts";

const REQUEST_MODEL = "deepseek-v4.1-flash-expires-on-0910";
const migrated = createFixture({ size: 4, variant: "migrated" });
const targetOf = (prompt: string) => /Update only (\S+) to satisfy/.exec(prompt)![1]!;

async function output(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sheep-deepseek-swarm-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "run");
}

// Valid edits with a DeepSeek transcript whose usage cannot be reconciled must not count as metered.
function unknownUsageCaller(): ModelCaller {
  return async options => {
    const usage: CodexUsage[] = [];
    return {
      result: { content: migrated.artifacts[targetOf(options.prompt)]!, note: "synthetic deepseek edit" },
      requestedModel: options.model, usage,
      transcript: { requestedModel: options.model, effectiveModelEvidence: "deepseek-flash", events: [], usage,
        stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, cancelled: false, durationMs: 1,
        runtime: "deepseek", httpStatus: 200, responseModel: "deepseek-flash",
        usageCompleteness: "partial-or-unknown", rawUsage: null },
    };
  };
}

test("the DeepSeek worker runtime requires an explicit raw API model id", async t => {
  for (const workerModel of [undefined, "", "   ", "deepseek/deepseek-chat"]) {
    await assert.rejects(runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
      runtime: "deepseek", ...(workerModel === undefined ? {} : { workerModel }) }, unknownUsageCaller()),
    /explicit --worker-model|without a provider prefix/);
  }
});

test("DeepSeek workers default meta observation to Codex and refuse the Astra model", async t => {
  await assert.rejects(runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "deepseek", workerModel: REQUEST_MODEL, metaRuntime: "deepseek", metaModel: "gpt-6-astra" },
    unknownUsageCaller()), /do not send the Astra model to the DeepSeek runtime/);
  await assert.rejects(runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "deepseek", workerModel: REQUEST_MODEL, metaRuntime: "deepseek" },
    unknownUsageCaller()), /explicit --meta-model/);
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "deepseek", workerModel: REQUEST_MODEL, maxCalls: 0 }, unknownUsageCaller());
  assert.equal(report.configuration.runtime, "deepseek");
  assert.equal(report.configuration.metaRuntime, "codex");
  assert.equal(report.configuration.metaModel, "gpt-6-astra");
});

test("unknown DeepSeek usage blocks further admission and fails the report despite committed edits", async t => {
  const outputDirectory = await output(t);
  const report = await runSwarm({ workers: 8, concurrency: 8, size: 4, outputDirectory,
    runtime: "deepseek", workerModel: REQUEST_MODEL, maxCalls: 10, maxMetaCalls: 2 }, unknownUsageCaller());
  assert.equal(report.success, false);
  assert.ok(report.finalErrors.includes("unknown-usage"), report.finalErrors.join("\n"));
  // The committed first wave is evidence, but no dependent second wave is admitted.
  assert.equal(report.lowerCalls, 4);
  assert.equal(report.upperCalls, 0);
  assert.equal(report.completedArtifacts, 4);
  const artifacts = JSON.parse(await readFile(join(outputDirectory, "artifacts.json"), "utf8")) as typeof migrated.artifacts;
  for (const id of ["consumers/consumer-001.mjs", "consumers/consumer-002.mjs", "consumers/consumer-003.mjs", "consumers/consumer-004.mjs"])
    assert.equal(artifacts[id], migrated.artifacts[id]);
  assert.ok(report.calls.every(call => call.usageCompleteness === "partial-or-unknown" && call.inputTokens === null));
});

test("non-DeepSeek workers still reject non-Luna models and unknown token bounds", async t => {
  await assert.rejects(runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    workerModel: "deepseek-v4.1-flash-expires-on-0910" }, unknownUsageCaller()), /real workers must use gpt-5.6-luna/);
  await assert.rejects(runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "deepseek", workerModel: REQUEST_MODEL, maxTokensPerCall: 0 }, unknownUsageCaller()),
  /token limit must be positive/);
});
