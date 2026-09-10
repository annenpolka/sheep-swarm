import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { resolve, relative, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { parseRateCard } from "../src/cost-estimate.ts";
import { CreditBudget } from "../src/credit-budget.ts";

// Token-series runs share the entrypoint but never touch the credit study parser or its side effects.
const budgetModeIndex = process.argv.findIndex(arg => arg === "--budget-mode" || arg.startsWith("--budget-mode="));
if (budgetModeIndex !== -1) {
  const mode = process.argv[budgetModeIndex].includes("=") ? process.argv[budgetModeIndex].slice("--budget-mode=".length) : process.argv[budgetModeIndex + 1];
  if (mode !== "tokens") throw new Error("Unknown --budget-mode; only tokens is dispatched here");
  const { runTokenSeries } = await import("./mechanism-token-experiment.mjs");
  const report = await runTokenSeries(process.argv.slice(2));
  process.stdout.write(JSON.stringify({ status: report.status, stopReason: report.stopReason,
    observedTokens: report.observedTokens, calls: report.calls, runs: report.runs.length }) + "\n");
  process.exit(report.status === "completed" ? 0 : 1);
}

const { values } = parseArgs({ options: {
  mode: { type: "string", default: "pilot" }, output: { type: "string" }, prior: { type: "string", multiple: true, default: [] },
  "unpriced-prior": { type: "string" },
} });
if (!["pilot", "main", "scaling-followup"].includes(values.mode) || !values.output) throw new Error("Use --mode pilot|main|scaling-followup --output NEW_DIRECTORY [--prior PREVIOUS_DIRECTORY]");
const followup = values.mode === "scaling-followup";
if (followup !== Boolean(values["unpriced-prior"])) throw new Error("Only scaling-followup requires --unpriced-prior STOPPED_UNKNOWN_STUDY");
const root = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(values.output), prior = values.prior.map(path => resolve(path));
const unpricedPrior = followup ? resolve(values["unpriced-prior"]) : null;
const directories = [output, ...prior, ...(unpricedPrior ? [unpricedPrior] : [])];
if (new Set(directories).size !== directories.length) throw new Error("Study directories must be distinct");
for (const a of directories) for (const b of directories) {
  if (a !== b && b.startsWith(a + "/")) throw new Error("Study directories must not overlap");
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const rateBytes = await readFile(join(root, "pricing/openai-2026-09-10.json"));
const rateCard = parseRateCard(JSON.parse(rateBytes));
const cap = followup ? 100 : 1200, perRun = 30;
async function files(path) {
  const found = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(path, entry.name);
    if (entry.isDirectory() && !["transcripts", "model-workspace", "frozen-source"].includes(entry.name)) found.push(...await files(name));
    else if (entry.isFile()) found.push(name);
  }
  return found;
}
async function spend(directories) {
  let credits = 0, calls = 0;
  const unknown = [];
  const unknownCallPaths = new Set();
  for (const directory of directories) {
    const paths = await files(directory), available = new Set(paths);
    const label = (file, reason) => `${relative(directory, file) || "."}: ${reason}`;
    const declarations = new Map();
    const results = paths.filter(file => file.endsWith("/result.json"));
    const manifestPath = join(directory, "experiment.json");
    if (!available.has(manifestPath) && !results.length && directory !== output) unknown.push(label(directory, "prior directory has no experiment or run inventory"));
    if (available.has(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!Array.isArray(manifest.runs)) unknown.push(label(manifestPath, "missing run inventory"));
      else for (const run of manifest.runs) {
        if (typeof run.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(run.id) || typeof run.resultSha256 !== "string") {
          unknown.push(label(manifestPath, "invalid declared run")); continue;
        }
        const resultPath = join(directory, run.id, "result.json");
        if (!available.has(resultPath) || sha(await readFile(resultPath)) !== run.resultSha256) unknown.push(label(resultPath, "missing or changed declared run result"));
      }
      if (manifest.activeJob !== null && manifest.activeJob !== undefined) unknown.push(label(manifestPath, "unfinished dispatched job may have unrecorded usage"));
      if (directory !== output && manifest.status === "running") unknown.push(label(manifestPath, "prior experiment is still marked running"));
      if (directory !== output && manifest.status === "error" && !Object.hasOwn(manifest, "activeJob")) unknown.push(label(manifestPath, "legacy interrupted experiment has no active-job inventory"));
    }
    for (const file of results) {
      const result = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(result.calls) || !result.budget) { unknown.push(label(file, "missing call/budget inventory")); continue; }
      if (result.budget.activeReservations > 0 || result.budget.unknownUsageCalls > 0) unknown.push(label(file, "unsettled or unknown declared calls"));
      for (const call of result.calls) {
        if (!call || typeof call.id !== "string" || !/^call-\d+$/.test(call.id) || typeof call.model !== "string") {
          unknown.push(label(file, "invalid declared call")); continue;
        }
        const receiptPath = join(dirname(file), `${call.id}.json`);
        if (declarations.has(receiptPath)) unknown.push(label(receiptPath, "duplicate declared call"));
        declarations.set(receiptPath, call.model);
        if (!available.has(receiptPath)) { unknown.push(label(receiptPath, "declared call receipt is missing")); unknownCallPaths.add(receiptPath); }
      }
    }
    for (const file of paths) {
      if (!/\/call-\d+\.json$/.test(file)) continue;
      const receipt = JSON.parse(await readFile(file, "utf8"));
      const model = declarations.get(file) ?? receipt.requestedModel ?? receipt.transcript?.requestedModel;
      calls++;
      if (!declarations.has(file)) unknown.push(label(file, "receipt has no completed run call inventory"));
      if (typeof model !== "string" || !Object.hasOwn(rateCard.models, model)) { unknown.push(label(file, "missing known model identity")); unknownCallPaths.add(file); continue; }
      // Reuse exactly the run's identity and unknown-usage rules; reservation size is irrelevant to this retrospective estimate.
      const audit = new CreditBudget({ maxCredits: 1, reservations: { [model]: 1 }, rateCard });
      const callId = file.slice(file.lastIndexOf("/") + 1, -5);
      if (!audit.reserve(model, callId)) { unknown.push(label(file, "missing model credit prices")); unknownCallPaths.add(file); continue; }
      const settlement = audit.settle(callId, receipt);
      credits += audit.snapshot().observedCredits;
      if (settlement.credits === null) { unknown.push(label(file, "usage, price, or identity is unknown")); unknownCallPaths.add(file); }
    }
  }
  return { credits, calls, unknownUsageCalls: unknownCallPaths.size, unknown: [...new Set(unknown)] };
}
let previousStudy = null, additionalBudgetAuthorization = null;
const additionalBudgetPriorExperiments = [];
if (followup) {
  const bytes = await readFile(join(unpricedPrior, "experiment.json")), historical = JSON.parse(bytes);
  if (historical.kind !== "mechanism" || historical.mode !== "main" || historical.status !== "stopped"
    || historical.stopReason !== "unknown-usage" || historical.activeJob !== null || !Array.isArray(historical.planned)
    || !Array.isArray(historical.runs) || !historical.runs.length || historical.rateCardSha256 !== sha(rateBytes)) {
    throw new Error("Unpriced prior must be the stopped main study with unknown usage and the same pinned rate card");
  }
  const historicalSources = await readFile(join(unpricedPrior, "source-manifest.json"));
  if (sha(historicalSources) !== historical.sourceManifestSha256) throw new Error("Unpriced prior source manifest hash mismatch");
  const sourceRows = JSON.parse(historicalSources);
  if (!Array.isArray(sourceRows) || sourceRows.some(row => typeof row.path !== "string" || row.path.startsWith("/")
    || row.path.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(row.sha256))) {
    throw new Error("Unpriced prior source manifest is invalid");
  }
  const runtimeRows = sourceRows.filter(row => row.path.startsWith("src/") || row.path.startsWith("pricing/"));
  const runtimeFiles = [...await files(join(root, "src")), ...await files(join(root, "pricing"))];
  if (!runtimeRows.length || new Set(runtimeRows.map(row => row.path)).size !== runtimeRows.length
    || runtimeFiles.length !== runtimeRows.length || runtimeFiles.some(file => !runtimeRows.some(row => row.path === relative(root, file)))) {
    throw new Error("Followup runtime inventory differs from the unpriced main study");
  }
  for (const row of runtimeRows) {
    if (sha(await readFile(join(root, row.path))) !== row.sha256
      || sha(await readFile(join(unpricedPrior, "frozen-source", row.path))) !== row.sha256) {
      throw new Error(`Followup runtime differs from the unpriced main study: ${row.path}`);
    }
  }
  const audited = await spend([unpricedPrior]);
  if (audited.unknownUsageCalls !== 1 || !audited.unknown.length
    || audited.unknown.some(reason => !reason.endsWith(": usage, price, or identity is unknown")
      && !reason.endsWith(": unsettled or unknown declared calls"))) throw new Error("Unpriced prior inventory is invalid or does not contain exactly one unpriced call");
  const plannedIds = new Set(historical.planned.map(job => job.id));
  const runIds = historical.runs.map(run => run.id);
  if (new Set(runIds).size !== runIds.length || runIds.some(id => !plannedIds.has(id))) throw new Error("Unpriced prior run inventory is inconsistent");
  let declaredUnknown = 0, declaredCalls = 0;
  for (const run of historical.runs) {
    const result = JSON.parse(await readFile(join(unpricedPrior, run.id, "result.json")));
    if (result.budget.activeReservations !== 0 || !Number.isSafeInteger(result.budget.unknownUsageCalls)
      || result.budget.unknownUsageCalls < 0) throw new Error("Unpriced prior has unresolved reservation inventory");
    declaredUnknown += result.budget.unknownUsageCalls; declaredCalls += result.calls.length;
  }
  const inherited = historical.priorSpend;
  if (!inherited || !Number.isFinite(inherited.credits) || inherited.credits < 0 || !Number.isSafeInteger(inherited.calls)
    || inherited.calls < 0 || !Array.isArray(inherited.unknown) || inherited.unknown.length || declaredUnknown !== 1
    || declaredCalls !== audited.calls) throw new Error("Unpriced prior inherited or call inventory is invalid");
  const knownCreditsLower = inherited.credits + audited.credits, recordedCalls = inherited.calls + audited.calls;
  if (!historical.observed || !Number.isFinite(historical.observed.credits)
    || Math.abs(historical.observed.credits - knownCreditsLower) > 1e-8 || historical.observed.calls !== recordedCalls) {
    throw new Error("Unpriced prior observed totals disagree with its receipt and inherited inventory");
  }
  previousStudy = { experimentSha256: sha(bytes), knownCreditsLower, recordedCalls, unknownUsageCalls: 1,
    recordedRuns: historical.runs.length, plannedRuns: historical.planned.length };
  additionalBudgetAuthorization = { kind: "user-approved-additional-standard-credits", maxCredits: 100,
    priorUnknownUsageCalls: 1, scope: "semantic-n16-n32" };
  const priorManifests = [];
  for (const directory of prior) {
    const priorBytes = await readFile(join(directory, "experiment.json")), manifest = JSON.parse(priorBytes);
    if (manifest.mode !== "scaling-followup" || manifest.standardCreditCap !== 100
      || manifest.previousStudy?.experimentSha256 !== previousStudy.experimentSha256
      || manifest.additionalBudgetAuthorization?.kind !== additionalBudgetAuthorization.kind
      || !Array.isArray(manifest.additionalBudgetPriorExperiments)) throw new Error("--prior must belong to this additional 100-credit campaign");
    additionalBudgetPriorExperiments.push(sha(priorBytes)); priorManifests.push(manifest);
  }
  if (priorManifests.some(manifest => manifest.additionalBudgetPriorExperiments.some(hash => !additionalBudgetPriorExperiments.includes(hash)))) {
    throw new Error("All earlier additional-campaign experiments must be included via --prior");
  }
}
const baseline = await spend(prior); // Validate references before creating a new experiment.
if (baseline.unknown.length) throw new Error("Prior usage is unknown; refusing further calls");
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Never overwrite existing evidence.
const sources = [];
for (const directory of ["src", "scripts", "tests", "pricing"]) sources.push(...await files(join(root, directory)));
for (const name of ["package.json", "package-lock.json", "tsconfig.json", "docs/execplan-mechanism.md"]) sources.push(join(root, name));
const sourceManifest = [];
for (const source of sources.sort()) {
  const path = relative(root, source), bytes = await readFile(source), dest = join(output, "frozen-source", path);
  await mkdir(dirname(dest), { recursive: true }); await writeFile(dest, bytes);
  sourceManifest.push({ path, sha256: sha(bytes) });
}
await writeFile(join(output, "source-manifest.json"), JSON.stringify(sourceManifest, null, 2) + "\n");
const jobs = [];
const add = (family, method, workers, repeat, groups = 8) => jobs.push({
  id: `${family}-${method}-n${workers}-r${repeat}`, family, method, workers,
  concurrency: method.startsWith("single-") ? 1 : Math.min(8, workers), repeat, groups,
});
if (followup) {
  for (const workers of [16, 32]) add("semantic", "sheep", workers, 1);
} else if (values.mode === "pilot") {
  for (const family of ["static", "semantic", "staged"]) add(family, "sheep", 4, 1, 1);
  add("staged", "single-luna", 1, 1, 1);
} else {
  for (const family of ["static", "semantic", "staged"]) {
    for (const workers of [8, 16, 32]) for (const repeat of [1, 2]) add(family, "sheep", workers, repeat);
    add(family, "single-luna", 1, 1);
  }
  for (const method of ["no-memory", "no-upper"]) for (const repeat of [1, 2]) add("staged", method, 16, repeat);
}
// Freeze an interleaved order to reduce systematic model-cache/time ordering effects.
let randomState = 20260910;
for (let i = values.mode === "main" ? jobs.length - 1 : 0; i > 0; i--) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  const j = randomState % (i + 1); [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
}
const experiment = { format: 1, kind: "mechanism", mode: values.mode, startedAt: new Date().toISOString(),
  status: "running", seed: 20260910, sourceManifestSha256: sha(await readFile(join(output, "source-manifest.json"))),
  rateCardSha256: sha(rateBytes), standardCreditCap: cap, perRunCreditCap: perRun, priorSpend: baseline,
  ...(followup ? { previousStudy, additionalBudgetAuthorization, additionalBudgetPriorExperiments } : {}),
  configuration: { lunaReservation: .25, astraReservation: 15, maxCalls: 400, timeoutMs: 90000, maxAttempts: 3, maxReadCalls: 2, maxMetaCalls: 3 },
  planned: jobs, runs: [], activeJob: null, observed: baseline, stopReason: null,
  conditions: ["Standard published credit equivalents; actual billing is not observed.",
    "Sequential run admission; already-started provider calls may exceed estimated reservations.",
    "Requested model identity is recorded; emitted evidence may be unavailable.",
    "Stage-local kernel versions; persistent workers cross acceptance barriers.",
    "No filesystem isolation claim: model tool events fail the run closed."] };
const save = () => writeFile(join(output, "experiment.json"), JSON.stringify(experiment, null, 2) + "\n");
await save();
try {
  for (const job of jobs) {
    const observed = await spend([...prior, output]); experiment.observed = observed;
    if (observed.unknown.length || observed.credits + perRun > cap) {
      experiment.stopReason = observed.unknown.length ? "unknown-usage" : "study-admission-limit"; break;
    }
    for (const file of sourceManifest) if (sha(await readFile(join(root, file.path))) !== file.sha256) throw new Error(`Frozen source changed: ${file.path}`);
    const args = ["src/mechanism-cli.ts", "--family", job.family, "--method", job.method, "--groups", String(job.groups),
      "--workers", String(job.workers), "--concurrency", String(job.concurrency), "--max-credits", String(perRun),
      "--output", join(output, job.id)];
    process.stdout.write(`${new Date().toISOString()} START ${job.id}\n`);
    experiment.activeJob = job.id; await save();
    const begun = Date.now(), chunks = [];
    const exitCode = await new Promise((resolveChild, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", chunk => chunks.push(chunk)); child.stderr.on("data", chunk => chunks.push(chunk));
      child.once("error", reject); child.once("close", (code, signal) => resolveChild(code ?? signal));
    });
    await writeFile(join(output, `${job.id}.log`), Buffer.concat(chunks));
    const resultBytes = await readFile(join(output, job.id, "result.json"));
    const result = JSON.parse(resultBytes);
    experiment.runs.push({ ...job, status: result.success ? "passed" : "failed", exitCode,
      resultSha256: sha(resultBytes), durationMs: Date.now() - begun,
      credits: result.budget.observedCredits, unknownUsageCalls: result.budget.unknownUsageCalls });
    experiment.activeJob = null;
    await save();
    experiment.observed = await spend([...prior, output]); await save();
    process.stdout.write(`${new Date().toISOString()} END ${job.id} success=${result.success} credits=${result.budget.observedCredits.toFixed(6)} calls=${result.calls.length}\n`);
    if (experiment.observed.unknown.length || result.budget.unknownUsageCalls || result.boundaryViolations.length || result.budget.exceeded) {
      experiment.stopReason = experiment.observed.unknown.length || result.budget.unknownUsageCalls ? "unknown-usage" : result.boundaryViolations.length ? "model-context-boundary" : "per-run-overrun"; break;
    }
  }
  experiment.status = experiment.runs.length === jobs.length && experiment.stopReason === null ? "completed" : "stopped";
} catch (error) {
  experiment.status = "error"; experiment.stopReason = String(error); process.exitCode = 1;
} finally {
  experiment.finishedAt = new Date().toISOString(); experiment.observed = await spend([...prior, output]); await save();
}
process.stdout.write(JSON.stringify({ status: experiment.status, runs: experiment.runs.length, planned: jobs.length,
  observed: experiment.observed, stopReason: experiment.stopReason }) + "\n");
if (experiment.status !== "completed") process.exitCode = 1;
