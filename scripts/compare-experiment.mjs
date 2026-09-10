import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" }, methods: { type: "string" },
  runtime: { type: "string", default: "codex" }, "meta-runtime": { type: "string" }, "worker-tools": { type: "string", default: "none" },
  "worker-model": { type: "string" }, "meta-model": { type: "string" }, "max-tokens-per-call": { type: "string" } } });
if (!values.source || !values.output) throw new Error("--source and --output are required");
const source = resolve(values.source), output = resolve(values.output);
const methods = values.methods?.split(",") ?? ["single-luna", "manager-local", "sheep-fixed", "sheep-full"];
if (!methods.length || methods.some(method => !["single-luna", "single-worker", "single-upper", "manager-local", "sheep-fixed", "sheep-full"].includes(method))) throw new Error("unknown method filter");
if (!["codex", "docker-agent", "deepseek", "opencode-go"].includes(values.runtime) || !["none", "local"].includes(values["worker-tools"])) throw new Error("unknown runtime/tool profile");
if (values["worker-tools"] === "local" && values.runtime !== "docker-agent") throw new Error("Local tools require Docker Agent");
if ((values.runtime === "deepseek" || values.runtime === "opencode-go") && !values["worker-model"]) throw new Error("API runtimes require an explicit --worker-model");
if (values.runtime === "docker-agent" && methods.includes("single-upper")) throw new Error("New Docker standalone trials use single-luna");
const manifest = JSON.parse(await readFile(join(source, "source-manifest.json"), "utf8"));
const digest = value => createHash("sha256").update(value).digest("hex");
for (const [file, expected] of Object.entries(manifest))
  if (digest(await readFile(join(source, file))) !== expected) throw new Error(`source mismatch: ${file}`);
await mkdir(output);
const conditions = [
  ...["single-luna", "single-upper", "manager-local", "sheep-fixed", "sheep-full"].map(method => ({ method, fault: "none", replicate: 1 })),
  ...["sheep-full", "sheep-fixed", "manager-local", "single-luna", "single-upper"].map(method => ({ method, fault: "none", replicate: 2 })),
  ...["sheep-fixed", "single-luna", "single-upper", "sheep-full", "manager-local"].map(method => ({ method, fault: "rounded-guidance", replicate: 1 })),
].filter(condition => methods.includes(condition.method)).map(condition => ({ ...condition, id: `${condition.method}-${condition.fault}-r${condition.replicate}` }));
const receipt = { format: 1, startedAt: new Date().toISOString(), source, sourceManifest: manifest,
  common: { size: 8, workers: 4, concurrency: 4, maxCalls: 48, maxTokens: 500000, reserveTokens: 30000,
    timeoutMs: values["worker-tools"] === "local" ? 240000 : 90000, maxRounds: 24,
    runtime: values.runtime, metaRuntime: values["meta-runtime"] ?? (["deepseek", "opencode-go"].includes(values.runtime) ? "codex" : values.runtime),
    workerModel: values["worker-model"] ?? "gpt-5.6-luna", metaModel: values["meta-model"] ?? "gpt-6-astra",
    maxTokensPerCall: values["max-tokens-per-call"] === undefined ? 30000 : Number(values["max-tokens-per-call"]),
    workerTools: values["worker-tools"] }, conditions, runs: [] };
const save = () => writeFile(join(output, "experiment.json"), JSON.stringify(receipt, null, 2) + "\n");
await save();
const fingerprints = new Map();
for (const condition of conditions) {
  const destination = join(output, condition.id);
  const args = [join(source, "src/compare-cli.ts"), "--method", condition.method, "--fault", condition.fault,
    "--output", destination, "--size", "8", "--workers", "4", "--concurrency", "4",
    "--max-calls", "48", "--max-tokens", "500000", "--reserve-tokens", "30000", "--timeout-ms", String(receipt.common.timeoutMs), "--max-rounds", "24",
    ...(values.runtime === "codex" ? [] : ["--runtime", values.runtime]),
    ...(values["meta-runtime"] === undefined ? [] : ["--meta-runtime", values["meta-runtime"]]),
    ...(values["worker-model"] === undefined ? [] : ["--worker-model", values["worker-model"]]),
    ...(values["meta-model"] === undefined ? [] : ["--meta-model", values["meta-model"]]),
    ...(values["max-tokens-per-call"] === undefined ? [] : ["--max-tokens-per-call", values["max-tokens-per-call"]]),
    ...(values["worker-tools"] === "local" ? ["--worker-tools", values["worker-tools"]] : [])];
  const run = { ...condition, destination, args, startedAt: new Date().toISOString(), status: "running" };
  receipt.runs.push(run); await save(); process.stdout.write(`START ${condition.id}\n`);
  let stdout = "", stderr = "";
  const child = spawn(process.execPath, args, { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const exitCode = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  run.exitCode = exitCode; run.finishedAt = new Date().toISOString(); run.status = exitCode === 0 ? "passed" : "failed";
  await writeFile(join(output, `${condition.id}.stdout.txt`), stdout);
  await writeFile(join(output, `${condition.id}.stderr.txt`), stderr);
  try {
    const bytes = await readFile(join(destination, "result.json")), result = JSON.parse(bytes);
    run.resultSha256 = digest(bytes);
    run.summary = { success: result.success, qualityPass: result.qualityPass, lowerCalls: result.lowerCalls,
      upperCalls: result.upperCalls, interventions: result.interventions, retries: result.retries,
      budget: result.budget, discovery: result.discovery, times: result.times, finalErrors: result.finalErrors };
    if (fingerprints.has(condition.fault) && fingerprints.get(condition.fault) !== result.fixtureFingerprint)
      throw new Error("fixture differs between comparison methods");
    fingerprints.set(condition.fault, result.fixtureFingerprint);
  } catch (error) { run.resultError = String(error); }
  await save(); process.stdout.write(`END ${condition.id} ${JSON.stringify(run.summary ?? { exitCode })}\n`);
  if (run.resultError || !run.summary || run.summary.budget?.unknownUsageCalls > 0
    || run.summary.finalErrors?.some(error => ["verification-unavailable", "sandbox-cleanup-failed"].includes(error))) {
    receipt.stoppedReason = "missing-or-untrusted-result-or-unknown-usage";
    await save(); process.exitCode = 1; break;
  }
}
receipt.finishedAt = new Date().toISOString(); await save();
