import { parseArgs } from "node:util";
import { runDurableSwarm } from "./durable-run.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const { values } = parseArgs({ options: {
  directory: { type: "string" }, resume: { type: "boolean", default: false },
  size: { type: "string" }, workers: { type: "string" }, "max-calls": { type: "string" },
  "max-meta-calls": { type: "string" }, "timeout-ms": { type: "string" }, fault: { type: "string" },
  runtime: { type: "string" }, "meta-runtime": { type: "string" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" }, "max-tokens-per-call": { type: "string" },
} });
if (!values.directory) throw new Error("--directory is required; pass --resume to continue its durable state");
if (values.fault !== undefined && values.fault !== "none" && values.fault !== "rounded-guidance") throw new Error("unknown fault");
const report = await runDurableSwarm({ directory: values.directory, resume: values.resume,
  ...(values.size === undefined ? {} : { size: Number(values.size) }),
  ...(values.workers === undefined ? {} : { workers: Number(values.workers) }),
  ...(values["max-calls"] === undefined ? {} : { maxCalls: Number(values["max-calls"]) }),
  ...(values["max-meta-calls"] === undefined ? {} : { maxMetaCalls: Number(values["max-meta-calls"]) }),
  ...(values["timeout-ms"] === undefined ? {} : { timeoutMs: Number(values["timeout-ms"]) }),
  ...(values.fault === undefined ? {} : { fault: values.fault }),
  ...(values.runtime === undefined ? {} : { runtime: values.runtime as ModelRuntime }),
  ...(values["meta-runtime"] === undefined ? {} : { metaRuntime: values["meta-runtime"] as ModelRuntime }),
  ...(values["worker-model"] === undefined ? {} : { workerModel: values["worker-model"] }),
  ...(values["meta-model"] === undefined ? {} : { metaModel: values["meta-model"] }),
  ...(values["max-tokens-per-call"] === undefined ? {} : { maxTokensPerCall: Number(values["max-tokens-per-call"]) }),
});
process.stdout.write(JSON.stringify({ directory: report.directory, success: report.success, lowerCalls: report.lowerCalls,
  upperCalls: report.upperCalls, unknownCalls: report.unknownCalls, usageUnknownCalls: report.usageUnknownCalls,
  resumes: report.resumes, generation: report.generation, finalErrors: report.finalErrors }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
