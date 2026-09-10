import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runSwarm, type SwarmOptions } from "./swarm.ts";

type SwarmRuntime = NonNullable<SwarmOptions["runtime"]>;
function parseRuntime(value: string | undefined, label: string): SwarmRuntime | undefined {
  if (value === undefined) return undefined;
  if (value !== "codex" && value !== "docker-agent" && value !== "deepseek" && value !== "opencode-go") throw new Error(`unknown ${label}`);
  return value;
}

const { values } = parseArgs({ options: {
  workers: { type: "string", default: "4" }, concurrency: { type: "string", default: "4" },
  size: { type: "string", default: "4" }, output: { type: "string" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" },
  "max-calls": { type: "string" }, "max-meta-calls": { type: "string", default: "2" },
  "max-rounds": { type: "string", default: "20" }, "timeout-ms": { type: "string", default: "120000" },
  "max-tokens-per-call": { type: "string" },
  fault: { type: "string", default: "none" },
  runtime: { type: "string", default: "codex" },
  "meta-runtime": { type: "string" },
  "worker-tools": { type: "string", default: "none" },
} });
if (values.fault !== "none" && values.fault !== "rounded-guidance") throw new Error("unknown fault");
const runtime: SwarmRuntime = parseRuntime(values.runtime, "runtime")!;
const metaRuntime = parseRuntime(values["meta-runtime"], "meta runtime");
if (values["worker-tools"] !== "none" && values["worker-tools"] !== "local") throw new Error("unknown worker tools");
const maxTokensPerCall = values["max-tokens-per-call"] === undefined ? undefined : Number(values["max-tokens-per-call"]);
const outputDirectory = resolve(values.output ?? `.sheep/run-${new Date().toISOString().replaceAll(":", "-")}`);
const report = await runSwarm({ workers: Number(values.workers), concurrency: Number(values.concurrency), size: Number(values.size),
  ...(values["worker-model"] === undefined ? {} : { workerModel: values["worker-model"] }),
  ...(values["meta-model"] === undefined ? {} : { metaModel: values["meta-model"] }),
  maxCalls: values["max-calls"] === undefined ? Number(values.size) * 5 : Number(values["max-calls"]),
  maxMetaCalls: Number(values["max-meta-calls"]), maxRounds: Number(values["max-rounds"]), timeoutMs: Number(values["timeout-ms"]),
  ...(maxTokensPerCall === undefined ? {} : { maxTokensPerCall }),
  fault: values.fault, outputDirectory, runtime, ...(metaRuntime === undefined ? {} : { metaRuntime }), workerTools: values["worker-tools"],
});
process.stdout.write(JSON.stringify({ outputDirectory, success: report.success, lowerCalls: report.lowerCalls,
  upperCalls: report.upperCalls, interventions: report.interventions, maxActiveWorkers: report.maxActiveWorkers,
  durationMs: report.durationMs, finalErrors: report.finalErrors }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
