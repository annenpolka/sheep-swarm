import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parseRateCard } from "./cost-estimate.ts";
import { MECHANISM_METHODS, runMechanism, type MechanismMethod, type MechanismFamily } from "./mechanism-run.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const { values } = parseArgs({ options: {
  runtime: { type: "string", default: "codex" }, "meta-runtime": { type: "string" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" },
  "worker-tools": { type: "string", default: "none" },
  "budget-mode": { type: "string", default: "credits" },
  "max-tokens": { type: "string" }, "reserve-tokens": { type: "string" },
  "max-tokens-per-call": { type: "string", default: "60000" },
  method: { type: "string", default: "sheep" }, family: { type: "string", default: "static" }, output: { type: "string" }, rates: { type: "string" },
  groups: { type: "string", default: "8" }, workers: { type: "string", default: "16" }, concurrency: { type: "string", default: "8" },
  "max-credits": { type: "string" }, "luna-reservation": { type: "string" }, "astra-reservation": { type: "string" },
  "max-calls": { type: "string", default: "400" }, "timeout-ms": { type: "string", default: "90000" },
  "max-attempts": { type: "string", default: "3" }, "max-read-calls": { type: "string", default: "2" }, "max-meta-calls": { type: "string", default: "3" },
} });
if (!MECHANISM_METHODS.includes(values.method as MechanismMethod)) throw new Error("unknown method");
if (!["static", "semantic", "staged"].includes(values.family)) throw new Error("unknown family");
if (values["worker-tools"] !== "none" && values["worker-tools"] !== "local") throw new Error("unknown worker tools");
if (values["budget-mode"] !== "credits" && values["budget-mode"] !== "tokens") throw new Error("unknown budget mode");
const outputDirectory = resolve(values.output ?? `.sheep/mechanism-${values.method}-${values.family}-${Date.now()}`);
const report = await runMechanism({ method: values.method as MechanismMethod, family: values.family as MechanismFamily, outputDirectory,
  runtime: values.runtime as ModelRuntime,
  ...(values["meta-runtime"] === undefined ? {} : { metaRuntime: values["meta-runtime"] as ModelRuntime }),
  ...(values["worker-model"] === undefined ? {} : { workerModel: values["worker-model"] }),
  ...(values["meta-model"] === undefined ? {} : { metaModel: values["meta-model"] }),
  workerTools: values["worker-tools"], maxTokensPerCall: Number(values["max-tokens-per-call"]),
  budgetMode: values["budget-mode"],
  groups: Number(values.groups), workers: Number(values.workers), concurrency: Number(values.concurrency),
  ...(values["max-tokens"] === undefined ? {} : { maxTokens: Number(values["max-tokens"]) }),
  ...(values["reserve-tokens"] === undefined ? {} : { reserveTokensPerCall: Number(values["reserve-tokens"]) }),
  ...(values["max-credits"] === undefined ? {} : { maxCredits: Number(values["max-credits"]) }),
  ...(values["luna-reservation"] === undefined ? {} : { lunaReservation: Number(values["luna-reservation"]) }),
  ...(values["astra-reservation"] === undefined ? {} : { astraReservation: Number(values["astra-reservation"]) }),
  maxCalls: Number(values["max-calls"]), timeoutMs: Number(values["timeout-ms"]), maxAttempts: Number(values["max-attempts"]),
  maxReadCalls: Number(values["max-read-calls"]), maxMetaCalls: Number(values["max-meta-calls"]),
  ...(values.rates ? { rateCard: parseRateCard(JSON.parse(await readFile(resolve(values.rates), "utf8"))) } : {}) });
process.stdout.write(JSON.stringify({ outputDirectory, method: report.method, family: report.family, success: report.success,
  terminationReason: report.terminationReason, lowerCalls: report.lowerCalls, upperCalls: report.upperCalls, interventions: report.interventions, budget: report.budget,
  stages: report.stages, boundaryViolations: report.boundaryViolations, finalErrors: report.finalErrors, durationMs: report.durationMs }, null, 2) + "\n");
if (!report.success) process.exitCode = 1;
