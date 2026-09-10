import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { parseRateCard, extractTokenUsage, estimateCallCost, sumCostIntervals } from "../src/cost-estimate.ts";

const { values } = parseArgs({ options: {
  run: { type: "string" }, output: { type: "string" }, markdown: { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
  process.stdout.write("Offline mechanism summary: --run EXPERIMENT_DIRECTORY --output SUMMARY.json --markdown SUMMARY.md\n");
  process.exit(0);
}
if (!values.run || !values.output || !values.markdown) throw new Error("Required: --run EXPERIMENT_DIRECTORY --output SUMMARY.json --markdown SUMMARY.md");
const directory = resolve(values.run);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const families = ["static", "semantic", "staged"];
const methods = ["sheep", "single-luna", "single-astra", "no-memory", "no-upper"];
const models = ["gpt-5.6-luna", "gpt-6-astra"];
const terminationReasons = ["completed", "credit-admission-limit", "call-limit", "attempt-limit", "final-quality-failed",
  "protocol-incomplete", "budget-unknown", "budget-exceeded", "context-boundary", "scheduler-stalled", "execution-error"];
const terminationReason = value => terminationReasons.includes(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/.test(value)
  && basename(value) === value && value !== "." && value !== "..";
const numericConfiguration = value => Object.fromEntries([
  "groups", "workers", "concurrency", "maxCredits", "lunaReservation", "astraReservation", "maxCalls",
  "timeoutMs", "maxAttempts", "maxReadCalls", "maxMetaCalls", "memoryLimit",
].filter(key => number(value?.[key]) !== null).map(key => [key, value[key]]));
const stripCost = value => ({ lower: value.lower, upper: value.upper, exact: value.exact });
const unknownCost = () => ({ lower: 0, upper: null, exact: false, unknownReasons: ["Incomplete receipt accounting"] });
const costTotal = rows => ({ apiUsd: stripCost(sumCostIntervals(rows.map(row => row.apiUsd))),
  codexCredits: stripCost(sumCostIntervals(rows.map(row => row.codexCredits))) });
async function optional(path) {
  try { return await readFile(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
const experimentBytes = await readFile(join(directory, "experiment.json"));
const experiment = JSON.parse(experimentBytes);
if (experiment.kind !== "mechanism" || !Array.isArray(experiment.planned) || !Array.isArray(experiment.runs)) throw new Error("Invalid mechanism experiment manifest");
const previousStudy = experiment.previousStudy && typeof experiment.previousStudy === "object" ? {
  experimentSha256: digest(experiment.previousStudy.experimentSha256),
  knownCreditsLower: number(experiment.previousStudy.knownCreditsLower), recordedCalls: count(experiment.previousStudy.recordedCalls),
  unknownUsageCalls: count(experiment.previousStudy.unknownUsageCalls), recordedRuns: count(experiment.previousStudy.recordedRuns),
  plannedRuns: count(experiment.previousStudy.plannedRuns),
} : null;
const authorization = experiment.additionalBudgetAuthorization;
const additionalBudgetAuthorization = authorization && typeof authorization === "object" ? {
  kind: authorization.kind === "user-approved-additional-standard-credits" ? authorization.kind : null,
  maxCredits: number(authorization.maxCredits), priorUnknownUsageCalls: count(authorization.priorUnknownUsageCalls),
  scope: authorization.scope === "semantic-n16-n32" ? authorization.scope : null,
} : null;
if (experiment.mode === "scaling-followup" && (!previousStudy || Object.values(previousStudy).includes(null)
  || !additionalBudgetAuthorization || Object.values(additionalBudgetAuthorization).includes(null))) throw new Error("Invalid follow-up authorization/history metadata");
const sourceBytes = await readFile(join(directory, "source-manifest.json"));
if (!digest(experiment.sourceManifestSha256) || sha(sourceBytes) !== experiment.sourceManifestSha256) throw new Error("Source manifest SHA mismatch");
const sourceManifest = JSON.parse(sourceBytes);
if (!Array.isArray(sourceManifest) || !sourceManifest.length) throw new Error("Empty source manifest");
const seenSources = new Set();
for (const item of sourceManifest) {
  if (typeof item.path !== "string" || item.path.startsWith("/") || item.path.split("/").some(part => !part || part === "." || part === "..")
    || !digest(item.sha256) || seenSources.has(item.path)) throw new Error("Invalid frozen source entry");
  seenSources.add(item.path);
  if (sha(await readFile(join(directory, "frozen-source", item.path))) !== item.sha256) throw new Error("Frozen source SHA mismatch");
}
const rateBytes = await readFile(join(directory, "frozen-source/pricing/openai-2026-09-10.json"));
if (!digest(experiment.rateCardSha256) || sha(rateBytes) !== experiment.rateCardSha256) throw new Error("Frozen rate-card SHA mismatch");
const rateCard = parseRateCard(JSON.parse(rateBytes));
const estimatorSha256 = sha(await readFile(new URL("../src/cost-estimate.ts", import.meta.url)));
const frozenEstimator = sourceManifest.find(item => item.path === "src/cost-estimate.ts");
if (frozenEstimator && frozenEstimator.sha256 !== estimatorSha256) throw new Error("Current estimator differs from the frozen experiment estimator");
const declarations = new Map();
for (const row of experiment.runs) {
  if (!identifier(row.id) || declarations.has(row.id)) throw new Error("Invalid or duplicate declared run ID");
  declarations.set(row.id, row);
}
const plannedIds = new Set();
for (const row of experiment.planned) {
  if (!identifier(row.id) || plannedIds.has(row.id) || !families.includes(row.family) || !methods.includes(row.method)
    || count(row.workers) === null || row.workers < 1 || count(row.concurrency) === null || row.concurrency < 1
    || row.concurrency > row.workers || count(row.groups) === null || row.groups < 1 || count(row.repeat) === null) throw new Error("Invalid planned run condition");
  plannedIds.add(row.id);
}
if ([...declarations.keys()].some(id => !plannedIds.has(id))) throw new Error("Declared run is absent from frozen plan");

function identity(receipt, declaredModel) {
  let requested = false, emitted = false, conflict = !models.includes(declaredModel);
  for (const row of [receipt, receipt?.transcript]) {
    if (!row || typeof row !== "object") continue;
    if (Object.hasOwn(row, "requestedModel")) { requested ||= row.requestedModel === declaredModel; conflict ||= row.requestedModel !== declaredModel; }
    if (Object.hasOwn(row, "model")) conflict ||= row.model !== declaredModel;
    if (Object.hasOwn(row, "effectiveModelEvidence") && row.effectiveModelEvidence !== null) {
      emitted ||= row.effectiveModelEvidence === declaredModel; conflict ||= row.effectiveModelEvidence !== declaredModel;
    }
  }
  for (const event of receipt?.transcript?.events ?? []) {
    if (!event || typeof event !== "object") continue;
    for (const key of ["model", "model_name", "modelName", "effective_model", "effectiveModel"]) {
      if (!Object.hasOwn(event, key) || event[key] === null) continue;
      emitted ||= event[key] === declaredModel; conflict ||= event[key] !== declaredModel;
    }
  }
  return { valid: requested && !conflict, verified: requested && emitted && !conflict, conflict };
}
function completionReason(result, accounting, integrity) {
  if (!result) return integrity;
  if (integrity !== "verified") return "unverified-result";
  if (accounting.extraReceipts) return "untracked-receipts";
  if (accounting.missingReceipts || accounting.unknownUsageCalls || accounting.identityConflicts) return "unknown-usage";
  if (result.boundaryViolations?.length) return "model-context-boundary";
  if (result.budget?.unknownUsageCalls) return "unknown-usage";
  if (result.budget?.exceeded) return "budget-overrun";
  if (result.budget?.activeReservations) return "reservations-open";
  if (result.success === true) return "completed";
  const explicit = terminationReason(result.terminationReason)
    ?? terminationReason((result.stages ?? []).findLast(stage => stage.success !== true)?.terminationReason);
  if (explicit && explicit !== "completed") return explicit;
  if (result.budget?.admissionDenied) return "budget-admission-limit";
  if (result.calls?.length >= result.configuration?.maxCalls) return "call-limit";
  if ((result.finalErrors ?? []).some(error => typeof error === "string" && error.startsWith("execution-error:"))) return "execution-error";
  if ((result.stages ?? []).some(stage => Object.values(stage.patchAttempts ?? {}).some(attempts => attempts >= result.configuration?.maxAttempts))) return "attempt-limit";
  if ((result.stages ?? []).some(stage => stage.qualityPass === false)) return "stage-quality-failure";
  if ((result.stages ?? []).some(stage => stage.protocolClean === false)) return "protocol-incomplete";
  return "incomplete";
}
const rows = [], allEstimates = [];
for (const condition of experiment.planned) {
  const declaration = declarations.get(condition.id), runDirectory = join(directory, condition.id);
  const resultBytes = await optional(join(runDirectory, "result.json"));
  let result = null, integrity = "not-run";
  if (resultBytes) {
    result = JSON.parse(resultBytes);
    if (declaration) {
      if (!digest(declaration.resultSha256) || declaration.resultSha256 !== sha(resultBytes)) throw new Error(`Result SHA mismatch: ${condition.id}`);
      integrity = "verified";
    } else integrity = "unverified-result";
    if (result.family !== condition.family || result.method !== condition.method
      || result.configuration?.workers !== condition.workers || result.configuration?.concurrency !== condition.concurrency
      || result.configuration?.groups !== condition.groups || !Array.isArray(result.calls)) throw new Error(`Result condition mismatch: ${condition.id}`);
  } else if (declaration) integrity = "missing-result";
  let entries = [];
  try { entries = await readdir(runDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const receiptFiles = entries.filter(entry => entry.isFile() && /^call-\d+\.json$/.test(entry.name));
  if (!result && !declaration && entries.length) integrity = experiment.status === "running" ? "running" : "incomplete-result";
  const expected = new Map();
  for (const call of result?.calls ?? []) {
    if (typeof call.id !== "string" || !/^call-\d+$/.test(call.id) || expected.has(call.id)) throw new Error("Invalid or duplicate result call ID");
    expected.set(call.id, call);
  }
  // A reserved call can outlive the normal result-record write on a failing path.
  for (const call of result?.budget?.calls ?? []) {
    if (typeof call.callId !== "string" || !/^call-\d+$/.test(call.callId)) throw new Error("Invalid budget call ID");
    if (!expected.has(call.callId)) expected.set(call.callId, { id: call.callId, model: call.model });
  }
  const actual = new Map();
  for (const entry of receiptFiles) actual.set(basename(entry.name, ".json"), await readFile(join(runDirectory, entry.name)));
  const ids = [...new Set([...expected.keys(), ...actual.keys()])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const estimates = [], receiptHashes = [];
  let missingReceipts = 0, extraReceipts = 0, unknownUsageCalls = 0, identityConflicts = 0, identityUnverifiedCalls = 0;
  const byModel = new Map();
  for (const id of ids) {
    const bytes = actual.get(id), data = bytes ? JSON.parse(bytes) : null, call = expected.get(id);
    if (!bytes) missingReceipts++;
    if (!call) extraReceipts++;
    const model = call?.model ?? data?.requestedModel ?? data?.transcript?.requestedModel;
    const identified = identity(data, model), usage = extractTokenUsage(data);
    identityConflicts += Number(identified.conflict); identityUnverifiedCalls += Number(!identified.verified);
    const estimate = estimateCallCost(usage, identified.valid ? model : "unknown", rateCard);
    const unknown = !identified.valid || usage.issues.length > 0 || ["missing", "ambiguous"].includes(usage.source)
      || !estimate.codexCredits.exact || !estimate.apiUsd.exact;
    unknownUsageCalls += Number(unknown);
    estimates.push(estimate);
    receiptHashes.push({ id, sha256: bytes ? sha(bytes) : null });
    const key = models.includes(model) ? model : "unknown", group = byModel.get(key) ?? [];
    group.push(estimate); byModel.set(key, group);
  }
  // Missing result evidence could omit additional calls; preserve an open upper bound.
  if (integrity !== "verified" && integrity !== "not-run") estimates.push({ apiUsd: unknownCost(), codexCredits: unknownCost() });
  allEstimates.push(...estimates);
  const accounting = { calls: ids.length, missingReceipts, extraReceipts, unknownUsageCalls, identityConflicts, identityUnverifiedCalls,
    complete: integrity === "verified" && missingReceipts === 0 && extraReceipts === 0 && unknownUsageCalls === 0,
    receiptManifestSha256: sha(JSON.stringify(receiptHashes)),
    ...(integrity === "not-run" ? { apiUsd: null, codexCredits: null } : costTotal(estimates)),
    byModel: [...byModel].map(([model, group]) => ({ model, calls: group.length, ...costTotal(group) })) };
  const calls = result?.calls ?? [], single = condition.method.startsWith("single-");
  const participants = Array.from({ length: condition.workers }, (_, index) => {
    const id = single ? "single" : `sheep-${index + 1}`;
    const agentCalls = calls.filter(call => call.agent === id);
    const stat = result?.workerStats?.find(worker => worker.id === id);
    return { id, actualCalls: result ? agentCalls.length : null,
      scheduledAssignments: result ? (single ? agentCalls.length : count(stat?.assignments)) : null,
      committedPatches: result ? agentCalls.filter(call => call.outcome === "committed").length : null,
      finalMemoryEntries: result ? (single ? Array.isArray(result.singleMemory) ? result.singleMemory.length : null
        : Array.isArray(stat?.memory) ? stat.memory.length : null) : null };
  });
  const actualCounts = participants.flatMap(worker => worker.actualCalls === null ? [] : [worker.actualCalls]);
  const reason = completionReason(result, accounting, integrity);
  rows.push({ id: condition.id, family: condition.family, method: condition.method, workers: condition.workers,
    concurrency: condition.concurrency, groups: condition.groups, replicate: condition.repeat,
    configuration: numericConfiguration(result?.configuration ?? { ...experiment.configuration, ...condition, maxCredits: experiment.perRunCreditCap }),
    integrity, resultSha256: resultBytes ? sha(resultBytes) : null, fixtureFingerprint: digest(result?.fixtureFingerprint),
    recordedSuccess: bool(result?.success), success: result ? result.success === true && accounting.complete && integrity === "verified" : null,
    qualityPass: bool(result?.qualityPass), completionReason: reason,
    recordedTerminationReason: terminationReason(result?.terminationReason), durationMs: number(result?.durationMs ?? declaration?.durationMs),
    lowerCalls: result ? calls.filter(call => call.model === "gpt-5.6-luna").length : null,
    upperCalls: result ? calls.filter(call => call.model === "gpt-6-astra").length : null,
    upperInterventions: count(result?.interventions), boundaryViolationCount: result ? (result.boundaryViolations?.length ?? null) : null,
    maxActiveModelCalls: count(result?.maxActiveModelCalls), reservationOverruns: count(result?.budget?.reservationOverruns),
    runnerUnknownUsageCalls: count(result?.budget?.unknownUsageCalls), budgetExceeded: bool(result?.budget?.exceeded),
    budgetAdmissionDenied: bool(result?.budget?.admissionDenied), observedRunnerCredits: number(result?.budget?.observedCredits),
    stagesExpected: condition.family === "staged" ? 3 : 1,
    stages: (result?.stages ?? []).map(stage => ({ stage: count(stage.stage), success: bool(stage.success), qualityPass: bool(stage.qualityPass),
      terminationReason: terminationReason(stage.terminationReason),
      protocolClean: bool(stage.protocolClean), durationMs: number(stage.elapsedMs), calls: count(stage.calls), lowerCalls: count(stage.lowerCalls),
      upperCalls: count(stage.upperCalls), readCalls: count(stage.readCalls), interventions: count(stage.interventions) })),
    participation: { registered: condition.workers, active: result ? actualCounts.filter(value => value > 0).length : null,
      minCalls: actualCounts.length ? Math.min(...actualCounts) : null, maxCalls: actualCounts.length ? Math.max(...actualCounts) : null,
      perWorker: participants },
    discovery: { deliveredEdges: result ? (result.discovery?.deliveredEdges?.length ?? null) : null,
      totalEdges: result ? (result.discovery?.edges?.length ?? null) : null,
      readCalls: result ? calls.filter(call => call.outcome === "read-requested").length : null,
      requestedReadArtifacts: result ? calls.reduce((sum, call) => sum + (call.readRequests?.length ?? 0), 0) : null },
    memory: { callsWithMemory: result ? calls.filter(call => number(call.memoryEntries) > 0).length : null,
      deliveredEntries: result ? calls.reduce((sum, call) => sum + (count(call.memoryEntries) ?? 0), 0) : null,
      finalEntries: result && participants.every(worker => worker.finalMemoryEntries !== null)
        ? participants.reduce((sum, worker) => sum + worker.finalMemoryEntries, 0) : null },
    accounting });
}
const stats = values => {
  const present = values.filter(value => number(value) !== null);
  return { samples: present.length, mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : null,
    min: present.length ? Math.min(...present) : null, max: present.length ? Math.max(...present) : null };
};
const grouped = new Map();
for (const row of rows) {
  const key = JSON.stringify([row.family, row.method, row.workers, row.concurrency, row.groups]);
  const group = grouped.get(key) ?? []; group.push(row); grouped.set(key, group);
}
const groupMetrics = [...grouped.values()].map(group => ({ family: group[0].family, method: group[0].method,
  workers: group[0].workers, concurrency: group[0].concurrency, groups: group[0].groups, plannedRuns: group.length,
  verifiedResults: group.filter(row => row.integrity === "verified").length, successfulRuns: group.filter(row => row.success === true).length,
  qualityPasses: group.filter(row => row.qualityPass === true && row.integrity === "verified").length, unexecutedRuns: group.filter(row => row.integrity === "not-run").length,
  allRunDurationMs: stats(group.map(row => row.durationMs)), successfulDurationMs: stats(group.filter(row => row.success).map(row => row.durationMs)),
  exactCredits: stats(group.filter(row => row.accounting.codexCredits?.exact && row.integrity === "verified").map(row => row.accounting.codexCredits.lower)),
  exactApiUsd: stats(group.filter(row => row.accounting.apiUsd?.exact && row.integrity === "verified").map(row => row.accounting.apiUsd.lower)),
  minCallsPerRegisteredWorker: stats(group.map(row => row.participation.minCalls)),
  readCalls: stats(group.map(row => row.discovery.readCalls)), memoryEntriesDelivered: stats(group.map(row => row.memory.deliveredEntries)),
  upperInterventions: stats(group.map(row => row.upperInterventions)) }));
const conditions = [
  "Published Standard-rate equivalents with observed cached-input splits; neither observed account debits nor invoices.",
  "API USD is the hypothetical API price for these tokens, not a Codex subscription charge.",
  "All discovered call receipts count, including failed calls. Missing receipts produce unknown upper costs.",
  "Never-started planned conditions remain in rows; their lack of a result is not a quality failure or a measured zero-cost success.",
  "Numbers compare this frozen synthetic development experiment; case-level repeats do not establish generalization or emergence.",
  "Semantic tasks exercise registry/JSON policy dependencies absent from the initial static graph; arbitrary semantic discovery is not established.",
  "Private-memory measurements count entries, not tokens; worker participation counts actual model calls including read requests.",
  "Registered-worker minima include idle workers; a single baseline counts its actual single actor, not the unused worker-pool slot.",
  ...(experiment.mode === "scaling-followup" ? [
    "Totals cover this additional campaign only. Previous-study known credit lower bounds and unknown usage remain separate historical metadata.",
    "The additional authorization does not resolve, erase, or charge unknown previous usage to this campaign's observed total.",
  ] : []),
];
const report = { format: 1, kind: "mechanism-summary", generatedAt: new Date().toISOString(),
  mode: ["pilot", "main", "scaling-followup"].includes(experiment.mode) ? experiment.mode : "unknown",
  status: ["running", "completed", "stopped", "error"].includes(experiment.status) ? experiment.status : "unknown",
  stopReason: experiment.stopReason === null ? null : ["unknown-usage", "study-admission-limit", "model-context-boundary", "per-run-overrun"].includes(experiment.stopReason)
    ? experiment.stopReason : "execution-error",
  sourceManifestSha256: experiment.sourceManifestSha256, experimentSha256: sha(experimentBytes), rateCardSha256: experiment.rateCardSha256,
  estimatorSha256, summarizerSha256: sha(await readFile(new URL(import.meta.url))),
  sourceFilesVerified: sourceManifest.length, seed: count(experiment.seed), standardCreditCap: number(experiment.standardCreditCap),
  perRunCreditCap: number(experiment.perRunCreditCap), configuration: numericConfiguration(experiment.configuration),
  previousStudy, additionalBudgetAuthorization,
  conditions, total: { plannedRuns: rows.length, recordedRuns: rows.filter(row => row.integrity === "verified").length,
    successfulRuns: rows.filter(row => row.success === true).length, unexecutedRuns: rows.filter(row => row.integrity === "not-run").length,
    callReceipts: rows.reduce((sum, row) => sum + row.accounting.calls - row.accounting.missingReceipts, 0),
    missingReceipts: rows.reduce((sum, row) => sum + row.accounting.missingReceipts, 0),
    unknownUsageCalls: rows.reduce((sum, row) => sum + row.accounting.unknownUsageCalls, 0), ...costTotal(allEstimates) },
  groupMetrics, rows };
const display = value => value.upper === null ? `≥${value.lower.toFixed(4)}（上限不明）`
  : value.exact ? value.lower.toFixed(4) : `${value.lower.toFixed(4)}–${value.upper.toFixed(4)}`;
const familyLabels = { static: "静的変更", semantic: "意味依存", staged: "段階更新" };
const markdown = ["# 機構実験の集計", "", "金額とcreditsはStandard公開単価による概算。実際の請求・残高消費は観測していない。",
  "", "| 課題 | 方式 | N/C | 回 | 結果 | 秒 | 下位/上位 | credits相当 | API USD相当 | 個体呼出し min–max |",
  "|:---|:---|:---|---:|:---|---:|---:|---:|---:|:---|",
  ...rows.map(row => `| ${familyLabels[row.family]} | ${row.method} | ${row.workers}/${row.concurrency} | ${row.replicate} | ${row.success === true ? "pass" : row.completionReason} | ${row.durationMs === null ? "—" : (row.durationMs / 1000).toFixed(2)} | ${row.lowerCalls ?? "—"}/${row.upperCalls ?? "—"} | ${row.integrity === "not-run" ? "未実行" : display(row.accounting.codexCredits)} | ${row.integrity === "not-run" ? "未実行" : display(row.accounting.apiUsd)} | ${row.participation.minCalls ?? "—"}–${row.participation.maxCalls ?? "—"} |`),
  "", `確認済みレシート ${report.total.callReceipts}件、欠落 ${report.total.missingReceipts}件。合計 ${display(report.total.codexCredits)} credits相当 / $${display(report.total.apiUsd)}相当。`,
  "", `凍結ソースmanifest SHA-256: \`${report.sourceManifestSha256}\``, "", ...conditions.map(item => `- ${item}`), "" ];
for (const path of [resolve(values.output), resolve(values.markdown)]) {
  if ([join(directory, "experiment.json"), join(directory, "source-manifest.json")].includes(path)
    || path.startsWith(join(directory, "frozen-source") + "/")
    || [...plannedIds].some(id => path.startsWith(join(directory, id) + "/"))) throw new Error("Summary output must not overwrite source evidence");
  await mkdir(dirname(path), { recursive: true });
}
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n");
await writeFile(resolve(values.markdown), markdown.join("\n"));
process.stdout.write(JSON.stringify(report.total, null, 2) + "\n");
