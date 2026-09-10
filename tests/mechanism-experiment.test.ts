import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const luna = "gpt-5.6-luna", astra = "gpt-6-astra";
const root = new URL("..", import.meta.url);
const sha = (data: string) => createHash("sha256").update(data).digest("hex");
function receipt(model = luna) {
  return { requestedModel: model, transcript: { requestedModel: model, effectiveModelEvidence: null,
    events: [{ type: "turn.completed", usage: { input_tokens: 25_000, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 2000 } }] } };
}
async function priorRun(path: string, data: unknown = receipt()) {
  await mkdir(path, { recursive: true });
  const result = { success: true, calls: [{ id: "call-1", model: luna }], budget: { observedCredits: .185,
    unknownUsageCalls: 0, activeReservations: 0, exceeded: false }, boundaryViolations: [] };
  await writeFile(join(path, "result.json"), JSON.stringify(result));
  if (data !== null) await writeFile(join(path, "call-1.json"), JSON.stringify(data));
  return result;
}
function invoke(path: string, output: string, priors: string[] = []) {
  return spawnSync(process.execPath, [join(path, "scripts/mechanism-experiment.mjs"), "--mode", "pilot", "--output", output,
    ...priors.flatMap(prior => ["--prior", prior])], { encoding: "utf8", timeout: 15_000 });
}

// The isolated dispatcher runs a deterministic local receipt producer, never a model CLI.
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "sheep-mechanism-dispatch-"));
  for (const directory of ["src", "scripts", "tests", "pricing", "docs"]) await mkdir(join(path, directory));
  for (const file of ["scripts/mechanism-experiment.mjs", "src/credit-budget.ts", "src/cost-estimate.ts", "pricing/openai-2026-09-10.json"])
    await copyFile(new URL(file, root), join(path, file));
  for (const file of ["package-lock.json", "tsconfig.json"]) await writeFile(join(path, file), "{}");
  await writeFile(join(path, "package.json"), '{"type":"module"}');
  await writeFile(join(path, "docs/execplan-mechanism.md"), "Frozen test plan\n");
  await writeFile(join(path, "src/mechanism-cli.ts"), `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
const output = value("--output"), model = value("--method") === "single-astra" ? "gpt-6-astra" : "gpt-5.6-luna";
const experiment = JSON.parse(await readFile(join(dirname(output), "experiment.json"), "utf8"));
if (experiment.activeJob !== output.slice(output.lastIndexOf("/") + 1)) throw new Error("Missing pre-dispatch durable record");
await mkdir(output);
const receipt = { requestedModel: model, transcript: { requestedModel: model, effectiveModelEvidence: null,
 events: [{ type: "turn.completed", usage: {input_tokens: 25000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2000} }] } };
const unknown = process.env.SHEEP_TEST_UNKNOWN_USAGE === "yes";
if (unknown) receipt.transcript.events = [];
const credit = unknown ? 0 : model === "gpt-6-astra" ? 8.75 : .185;
const final = experiment.runs.length === experiment.planned.length - 1;
const overrun = process.env.SHEEP_TEST_FINAL_OVERRUN === "yes" && final;
if (process.env.SHEEP_TEST_MISSING_RECEIPT !== "yes") await writeFile(join(output, "call-1.json"), JSON.stringify(receipt));
await writeFile(join(output, "result.json"), JSON.stringify({ success: !overrun, calls:[{id:"call-1",model}],
 budget:{observedCredits:credit,unknownUsageCalls:unknown ? 1 : 0,activeReservations:0,exceeded:overrun},boundaryViolations:[] }));
`);
  return path;
}

test("dispatcher includes five development controls, retains prior costs, and freezes exact source bytes", async () => {
  const path = await fixture();
  try {
    const prior = join(path, "prior"), output = join(path, "out");
    await priorRun(prior);
    const child = invoke(path, output, [prior]);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(report.status, "completed");
    assert.equal(report.planned.length, 5);
    assert.equal(report.runs.length, 5);
    assert.equal(report.activeJob, null);
    assert.equal(report.observed.calls, 6);
    assert.ok(Math.abs(report.observed.credits - 9.675) < 1e-10);
    assert.deepEqual(report.observed.unknown, []);
    assert.equal(report.planned.filter((job: { method: string }) => job.method.startsWith("single-")).length, 2);
    const manifest = JSON.parse(await readFile(join(output, "source-manifest.json"), "utf8"));
    for (const file of manifest) {
      const contents = await readFile(join(output, "frozen-source", file.path), "utf8");
      assert.equal(sha(contents), file.sha256);
    }
    assert.notEqual(invoke(path, output, [prior]).status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(output, "experiment.json"), "utf8")), report);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("prior missing receipts, identity conflicts, and unknown usage refuse all model dispatch", async () => {
  const path = await fixture();
  try {
    const samples = [null, { ...receipt(), requestedModel: astra },
      { transcript: { ...receipt().transcript, events: [...receipt().transcript.events, { type: "thread.started", model: astra }] } },
      { transcript: { requestedModel: luna, events: [] } }];
    for (let index = 0; index < samples.length; index++) {
      const prior = join(path, `prior-${index}`), output = join(path, `out-${index}`);
      await priorRun(prior, samples[index]);
      const child = invoke(path, output, [prior]);
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /Prior usage is unknown/);
      await assert.rejects(readFile(join(output, "experiment.json")), { code: "ENOENT" });
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("unfinished dispatched prior and changed declared result cannot become zero-cost continuation", async () => {
  const path = await fixture();
  try {
    const unfinished = join(path, "unfinished"); await mkdir(unfinished);
    await writeFile(join(unfinished, "experiment.json"), JSON.stringify({ status: "running", runs: [], activeJob: "staged-sheep-n4-r1" }));
    assert.match(invoke(path, join(path, "out-one"), [unfinished]).stderr, /Prior usage is unknown/);
    const changed = join(path, "changed"), result = await priorRun(join(changed, "run-1"));
    await writeFile(join(changed, "experiment.json"), JSON.stringify({ status: "completed", activeJob: null,
      runs: [{ id: "run-1", resultSha256: sha(JSON.stringify(result) + "changed") }] }));
    assert.match(invoke(path, join(path, "out-two"), [changed]).stderr, /Prior usage is unknown/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("last-run overrun stops the study instead of being mislabeled completed", async () => {
  const path = await fixture();
  try {
    const output = join(path, "out");
    const child = spawnSync(process.execPath, [join(path, "scripts/mechanism-experiment.mjs"), "--output", output],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, SHEEP_TEST_FINAL_OVERRUN: "yes" } });
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(report.runs.length, 5);
    assert.equal(report.status, "stopped");
    assert.equal(report.stopReason, "per-run-overrun");
    assert.equal(report.activeJob, null);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("missing current receipt stops immediately even when the child reports zero unknown calls", async () => {
  const path = await fixture();
  try {
    const output = join(path, "out");
    const child = spawnSync(process.execPath, [join(path, "scripts/mechanism-experiment.mjs"), "--output", output],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, SHEEP_TEST_MISSING_RECEIPT: "yes" } });
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(report.runs.length, 1);
    assert.equal(report.status, "stopped");
    assert.equal(report.stopReason, "unknown-usage");
    assert.ok(report.observed.unknown.some((item: string) => item.includes("receipt is missing")));
  } finally { await rm(path, { recursive: true, force: true }); }
});

async function unpricedStudy(path: string, name = "old-study") {
  const directory = join(path, name), knownPath = join(directory, "known-run"), unknownPath = join(directory, "unknown-run");
  const known = await priorRun(knownPath);
  const unknown = await priorRun(unknownPath, { requestedModel: luna, transcript: { requestedModel: luna, events: [] } });
  unknown.success = false; unknown.budget.observedCredits = 0; unknown.budget.unknownUsageCalls = 1;
  await writeFile(join(unknownPath, "result.json"), JSON.stringify(unknown));
  const rates = await readFile(join(path, "pricing/openai-2026-09-10.json"), "utf8");
  const sourceManifest = [];
  await mkdir(join(directory, "frozen-source", "src"), { recursive: true });
  await mkdir(join(directory, "frozen-source", "pricing"), { recursive: true });
  for (const file of ["src/credit-budget.ts", "src/cost-estimate.ts", "src/mechanism-cli.ts", "pricing/openai-2026-09-10.json"]) {
    const bytes = await readFile(join(path, file), "utf8");
    sourceManifest.push({ path: file, sha256: sha(bytes) });
    await writeFile(join(directory, "frozen-source", file), bytes);
  }
  const sourceBytes = JSON.stringify(sourceManifest);
  await writeFile(join(directory, "source-manifest.json"), sourceBytes);
  const manifest = { format: 1, kind: "mechanism", mode: "main", status: "stopped", stopReason: "unknown-usage", activeJob: null,
    sourceManifestSha256: sha(sourceBytes),
    rateCardSha256: sha(rates), priorSpend: { credits: 29, calls: 59, unknown: [] },
    observed: { credits: 29.185, calls: 61, unknown: ["one missing usage receipt"] },
    planned: [{ id: "known-run" }, { id: "unknown-run" }], runs: [
      { id: "known-run", resultSha256: sha(JSON.stringify(known)) }, { id: "unknown-run", resultSha256: sha(JSON.stringify(unknown)) }],
  };
  await writeFile(join(directory, "experiment.json"), JSON.stringify(manifest));
  return { directory, manifest };
}
function followup(path: string, output: string, historical: string, prior: string[] = [], environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [join(path, "scripts/mechanism-experiment.mjs"), "--mode", "scaling-followup", "--output", output,
    "--unpriced-prior", historical, ...prior.flatMap(item => ["--prior", item])], { encoding: "utf8", timeout: 15_000, env: environment });
}

test("scaling followup keeps historical unknown context separate from the additional100 ledger and fixes N16 then N32", async () => {
  const path = await fixture();
  try {
    const historical = await unpricedStudy(path), output = join(path, "followup-one");
    const child = followup(path, output, historical.directory);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(report.standardCreditCap, 100); assert.equal(report.perRunCreditCap, 30);
    assert.equal(report.status, "completed"); assert.equal(report.priorSpend.credits, 0);
    assert.ok(Math.abs(report.observed.credits - .37) < 1e-10);
    assert.equal(report.observed.calls, 2); assert.equal(report.observed.unknownUsageCalls, 0);
    assert.deepEqual(report.previousStudy, { experimentSha256: sha(JSON.stringify(historical.manifest)), knownCreditsLower: 29.185,
      recordedCalls: 61, unknownUsageCalls: 1, recordedRuns: 2, plannedRuns: 2 });
    assert.deepEqual(report.additionalBudgetAuthorization, { kind: "user-approved-additional-standard-credits", maxCredits: 100,
      priorUnknownUsageCalls: 1, scope: "semantic-n16-n32" });
    assert.deepEqual(report.planned.map((job: { family: string; method: string; groups: number; workers: number; concurrency: number }) =>
      [job.family, job.method, job.groups, job.workers, job.concurrency]), [["semantic", "sheep", 8, 16, 8], ["semantic", "sheep", 8, 32, 8]]);
    assert.ok(!JSON.stringify([report.previousStudy, report.additionalBudgetAuthorization]).includes(path));
    assert.deepEqual(JSON.parse(await readFile(join(historical.directory, "experiment.json"), "utf8")), historical.manifest);
    assert.match(invoke(path, join(path, "ordinary-pilot"), [historical.directory]).stderr, /Prior usage is unknown/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("unpriced-prior is restricted to explicit followup with a verified stopped unknown main inventory", async () => {
  const path = await fixture();
  try {
    const historical = await unpricedStudy(path);
    const wrongMode = spawnSync(process.execPath, [join(path, "scripts/mechanism-experiment.mjs"), "--mode", "main", "--output", join(path, "wrong-mode"),
      "--unpriced-prior", historical.directory], { encoding: "utf8" });
    assert.match(wrongMode.stderr, /Only scaling-followup requires/);
    const absent = spawnSync(process.execPath, [join(path, "scripts/mechanism-experiment.mjs"), "--mode", "scaling-followup", "--output", join(path, "absent")], { encoding: "utf8" });
    assert.match(absent.stderr, /Only scaling-followup requires/);
    for (const [index, change] of [{ status: "completed" }, { stopReason: "per-run-overrun" }, { activeJob: "unknown-run" },
      { observed: { credits: 0, calls: 61 } }, { mode: "scaling-followup" }].entries()) {
      await writeFile(join(historical.directory, "experiment.json"), JSON.stringify({ ...historical.manifest, ...change }));
      const output = join(path, `invalid-${index}`), child = followup(path, output, historical.directory);
      assert.notEqual(child.status, 0);
      await assert.rejects(readFile(join(output, "experiment.json")), { code: "ENOENT" });
    }
    await writeFile(join(historical.directory, "experiment.json"), JSON.stringify(historical.manifest));
    await writeFile(join(historical.directory, "known-run", "result.json"), "{}");
    assert.match(followup(path, join(path, "changed-result"), historical.directory).stderr, /Unpriced prior inventory is invalid/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("followup authorization never waives new unknown usage, and an unknown additional prior blocks retry", async () => {
  const path = await fixture();
  try {
    const historical = await unpricedStudy(path), output = join(path, "new-unknown");
    const child = followup(path, output, historical.directory, [], { ...process.env, SHEEP_TEST_UNKNOWN_USAGE: "yes" });
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
    assert.equal(report.status, "stopped"); assert.equal(report.stopReason, "unknown-usage");
    assert.equal(report.runs.length, 1); assert.equal(report.observed.unknownUsageCalls, 1);
    assert.equal(report.previousStudy.unknownUsageCalls, 1);
    assert.match(followup(path, join(path, "retry-refused"), historical.directory, [output]).stderr, /Prior usage is unknown/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("additional-campaign retries include previous new charges and reject unrelated or omitted ancestors", async () => {
  const path = await fixture();
  try {
    const historical = await unpricedStudy(path), first = join(path, "first"), second = join(path, "second");
    assert.equal(followup(path, first, historical.directory).status, 0);
    const child = followup(path, second, historical.directory, [first]);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(join(second, "experiment.json"), "utf8"));
    assert.ok(Math.abs(report.priorSpend.credits - .37) < 1e-10);
    assert.ok(Math.abs(report.observed.credits - .74) < 1e-10);
    assert.equal(report.additionalBudgetPriorExperiments.length, 1);
    assert.match(followup(path, join(path, "missing-ancestor"), historical.directory, [second]).stderr, /All earlier additional-campaign experiments/);
    const unrelated = join(path, "unrelated"); await mkdir(unrelated);
    await writeFile(join(unrelated, "experiment.json"), JSON.stringify({ mode: "pilot" }));
    assert.match(followup(path, join(path, "unrelated-refused"), historical.directory, [unrelated]).stderr, /must belong to this additional 100-credit campaign/);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("followup refuses a changed runtime or changed historical source manifest before any dispatch", async () => {
  const path = await fixture();
  try {
    const historical = await unpricedStudy(path);
    const runtimePath = join(path, "src/mechanism-cli.ts"), original = await readFile(runtimePath, "utf8");
    await writeFile(runtimePath, original + "\n// Changed after the main study\n");
    assert.match(followup(path, join(path, "runtime-refused"), historical.directory).stderr, /runtime differs from the unpriced main study/);
    await writeFile(runtimePath, original);
    await writeFile(join(historical.directory, "source-manifest.json"), "[]");
    assert.match(followup(path, join(path, "manifest-refused"), historical.directory).stderr, /source manifest hash mismatch/);
  } finally { await rm(path, { recursive: true, force: true }); }
});
