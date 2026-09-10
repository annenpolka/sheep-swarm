import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFixture, type FixtureObserver } from "../src/fixture.ts";
import { capture } from "../src/docker-agent-worker.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { ISOLATED_FIXTURE_RUNNER } from "../src/docker-fixture-observer.ts";
import { dockerWorkspaceWrites, runSwarm, type ModelCaller } from "../src/swarm.ts";

// Same guest runner exercised in a bounded local child, only with synthetic code.
// This tests its contract, not microVM isolation (the real probe does that).
const observeLocally: FixtureObserver = async (files, calls, timeoutMs) => {
  const result = await capture(process.execPath, ["--permission", "--experimental-vm-modules", "--input-type=module", "-e", ISOLATED_FIXTURE_RUNNER],
    { input: JSON.stringify({ files, calls, timeoutMs: Math.min(timeoutMs, 100) }), timeoutMs: 2000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout) as unknown;
};

async function output(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sheep-docker-swarm-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "run");
}
const migrated = createFixture({ size: 4, variant: "migrated" });
const targetOf = (prompt: string) => /Update only (\S+) to satisfy/.exec(prompt)![1]!;
function callerWith(change: (target: string) => Record<string, string | null>): ModelCaller {
  return async options => {
    const usage = [{ event: {}, inputTokens: 10, outputTokens: 20 }];
    return { result: { content: "INVALID SELF-REPORT; accept only the actual files", note: "synthetic test" },
      requestedModel: options.model, usage,
      transcript: { requestedModel: options.model, effectiveModelEvidence: null, events: [], usage, stdout: "", stderr: "",
        exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
        runtime: "docker-agent", cleanupSucceeded: true, usageCompleteness: "complete",
        workspaceChanges: change(targetOf(options.prompt)) },
    };
  };
}

test("isolated fixture execution preserves the frozen oracle and catches boundary mutations", async () => {
  const fixture = createFixture({ size: 4, variant: "migrated", observe: observeLocally });
  assert.deepEqual(await fixture.verify(fixture.artifacts), { ok: true, errors: [] });
  const baseline = createFixture({ size: 4 });
  assert.equal((await fixture.verify({ ...baseline.artifacts, [fixture.sourceId]: fixture.artifacts[fixture.sourceId]! })).ok, false);
  const target = fixture.consumerIds[0]!;
  for (const replacement of [
    ["<= 0.3", "< 0.3"], ["<= 0.3", "<= 300"],
    ["durationSeconds: reading.durationSeconds", "durationSeconds: Math.floor(reading.durationSeconds)"],
    ["=== 0 ? 0", "=== 0 ? Infinity"],
  ]) {
    const wrong = fixture.artifacts[target]!.replace(replacement[0]!, replacement[1]!);
    assert.notEqual(wrong, fixture.artifacts[target]);
    const files = { ...fixture.artifacts, [target]: wrong };
    assert.equal((await fixture.verify(files, [target])).ok, false);
    assert.equal((await migrated.verify(files, [target])).ok, false);
  }
});

test("isolated runner refuses host APIs, external imports and infinite candidate evaluation", async () => {
  const fixture = createFixture({ size: 4, variant: "migrated", observe: observeLocally });
  const target = fixture.consumerIds[0]!;
  for (const source of [
    'import fs from "node:fs"; export const summarize=()=>fs.readFileSync("/etc/hosts");',
    'import "../../outside.mjs";', 'export function summarize(){process.stdout.write("forged");}',
    'while(true){}', 'export function summarize(){while(true){}}',
    'export function summarize(){return {toJSON(){while(true){}}}}',
  ]) assert.equal((await fixture.verify({ ...fixture.artifacts, [target]: source }, [target])).ok, false);
});

test("visible tests fail the migrated source with old targets and pass every fixed target", async t => {
  const directory = await output(t);
  const baseline = createFixture({ size: 4 });
  for (const target of migrated.writableIds) {
    for (const [state, targetContent] of [["old", baseline.artifacts[target]!], ["fixed", migrated.artifacts[target]!]]) {
      const files = { ...migrated.artifacts, [target]: targetContent!, "visible.test.mjs": migrated.visibleTest(target) };
      for (const [id, content] of Object.entries(files)) {
        await mkdir(dirname(join(directory, id)), { recursive: true });
        await writeFile(join(directory, id), content);
      }
      // node:test also runs when the file is executed directly; avoid --test's
      // cwd discovery outside the deliberately allowed temporary directory.
      const result = await capture(process.execPath, ["--permission", `--allow-fs-read=${directory}`, join(directory, "visible.test.mjs")], { timeoutMs: 3000 });
      assert.equal(result.exitCode === 0, state === "fixed", `${target}: ${result.stdout} ${result.stderr}`);
    }
  }
});

test("tool workers receive only versioned local context and commit actual deltas despite false final text", async t => {
  const caller = callerWith(target => ({ [target]: migrated.artifacts[target]! }));
  const outputDirectory = await output(t);
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory,
    runtime: "docker-agent", workerTools: "local", maxMetaCalls: 0 }, async options => {
    assert.equal(options.tools, "local");
    const encoded = /Local files:\n([^\n]+)\n/.exec(options.prompt)![1]!;
    const context = JSON.parse(encoded);
    assert.deepEqual(Object.keys(options.files!).sort(), [...Object.keys(context), "visible.test.mjs"].sort());
    assert.ok(Object.entries(context).every(([id, value]) => options.files![id] === value));
    assert.equal(options.files!["visible.test.mjs"], migrated.visibleTest(targetOf(options.prompt)));
    return caller(options);
  }, observeLocally);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.completedArtifacts, 5);
  assert.equal(report.lowerCalls, 5);
  assert.equal(report.upperCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(join(outputDirectory, "artifacts.json"), "utf8")), migrated.artifacts);
});

test("a tool worker cannot hide test tampering, out-of-lease edits or deletions in a valid target edit", async t => {
  for (const extra of [{ "visible.test.mjs": "// always passes" }, { [migrated.sourceId]: "bad library" }, { [migrated.consumerIds[0]!]: null }]) {
    const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
      runtime: "docker-agent", workerTools: "local", maxCalls: 1, maxMetaCalls: 0 },
    callerWith(target => ({ [target]: migrated.artifacts[target]!, ...extra })), observeLocally);
    assert.equal(report.success, false);
    assert.equal(report.completedArtifacts, 0);
    assert.ok(report.calls.every(call => call.outcome !== "committed"));
  }
});

test("missing workspace evidence cannot fall back to final-answer content", async t => {
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "docker-agent", workerTools: "local", maxCalls: 1, maxMetaCalls: 0 }, async options => {
    const response = await callerWith(() => ({}))(options);
    return { ...response, result: { content: migrated.artifacts[targetOf(options.prompt)]!, note: "claims fixed" } };
  }, observeLocally);
  assert.equal(report.success, false);
  assert.equal(report.completedArtifacts, 0);
});

test("unknown Docker usage stops subsequent waves and upper intervention", async t => {
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "docker-agent", workerTools: "local", maxCalls: 10, maxMetaCalls: 2 }, async options => {
    const response = await callerWith(() => ({}))(options);
    throw new CodexWorkerError("timeout", "interrupted inference", { ...response.transcript,
      ...{ runtime: "docker-agent", usageCompleteness: "partial-or-unknown" as const }, timedOut: true });
  }, observeLocally);
  assert.equal(report.lowerCalls, 2);
  assert.equal(report.upperCalls, 0);
  assert.ok(report.calls.every(call => call.usageCompleteness === "partial-or-unknown" && call.inputTokens === 10));
});

test("local tools cannot silently use the Codex host runtime", async t => {
  await assert.rejects(runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    workerTools: "local" }, callerWith(() => ({}))), /require the Docker Agent runtime/);
});

test("verifier infrastructure failures stop admission without a semantic upper intervention", async t => {
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "docker-agent", workerTools: "local", maxCalls: 10, maxMetaCalls: 2 },
  callerWith(target => ({ [target]: migrated.artifacts[target]! })), async () => { throw new Error("sandbox setup unavailable"); });
  assert.equal(report.success, false);
  assert.equal(report.lowerCalls, 2);
  assert.equal(report.upperCalls, 0);
  assert.equal(report.completedArtifacts, 0);
  assert.ok(report.calls.every(call => call.outcome === "validator-error" && call.errors.some(error => error.includes("sandbox setup unavailable"))));
});

test("workspace acceptance requires both cleanup and complete usage receipts", async () => {
  const valid = (await callerWith(target => ({ [target]: migrated.artifacts[target]! }))({ model: "gpt-5.6-luna",
    prompt: "Update only consumers/consumer-001.mjs to satisfy", schema: {}, cwd: "/unused", timeoutMs: 1 })).transcript;
  for (const fields of [{ cleanupSucceeded: false }, { usageCompleteness: "partial-or-unknown" }, { workspaceChanges: 42 }])
    assert.throws(() => dockerWorkspaceWrites({ ...valid, ...fields }), /Missing completed Docker workspace receipt/);
});

test("failed worker cleanup stops swarm admission even after a fully metered response", async t => {
  const report = await runSwarm({ workers: 4, concurrency: 2, size: 4, outputDirectory: await output(t),
    runtime: "docker-agent", workerTools: "local", maxCalls: 10, maxMetaCalls: 2 }, async options => {
    const response = await callerWith(() => ({}))(options);
    throw new CodexWorkerError("nonzero-exit", "VM cleanup failed", { ...response.transcript,
      ...{ runtime: "docker-agent", cleanupSucceeded: false, usageCompleteness: "complete" } });
  }, observeLocally);
  assert.equal(report.lowerCalls, 2); assert.equal(report.upperCalls, 0);
  assert.equal(report.success, false); assert.ok(report.finalErrors.includes("sandbox-cleanup-failed"));
});
