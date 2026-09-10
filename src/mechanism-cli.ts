import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseRateCard } from "./cost-estimate.ts";
import { MECHANISM_METHODS, runMechanism, type MechanismMethod, type MechanismFamily } from "./mechanism-run.ts";

const { values } = parseArgs({ options: {
  method: { type: "string", default: "sheep" }, family: { type: "string", default: "static" }, output: { type: "string" }, rates: { type: "string" },
  groups: { type: "string", default: "8" }, workers: { type: "string", default: "16" }, concurrency: { type: "string", default: "8" },
  "max-credits": { type: "string", default: "30" }, "luna-reservation": { type: "string", default: "0.25" }, "astra-reservation": { type: "string", default: "15" },
  "max-calls": { type: "string", default: "400" }, "timeout-ms": { type: "string", default: "90000" },
  "max-attempts": { type: "string", default: "3" }, "max-read-calls": { type: "string", default: "2" }, "max-meta-calls": { type: "string", default: "3" },
} });
if (!MECHANISM_METHODS.includes(values.method as MechanismMethod)) throw new Error("unknown method");
if (!["static", "semantic", "staged"].includes(values.family)) throw new Error("unknown family");
const outputDirectory = resolve(values.output ?? `.sheep/mechanism-${values.method}-${values.family}-${Date.now()}`);
const report = await runMechanism({ method: values.method as MechanismMethod, family: values.family as MechanismFamily, outputDirectory,
  groups: Number(values.groups), workers: Number(values.workers), concurrency: Number(values.concurrency),
  maxCredits: Number(values["max-credits"]), lunaReservation: Number(values["luna-reservation"]), astraReservation: Number(values["astra-reservation"]),
  maxCalls: Number(values["max-calls"]), timeoutMs: Number(values["timeout-ms"]), maxAttempts: Number(values["max-attempts"]),
  maxReadCalls: Number(values["max-read-calls"]), maxMetaCalls: Number(values["max-meta-calls"]),
  ...(values.rates ? { rateCard: parseRateCard(JSON.parse(await readFile(resolve(values.rates), "utf8"))) } : {}) });
process.stdout.write(JSON.stringify({ outputDirectory, method: report.method, family: report.family, success: report.success,
  terminationReason: report.terminationReason, lowerCalls: report.lowerCalls, upperCalls: report.upperCalls, interventions: report.interventions, budget: report.budget,
  stages: report.stages, boundaryViolations: report.boundaryViolations, finalErrors: report.finalErrors, durationMs: report.durationMs }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
