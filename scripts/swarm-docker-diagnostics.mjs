import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runSwarm } from "../src/swarm.ts";
import { diagnosticsTask } from "../experiments/docker-diagnostics-task.ts";
import { callDockerAgent } from "../src/docker-agent-worker.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { CreditBudget } from "../src/credit-budget.ts";
import { parseRateCard } from "../src/cost-estimate.ts";

const outputDirectory = resolve(`.sheep/swarm-docker-diagnostics-${Date.now()}`);
const rateCard = parseRateCard(JSON.parse(await readFile(new URL("../pricing/openai-2026-09-10.json", import.meta.url), "utf8")));
const budget = new CreditBudget({ maxCredits: 3, rateCard, reservations: { "gpt-5.6-luna": 0.5 } });
let dispatch = 0;
const report = await runSwarm({ runtime: "docker-agent", workerTools: "local", workers: 4, concurrency: 2, size: 2,
  maxCalls: 8, maxMetaCalls: 0, maxRounds: 6, maxTokensPerCall: 60000, timeoutMs: 240000, outputDirectory }, async options => {
  const id = `dispatch-${++dispatch}`;
  if (!budget.reserve(options.model, id)) throw new Error("Implementation swarm credit admission closed");
  let receipt = {};
  try { receipt = await callDockerAgent(options); return receipt; }
  catch (error) { receipt = error instanceof CodexWorkerError ? { error: error.code, transcript: error.transcript } : { error: String(error) }; throw error; }
  finally {
    budget.settle(id, receipt);
    await writeFile(join(outputDirectory, "credit-budget.json"), JSON.stringify(budget.snapshot(), null, 2) + "\n");
  }
}, undefined, diagnosticsTask);
const state = budget.snapshot();
const success = report.success && state.unknownUsageCalls === 0 && !state.exceeded && state.activeReservations === 0;
await writeFile(join(outputDirectory, "implementation-result.json"), JSON.stringify({ success, outputDirectory,
  source: "existing runSwarm + WorkerPool + kernel; trusted diagnostics fixture", report: "result.json", budget: state }, null, 2) + "\n");
console.log(JSON.stringify({ success, outputDirectory, lowerCalls: report.lowerCalls, completedArtifacts: report.completedArtifacts, budget: state, errors: report.finalErrors }));
if (!success) process.exitCode = 1;
