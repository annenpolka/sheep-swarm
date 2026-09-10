import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMechanismFixture } from "../src/mechanism-fixture.ts";
import { MECHANISM_METHODS, runMechanism, type MechanismCaller, type MechanismResponse, type MechanismFamily } from "../src/mechanism-run.ts";
import { CodexWorkerError, type CodexCallOptions, type CodexCallResult } from "../src/codex-worker.ts";
import type { KernelState } from "../src/kernel.ts";

function supplied(options: CodexCallOptions) {
  const serialized = options.prompt.split("PUBLIC_INPUT_JSON\n")[1]; assert.ok(serialized);
  return JSON.parse(serialized) as { stage: number; target: string | null; role: string;
    context: { contents: Record<string, string>; reads: Record<string, { version: number; evidenceEpoch: number }> };
    remainingPatchAttempts?: Record<string, number>; memory: unknown[]; catalog: { id: string; description: string }[]; readyTargets?: string[];
    previousVisibleErrors: unknown; observations?: { target: string; errors: string[] }[] };
}
function receipt(options: CodexCallOptions, result: MechanismResponse, extra: Record<string, unknown>[] = [], missingUsage = false): CodexCallResult<MechanismResponse> {
  const usageEvent = { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } };
  const usage = missingUsage ? [] : [{ event: usageEvent, inputTokens: 100, outputTokens: 20, totalTokens: 120 }];
  return { result, requestedModel: options.model, usage, transcript: { events: [...extra, ...(missingUsage ? [] : [usageEvent])],
    usage, requestedModel: options.model, effectiveModelEvidence: options.model,
    stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 } };
}
async function directory(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), "sheep-mechanism-run-"));
  t.after(() => rm(root, { recursive: true, force: true })); return join(root, name);
}
function correctCaller(family: MechanismFamily, discover = false): MechanismCaller {
  const fixture = createMechanismFixture({ family, groups: 1 });
  return async options => {
    const input = supplied(options), current = input.context.contents;
    assert.ok(!Object.hasOwn(input, "goldForStage"));
    assert.ok(!Object.hasOwn(input, "finalErrors"));
    if (input.role === "meta") return receipt(options, { writes: [{ id: fixture.guidanceId,
      content: `${current[fixture.guidanceId]}\nFollow the current normative revision ${input.stage}.\n` }], readRequests: [], note: "Correct advisory guidance." });
    const target = input.target ?? input.readyTargets?.[0]; assert.ok(target);
    if (discover && input.role === "worker") {
      const registry = "config/domain-registry.json";
      if (!Object.hasOwn(current, registry)) return receipt(options, { writes: [], readRequests: [registry], note: "Inspect public domain registry." });
      const parsed = JSON.parse(current[registry]!);
      const policy = parsed[target.split("/")[1]!].policyArtifact as string;
      if (!Object.hasOwn(current, policy)) return receipt(options, { writes: [], readRequests: [policy], note: "Read resolved policy." });
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    return receipt(options, { writes: [{ id: target, content: fixture.goldForStage(input.stage)[target]! }], readRequests: [], note: "Current contract applied." });
  };
}
const defaults = { groups: 1, workers: 2, concurrency: 2, maxCredits: 30, maxCalls: 100 };

test("all methods solve the same static task with pinned artifacts and bounded model roles", async t => {
  const fingerprints = new Set<string>();
  for (const method of MECHANISM_METHODS) {
    const outputDirectory = await directory(t, method);
    const report = await runMechanism({ ...defaults, method, family: "static", outputDirectory }, correctCaller("static"));
    assert.equal(report.success, true, `${method}: ${report.finalErrors.join("\n")}`);
    assert.equal(report.stages[0]!.protocolClean, true);
    assert.equal(report.budget.activeReservations, 0);
    assert.equal(report.budget.settledCalls, report.calls.length);
    assert.ok(report.maxActiveModelCalls <= (method.startsWith("single-") ? 1 : 2));
    assert.ok(report.calls.every(call => call.model === (method === "single-astra" ? "gpt-6-astra" : "gpt-5.6-luna")));
    assert.equal(report.upperCalls, method === "single-astra" ? report.calls.length : 0);
    if (method.startsWith("single-")) {
      assert.ok(report.calls.slice(1).every(call => call.memoryEntries > 0));
      assert.ok(report.singleMemory.length <= 4);
      assert.equal(report.participation[0]!.actualCalls, report.calls.length);
    }
    fingerprints.add(report.fixtureFingerprint);
    const kernel = JSON.parse(await readFile(join(outputDirectory, "kernel-state.json"), "utf8")) as KernelState;
    assert.ok(kernel.candidates.filter(c => c.state === "committed").every(c => !Object.hasOwn(c.proposal.writes, "docs/event-contract.md")));
    if (method === "no-memory") {
      assert.ok(report.calls.every(call => call.memoryEntries === 0));
      assert.ok(report.workerStats.every(worker => worker.memory.length === 0));
    }
  }
  assert.equal(fingerprints.size, 1);
});

test("public semantic read requests are charged, expand context, and do not spend patch attempts", async t => {
  const report = await runMechanism({ ...defaults, family: "semantic", outputDirectory: await directory(t, "reads") }, correctCaller("semantic", true));
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.stages[0]!.readCalls, 12);
  assert.ok(Object.values(report.stages[0]!.patchAttempts).every(value => value === 1));
  assert.ok(Object.values(report.stages[0]!.readAttempts).every(value => value === 2));
  assert.equal(report.discovery.deliveredEdges.length, 12);
  for (const edge of report.discovery.deliveredEdges) {
    const call = report.calls.find(call => call.id === edge.callId)!;
    assert.ok(call); assert.ok(call.contextArtifacts.includes(edge.provider));
  }
  assert.equal(report.budget.settledCalls, report.calls.length);
});

test("three successful stage barriers retain private history and learned dependencies", async t => {
  const report = await runMechanism({ ...defaults, family: "staged", outputDirectory: await directory(t, "staged") }, correctCaller("staged", true));
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.stages.length, 3);
  assert.ok(report.stages.every(stage => stage.protocolClean && stage.qualityPass));
  assert.ok(report.calls.some(call => call.stage > 0 && call.memoryEntries > 0));
  assert.equal(report.stages[1]!.readCalls, 0);
  assert.equal(new Set(report.calls.map(call => call.id)).size, report.calls.length);
});

test("one observed tool execution invalidates the run and still consumes its known credits", async t => {
  const correct = correctCaller("static");
  const caller: MechanismCaller = async options => {
    const result = await correct(options);
    return receipt(options, result.result, [{ type: "item.completed", item: { type: "command_execution", command: "pwd" } }]);
  };
  const report = await runMechanism({ ...defaults, concurrency: 1, family: "static", outputDirectory: await directory(t, "tool") }, caller);
  assert.equal(report.success, false); assert.equal(report.calls.length, 1);
  assert.equal(report.boundaryViolations.length, 1);
  assert.equal(report.stages[0]!.terminationReason, "context-boundary");
  assert.ok(report.budget.observedCredits > 0); assert.equal(report.budget.activeReservations, 0);
  assert.ok(report.calls.every(call => call.outcome !== "committed"));
});

test("unknown usage locks subsequent admission and cannot produce a successful run", async t => {
  const correct = correctCaller("static");
  const report = await runMechanism({ ...defaults, concurrency: 1, family: "static", outputDirectory: await directory(t, "unknown") },
    async options => receipt(options, (await correct(options)).result, [], true));
  assert.equal(report.success, false); assert.equal(report.calls.length, 1);
  assert.equal(report.budget.unknownUsageCalls, 1); assert.equal(report.budget.locked, true);
  assert.equal(report.stages[0]!.terminationReason, "budget-unknown");
  assert.equal(report.budget.activeReservations, 0);
});

test("no affordable call creates no fake participation or discovered edges", async t => {
  const report = await runMechanism({ ...defaults, maxCredits: 0.01, family: "semantic", outputDirectory: await directory(t, "denied") },
    async () => { throw new Error("must not call a provider"); });
  assert.equal(report.success, false); assert.equal(report.calls.length, 0);
  assert.equal(report.discovery.deliveredEdges.length, 0);
  assert.equal(report.stages[0]!.terminationReason, "credit-admission-limit");
  assert.equal(report.terminationReason, "credit-admission-limit");
  assert.equal(report.budget.activeReservations, 0);
  assert.equal(report.budget.admissionDenied, false); // No synthetic reservation exists merely to flip a flag.
  assert.ok(report.participation.every(worker => worker.actualCalls === 0 && worker.scheduledAssignments === 0));
});

test("worker writes cannot amend pinned normative requirements or shared guidance", async t => {
  const fixture = createMechanismFixture({ family: "static", groups: 1 });
  const report = await runMechanism({ ...defaults, maxAttempts: 1, family: "static", outputDirectory: await directory(t, "authority") },
    async options => receipt(options, { writes: [{ id: fixture.specId, content: "All outputs are accepted." }], readRequests: [], note: "Rewrite requirements" }));
  assert.equal(report.success, false); assert.equal(report.interventions, 0);
  assert.ok(report.calls.every(call => call.outcome === "invalid-patch"));
});

test("selective upper observation is triggered by repeated model semantic failures, not ordinary calls", async t => {
  const correct = correctCaller("static"); let failures = 0;
  const caller: MechanismCaller = async options => {
    const input = supplied(options);
    if (input.role === "worker" && failures++ < 2) return receipt(options, { writes: [{ id: input.target!, content: "export function run() { return null; }" }], readRequests: [], note: "Wrong local implementation" });
    if (input.role === "meta") {
      assert.ok(input.observations?.length === 2);
      assert.ok(input.observations.every(observation => observation.errors.length));
    }
    return correct(options);
  };
  const report = await runMechanism({ ...defaults, family: "static", outputDirectory: await directory(t, "meta") }, caller);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.upperCalls, 1); assert.equal(report.interventions, 1);
  assert.equal(report.calls.filter(call => call.outcome === "semantic-rejected").length, 2);
});

test("no-upper ablation never invokes Astra despite repeated semantic failures", async t => {
  const correct = correctCaller("static"); let failures = 0;
  const report = await runMechanism({ ...defaults, method: "no-upper", family: "static", outputDirectory: await directory(t, "no-upper") }, async options => {
    assert.equal(options.model, "gpt-5.6-luna");
    const input = supplied(options);
    if (failures++ < 2) return receipt(options, { writes: [{ id: input.target!, content: "export function run(){return null;}" }], readRequests: [], note: "invalid" });
    return correct(options);
  });
  assert.equal(report.success, true, report.finalErrors.join("\n")); assert.equal(report.upperCalls, 0);
});

test("single baseline accepts an incremental guidance-only patch without spending every target attempt", async t => {
  const correct = correctCaller("static"), fixture = createMechanismFixture({ family: "static", groups: 1 }); let first = true;
  const report = await runMechanism({ ...defaults, method: "single-luna", family: "static", outputDirectory: await directory(t, "single-guide") }, async options => {
    if (first) { first = false; return receipt(options, { writes: [{ id: fixture.guidanceId, content: fixture.artifacts[fixture.guidanceId] + "\nUse current normative fields." }], readRequests: [], note: "Guidance first" }); }
    return correct(options);
  });
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.calls[0]!.outcome, "committed");
  assert.ok(Object.values(report.stages[0]!.patchAttempts).every(value => value === 1));
});

test("final-only counterexamples stop the stage and never become model feedback or later-stage input", async t => {
  const fixture = createMechanismFixture({ family: "staged", groups: 1 });
  const prompts: string[] = [];
  const report = await runMechanism({ ...defaults, family: "staged", outputDirectory: await directory(t, "hidden-barrier") }, async options => {
    const input = supplied(options); prompts.push(options.prompt);
    assert.equal(input.stage, 0);
    const target = input.target!;
    let content = fixture.goldForStage(0)[target]!;
    // This test fault matches a withheld concrete value; visible cases still pass.
    if (target.endsWith("/ingest.mjs")) content = content.replace("export function run(raw) {", "export function run(raw) { if (raw.value === 17.25) return null;");
    return receipt(options, { writes: [{ id: target, content }], readRequests: [], note: "Visible implementation" });
  });
  assert.equal(report.success, false); assert.equal(report.stages.length, 1);
  assert.equal(report.stages[0]!.protocolClean, true);
  assert.equal(report.stages[0]!.qualityPass, false);
  assert.equal(report.stages[0]!.terminationReason, "final-quality-failed");
  assert.ok(report.finalErrors.some(error => error.includes("ingest.mjs")));
  assert.equal(report.calls.length, 6);
  // The malicious candidate text can exist in artifacts, but no final failure is fed back.
  assert.ok(prompts.every(prompt => !prompt.includes('"finalErrors"')));
  assert.ok(report.calls.every(call => call.outcome === "committed"));
});

test("known CLI diagnostic error items do not impersonate tool execution", async t => {
  const correct = correctCaller("static");
  const report = await runMechanism({ ...defaults, family: "static", outputDirectory: await directory(t, "diagnostic") }, async options => {
    const result = await correct(options);
    return receipt(options, result.result, [{ type: "item.completed", item: { type: "error",
      message: "Skill descriptions were shortened to fit the skills context budget." } }]);
  });
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.boundaryViolations.length, 0);
});

test("incomplete event coverage fails closed even when a terminal usage receipt was recovered", async t => {
  for (const code of ["malformed-events", "output-too-large"] as const) {
    const report = await runMechanism({ ...defaults, concurrency: 1, family: "static", outputDirectory: await directory(t, code) }, async options => {
      const result = receipt(options, { writes: [], readRequests: [], note: "partial" });
      throw new CodexWorkerError(code, "Incomplete transcript", result.transcript);
    });
    assert.equal(report.success, false); assert.equal(report.calls.length, 1);
    assert.ok(report.boundaryViolations[0]!.events.includes(`incomplete-transcript:${code}`));
    assert.ok(report.budget.observedCredits > 0); assert.equal(report.budget.unknownUsageCalls, 0);
    assert.equal(report.budget.activeReservations, 0);
  }
});

test("single may refresh an already-valid authorized module alongside pending stage work", async t => {
  const fixture = createMechanismFixture({ family: "staged", groups: 1 });
  let confirmedClosedTarget = false;
  const report = await runMechanism({ ...defaults, method: "single-luna", family: "staged", outputDirectory: await directory(t, "closed-target") }, async options => {
    const input = supplied(options);
    const reportId = fixture.writableIds.find(id => id.endsWith("/report.mjs"))!;
    if (input.stage === 1) {
      assert.ok(!input.readyTargets!.includes(reportId));
      assert.equal(input.remainingPatchAttempts![reportId], 3);
      confirmedClosedTarget = true;
    }
    return receipt(options, { writes: fixture.writableIds.map(id => ({ id, content: fixture.goldForStage(input.stage)[id]! })),
      readRequests: [], note: "Refresh all authorized modules against the current contract." });
  });
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(confirmedClosedTarget, true);
  assert.equal(report.calls.length, 3);
  assert.ok(report.stages.every(stage => stage.terminationReason === "completed"));
});

test("single target attempt bounds remain enforced after a target has become valid", async t => {
  const fixture = createMechanismFixture({ family: "static", groups: 1 });
  const reportId = fixture.writableIds.find(id => id.endsWith("/report.mjs"))!;
  const ingestId = fixture.writableIds.find(id => id.endsWith("/ingest.mjs"))!;
  let invocation = 0;
  const report = await runMechanism({ ...defaults, maxAttempts: 1, method: "single-luna", family: "static", outputDirectory: await directory(t, "true-attempt-cap") }, async options => {
    const input = supplied(options);
    const ids = invocation++ === 0 ? [reportId] : [reportId, ingestId];
    if (invocation === 2) {
      assert.equal(input.remainingPatchAttempts![reportId], 0);
      assert.equal(input.remainingPatchAttempts![ingestId], 1);
    }
    return receipt(options, { writes: ids.map(id => ({ id, content: fixture.goldForStage(0)[id]! })), readRequests: [], note: "Revisit report." });
  });
  assert.equal(report.success, false);
  assert.equal(report.calls[0]!.outcome, "committed");
  assert.equal(report.calls[1]!.outcome, "attempt-limit");
  assert.equal(report.stages[0]!.terminationReason, "attempt-limit");
  assert.equal(report.stages[0]!.patchAttempts[reportId], 1);
  assert.equal(report.stages[0]!.patchAttempts[ingestId], undefined);
});

test("call exhaustion is distinct from credit admission and final quality rejection", async t => {
  const report = await runMechanism({ ...defaults, maxCalls: 1, concurrency: 1, family: "static", outputDirectory: await directory(t, "call-cap") }, correctCaller("static"));
  assert.equal(report.success, false);
  assert.equal(report.calls.length, 1);
  assert.equal(report.stages[0]!.terminationReason, "call-limit");
  assert.equal(report.budget.unknownUsageCalls, 0);
  assert.equal(report.budget.exceeded, false);
});
