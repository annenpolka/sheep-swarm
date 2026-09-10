import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { capture } from "../src/sandbox-process.ts";

test("comparison dispatch pins one tool profile, defaults to single Luna, and stops the series on unknown usage", async t => {
  const root = await mkdtemp(join(tmpdir(), "sheep-comparison-dispatch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"); await mkdir(join(source, "src"), { recursive: true });
  const stub = `import {mkdir,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2); const at=args.indexOf('--output'); const directory=args[at+1]; await mkdir(directory);
await writeFile(directory+'/result.json',JSON.stringify({success:false,qualityPass:false,fixtureFingerprint:'fixed-synthetic',lowerCalls:1,upperCalls:0,budget:{unknownUsageCalls:1},finalErrors:['token-usage-incomplete']}));
await writeFile(directory+'/args.json',JSON.stringify(args));
process.exitCode=1;`;
  await writeFile(join(source, "src/compare-cli.ts"), stub);
  await writeFile(join(source, "source-manifest.json"), JSON.stringify({ "src/compare-cli.ts": createHash("sha256").update(stub).digest("hex") }));
  const output = join(root, "experiment");
  const ran = await capture(process.execPath, [resolve("scripts/compare-experiment.mjs"), "--source", source, "--output", output,
    "--runtime", "docker-agent", "--worker-tools", "local"], { timeoutMs: 5000 });
  assert.equal(ran.exitCode, 1, ran.stderr);
  const report = JSON.parse(await readFile(join(output, "experiment.json"), "utf8"));
  assert.equal(report.runs.length, 1); assert.equal(report.runs[0].method, "single-luna");
  assert.equal(report.conditions.length, 12); assert.ok(report.conditions.every((row: { method: string }) => row.method !== "single-upper"));
  assert.equal(report.common.runtime, "docker-agent"); assert.equal(report.common.workerTools, "local");
  assert.ok(report.stoppedReason);
  const args: string[] = JSON.parse(await readFile(join(report.runs[0].destination, "args.json"), "utf8"));
  assert.equal(args[args.indexOf("--runtime") + 1], "docker-agent");
  assert.equal(args[args.indexOf("--worker-tools") + 1], "local");
});
