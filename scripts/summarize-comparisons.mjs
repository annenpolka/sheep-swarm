import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const directory = resolve(process.argv[2] ?? ".sheep/comparison-v2");
const experiment = JSON.parse(await readFile(join(directory, "experiment.json"), "utf8"));
const rows = [];
for (const run of experiment.runs) {
  if (!run.resultSha256) continue;
  const bytes = await readFile(join(run.destination, "result.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== run.resultSha256) throw new Error(`receipt changed: ${run.id}`);
  const result = JSON.parse(bytes);
  const entry = { id: run.id, method: result.method, fault: run.fault, replicate: run.replicate,
    fixtureFingerprint: result.fixtureFingerprint, configuration: result.configuration,
    success: result.success, qualityPass: result.qualityPass, lowerCalls: result.lowerCalls, upperCalls: result.upperCalls,
    interventions: result.interventions, retries: result.retries, budget: result.budget,
    times: result.times, discovery: result.discovery, acceptanceChecks: result.acceptanceChecks,
    contextBytes: result.contextBytes, maxActiveModelCalls: result.maxActiveModelCalls,
    outcomes: Object.fromEntries([...new Set(result.calls.map(call => call.outcome))]
      .map(outcome => [outcome, result.calls.filter(call => call.outcome === outcome).length])),
    finalErrors: result.finalErrors, rawResultSha256: run.resultSha256 };
  rows.push(entry);
}
await writeFile(join(directory, "summary.json"), JSON.stringify({ format: 1, generatedAt: new Date().toISOString(),
  sourceManifest: experiment.sourceManifest, common: experiment.common, complete: Boolean(experiment.finishedAt), rows }, null, 2) + "\n");
const lines = ["| 方式 | 条件 | 回 | 成功 | 秒 | 下位/上位呼出し | token合計 | 再試行 |",
  "|:---|:---|---:|:---:|---:|---:|---:|---:|"];
for (const row of rows) lines.push(`| ${row.method} | ${row.fault} | ${row.replicate} | ${row.success ? "pass" : "FAIL"} | ${(row.times.elapsedMs/1000).toFixed(2)} | ${row.lowerCalls}/${row.upperCalls} | ${row.budget.observedTokens} | ${row.retries} |`);
await writeFile(join(directory, "table.md"), lines.join("\n") + "\n");
process.stdout.write(lines.join("\n") + "\n");

// Keep preliminary and discarded experimental calls in a separate accounting ledger.
const root = resolve(directory, "..");
const families = [
  ["m2-normal", join(root, "luna-4-initial")], ["m2-fault", join(root, "luna-4-intervention")],
  ["m3-pretrial", join(root, "luna-16-stateful-pilot")], ["m3-primary", join(root, "scaling-v1")],
  ["m4-restart", join(root, "durable-real-v1")], ["m5-preliminary", join(root, "comparison-v1")],
  ["m5-primary", join(root, "comparison-v2")], ["m5-manager-followup", join(root, "manager-followup")],
];
if (!families.some(([, path]) => path === directory)) families.push(["current-comparison", directory]);
const ledger = [];
async function files(path) {
  const result = [];
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return result; throw error; }
  for (const item of entries) {
    const name = join(path, item.name);
    if (item.isDirectory() && item.name !== "transcripts" && !item.name.startsWith("model-workspace")) result.push(...await files(name));
    if (item.isFile() && /^(compare-)?call-\d+\.json$/.test(item.name)) result.push(name);
  }
  return result;
}
for (const [family, path] of families) {
  const byModel = new Map();
  for (const file of await files(path)) {
    const data = JSON.parse(await readFile(file, "utf8")), transcript = data.transcript;
    if (!transcript) continue;
    const model = transcript.requestedModel ?? data.requestedModel ?? "unknown";
    const entry = byModel.get(model) ?? { family, model, calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 };
    entry.calls++;
    const usage = transcript.usage ?? [];
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    if (!usage.length || !usage.every(row => valid(row.inputTokens) && valid(row.outputTokens))) entry.unknownUsageCalls++;
    for (const row of usage) { entry.inputTokens += valid(row.inputTokens) ? row.inputTokens : 0; entry.outputTokens += valid(row.outputTokens) ? row.outputTokens : 0; }
    byModel.set(model, entry);
  }
  ledger.push(...byModel.values());
}
await writeFile(join(directory, "usage-ledger.json"), JSON.stringify({ format: 1, generatedAt: new Date().toISOString(),
  scope: "Actual experiment CLI receipts in the named directories. Includes discarded preliminary runs; excludes development agents and the initial adapter connectivity probe.", ledger }, null, 2) + "\n");
