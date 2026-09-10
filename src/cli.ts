import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runSwarm } from "./swarm.ts";

const { values } = parseArgs({ options: {
  workers: { type: "string", default: "4" }, concurrency: { type: "string", default: "4" },
  size: { type: "string", default: "4" }, output: { type: "string" },
  "meta-model": { type: "string", default: "gpt-6-astra" },
  "max-calls": { type: "string" }, "max-meta-calls": { type: "string", default: "2" },
  "max-rounds": { type: "string", default: "20" }, "timeout-ms": { type: "string", default: "120000" },
  fault: { type: "string", default: "none" },
  runtime: { type: "string", default: "codex" },
} });
if (values.fault !== "none" && values.fault !== "rounded-guidance") throw new Error("unknown fault");
if (values.runtime !== "codex" && values.runtime !== "docker-agent") throw new Error("unknown runtime");
const outputDirectory = resolve(values.output ?? `.sheep/run-${new Date().toISOString().replaceAll(":", "-")}`);
const report = await runSwarm({ workers: Number(values.workers), concurrency: Number(values.concurrency), size: Number(values.size),
  workerModel: "gpt-5.6-luna", metaModel: values["meta-model"],
  maxCalls: values["max-calls"] === undefined ? Number(values.size) * 5 : Number(values["max-calls"]),
  maxMetaCalls: Number(values["max-meta-calls"]), maxRounds: Number(values["max-rounds"]), timeoutMs: Number(values["timeout-ms"]),
  fault: values.fault, outputDirectory, runtime: values.runtime,
});
process.stdout.write(JSON.stringify({ outputDirectory, success: report.success, lowerCalls: report.lowerCalls,
  upperCalls: report.upperCalls, interventions: report.interventions, maxActiveWorkers: report.maxActiveWorkers,
  durationMs: report.durationMs, finalErrors: report.finalErrors }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
