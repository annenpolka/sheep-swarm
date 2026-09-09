import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const { values } = parseArgs({ options: {
  source: { type: "string" }, output: { type: "string" }, pilot: { type: "string" },
} });
if (!values.source || !values.output || !values.pilot) throw new Error("--source, --output and --pilot are required");
const source = resolve(values.source), output = resolve(values.output), pilot = resolve(values.pilot);
const manifest = JSON.parse(await readFile(join(source, "source-manifest.json"), "utf8"));
const pilotManifest = JSON.parse(await readFile(join(pilot, "source-manifest.json"), "utf8"));
for (const [file, expected] of Object.entries(manifest)) {
  const actual = createHash("sha256").update(await readFile(join(source, file))).digest("hex");
  if (actual !== expected || pilotManifest.workingTreeFiles[file] !== actual) throw new Error(`source mismatch: ${file}`);
}
const pilotResult = JSON.parse(await readFile(join(pilot, "result.json"), "utf8"));
if (pilotResult.configuration.workers !== 16 || pilotResult.configuration.concurrency !== 16
  || pilotResult.configuration.size !== 32 || pilotResult.configuration.fault !== "none") throw new Error("pilot configuration mismatch");
await mkdir(output);
// The middle N=16,size=32 point is shared by the strong and weak scaling series.
// Each run is performed in isolation; alternating sizes reduces a simple time-order confound.
const conditions = [
  [16, 16, 32, "none", 1],
  [32, 32, 32, "none", 1], [8, 8, 32, "none", 1],
  [8, 8, 16, "none", 1], [32, 32, 64, "none", 1],
  [16, 16, 32, "none", 2], [32, 32, 32, "none", 2],
  [8, 8, 32, "none", 2], [32, 32, 64, "none", 2], [8, 8, 16, "none", 2],
  [8, 8, 32, "rounded-guidance", 1], [16, 16, 32, "rounded-guidance", 1], [32, 32, 32, "rounded-guidance", 1],
  [16, 8, 32, "none", 1], [32, 8, 32, "none", 1],
].map(([workers, concurrency, size, fault, replicate]) => ({ workers, concurrency, size, fault, replicate,
  id: `n${workers}-c${concurrency}-s${size}-${fault}-r${replicate}` }));
const receipt = { format: 1, startedAt: new Date().toISOString(), source, sourceManifest: manifest,
  reusedPilot: { path: pilot, id: "pilot-n16-c16-s32", purpose: "pretrial; excluded from matched series", sha256: createHash("sha256")
    .update(await readFile(join(pilot, "result.json"))).digest("hex") },
  conditions, runs: [] };
const save = () => writeFile(join(output, "experiment.json"), JSON.stringify(receipt, null, 2) + "\n");
await save();
for (const condition of conditions) {
  const destination = join(output, condition.id);
  const args = [join(source, "src/cli.ts"), "--workers", String(condition.workers), "--concurrency", String(condition.concurrency),
    "--size", String(condition.size), "--fault", condition.fault, "--output", destination,
    "--max-calls", String(condition.size * 3), "--max-meta-calls", "2", "--max-rounds", "20", "--timeout-ms", "90000"];
  const run = { ...condition, startedAt: new Date().toISOString(), destination, args, status: "running" };
  receipt.runs.push(run); await save();
  process.stdout.write(`START ${condition.id}\n`);
  let stdout = "", stderr = "";
  const child = spawn(process.execPath, args, { cwd: source, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const exitCode = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  run.exitCode = exitCode; run.finishedAt = new Date().toISOString(); run.status = exitCode === 0 ? "passed" : "failed";
  await writeFile(join(output, `${condition.id}.stdout.txt`), stdout);
  await writeFile(join(output, `${condition.id}.stderr.txt`), stderr);
  try {
    const bytes = await readFile(join(destination, "result.json"));
    run.resultSha256 = createHash("sha256").update(bytes).digest("hex");
    const result = JSON.parse(bytes);
    run.summary = { success: result.success, lowerCalls: result.lowerCalls, upperCalls: result.upperCalls,
      interventions: result.interventions, durationMs: result.durationMs, finalErrors: result.finalErrors };
  } catch (error) { run.resultError = String(error); }
  await save(); process.stdout.write(`END ${condition.id} ${JSON.stringify(run.summary ?? { exitCode })}\n`);
}
receipt.finishedAt = new Date().toISOString(); await save();
