import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { summarizeTools } from "./lib/docker-tool-summary.mjs";
import { summarizeProgress } from "./lib/mechanism-progress.mjs";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/summarize-docker-mechanism.mjs PATH_TO_RESULT_JSON");
const source = resolve(process.argv[2]), bytes = await readFile(source), report = JSON.parse(bytes);
const progress = summarizeProgress(report), calls = [];
for (const call of report.calls) {
  if (typeof call.id !== "string" || !/^call-\d+$/.test(call.id)) throw new Error("Invalid receipt ID");
  const receiptBytes = await readFile(join(dirname(source), `${call.id}.json`));
  const receipt = JSON.parse(receiptBytes), transcript = receipt.transcript;
  calls.push({ id: call.id, target: call.target, outcome: call.outcome, model: call.model,
    sha256: createHash("sha256").update(receiptBytes).digest("hex"),
    usageCompleteness: transcript?.usageCompleteness ?? null, cleanupSucceeded: transcript?.cleanupSucceeded ?? null,
    tools: Array.isArray(transcript?.events) ? summarizeTools(transcript.events) : null });
}
console.log(JSON.stringify({ source, sourceSha256: createHash("sha256").update(bytes).digest("hex"), progress, calls,
  evidenceNote: "Summarizes saved reports and events; does not replace kernel acceptance or reconstruct missing usage." }, null, 2));
