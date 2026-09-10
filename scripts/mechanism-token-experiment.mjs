import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { TokenBudget } from "../src/token-budget.ts";
import { resolveRoleRuntimes } from "../src/model-runtime.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPTIONS = {
  "budget-mode": { type: "string", default: "tokens" },
  runtime: { type: "string", default: "codex" }, "meta-runtime": { type: "string" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" },
  "max-tokens-per-call": { type: "string", default: "30000" },
  families: { type: "string", default: "static" }, methods: { type: "string", default: "sheep" },
  groups: { type: "string", default: "1" }, workers: { type: "string", default: "4" }, concurrency: { type: "string", default: "2" },
  "max-tokens": { type: "string" }, "reserve-tokens": { type: "string" }, "max-calls": { type: "string", default: "100" },
  "max-meta-calls": { type: "string", default: "0" }, "timeout-ms": { type: "string", default: "120000" },
  output: { type: "string" },
};
function integer(value, label, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new RangeError(`${label} must be a safe integer >= ${minimum}`);
  return parsed;
}
function selection(value, allowed, label) {
  const items = value.split(",");
  if (!items.length || new Set(items).size !== items.length || items.some(item => !allowed.includes(item)))
    throw new Error(`Invalid or duplicate ${label}`);
  return items;
}
async function defaultRunChild(args, logPath) {
  const log = createWriteStream(logPath, { flags: "wx" });
  const logDone = finished(log); logDone.catch(() => {});
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let interrupted = null;
  const interrupt = signal => { interrupted = signal; child.kill(signal); };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    return await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => done(interrupted ?? code ?? signal));
      log.once("error", error => { child.kill("SIGTERM"); reject(error); });
    });
  } finally {
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    log.end(); await logDone;
  }
}

/** Sequential token admission, with a durable pending inventory and independent receipt metering. */
export async function runTokenSeries(argv, deps = {}) {
  const { values } = parseArgs({ args: argv, options: OPTIONS });
  if (values["budget-mode"] !== "tokens") throw new Error("Expected --budget-mode tokens");
  if (!values.output || values["max-tokens"] === undefined || values["reserve-tokens"] === undefined)
    throw new Error("--output, --max-tokens, and --reserve-tokens are required");
  const maxTokens = integer(values["max-tokens"], "max-tokens");
  const reserveTokens = integer(values["reserve-tokens"], "reserve-tokens", 1);
  const maxCalls = integer(values["max-calls"], "max-calls");
  const limits = Object.fromEntries(["groups", "workers", "concurrency", "max-tokens-per-call", "timeout-ms", "max-meta-calls"]
    .map(key => [key, integer(values[key], key, key === "max-meta-calls" ? 0 : 1)]));
  const profile = resolveRoleRuntimes({ runtime: values.runtime, metaRuntime: values["meta-runtime"],
    workerModel: values["worker-model"], metaModel: values["meta-model"], maxTokensPerCall: limits["max-tokens-per-call"] });
  const { runtime, metaRuntime } = profile;
  const families = selection(values.families, ["static", "semantic", "staged"], "families");
  const methods = selection(values.methods, ["sheep", "single-worker", "single-luna", "single-astra", "no-memory", "no-upper"], "methods");
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Never overwrite previous evidence.
  const report = { format: 1, kind: "mechanism-token-series", status: "running", stopReason: null,
    maxTokens, reserveTokensPerCall: reserveTokens, maxCalls, observedTokens: 0, calls: 0,
    usageComplete: true, runtime, metaRuntime, profile, limits, families, methods, runs: [], pending: null, failedAttempt: null };
  const persist = async () => {
    const file = join(output, "token-series.json");
    await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2) + "\n");
    await rename(`${file}.tmp`, file);
  };
  const stop = reason => { report.status = "stopped"; report.stopReason = reason; };
  await persist();
  outer: for (const family of families) for (const method of methods) {
    if (report.calls >= maxCalls) { stop("token-series-call-limit"); break outer; }
    const remaining = maxTokens - report.observedTokens;
    if (remaining < reserveTokens) { stop("token-series-admission-limit"); break outer; }
    const id = `${family}-${method}`, directory = join(output, id);
    const args = ["src/mechanism-cli.ts", "--family", family, "--method", method,
      ...Object.entries(limits).flatMap(([key, value]) => [`--${key}`, String(value)]),
      "--budget-mode", "tokens", "--max-tokens", String(remaining), "--reserve-tokens", String(reserveTokens),
      "--max-calls", String(maxCalls - report.calls), "--runtime", runtime, "--meta-runtime", metaRuntime,
      "--worker-model", profile.workerModel, "--meta-model", profile.metaModel, "--output", directory];
    report.pending = { id, family, method, args };
    report.usageComplete = false;
    await persist(); // The child cannot spend before its inventory exists.
    let exitCode = null, launchError = null;
    try { exitCode = await (deps.runChild ?? defaultRunChild)(args, join(output, `${id}.log`)); }
    catch (error) { launchError = String(error); }
    let result;
    try { result = JSON.parse(await readFile(join(directory, "result.json"), "utf8")); } catch { result = null; }
    let problem = null, auditedTokens = 0, callCount = 0, complete = true;
    if (!result) problem = exitCode !== 0 || launchError ? "subprocess-failed" : "missing-result";
    else if (result.format !== 1 || result.family !== family || result.method !== method) problem = "result-mismatch";
    else if (result.budget?.unit !== "tokens") problem = "missing-token-budget";
    else if (["runtime", "metaRuntime", "workerModel", "metaModel"].some(key => result.configuration?.[key] !== profile[key])) problem = "runtime-mismatch";
    else if (!Array.isArray(result.calls)) problem = "invalid-call-inventory";
    else {
      const seen = new Set();
      callCount = result.calls.length;
      for (const call of result.calls) {
        if (!call || typeof call.id !== "string" || !/^call-\d+$/.test(call.id) || seen.has(call.id)
          || !["worker", "meta", "single"].includes(call.role)) { problem ??= "invalid-call-inventory"; complete = false; continue; }
        seen.add(call.id);
        const upper = call.role === "meta" || (call.role === "single" && method === "single-astra");
        const expected = upper ? profile.metaModel : profile.workerModel;
        let receipt;
        try { receipt = JSON.parse(await readFile(join(directory, `${call.id}.json`), "utf8")); }
        catch { problem ??= "missing-receipt"; complete = false; continue; }
        if (call.model !== expected || (receipt.requestedModel ?? receipt.transcript?.requestedModel) !== expected) {
          problem ??= "model-conflict"; complete = false; continue;
        }
        const audit = new TokenBudget({ maxTokens: Number.MAX_SAFE_INTEGER, reserveTokensPerCall: 1 });
        audit.reserve(expected, call.id);
        const settlement = audit.settle(call.id, receipt);
        auditedTokens += audit.snapshot().observedTokens;
        if (settlement.tokens === null) { problem ??= "unknown-usage"; complete = false; }
      }
      if (!Number.isSafeInteger(auditedTokens + report.observedTokens)) { problem ??= "invalid-token-total"; complete = false; }
      if (result.budget.unknownUsageCalls !== 0 || result.budget.activeReservations !== 0) { problem ??= "unknown-usage"; complete = false; }
      if (complete && auditedTokens !== result.budget.observedTokens) problem ??= "forged-summary";
    }
    // Preserve known spend even if a child failed or its usage is only a lower bound.
    report.observedTokens += auditedTokens;
    report.calls += callCount;
    report.usageComplete = !!result && complete && !["result-mismatch", "missing-token-budget", "runtime-mismatch", "invalid-call-inventory"].includes(problem);
    problem ??= exitCode !== 0 || launchError || result?.success !== true ? "subprocess-failed" : null;
    if (report.observedTokens > maxTokens) problem ??= "token-series-overrun";
    if (report.calls > maxCalls) problem ??= "token-series-call-limit";
    const run = { id, family, method, observedTokens: auditedTokens, calls: callCount, success: !problem, exitCode };
    if (problem) { report.failedAttempt = { ...run, launchError }; stop(problem); }
    else report.runs.push(run);
    report.pending = null;
    await persist();
    if (problem) break outer;
  }
  if (report.status === "running") report.status = "completed";
  await persist();
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const report = await runTokenSeries(process.argv.slice(2));
  process.stdout.write(JSON.stringify({ status: report.status, stopReason: report.stopReason,
    observedTokens: report.observedTokens, calls: report.calls, runs: report.runs.length }) + "\n");
  if (report.status !== "completed") process.exitCode = 1;
}
