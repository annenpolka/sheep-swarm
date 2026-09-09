import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const directory = resolve(process.argv[2] ?? ".sheep/scaling-v1");
const experiment = JSON.parse(await readFile(join(directory, "experiment.json"), "utf8"));
const entries = [{ id: experiment.reusedPilot.id, destination: experiment.reusedPilot.path,
  expected: experiment.reusedPilot.sha256, pilot: true }, ...experiment.runs.filter(run => run.resultSha256)
  .map(run => ({ ...run, expected: run.resultSha256, pilot: false }))];
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), i = Math.floor(ordered.length / 2);
  return ordered.length ? ordered.length % 2 ? ordered[i] : (ordered[i - 1] + ordered[i]) / 2 : null;
};
const rows = [];
for (const entry of entries) {
  const bytes = await readFile(join(entry.destination, "result.json"));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.expected) throw new Error(`receipt changed: ${entry.id}`);
  const report = JSON.parse(bytes);
  const reportedUnknownUsageCalls = report.calls.filter(call => call.inputTokens === null || call.outputTokens === null).length;
  const usageRestorations = [];
  // Never rewrite original run receipts. Recover missing accounting only from their raw CLI evidence.
  for (const call of report.calls) if (call.inputTokens === null || call.outputTokens === null) {
    const rawBytes = await readFile(join(entry.destination, `${call.id}.json`));
    const transcript = JSON.parse(rawBytes).transcript;
    const usage = transcript?.usage ?? [];
    const inputs = usage.map(item => item.inputTokens), outputs = usage.map(item => item.outputTokens);
    const valid = value => Number.isSafeInteger(value) && value >= 0;
    if (inputs.length && inputs.every(valid) && outputs.every(valid)) {
      call.inputTokens = inputs.reduce((sum, value) => sum + value, 0);
      call.outputTokens = outputs.reduce((sum, value) => sum + value, 0);
      const events = transcript.events ?? [];
      const completedAt = events.findLastIndex(event => event.type === "turn.completed");
      const errorAt = events.findLastIndex(event => event.type === "error" || event.type === "turn.failed");
      usageRestorations.push({ call: call.id, inputTokens: call.inputTokens, outputTokens: call.outputTokens,
        rawReceiptSha256: createHash("sha256").update(rawBytes).digest("hex"),
        recoveredTransportMisclassified: call.outcome === "nonzero-exit" && transcript.exitCode === 0 && errorAt >= 0 && completedAt > errorAt });
    }
  }
  const workerCalls = report.calls.filter(call => call.role === "worker");
  const state = JSON.parse(await readFile(join(entry.destination, "kernel-state.json"), "utf8"));
  const assignments = report.individuals.map(worker => worker.assignments);
  const firstMetaCommit = state.trace.find(event => event.type === "intervention");
  const firstIntervention = state.trace.find(event => event.type === "intervention" && event.details.events?.length > 0);
  const failures = workerCalls.filter(call => call.outcome !== "committed");
  rows.push({ id: entry.id, pilot: entry.pilot, ...report.configuration, success: report.success,
    durationMs: report.durationMs, lowerCalls: report.lowerCalls, upperCalls: report.upperCalls,
    interventions: report.interventions, completedArtifacts: report.completedArtifacts,
    writableArtifacts: report.writableArtifacts, maxActiveWorkers: report.maxActiveWorkers,
    maxConcurrentModelCalls: report.maxConcurrentModelCalls,
    activeIndividuals: assignments.filter(count => count > 0).length,
    assignmentMin: Math.min(...assignments), assignmentMax: Math.max(...assignments),
    callsWithPrivateMemory: workerCalls.filter(call => call.memoryEntries > 0).length,
    outcomeCounts: Object.fromEntries([...new Set(report.calls.map(call => call.outcome))]
      .map(outcome => [outcome, report.calls.filter(call => call.outcome === outcome).length])),
    lowerInputTokens: workerCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    lowerOutputTokens: workerCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    upperInputTokens: report.calls.filter(call => call.role === "meta").reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    upperOutputTokens: report.calls.filter(call => call.role === "meta").reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    unknownUsageCalls: report.calls.filter(call => call.inputTokens === null || call.outputTokens === null).length,
    reportedUnknownUsageCalls, usageRestorations,
    modelIdentityEvidenceCalls: report.calls.filter(call => call.effectiveModelEvidence !== null).length,
    workerMedianCallMs: median(workerCalls.map(call => call.durationMs)),
    workerMaxCallMs: Math.max(...workerCalls.map(call => call.durationMs)),
    commitWaitTotalMs: workerCalls.reduce((sum, call) => sum + call.commitWaitMs, 0),
    workerContextBytes: workerCalls.reduce((sum, call) => sum + call.contextBytes, 0),
    upperContextBytes: report.calls.filter(call => call.role === "meta").reduce((sum, call) => sum + call.contextBytes, 0),
    failedWorkerAttempts: failures.length,
    firstInterventionTime: firstIntervention?.time ?? null,
    firstMetaCommitTime: firstMetaCommit?.time ?? null,
    unresolvedObligations: state.obligations.filter(work => work.state !== "handled").length,
    unresolvedClaims: state.claims.filter(claim => claim.open && claim.blocking).length,
    finalErrors: report.finalErrors,
  });
}
const report = { format: 1, generatedAt: new Date().toISOString(), sourceManifest: experiment.sourceManifest,
  experimentComplete: Boolean(experiment.finishedAt), plannedRuns: experiment.conditions.length + 1, observedRuns: rows.length,
  rows };
await writeFile(join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
const lines = ["| N | C | consumer数 | 条件 | 回 | 成功 | 秒 | 下位/上位呼出し | 失敗試行 | 観測token合計 | usage不明 |",
  "|---:|---:|---:|:---|---:|:---:|---:|---:|---:|---:|---:|"];
for (const row of rows) lines.push(`| ${row.workers} | ${row.concurrency} | ${row.size} | ${row.fault} | ${row.pilot ? "pilot" : /r(\d+)$/.exec(row.id)?.[1]} | ${row.success ? "pass" : "FAIL"} | ${(row.durationMs / 1000).toFixed(2)} | ${row.lowerCalls}/${row.upperCalls} | ${row.failedWorkerAttempts} | ${row.lowerInputTokens + row.lowerOutputTokens + row.upperInputTokens + row.upperOutputTokens} | ${row.unknownUsageCalls} |`);
await writeFile(join(directory, "table.md"), lines.join("\n") + "\n");
process.stdout.write(lines.join("\n") + "\n");
