import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { COMPARISON_METHODS, runComparison, type ComparisonMethod } from "./comparison.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const { values } = parseArgs({ options: {
  method: { type: "string", default: "sheep-fixed" }, output: { type: "string" },
  size: { type: "string", default: "8" }, workers: { type: "string", default: "4" }, concurrency: { type: "string", default: "4" },
  "max-calls": { type: "string", default: "48" }, "max-tokens": { type: "string", default: "120000" },
  "max-upper-calls": { type: "string" },
  "reserve-tokens": { type: "string", default: "12000" }, "timeout-ms": { type: "string", default: "120000" },
  "max-rounds": { type: "string", default: "24" },
  "max-attempts": { type: "string", default: "3" },
  fault: { type: "string", default: "none" },
  runtime: { type: "string", default: "codex" }, "meta-runtime": { type: "string" }, "worker-tools": { type: "string", default: "none" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" }, "max-tokens-per-call": { type: "string" },
} });
if (!COMPARISON_METHODS.includes(values.method as ComparisonMethod)) throw new Error(`method must be one of ${COMPARISON_METHODS.join(", ")}`);
if (values.fault !== "none" && values.fault !== "rounded-guidance") throw new Error("unknown comparison fault");
const outputDirectory = resolve(values.output ?? `.sheep/comparison-${values.method}-${Date.now()}`);
const report = await runComparison({ method: values.method as ComparisonMethod, outputDirectory,
  size: Number(values.size), workers: Number(values.workers), concurrency: Number(values.concurrency),
  maxCalls: Number(values["max-calls"]), maxTokens: Number(values["max-tokens"]),
  ...(values["max-upper-calls"] === undefined ? {} : { maxUpperCalls: Number(values["max-upper-calls"]) }),
  reserveTokensPerCall: Number(values["reserve-tokens"]), timeoutMs: Number(values["timeout-ms"]), maxRounds: Number(values["max-rounds"]),
  maxAttempts: Number(values["max-attempts"]),
  fault: values.fault,
  runtime: values.runtime as ModelRuntime, workerTools: values["worker-tools"] as "none" | "local",
  ...(values["meta-runtime"] === undefined ? {} : { metaRuntime: values["meta-runtime"] as ModelRuntime }),
  ...(values["worker-model"] === undefined ? {} : { workerModel: values["worker-model"] }),
  ...(values["meta-model"] === undefined ? {} : { metaModel: values["meta-model"] }),
  ...(values["max-tokens-per-call"] === undefined ? {} : { maxTokensPerCall: Number(values["max-tokens-per-call"]) }),
});
process.stdout.write(JSON.stringify({ outputDirectory, method: report.method, success: report.success, qualityPass: report.qualityPass,
  lowerCalls: report.lowerCalls, upperCalls: report.upperCalls, budget: report.budget, discovery: report.discovery,
  finalErrors: report.finalErrors, durationMs: report.times.elapsedMs }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
