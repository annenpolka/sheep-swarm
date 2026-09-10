import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capture, type DockerTranscript } from "../src/docker-agent-worker.ts";
import { ISOLATED_FIXTURE_RUNNER } from "../src/docker-fixture-observer.ts";
import { createMechanismFixture, type MechanismFamily } from "../src/mechanism-fixture.ts";
import { runMechanism, mechanismToolEvents, type MechanismCaller, type MechanismMethod } from "../src/mechanism-run.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";
import type { FixtureObserver } from "../src/fixture.ts";

const observe: FixtureObserver = async (files, calls, timeoutMs, imports = []) => {
  const child = await capture(process.execPath, ["--permission", "--experimental-vm-modules", "--input-type=module", "-e", ISOLATED_FIXTURE_RUNNER],
    { input: JSON.stringify({ files, calls, timeoutMs, imports }), timeoutMs: 5000 });
  assert.equal(child.exitCode, 0, child.stderr); return JSON.parse(child.stdout) as unknown;
};
async function output(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "sheep-docker-mechanism-")));
  t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, "run");
}
const defaults = { runtime: "docker-agent", workerTools: "local", groups: 1, workers: 2, concurrency: 2,
  maxCredits: 30, maxCalls: 100, maxMetaCalls: 0 } as const;
function supplied(options: Parameters<MechanismCaller>[0]) {
  return JSON.parse(options.prompt.split("PUBLIC_INPUT_JSON\n")[1]!) as {
    stage: number; role: string; target: string | null; context: { contents: Record<string, string>; reads: Record<string, unknown> };
    requiredReads?: string[]; previousVisibleErrors: unknown; readyTargets?: string[];
  };
}
function correct(family: MechanismFamily): MechanismCaller {
  const fixture = createMechanismFixture({ family, groups: 1 });
  return async options => {
    const input = supplied(options), files = input.context.contents;
    const targets = input.target ? [input.target] : fixture.writableIds;
    assert.equal(options.model, "gpt-5.6-luna"); assert.equal(options.tools, "local");
    const feedback = fixture.visibleFeedback(files, input.stage, targets);
    assert.deepEqual(options.files, { ...files, "visible.test.mjs": feedback.source });
    assert.deepEqual(Object.keys(files).sort(), Object.keys(input.context.reads).sort());
    if (feedback.requiredReads.length) {
      assert.equal(feedback.readyTargets.length, 0);
      assert.ok(!JSON.stringify(input.previousVisibleErrors).includes("expected"));
      assert.ok(!feedback.source.includes('"label":"raw-0"'));
    }
    const usageEvent = { type: "token_usage", timestamp: "synthetic", usage: { last_message: {
      input_tokens: 100, cached_input_tokens: 0, cached_write_tokens: 0, output_tokens: 20, reasoning_tokens: 0, Model: `chatgpt/${options.model}` } } };
    const usage = [{ event: usageEvent, inputTokens: 100, outputTokens: 20, totalTokens: 120 }];
    return { requestedModel: options.model, usage,
      result: { writes: [], readRequests: feedback.requiredReads, note: "Synthetic context-respecting implementation" },
      transcript: { requestedModel: options.model, effectiveModelEvidence: null, usage,
        events: [{ type: "agent_info", model: `chatgpt/${options.model}` }, { type: "stream_started", session_id: "synthetic" }, usageEvent, { type: "stream_stopped", session_id: "synthetic", reason: "normal" }], stdout: "", stderr: "",
        exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1, runtime: "docker-agent",
        runtimeVersion: "v1.137.0", usageCompleteness: "complete", cleanupSucceeded: true,
        workspaceChanges: feedback.requiredReads.length ? {} : Object.fromEntries(targets.map(id => [id, fixture.goldForStage(input.stage)[id]!])) } };
  };
}

for (const family of ["static", "semantic", "staged"] as const) test(`${family}: isolated oracle agrees with host on base, gold, pipeline and mutations`, async () => {
  const host = createMechanismFixture({ family, groups: 2 }), isolated = createMechanismFixture({ family, groups: 2, observe });
  const base = { ...host.artifacts, ...host.changesForStage(0) };
  const failed = await isolated.verify(base, 0);
  assert.equal(failed.ok, false); assert.equal(failed.executionFailure, undefined);
  for (const id of host.writableIds) assert.ok(failed.errors.some(error => error.startsWith(id)));
  for (let stage = 0; stage < host.stageCount; stage++) for (const mode of ["visible", "final"] as const) {
    const gold = host.goldForStage(stage);
    assert.deepEqual(await isolated.verify(gold, stage, undefined, mode), await host.verify(gold, stage, undefined, mode));
    const id = host.writableIds[1]!;
    const mutated = { ...gold, [id]: gold[id]!.replace("Math.floor", "Math.trunc") };
    assert.equal((await isolated.verify(mutated, stage, [id], mode)).ok, false);
    assert.equal((await host.verify(mutated, stage, [id], mode)).ok, false);
  }
  const gold = host.goldForStage(0), id = host.writableIds[0]!;
  const removed = gold[id]!.replace('import { decode }', '// import { decode }');
  assert.ok((await isolated.verify({ ...gold, [id]: removed }, 0, [id])).errors.some(e => e.includes("missing required import")));
});

test("virtual JSON filesystem supports async reads, denies host paths, and respects supplied artifact scope", async () => {
  const fixture = createMechanismFixture({ family: "semantic", groups: 1, observe });
  const gold = fixture.goldForStage(0), id = fixture.writableIds[0]!;
  const asyncSource = gold[id]!.replace('import { readFileSync } from "node:fs"', 'import { readFile } from "node:fs/promises"')
    .replaceAll('readFileSync(', 'await readFile(').replace('export function run', 'export async function run');
  assert.equal((await fixture.verify({ ...gold, [id]: asyncSource }, 0, [id])).ok, true);
  for (const source of [
    'import { readFileSync } from "node:fs"; export function run() { return readFileSync("/etc/passwd", "utf8"); }',
    'export function run() { return URL.constructor("return process")().env; }',
    'export function run() { return globalThis.constructor.constructor("return process")().env; }',
  ]) {
    const observations = await observe({ "attack.mjs": source }, [{ id: "attack.mjs", method: "run", args: [] }], 3000) as { error?: string }[];
    assert.equal(observations[0]!.error, "Isolated fixture invocation failed");
  }
  const selected = Object.keys(gold).filter(key => !key.startsWith("policies/"));
  assert.equal((await fixture.verify(gold, 0, [id], "visible", selected)).ok, false);
});

test("visible bundle reveals no unread or stale policy cases and passes current gold in every stage", async t => {
  const fixture = createMechanismFixture({ family: "staged", groups: 1 }), dir = await output(t);
  const id = fixture.writableIds[0]!;
  for (let stage = 0; stage < fixture.stageCount; stage++) {
    const gold = fixture.goldForStage(stage);
    const bare = { [id]: gold[id]!, [fixture.specId]: gold[fixture.specId]!, "lib/decode.mjs": gold["lib/decode.mjs"]! };
    const unread = fixture.visibleFeedback(bare, stage, [id]);
    assert.deepEqual(unread.requiredReads, ["config/domain-registry.json"]);
    assert.deepEqual(unread.readyTargets, []);
    assert.ok(!unread.source.includes("policy-003"));
    const registry = { ...bare, "config/domain-registry.json": gold["config/domain-registry.json"]! };
    assert.deepEqual(fixture.visibleFeedback(registry, stage, [id]).requiredReads, ["policies/policy-003.json"]);
    if (stage > 0) assert.deepEqual(fixture.visibleFeedback({ ...registry, "policies/policy-003.json": fixture.goldForStage(stage - 1)["policies/policy-003.json"]! }, stage, [id]).readyTargets, []);
    for (const [path, content] of Object.entries(gold)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), content); }
    const bundle = fixture.visibleFeedback(gold, stage, fixture.writableIds).source;
    assert.ok(!bundle.includes('"value":17.25'));
    await writeFile(join(dir, "visible.test.mjs"), bundle);
    const run = () => capture(process.execPath, ["--permission", `--allow-fs-read=${dir}`, "--input-type=module", "-e",
      `process.chdir(${JSON.stringify(dir)}); await import(${JSON.stringify(join(dir, "visible.test.mjs"))});`], { timeoutMs: 3000 });
    assert.equal((await run()).exitCode, 0);
    await writeFile(join(dir, id), fixture.artifacts[id]!);
    assert.notEqual((await run()).exitCode, 0);
  }
});

test("Docker mechanism preserves paid discovery, stage rereads and method roles", async t => {
  const fingerprints = new Set<string>();
  for (const method of ["sheep", "single-luna", "no-memory", "no-upper"] as MechanismMethod[]) {
    const report = await runMechanism({ ...defaults, method, family: "staged", outputDirectory: await output(t) }, correct("staged"), observe);
    assert.equal(report.success, true, report.finalErrors.join("\n"));
    assert.equal(report.stages.length, 3); assert.equal(report.upperCalls, 0);
    assert.equal(report.budget.unknownUsageCalls, 0); assert.equal(report.budget.activeReservations, 0);
    assert.equal(report.budget.settledCalls, report.calls.length);
    if (method === "single-luna") {
      assert.equal(report.configuration.workers, 1); assert.equal(report.configuration.concurrency, 1);
      assert.equal(report.stages[0]!.readCalls, 0);
    } else {
      assert.equal(report.stages[0]!.readCalls, 12);
      assert.equal(report.discovery.deliveredEdges.length, 12);
      assert.ok(report.calls.filter(c => c.outcome === "committed").every(c => c.contextArtifacts.includes("policies/policy-003.json")));
      assert.ok(report.stages.slice(1).every(s => s.readCalls === 0)); // New checkout versions of learned providers.
    }
    if (method === "no-memory") assert.ok(report.calls.every(call => call.memoryEntries === 0));
    fingerprints.add(report.fixtureFingerprint);
  }
  assert.equal(fingerprints.size, 1);
});

test("unread writes, mixed actual edits plus read requests, and unauthorized deltas never commit", async t => {
  const fixture = createMechanismFixture({ family: "semantic", groups: 1 });
  for (const mutation of ["skip-read", "mix-read", "test-edit", "pinned-edit", "delete"] as const) {
    const family = mutation === "skip-read" || mutation === "mix-read" ? "semantic" : "static";
    const report = await runMechanism({ ...defaults, family, maxCalls: 1, concurrency: 1, outputDirectory: await output(t) }, async options => {
      const result = await correct(family)(options), input = supplied(options), id = input.target!;
      const changes = mutation === "test-edit" ? { "visible.test.mjs": "accepted" }
        : mutation === "pinned-edit" ? { [fixture.specId]: "accepted" }
        : mutation === "delete" ? { [id]: null } : { [id]: fixture.goldForStage(0)[id]! };
      return { ...result, result: { ...result.result, readRequests: mutation === "mix-read" ? ["config/domain-registry.json"] : [] },
        transcript: { ...result.transcript, ...{ workspaceChanges: changes } } };
    }, observe);
    assert.equal(report.success, false); assert.ok(report.calls.every(c => c.outcome !== "committed"));
    assert.equal(report.discovery.deliveredEdges.length, 0);
  }
});

test("a final-only failure ends staged execution without another model call or feedback", async t => {
  const prompts: string[] = [];
  const report = await runMechanism({ ...defaults, family: "staged", outputDirectory: await output(t) }, async options => {
    prompts.push(options.prompt); assert.equal(supplied(options).stage, 0);
    const result = await correct("staged")(options), transcript = result.transcript as DockerTranscript;
    const changes = { ...transcript.workspaceChanges };
    for (const [id, content] of Object.entries(changes)) if (id.endsWith("/ingest.mjs")) {
      changes[id] = content!.replace("export function run(raw) {", "export function run(raw) { if(raw.value === 17.25)return null;");
    }
    return { ...result, transcript: { ...transcript, workspaceChanges: changes } };
  }, observe);
  assert.equal(report.success, false); assert.equal(report.stages.length, 1);
  assert.equal(report.terminationReason, "final-quality-failed"); assert.equal(report.stages[0]!.protocolClean, true);
  assert.equal(report.calls.length, 18); assert.ok(prompts.every(prompt => !prompt.includes('"finalErrors"')));
});

test("unknown usage, failed cleanup and unavailable verifier stop admission", async t => {
  for (const kind of ["usage", "cleanup", "verifier"] as const) {
    let called = 0;
    const report = await runMechanism({ ...defaults, family: "static", concurrency: 1, outputDirectory: await output(t) }, async options => {
      called++; const result = await correct("static")(options);
      throw new CodexWorkerError("timeout", "injected failure", { ...result.transcript,
        ...{ usageCompleteness: kind === "usage" ? "partial-or-unknown" : "complete", cleanupSucceeded: kind !== "cleanup" } });
    }, kind === "verifier" ? async () => { throw new Error("VM unavailable"); } : observe);
    assert.equal(report.success, false); assert.equal(called, kind === "verifier" ? 0 : 1);
    assert.equal(report.budget.activeReservations, 0);
    assert.equal(report.budget.unknownUsageCalls, kind === "usage" ? 1 : 0);
    if (kind === "usage") assert.ok(report.budget.observedCredits > 0);
    if (kind !== "usage") assert.equal(report.terminationReason, "execution-error");
  }
});

test("tool audit accepts pinned local calls, rejects forbidden and unmatched executions", async () => {
  const call = { type: "tool_call", tool_call: { id: "call-1", function: { name: "check_local" } }, tool_definition: { name: "check_local" } };
  const events = [call, { type: "tool_call_output", tool_call_id: "call-1", tool_definition: { name: "check_local" } }];
  assert.deepEqual(mechanismToolEvents({ transcript: { events } }, true), []);
  assert.ok(mechanismToolEvents({ transcript: { events } }).length);
  for (const invalid of [events.slice(1), [{ ...call, tool_definition: { name: "shell" } }],
    [{ type: "item.completed", item: { type: "command_execution" } }]]) {
    assert.ok(mechanismToolEvents({ transcript: { events: invalid } }, true).length);
  }
  // The pinned real event fixture includes an intentionally abbreviated stream;
  // it cannot be mistaken for a complete tool-audit receipt.
  const abbreviated = (await readFile(new URL("fixtures/docker-agent-v1.137.0-local.jsonl", import.meta.url), "utf8")).trim().split("\n").map(row => JSON.parse(row));
  assert.ok(mechanismToolEvents({ transcript: { events: abbreviated } }, true).length);
});

test("new Docker standalone Astra and incompatible local-tool runtime are rejected before dispatch", async t => {
  const unused: MechanismCaller = async () => { throw new Error("must not dispatch"); };
  await assert.rejects(runMechanism({ ...defaults, method: "single-astra", family: "static", outputDirectory: await output(t) }, unused, observe), /single-luna/);
  await assert.rejects(runMechanism({ ...defaults, runtime: "codex", family: "static", outputDirectory: await output(t) }, unused, observe), /Local tools/);
});

test("selected reads are not available to the verifier until a paid call delivers them", async t => {
  let deliveredPolicy = false;
  const caller = correct("semantic");
  const report = await runMechanism({ ...defaults, family: "semantic", concurrency: 1, maxCalls: 2, outputDirectory: await output(t) }, async options => {
    const input = supplied(options);
    if (input.context.contents["policies/policy-003.json"]) deliveredPolicy = true;
    return caller(options);
  }, async (...args) => {
    // Final verification may use the whole fixture. A local verification cannot
    // execute after two read-request calls with no third delivery call.
    if (args[1].length < 20) assert.equal(deliveredPolicy, true);
    return observe(...args);
  });
  assert.equal(report.calls.length, 2); assert.equal(deliveredPolicy, false);
  assert.equal(report.stages[0]!.readCalls, 2);
  assert.deepEqual(report.discovery.deliveredEdges.map(e => e.provider), ["config/domain-registry.json"]);
});

test("selective upper intervention stays tool-less and guidance-scoped with Docker workers", async t => {
  const caller = correct("static");
  let failures = 0, upper = 0;
  let last: Awaited<ReturnType<MechanismCaller>> | undefined;
  const report = await runMechanism({ ...defaults, family: "static", maxMetaCalls: 1, outputDirectory: await output(t) }, async options => {
    const input = supplied(options);
    if (input.role === "meta") {
      upper++; assert.equal(options.model, "gpt-6-astra"); assert.equal(options.tools, undefined); assert.equal(options.files, undefined);
      const receipt = last!;
      const usageEvent = { type: "token_usage", usage: { last_message: { input_tokens: 100, cached_input_tokens: 0,
        cached_write_tokens: 0, output_tokens: 20, reasoning_tokens: 0, Model: "chatgpt/gpt-6-astra" } } };
      return { ...receipt, requestedModel: options.model,
        result: { writes: [{ id: "docs/working-guidance.md", content: input.context.contents["docs/working-guidance.md"] + "\nRespect current normative requirements.\n" }], readRequests: [], note: "Repair shared guidance" },
        transcript: { ...receipt.transcript, requestedModel: options.model, ...{ workspaceChanges: {} },
          events: [{ type: "toolset_info", available_tools: [] }, { type: "stream_started", session_id: "meta" }, usageEvent, { type: "stream_stopped", session_id: "meta", reason: "normal" }] } };
    }
    const result = await caller(options); last = result;
    if (failures++ >= 2) return result;
    return { ...result, transcript: { ...result.transcript, ...{ workspaceChanges: { [input.target!]: "export function run(){return null;}" } } } };
  }, observe);
  assert.equal(report.success, true, report.finalErrors.join("\n")); assert.equal(upper, 1); assert.equal(report.interventions, 1);
  assert.equal(report.budget.settledCalls, report.calls.length);
});
