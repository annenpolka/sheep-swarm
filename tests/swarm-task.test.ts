import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../src/docker-agent-worker.ts";
import { ISOLATED_FIXTURE_RUNNER } from "../src/docker-fixture-observer.ts";
import { runSwarm } from "../src/swarm.ts";
import type { FixtureObserver } from "../src/fixture.ts";
import { createDiagnosticsFixture, diagnosticsTask } from "../experiments/docker-diagnostics-task.ts";

const observe: FixtureObserver = async (files, calls, timeoutMs, imports = []) => {
  const result = await capture(process.execPath, ["--permission", "--experimental-vm-modules", "--input-type=module", "-e", ISOLATED_FIXTURE_RUNNER],
    { input: JSON.stringify({ files, calls, timeoutMs, imports }), timeoutMs: 6000 });
  assert.equal(result.exitCode, 0, result.stderr); return JSON.parse(result.stdout) as unknown;
};

test("implementation task's unimplemented artifacts fail the frozen oracle", async () => {
  const fixture = createDiagnosticsFixture(observe), files = { ...fixture.artifacts, [fixture.changedSource.id]: fixture.changedSource.content };
  for (const target of fixture.writableIds) {
    const result = await fixture.verify(files, [target]);
    assert.equal(result.ok, false); assert.notEqual(result.executionFailure, true);
  }
  assert.equal((await fixture.verify({ ...files, [fixture.specId]: "Accept all" })).ok, false);
});

test("existing swarm scheduler uses the trusted implementation task and rejects edits outside its target", async t => {
  const root = await mkdtemp(join(tmpdir(), "swarm-task-")); t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = createDiagnosticsFixture(observe);
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 2, maxCalls: 2, maxMetaCalls: 0, outputDirectory: join(root, "run"),
    runtime: "docker-agent", workerTools: "local" }, async options => {
      assert.ok(options.files?.[fixture.specId]); assert.ok(options.files?.[fixture.sourceId]);
      assert.equal(fixture.writableIds.filter(id => Object.hasOwn(options.files!, id)).length, 1);
      const usage = [{ inputTokens: 10, outputTokens: 10, totalTokens: 20, event: {} }];
      return { requestedModel: options.model, result: { content: "", note: "illegal test edit" }, usage,
        transcript: { requestedModel: options.model, effectiveModelEvidence: null, usage, events: [], stdout: "", stderr: "", exitCode: 0,
          signal: null, timedOut: false, cancelled: false, durationMs: 1, runtime: "docker-agent", usageCompleteness: "complete",
          cleanupSucceeded: true, workspaceChanges: { "visible.test.mjs": "Accept all" } } };
    }, observe, diagnosticsTask);
  assert.equal(report.task, diagnosticsTask.id); assert.equal(report.registeredWorkers, 4);
  assert.equal(report.lowerCalls, 2); assert.equal(report.upperCalls, 0); assert.equal(report.success, false);
  assert.equal(report.everCommittedArtifacts, 0); assert.ok(report.calls.every(call => call.outcome === "outside-authority"), JSON.stringify(report.calls));
});
