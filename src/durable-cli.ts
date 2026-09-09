import { parseArgs } from "node:util";
import { runDurableSwarm } from "./durable-run.ts";

const { values } = parseArgs({ options: {
  directory: { type: "string" }, resume: { type: "boolean", default: false },
  size: { type: "string" }, workers: { type: "string" }, "max-calls": { type: "string" },
  "max-meta-calls": { type: "string" }, "timeout-ms": { type: "string" }, fault: { type: "string" },
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
});
process.stdout.write(JSON.stringify({ directory: report.directory, success: report.success, lowerCalls: report.lowerCalls,
  upperCalls: report.upperCalls, unknownCalls: report.unknownCalls, usageUnknownCalls: report.usageUnknownCalls,
  resumes: report.resumes, generation: report.generation, finalErrors: report.finalErrors }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
