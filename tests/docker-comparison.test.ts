import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHeldoutFixture } from "../src/heldout-fixture.ts";
import type { FixtureObserver } from "../src/fixture.ts";
import { capture } from "../src/docker-agent-worker.ts";
import { ISOLATED_FIXTURE_RUNNER } from "../src/docker-fixture-observer.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { runComparison, type ComparisonCaller, type ComparisonMethod } from "../src/comparison.ts";

const observe: FixtureObserver = async (files, calls, timeoutMs, imports = []) => {
  const child = await capture(process.execPath, ["--permission", "--experimental-vm-modules", "--input-type=module", "-e", ISOLATED_FIXTURE_RUNNER],
    { input: JSON.stringify({ files, calls, timeoutMs, imports }), timeoutMs: 4000 });
  assert.equal(child.exitCode, 0, child.stderr);
  return JSON.parse(child.stdout) as unknown;
};
async function output(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sheep-docker-compare-")));
  t.after(() => rm(directory, { recursive: true, force: true })); return join(directory, "run");
}
const fixed = createHeldoutFixture({ size: 4, variant: "migrated" });
const limits = { runtime: "docker-agent", workerTools: "local", size: 4, workers: 4, concurrency: 2,
  maxCalls: 12, maxTokens: 10000, reserveTokensPerCall: 500 } as const;
const caller: ComparisonCaller = async options => {
  const files = JSON.parse(options.prompt.split("CONTEXT_JSON\n")[1]!.split("\nEXTRA_JSON")[0]!);
  const extra = JSON.parse(options.prompt.split("EXTRA_JSON\n")[1]!);
  const management = options.prompt.startsWith("Manage local workers");
  const targets: readonly string[] = management ? [] : extra.target ? [extra.target] : fixed.writableIds;
  if (management) { assert.equal(options.model, "gpt-6-astra"); assert.equal(options.tools, undefined); assert.equal(options.files, undefined); }
  else {
    assert.equal(options.model, "gpt-5.6-luna"); assert.equal(options.tools, "local");
    assert.deepEqual(options.files, { ...files, "visible.test.mjs": fixed.visibleTest(targets) });
  }
  const usage = [{ event: {}, inputTokens: 10, outputTokens: 20, totalTokens: 30 }];
  return { result: { writes: [], targets: management ? extra.readyTargets.slice(0, extra.concurrency) : [], note: "synthetic receipt" },
    requestedModel: options.model, usage,
    transcript: { requestedModel: options.model, effectiveModelEvidence: null, usage, events: [], stdout: "", stderr: "", exitCode: 0,
      signal: null, timedOut: false, cancelled: false, durationMs: 1, runtime: "docker-agent", cleanupSucceeded: true, usageCompleteness: "complete",
      workspaceChanges: Object.fromEntries(targets.map(id => [id, fixed.artifacts[id]!])) } };
};

test("isolated thermal observations preserve values and mandatory imports independently of source-text discovery", async () => {
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated", observe });
  assert.equal((await fixture.verify(fixed.artifacts)).ok, true);
  const target = fixed.writableIds[0]!, source = fixed.artifacts[target]!;
  for (const change of [
    source.replace("value.kelvin >= -10 + 273.15", "value.kelvin >= -10"),
    source.replace('import { sample } from "../lib/thermal.mjs";', '// import { sample } from "../lib/thermal.mjs";')
      .replace("const value = sample(input);", "const value = { kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000 };"),
  ]) {
    const contents = { ...fixed.artifacts, [target]: change };
    for (const scope of [[target], ["regions/region-1.mjs"], undefined]) {
      const isolated = await fixture.verify(contents, scope), host = await fixed.verify(contents, scope);
      assert.equal(isolated.ok, false); assert.equal(host.ok, false);
      if (change.includes("// import")) assert.ok(isolated.errors.some(error => error.includes("missing required import")));
    }
  }
});

test("thermal visible tests fail old targets and pass fixed targets, including the single-worker test bundle", async t => {
  const directory = await output(t), old = createHeldoutFixture({ size: 4 });
  for (const [id, content] of Object.entries(fixed.artifacts)) { await mkdir(dirname(join(directory, id)), { recursive: true }); await writeFile(join(directory, id), content); }
  const run = () => capture(process.execPath, ["--permission", `--allow-fs-read=${directory}`, join(directory, "visible.test.mjs")], { timeoutMs: 3000 });
  for (const id of fixed.writableIds) {
    await writeFile(join(directory, "visible.test.mjs"), fixed.visibleTest([id]));
    await writeFile(join(directory, id), old.artifacts[id]!);
    assert.notEqual((await run()).exitCode, 0);
    await writeFile(join(directory, id), fixed.artifacts[id]!);
    assert.equal((await run()).exitCode, 0);
  }
  await writeFile(join(directory, "visible.test.mjs"), fixed.visibleTest(fixed.writableIds));
  assert.equal((await run()).exitCode, 0);
});

test("single Luna, manager-local and both Sheep methods use equal local tools and the same frozen oracle", async t => {
  const fingerprints = new Set<string>();
  for (const method of ["single-luna", "manager-local", "sheep-fixed", "sheep-full"] as ComparisonMethod[]) {
    const outputDirectory = await output(t);
    const report = await runComparison({ ...limits, method, outputDirectory }, caller, observe);
    assert.equal(report.success, true, `${method}: ${report.finalErrors.join("\n")}`);
    assert.equal(report.budget.unknownUsageCalls, 0);
    assert.equal(report.lowerCalls, method === "single-luna" ? 1 : 5);
    assert.equal(report.upperCalls > 0, method === "manager-local");
    assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "artifacts.json"), "utf8")), fixed.artifacts);
    fingerprints.add(report.fixtureFingerprint);
  }
  assert.equal(fingerprints.size, 1);
});

test("all actual edits are checked even when the model returns no reported writes", async t => {
  for (const path of ["visible.test.mjs", fixed.sourceId]) {
    const report = await runComparison({ ...limits, method: "sheep-fixed", maxCalls: 1, maxUpperCalls: 0, outputDirectory: await output(t) }, async options => {
      const result = await caller(options);
      return { ...result, transcript: { ...result.transcript, ...{ workspaceChanges: { [fixed.writableIds[0]!]: fixed.artifacts[fixed.writableIds[0]!]!, [path]: "modified" } } } };
    }, observe);
    assert.equal(report.success, false);
    assert.equal(report.calls[0]!.outcome, "patch-error");
    assert.ok(report.calls[0]!.errors.some(error => error.includes("authority")));
  }
});

test("partial usage locks comparison admission while preserving metered lower bounds", async t => {
  const report = await runComparison({ ...limits, method: "sheep-fixed", outputDirectory: await output(t) }, async options => {
    const result = await caller(options);
    throw new CodexWorkerError("timeout", "inference interrupted", { ...result.transcript, timedOut: true,
      ...{ usageCompleteness: "partial-or-unknown" } });
  }, observe);
  assert.equal(report.success, false); assert.equal(report.calls.length, 2);
  assert.equal(report.budget.unknownUsageCalls, 2); assert.equal(report.budget.observedTokens, 60);
});

test("verifier setup failure and zero upper allowance cause no model spend", async t => {
  let calls = 0;
  const unused: ComparisonCaller = async () => { calls++; throw new Error("caller must not run"); };
  const failed = await runComparison({ ...limits, method: "sheep-fixed", outputDirectory: await output(t) }, unused,
    async () => { throw new Error("verifier setup failed"); });
  assert.equal(failed.success, false); assert.ok(failed.finalErrors.includes("verification-unavailable"));
  const capped = await runComparison({ ...limits, method: "manager-local", maxUpperCalls: 0, outputDirectory: await output(t) }, unused, observe);
  assert.equal(capped.success, false); assert.ok(capped.finalErrors.includes("upper-call-limit"));
  assert.equal(calls, 0);
  await assert.rejects(runComparison({ ...limits, method: "single-upper", outputDirectory: await output(t) }, unused, observe), /single-luna/);
});

test("failed worker cleanup stops comparison admission even with complete usage", async t => {
  const report = await runComparison({ ...limits, method: "sheep-fixed", outputDirectory: await output(t) }, async options => {
    const result = await caller(options);
    throw new CodexWorkerError("nonzero-exit", "VM cleanup failed", { ...result.transcript,
      ...{ runtime: "docker-agent", cleanupSucceeded: false, usageCompleteness: "complete" } });
  }, observe);
  assert.equal(report.calls.length, 2); assert.equal(report.success, false);
  assert.equal(report.budget.unknownUsageCalls, 0); assert.ok(report.finalErrors.includes("sandbox-cleanup-failed"));
});
