import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CodexWorkerError, type CodexCallOptions, type CodexCallResult, type CodexUsage } from "../src/codex-worker.ts";
import { COMPARISON_METHODS, runComparison, type ComparisonCaller, type ComparisonResponse } from "../src/comparison.ts";
import { createHeldoutFixture, discoverThermalDependencies } from "../src/heldout-fixture.ts";
import { SwarmKernel, type Checkout, type KernelState } from "../src/kernel.ts";

const knownUsage: readonly CodexUsage[] = [{ event: { type: "test-usage" }, inputTokens: 10, outputTokens: 20, totalTokens: 30 }];
function result(options: CodexCallOptions, value: ComparisonResponse, usage = knownUsage): CodexCallResult<ComparisonResponse> {
  return { result: value, requestedModel: options.model, usage,
    transcript: { events: [], usage, requestedModel: options.model, effectiveModelEvidence: options.model,
      stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 } };
}
function supplied(options: CodexCallOptions) {
  const match = /CONTEXT_JSON\n([^\n]+)\nEXTRA_JSON\n([^\n]+)$/.exec(options.prompt);
  assert.ok(match);
  return { files: JSON.parse(match[1]!) as Record<string, string>, extra: JSON.parse(match[2]!) as Record<string, unknown> };
}
function correctCaller(size = 4, singleModel = "gpt-6-astra"): ComparisonCaller {
  const fixture = createHeldoutFixture({ size, variant: "migrated" });
  return async options => {
    const { files, extra } = supplied(options);
    const brokenGuidance = files[fixture.specId]!.includes("Round returned kelvin");
    if (options.prompt.startsWith("Manage local workers")) {
      assert.equal(options.model, "gpt-6-astra");
      return result(options, { writes: brokenGuidance ? [{ id: fixture.specId, content: fixture.artifacts[fixture.specId]! }] : [],
        targets: (extra.readyTargets as string[]).slice(0, extra.concurrency as number), note: "Choose ready jobs and preserve physical units." });
    }
    if (options.prompt.startsWith("Observe the swarm")) {
      assert.equal(options.model, "gpt-6-astra");
      return result(options, { writes: [{ id: fixture.specId, content: fixture.artifacts[fixture.specId]! }], targets: [], note: "Correct rounding guidance from acceptance evidence." });
    }
    if (options.prompt.startsWith("Solve the complete")) {
      assert.equal(options.model, singleModel);
      return result(options, { writes: [...fixture.writableIds, ...(brokenGuidance ? [fixture.specId] : [])]
        .map(id => ({ id, content: fixture.artifacts[id]! })), targets: [], note: "Complete migration." });
    }
    assert.equal(options.model, "gpt-5.6-luna");
    const id = extra.target as string;
    let content = fixture.artifacts[id]!;
    if (brokenGuidance) content = content.replace("kelvin: value.kelvin", "kelvin: Math.floor(value.kelvin)")
      .replace("pascals: value.pascals", "pascals: Math.floor(value.pascals)");
    await new Promise<void>(resolve => setImmediate(resolve));
    return result(options, { writes: [{ id, content }], targets: [], note: "Local update at the supplied versions." });
  };
}
async function directory(t: TestContext, name: string) {
  const root = await mkdtemp(join(tmpdir(), "sheep-comparison-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, name);
}
const limits = { size: 4, workers: 4, concurrency: 2, maxTokens: 10_000, reserveTokensPerCall: 100, maxCalls: 30 };

test("heldout oracle rejects affine-unit and threshold mistakes independently of task documents", async () => {
  const correct = createHeldoutFixture({ size: 4, variant: "migrated" });
  const initial = createHeldoutFixture({ size: 4 });
  assert.equal((await correct.verify(correct.artifacts)).ok, true);
  assert.equal((await initial.verify({ ...initial.artifacts, [initial.sourceId]: initial.changedSource.content })).ok, false);
  const id = correct.writableIds[0]!;
  const wrong = correct.artifacts[id]!.replace("value.kelvin >= -10 + 273.15", "value.kelvin >= -10");
  assert.notEqual(wrong, correct.artifacts[id]);
  assert.equal((await correct.verify({ ...correct.artifacts, [id]: wrong, [correct.specId]: "All readings are safe." }, [id])).ok, false);
  const deleted = { ...correct.artifacts }; delete deleted[id];
  assert.equal((await correct.verify(deleted)).ok, false);
});

test("value-equivalent raw-input code cannot satisfy the mandatory static import contract", async () => {
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated" });
  const id = "sensors/sensor-1.mjs";
  const noImport = fixture.artifacts[id]!
    .replace('import { sample } from "../lib/thermal.mjs";', '// import { sample } from "../lib/thermal.mjs";')
    .replace("const value = sample(input);", "const value = { kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000 };");
  assert.notEqual(noImport, fixture.artifacts[id]);
  const changed = { ...fixture.artifacts, [id]: noImport };
  // A comment can fool source-text matching; native module requests must determine imports.
  assert.ok(discoverThermalDependencies(changed).edges.some(edge => edge.consumer === id && edge.provider === fixture.sourceId));
  for (const scope of [[id], ["regions/region-1.mjs"], undefined]) {
    const result = await fixture.verify(changed, scope);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.includes(`missing required import: ${id} -> ${fixture.sourceId}`)), result.errors.join("\n"));
  }
});

test("local import checks cover the needed dependency closure without imposing unrelated global progress", async () => {
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated" });
  const unrelated = "sensors/sensor-2.mjs";
  const noImport = fixture.artifacts[unrelated]!
    .replace('import { sample } from "../lib/thermal.mjs";', "")
    .replace("const value = sample(input);", "const value = { kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000 };");
  const changed = { ...fixture.artifacts, [unrelated]: noImport };
  // Region 1 depends on sensors 1 and 3, so sensor 2's unrelated defect is a final-gate failure.
  assert.equal((await fixture.verify(changed, ["regions/region-1.mjs"])).ok, true);
  assert.equal((await fixture.verify(changed)).ok, false);
});

test("static discovery reads actual imports and declarations instead of returning the supplied fixture graph", () => {
  const fixture = createHeldoutFixture({ size: 8 });
  const scan = discoverThermalDependencies(fixture.artifacts);
  const key = (edge: { consumer: string; provider: string }) => `${edge.consumer}->${edge.provider}`;
  assert.deepEqual(new Set(scan.edges.map(key)), new Set(fixture.dependencies.map(key)));
  assert.ok(scan.bytesRead > 0 && scan.filesRead > 0);
  const first = fixture.writableIds[0]!;
  const modified = { ...fixture.artifacts, [first]: fixture.artifacts[first]!.replace("../lib/thermal.mjs", "../sensors/sensor-2.mjs") };
  const changed = discoverThermalDependencies(modified);
  assert.ok(changed.edges.some(edge => edge.consumer === first && edge.provider === "sensors/sensor-2.mjs"));
  assert.ok(!changed.edges.some(edge => edge.consumer === first && edge.provider === fixture.sourceId));
});

test("all methods share fixture, token cap, role identities and final external acceptance", async t => {
  const fingerprints: string[] = [];
  for (const method of COMPARISON_METHODS) {
    const report = await runComparison({ ...limits, method, outputDirectory: await directory(t, method) }, correctCaller(4, method === "single-luna" || method === "single-worker" ? "gpt-5.6-luna" : "gpt-6-astra"));
    assert.equal(report.success, true, `${method}: ${report.finalErrors.join("\n")}`);
    assert.equal(report.qualityPass, true);
    fingerprints.push(report.fixtureFingerprint);
    assert.equal(report.budget.maxTokens, limits.maxTokens);
    assert.equal(report.budget.observedTokens, report.calls.length * 30);
    assert.equal(report.budget.unknownUsageCalls, 0);
    assert.ok(report.calls.every(call => call.usageComplete && call.totalTokens === 30));
    assert.ok(report.calls.every(call => call.agent === "upper" ? call.model === "gpt-6-astra" : call.model === "gpt-5.6-luna"));
    assert.ok(report.maxActiveModelCalls <= limits.concurrency);
    if (method === "single-upper") { assert.equal(report.upperCalls, 1); assert.equal(report.lowerCalls, 0); }
    if (method === "single-luna") { assert.equal(report.upperCalls, 0); assert.equal(report.lowerCalls, 1); assert.equal(report.configuration.concurrency, 1); }
    if (method === "manager-local") assert.ok(report.upperCalls >= 2 && report.lowerCalls === 5);
    if (method.startsWith("sheep-")) assert.equal(report.upperCalls, 0);
    if (method === "sheep-full") assert.ok(report.discovery.scans > 1 && report.discovery.bytesRead > 0);
    else assert.equal(report.discovery.scans, 0);
    assert.equal(report.discovery.missingDeclaredEdges, 0);
    assert.ok(report.times.acceptanceMs > 0 && report.times.readingMs >= 0);
  }
  assert.equal(new Set(fingerprints).size, 1);
});

test("single-upper retains two correct sensor patches and completes remaining work incrementally", async t => {
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated" });
  const firstTargets = fixture.writableIds.filter(id => id.startsWith("sensors/")).slice(0, 2);
  let step = 0;
  const report = await runComparison({ ...limits, maxAttempts: 1, method: "single-upper",
    outputDirectory: await directory(t, "incremental-single") }, async options => {
    const { files } = supplied(options);
    assert.equal(options.model, "gpt-6-astra");
    assert.match(options.prompt, /incremental subset/);
    if (step++ > 0) {
      for (const id of firstTargets) assert.equal(files[id], fixture.artifacts[id], `previously accepted ${id} must remain`);
    }
    const targets = step === 1 ? firstTargets : fixture.writableIds.filter(id => !firstTargets.includes(id));
    return result(options, { writes: targets.map(id => ({ id, content: fixture.artifacts[id]! })), targets: [], note: "Incremental migration." });
  });
  assert.equal(step, 2);
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.qualityPass, true);
  assert.equal(report.upperCalls, 2); assert.equal(report.lowerCalls, 0);
  assert.ok(report.calls.every(call => call.outcome === "committed"));
  assert.equal(report.retries, 0); assert.equal(report.times.retryModelMs, 0);
  assert.equal(report.budget.observedTokens, 60);
});

test("shared rounded-guidance fault recovers through each method's own allowed path", async t => {
  const fingerprints: string[] = [];
  for (const method of COMPARISON_METHODS) {
    const report = await runComparison({ ...limits, method, fault: "rounded-guidance", outputDirectory: await directory(t, method) }, correctCaller(4, method === "single-luna" || method === "single-worker" ? "gpt-5.6-luna" : "gpt-6-astra"));
    assert.equal(report.success, true, `${method}: ${report.finalErrors.join("\n")}`);
    fingerprints.push(report.fixtureFingerprint);
    assert.equal(report.configuration.fault, "rounded-guidance");
    if (method.startsWith("sheep-")) {
      assert.ok(report.calls.some(call => call.failureKind === "semantic"));
      assert.ok(report.calls.some(call => call.phase === "intervention" && call.model === "gpt-6-astra"));
      assert.ok(report.interventions >= 1 && report.retries >= 2);
    }
  }
  assert.equal(new Set(fingerprints).size, 1);
});

test("manager global observations remain recorded without making future sensors dependencies of the specification", async t => {
  const fixture = createHeldoutFixture({ size: 8, variant: "migrated" });
  const normal = correctCaller(8);
  const outputDirectory = await directory(t, "manager-observation-fault");
  const observations: Pick<Checkout, "id" | "contents" | "reads">[] = [];
  const report = await runComparison({ ...limits, size: 8, concurrency: 4, method: "manager-local",
    fault: "rounded-guidance", outputDirectory }, async options => {
    if (!options.prompt.startsWith("Manage local workers")) return normal(options);
    const { files, extra } = supplied(options);
    assert.deepEqual(Object.keys(files).sort(), [fixture.specId, fixture.sourceId].sort());
    const observation = extra.planningObservation as Pick<Checkout, "id" | "contents" | "reads">;
    assert.deepEqual(Object.keys(observation.contents).sort(), Object.keys(fixture.artifacts).sort());
    assert.deepEqual(Object.keys(observation.reads).sort(), Object.keys(fixture.artifacts).sort());
    observations.push(observation);
    // Reproduce delayed correction: the first real spec edit keeps the fault;
    // the second removes it after four semantic failures. Subsequent waves
    // select jobs from the full immutable snapshot without rewriting guidance.
    const content = observations.length === 1 ? files[fixture.specId]! + "\nPreserve physical thresholds.\n"
      : observations.length === 2 ? fixture.artifacts[fixture.specId]! : null;
    return result(options, { writes: content === null ? [] : [{ id: fixture.specId, content }],
      targets: (extra.readyTargets as string[]).slice(0, 4), note: "Inspect the whole migration and then dispatch ready workers." });
  });
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.qualityPass, true);
  assert.equal(report.maxActiveModelCalls, 4);
  assert.equal(report.interventions, 2);
  assert.equal(report.lowerCalls, fixture.writableIds.length + 4);
  assert.equal(report.retries, 4);
  assert.equal(report.calls.filter(call => call.failureKind === "semantic").length, 4);
  // All four proposals in each parallel sensor wave retain valid spec/source
  // reads after their independent peers commit. A spurious spec -> sensor
  // dependency made these otherwise-correct proposals stale in the old runner.
  assert.equal(report.calls.filter(call => call.failureKind === "stale").length, 0);
  const state = JSON.parse(await readFile(join(outputDirectory, "kernel-state.json"), "utf8")) as KernelState;
  assert.deepEqual(state.historical.filter(edge => edge.consumer === fixture.specId),
    [{ consumer: fixture.specId, provider: fixture.sourceId }]);
  for (const candidate of state.candidates.filter(candidate => candidate.proposal.kind === "intervention")) {
    const context = state.contexts.find(context => context.id === candidate.proposal.context)!;
    assert.deepEqual(Object.keys(context.reads).sort(), [fixture.sourceId, fixture.specId].sort());
    assert.equal(candidate.state, "committed");
  }
  const management = report.calls.filter(call => call.phase === "management");
  assert.equal(management.length, observations.length);
  for (const [index, call] of management.entries()) {
    const observation = observations[index]!;
    const receipt = JSON.parse(await readFile(join(outputDirectory, `${call.id}.json`), "utf8")) as {
      input: { context: Checkout; extra: { planningObservation: typeof observation } };
    };
    assert.deepEqual(receipt.input.extra.planningObservation, observation);
    assert.deepEqual(call.planningObservation?.reads, observation.reads);
    assert.equal(call.planningObservation?.id, observation.id);
    assert.deepEqual(call.persistentContext?.reads, receipt.input.context.reads);
    assert.deepEqual(call.contextArtifacts.slice().sort(), Object.keys(fixture.artifacts).sort());
    assert.equal(call.planningObservation?.bytes, Buffer.byteLength(JSON.stringify(observation)));
    assert.equal(call.contextBytes, Buffer.byteLength(JSON.stringify(receipt.input.context.contents)) + call.planningObservation!.bytes);
    assert.ok(call.promptBytes > call.contextBytes);
    assert.equal(call.totalTokens, 30);
  }
  assert.equal(observations[0]!.reads[fixture.writableIds[0]!]!.version, 0);
  assert.equal(state.artifacts[fixture.writableIds[0]!]!.version, 1);
  assert.equal(report.contextBytes, report.calls.reduce((sum, call) => sum + call.contextBytes, 0));
  assert.equal(report.budget.observedTokens, report.calls.length * 30);
});

test("failed management calls retain the full planning snapshot and read stamps", async t => {
  const outputDirectory = await directory(t, "manager-failed-observation");
  const report = await runComparison({ ...limits, method: "manager-local", maxCalls: 1, outputDirectory }, async options => {
    throw new CodexWorkerError("timeout", "injected transport timeout", result(options, { writes: [], targets: [], note: "" }).transcript);
  });
  assert.equal(report.success, false);
  assert.equal(report.upperCalls, 1);
  assert.equal(report.lowerCalls, 0);
  const call = report.calls[0]!;
  const receipt = JSON.parse(await readFile(join(outputDirectory, `${call.id}.json`), "utf8")) as {
    error: string; input: { extra: { planningObservation: Pick<Checkout, "id" | "contents" | "reads"> } };
  };
  assert.equal(receipt.error, "timeout");
  assert.equal(call.failureKind, "transport");
  assert.deepEqual(receipt.input.extra.planningObservation.reads, call.planningObservation!.reads);
  assert.deepEqual(Object.keys(receipt.input.extra.planningObservation.contents).sort(), call.contextArtifacts.slice().sort());
  assert.equal(report.budget.observedTokens, 30);
});

test("manager rejects a plan whose global observation changed before application", async t => {
  const fixture = createHeldoutFixture({ size: 4, variant: "migrated" });
  const outputDirectory = await directory(t, "manager-stale-observation");
  let kernel: SwarmKernel | undefined;
  const originalCheckout = SwarmKernel.prototype.checkout;
  t.mock.method(SwarmKernel.prototype, "checkout", function (this: SwarmKernel, ...args: Parameters<typeof originalCheckout>) {
    kernel = this;
    return originalCheckout.apply(this, args);
  });
  const report = await runComparison({ ...limits, method: "manager-local", maxCalls: 1,
    fault: "rounded-guidance", outputDirectory }, async options => {
    const { files, extra } = supplied(options);
    assert.ok(kernel);
    // Simulate another valid host commit during the model call. The narrow
    // spec/source context stays current, but dispatch based on the older whole
    // snapshot must still be refused before the manager edits the specification.
    const target = fixture.writableIds[0]!;
    const context = kernel.checkout("concurrent", [target, fixture.specId, fixture.sourceId]);
    const lease = kernel.grant("concurrent", [target]);
    const proposal = kernel.prepare({ id: "concurrent-update", agent: "concurrent", context: context.id,
      lease, writes: { [target]: fixture.artifacts[target]! } });
    assert.equal((await kernel.validate(proposal.id, contents => fixture.verify(contents, [target]))).ok, true);
    kernel.commit(proposal.id);
    kernel.deliverAll();
    assert.equal(kernel.artifact(fixture.specId).content, files[fixture.specId]);
    return result(options, { writes: [{ id: fixture.specId, content: fixture.artifacts[fixture.specId]! }],
      targets: (extra.readyTargets as string[]).slice(0, 2), note: "A plan based on an obsolete global observation." });
  });
  assert.equal(report.success, false);
  assert.equal(report.calls[0]!.outcome, "stale-planning-observation");
  assert.equal(report.calls[0]!.failureKind, "stale");
  assert.equal(report.interventions, 0);
  assert.equal(report.lowerCalls, 0);
  assert.equal(kernel!.artifact(fixture.specId).version, 0);
  assert.equal(kernel!.artifact(fixture.writableIds[0]!).version, 1);
});

test("a manager call that leaves insufficient worker reservation records admission denial", async t => {
  const report = await runComparison({ ...limits, method: "manager-local", maxTokens: 100, reserveTokensPerCall: 80,
    outputDirectory: await directory(t, "manager-no-worker-reservation") }, correctCaller());
  assert.equal(report.success, false);
  assert.equal(report.upperCalls, 1);
  assert.equal(report.lowerCalls, 0);
  assert.equal(report.calls[0]!.outcome, "planned");
  assert.equal(report.budget.observedTokens, 30);
  assert.equal(report.budget.exceeded, false);
  assert.equal(report.budget.admissionDenied, true);
});

test("token reservations constrain admission and post-call overshoot prevents success", async t => {
  const normal = correctCaller();
  let calls = 0;
  const expensive: ComparisonCaller = async options => {
    calls++;
    const value = await normal(options);
    return result(options, value.result, [{ event: {}, inputTokens: 50, outputTokens: 40 }]);
  };
  const report = await runComparison({ ...limits, method: "sheep-fixed", maxTokens: 100, reserveTokensPerCall: 40,
    outputDirectory: await directory(t, "overshoot") }, expensive);
  assert.equal(calls, 2);
  assert.equal(report.success, false);
  assert.equal(report.budget.observedTokens, 180);
  assert.equal(report.budget.reservationOverruns, 2);
  assert.ok(report.finalErrors.includes("total-token-budget-exceeded"));
});

test("missing usage is explicit and cannot be represented as a successful budgeted run", async t => {
  const normal = correctCaller();
  const report = await runComparison({ ...limits, method: "single-upper", outputDirectory: await directory(t, "unknown") },
    async options => result(options, (await normal(options)).result, []));
  assert.equal(report.success, false);
  assert.equal(report.calls.length, 1);
  assert.equal(report.calls[0]!.inputTokens, null);
  assert.equal(report.calls[0]!.outputTokens, null);
  assert.equal(report.calls[0]!.totalTokens, null);
  assert.equal(report.budget.unknownUsageCalls, 1);
  assert.ok(report.finalErrors.includes("token-usage-incomplete"));
});

test("known-usage transport failures retry without invoking semantic meta guidance", async t => {
  const normal = correctCaller();
  let transportFailures = 0;
  const report = await runComparison({ ...limits, method: "sheep-fixed", outputDirectory: await directory(t, "transport") }, async options => {
    if (transportFailures < 2) {
      transportFailures++;
      throw new CodexWorkerError("timeout", "injected transport timeout", result(options, { writes: [], targets: [], note: "" }).transcript);
    }
    return normal(options);
  });
  assert.equal(report.success, true, report.finalErrors.join("\n"));
  assert.equal(report.upperCalls, 0);
  assert.equal(report.calls.filter(call => call.failureKind === "transport").length, 2);
  assert.ok(report.retries >= 2 && report.times.retryModelMs > 0);
});

test("single retries are accounted and source editing is rejected by the shared authority boundary", async t => {
  const fixture = createHeldoutFixture({ size: 4 });
  const outputDirectory = await directory(t, "authority");
  const report = await runComparison({ ...limits, method: "single-upper", outputDirectory }, async options =>
    result(options, { writes: [{ id: fixture.sourceId, content: "export function sample() { return {}; }" }], targets: [], note: "invalid" }));
  assert.equal(report.success, false);
  assert.equal(report.calls.length, 3);
  assert.equal(report.retries, 2);
  assert.ok(report.calls.every(call => call.failureKind === "response"));
  const artifacts = JSON.parse(await readFile(join(outputDirectory, "artifacts.json"), "utf8")) as Record<string, string>;
  assert.equal(artifacts[fixture.sourceId], fixture.changedSource.content);
  await assert.rejects(runComparison({ ...limits, method: "single-upper", outputDirectory }, correctCaller()), { code: "EEXIST" });
});
