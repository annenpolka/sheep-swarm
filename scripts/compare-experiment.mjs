import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const { values } = parseArgs({ options: { source: { type: "string" }, output: { type: "string" }, methods: { type: "string" } } });
if (!values.source || !values.output) throw new Error("--source and --output are required");
const source = resolve(values.source), output = resolve(values.output);
const methods = values.methods?.split(",") ?? ["manager-local", "sheep-fixed", "sheep-full"];
if (!methods.length || methods.some(method => !["single-upper", "manager-local", "sheep-fixed", "sheep-full"].includes(method))) throw new Error("unknown method filter");
const manifest = JSON.parse(await readFile(join(source, "source-manifest.json"), "utf8"));
const digest = value => createHash("sha256").update(value).digest("hex");
for (const [file, expected] of Object.entries(manifest))
  if (digest(await readFile(join(source, file))) !== expected) throw new Error(`source mismatch: ${file}`);
await mkdir(output);
const conditions = [
  ...["single-upper", "manager-local", "sheep-fixed", "sheep-full"].map(method => ({ method, fault: "none", replicate: 1 })),
  ...["sheep-full", "sheep-fixed", "manager-local", "single-upper"].map(method => ({ method, fault: "none", replicate: 2 })),
  ...["sheep-fixed", "single-upper", "sheep-full", "manager-local"].map(method => ({ method, fault: "rounded-guidance", replicate: 1 })),
].filter(condition => methods.includes(condition.method)).map(condition => ({ ...condition, id: `${condition.method}-${condition.fault}-r${condition.replicate}` }));
const receipt = { format: 1, startedAt: new Date().toISOString(), source, sourceManifest: manifest,
  common: { size: 8, workers: 4, concurrency: 4, maxCalls: 48, maxTokens: 500000, reserveTokens: 30000,
    timeoutMs: 90000, maxRounds: 24 }, conditions, runs: [] };
const save = () => writeFile(join(output, "experiment.json"), JSON.stringify(receipt, null, 2) + "\n");
await save();
const fingerprints = new Map();
for (const condition of conditions) {
  const destination = join(output, condition.id);
  const args = [join(source, "src/compare-cli.ts"), "--method", condition.method, "--fault", condition.fault,
    "--output", destination, "--size", "8", "--workers", "4", "--concurrency", "4",
    "--max-calls", "48", "--max-tokens", "500000", "--reserve-tokens", "30000", "--timeout-ms", "90000", "--max-rounds", "24"];
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
}
receipt.finishedAt = new Date().toISOString(); await save();
