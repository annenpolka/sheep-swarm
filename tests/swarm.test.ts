import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CodexWorkerError, type CodexCallOptions, type CodexCallResult } from "../src/codex-worker.ts";
import { createFixture } from "../src/fixture.ts";
import { runSwarm, type ModelCaller, type SwarmOptions } from "../src/swarm.ts";

interface Response { content: string; note: string }

function answer(options: CodexCallOptions, content: string): CodexCallResult<Response> {
  const usage = [{ event: { type: "test-usage" }, inputTokens: 10, outputTokens: 20 }];
  return {
    result: { content, note: "Deterministic test response; no model was called." },
    requestedModel: options.model,
    usage,
    transcript: {
      events: [], usage, requestedModel: options.model, effectiveModelEvidence: options.model,
      stdout: "", stderr: "", exitCode: 0, signal: null,
      timedOut: false, cancelled: false, durationMs: 1,
    },
  };
}

async function outputFor(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sheep-swarm-run-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "run");
}

function targetOf(options: CodexCallOptions): string {
  const target = /Update only (\S+) to satisfy/.exec(options.prompt)?.[1];
  assert.ok(target, "worker prompt must name its local artifact");
  return target;
}

test("four workers converge with the requested Luna identity and at most two concurrent calls", async t => {
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const requested: CodexCallOptions[] = [];
  let active = 0;
  let observedMaxActive = 0;
  const caller: ModelCaller = async options => {
    requested.push(options);
    active++;
    observedMaxActive = Math.max(observedMaxActive, active);
    // Yield a turn so calls overlap, without depending on elapsed-time assertions.
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return answer(options, fixture.artifacts[targetOf(options)]!);
  };
  const outputDirectory = await outputFor(t);
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory, maxMetaCalls: 0 }, caller);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.registeredWorkers, 4);
  assert.equal(report.completedArtifacts, 5);
  assert.equal(report.lowerCalls, 5);
  assert.equal(report.upperCalls, 0);
  assert.equal(report.maxActiveWorkers, 2);
  assert.equal(observedMaxActive, 2);
  assert.equal(active, 0);
  assert.ok(requested.every(options => options.model === "gpt-5.6-luna"));
  assert.ok(report.calls.every(call => call.role === "worker" && call.model === "gpt-5.6-luna"));
  assert.deepEqual(new Set(report.calls.map(call => call.agent)), new Set(["sheep-1", "sheep-2", "sheep-3", "sheep-4"]));
  assert.ok(report.calls.every(call => call.inputTokens === 10 && call.outputTokens === 20));
  assert.ok(report.calls.some(call => call.memoryEntries > 0), "a returning individual must receive its own prior observations");
  assert.equal(report.individuals.length, 4);
  assert.ok(report.individuals.every(worker => !worker.active && worker.memory.length > 0));
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "artifacts.json"), "utf8")), fixture.artifacts);
  assert.equal(JSON.parse(await readFile(join(outputDirectory, "result.json"), "utf8")).success, true);
});

test("semantic failures consume at most the call budget and remain failed", async t => {
  const baseline = createFixture({ size: 4 });
  let calls = 0;
  const caller: ModelCaller = async options => {
    calls++;
    assert.equal(options.model, "gpt-5.6-luna");
    return answer(options, baseline.artifacts[targetOf(options)]!);
  };
  const report = await runSwarm({
    workers: 4, concurrency: 2, size: 4, outputDirectory: await outputFor(t),
    maxCalls: 3, maxMetaCalls: 0, maxRounds: 20,
  }, caller);
  assert.equal(calls, 3);
  assert.equal(report.lowerCalls, 3);
  assert.equal(report.upperCalls, 0);
  assert.equal(report.completedArtifacts, 0);
  assert.equal(report.success, false);
  assert.ok(report.finalErrors.includes("pending-work"));
  assert.ok(report.finalErrors.includes("blocking-claims"));
  assert.ok(report.calls.every(call => call.outcome === "rejected" && call.errors.length > 0));
});

test("model transport failures produce failure records and no false completed artifacts", async t => {
  const caller: ModelCaller = async () => { throw new Error("injected transport failure"); };
  const report = await runSwarm({
    workers: 4, concurrency: 2, size: 4, outputDirectory: await outputFor(t),
    maxCalls: 2, maxMetaCalls: 0,
  }, caller);
  assert.equal(report.success, false);
  assert.equal(report.lowerCalls, 2);
  assert.equal(report.completedArtifacts, 0);
  assert.ok(report.calls.every(call => call.outcome === "model-error" && call.errors.some(error => error.includes("injected transport failure"))));
  assert.ok(report.calls.every(call => call.inputTokens === null && call.outputTokens === null));
});

test("zero call budget is enforced and an existing output directory cannot be reused", async t => {
  let calls = 0;
  const caller: ModelCaller = async () => { calls++; throw new Error("caller must not run"); };
  const outputDirectory = await outputFor(t);
  const options = { workers: 4, concurrency: 2, size: 4, outputDirectory, maxCalls: 0 };
  const report = await runSwarm(options, caller);
  const resultBefore = await readFile(join(outputDirectory, "result.json"), "utf8");
  assert.equal(report.success, false);
  assert.equal(report.lowerCalls, 0);
  assert.equal(report.upperCalls, 0);
  await assert.rejects(runSwarm(options, caller), { code: "EEXIST" });
  assert.equal(await readFile(join(outputDirectory, "result.json"), "utf8"), resultBefore);
  assert.equal(calls, 0);
});

test("a failed CLI turn retains any observed usage instead of counting the failure as free", async t => {
  const caller: ModelCaller = async options => {
    const transcript = answer(options, "unused").transcript;
    throw new CodexWorkerError("nonzero-exit", "turn failed after metered work", { ...transcript, exitCode: 1 });
  };
  const report = await runSwarm({ workers: 2, concurrency: 1, size: 2,
    outputDirectory: await outputFor(t), maxCalls: 1, maxMetaCalls: 0 }, caller);
  assert.equal(report.success, false);
  assert.equal(report.calls[0]?.outcome, "nonzero-exit");
  assert.equal(report.calls[0]?.inputTokens, 10);
  assert.equal(report.calls[0]?.outputTokens, 20);
});

test("transport failures alone do not spend an upper semantic consultation", async t => {
  const requested: string[] = [];
  const caller: ModelCaller = async options => { requested.push(options.model); throw new Error("network unavailable"); };
  const report = await runSwarm({ workers: 4, concurrency: 4, size: 4,
    outputDirectory: await outputFor(t), maxCalls: 8, maxMetaCalls: 2 }, caller);
  assert.equal(report.success, false);
  assert.equal(report.lowerCalls, 8);
  assert.equal(report.upperCalls, 0);
  assert.ok(requested.every(model => model === "gpt-5.6-luna"));
});

test("runtime callers cannot substitute a different lower model", async t => {
  const options = {
    workers: 4, concurrency: 2, size: 4, outputDirectory: await outputFor(t), workerModel: "gpt-6-astra",
  } as unknown as SwarmOptions;
  await assert.rejects(runSwarm(options, async () => { throw new Error("caller must not run"); }), /must use gpt-5.6-luna/);
});

test("observation-driven meta guidance repair lets ordinary workers retry and converge", async t => {
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const requested: string[] = [];
  let roundedResponses = 0;
  let correctedResponses = 0;
  const caller: ModelCaller = async options => {
    requested.push(options.model);
    if (options.model === "gpt-6-astra") {
      assert.ok(options.prompt.includes("Observed failures:"));
      assert.ok(options.prompt.includes("Workers did not request consultation"));
      return answer(options, fixture.artifacts[fixture.specId]!);
    }
    assert.equal(options.model, "gpt-5.6-luna");
    const target = targetOf(options);
    const encodedFiles = /Local files:\n([^\n]+)\n/.exec(options.prompt)?.[1];
    assert.ok(encodedFiles);
    const files = JSON.parse(encodedFiles) as Record<string, string>;
    let content = fixture.artifacts[target]!;
    if (files[fixture.specId]!.includes("Round returned durationSeconds")) {
      roundedResponses++;
      content = content
        .replace("durationSeconds: reading.durationSeconds", "durationSeconds: Math.floor(reading.durationSeconds)")
        .replace("kibibytesPerSecond: rate", "kibibytesPerSecond: Math.floor(rate)");
    } else correctedResponses++;
    return answer(options, content);
  };
  const report = await runSwarm({
    workers: 4, concurrency: 2, size: 4, outputDirectory: await outputFor(t),
    fault: "rounded-guidance", maxCalls: 30, maxMetaCalls: 2, maxRounds: 20,
  }, caller);
  assert.ok(roundedResponses >= 2);
  assert.ok(correctedResponses >= 5);
  assert.ok(requested.includes("gpt-6-astra"));
  assert.ok(report.interventions >= 1);
  assert.ok(report.upperCalls <= 2);
  assert.ok(report.lowerCalls <= 30);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.completedArtifacts, fixture.writableIds.length);
  assert.ok(report.maxActiveWorkers <= 2);
});
