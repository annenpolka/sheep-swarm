import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { unknownUsageForRun } from "../src/model-runtime.ts";

test("timeout, cancel and ambiguous multi-row counters are never a final total", () => {
  const row = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
  assert.equal(unknownUsageForRun({ usage: [row], timedOut: false, cancelled: false }, "codex", true), false);
  assert.equal(unknownUsageForRun({ usage: [row], timedOut: true }, "codex", true), true);
  assert.equal(unknownUsageForRun({ usage: [row], cancelled: true }, "codex", true), true);
  assert.equal(unknownUsageForRun({ usage: [row, row] }, "codex", true), true);
  assert.equal(unknownUsageForRun({ usage: [row], exitCode: null }, "codex", true), false);
  // An API adapter's complete marker cannot erase explicit timeout/cancel facts.
  assert.equal(unknownUsageForRun({ usageCompleteness: "complete", timedOut: true }, "deepseek", true), true);
  assert.equal(unknownUsageForRun({ usageCompleteness: "complete", cancelled: true }, "opencode-go", true), true);
  assert.equal(unknownUsageForRun({ usageCompleteness: "complete", timedOut: true }, "deepseek", false), false);
});

async function seriesRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-review-scale-followup-"));
  await mkdir(root + "/source/src", { recursive: true });
  await mkdir(root + "/pilot");
  await writeFile(root + "/source/source-manifest.json", "{}");
  await writeFile(root + "/pilot/source-manifest.json", '{"workingTreeFiles":{}}');
  await writeFile(root + "/pilot/result.json", JSON.stringify({ configuration: { workers: 16, concurrency: 16, size: 32, fault: "none" } }));
  return root;
}

function runSeries(root: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/scale-experiment.mjs", import.meta.url)),
    "--source", root + "/source", "--pilot", root + "/pilot", "--output", root + "/series",
    "--runtime", "deepseek", "--worker-model", "deepseek-flash"], { encoding: "utf8" });
}

test("scale continues across well-shaped known-usage semantic failures", async () => {
  const root = await seriesRoot();
  await writeFile(root + "/source/src/cli.ts", `import {mkdir,writeFile} from 'node:fs/promises';const out=process.argv[process.argv.indexOf('--output')+1];await mkdir(out);await writeFile(out+'/result.json',JSON.stringify({success:false,finalErrors:['semantic-failure'],lowerCalls:1,upperCalls:0,calls:[{usageCompleteness:'complete',inputTokens:10,outputTokens:2}]}));process.exitCode=0;`);
  const child = runSeries(root);
  assert.equal(child.status, 0);
  const report = JSON.parse(await readFile(root + "/series/experiment.json", "utf8"));
  assert.equal(report.runs.length, 15, JSON.stringify(report.runs.length));
});

test("scale stops on well-shaped unknown usage even when the child exits zero", async () => {
  const root = await seriesRoot();
  await writeFile(root + "/source/src/cli.ts", `import {mkdir,writeFile} from 'node:fs/promises';const out=process.argv[process.argv.indexOf('--output')+1];await mkdir(out);await writeFile(out+'/result.json',JSON.stringify({success:false,finalErrors:['unknown-usage'],lowerCalls:1,upperCalls:0,calls:[{usageCompleteness:'partial-or-unknown'}]}));process.exitCode=0;`);
  const child = runSeries(root);
  assert.notEqual(child.status, 0);
  const report = JSON.parse(await readFile(root + "/series/experiment.json", "utf8"));
  assert.equal(report.runs.length, 1);
  assert.equal(report.stoppedReason, "failed-or-invalid-child-result");
  assert.equal(report.runs[0].summary.observedInputTokens, 0);
});
