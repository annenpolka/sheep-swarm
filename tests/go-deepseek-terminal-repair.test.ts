import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCodex } from "../src/codex-worker.ts";
import { runDurableSwarm, type DurableModelCaller } from "../src/durable-run.ts";
import { unknownUsageForRun } from "../src/model-runtime.ts";

const counted = { usage: [{ inputTokens: 10, outputTokens: 2, totalTokens: 12 }] };

test("incomplete terminal codes lock while ordinary metered failures keep their semantics", () => {
  for (const code of ["spawn-failed", "output-too-large", "malformed-events", "timeout", "cancelled", "nonzero-exit"])
    assert.equal(unknownUsageForRun(counted, "codex", true, code), true, code);
  for (const code of ["missing-output", "malformed-output"])
    assert.equal(unknownUsageForRun(counted, "codex", true, code), false, code);
  assert.equal(unknownUsageForRun(counted, "codex", true), false);
  assert.equal(unknownUsageForRun(counted, "codex", false, "malformed-events"), false);
  assert.equal(unknownUsageForRun({ ...counted, timedOut: true }, "codex", false), false);
});

async function fakeCodexBin(root: string): Promise<string> {
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "codex"),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({type:'usage',input_tokens:10,output_tokens:2,total_tokens:12})+'\\n{"type":"turn.comp');`,
    { mode: 0o755 });
  return join(root, "bin");
}

async function withFakePath<T>(bin: string, action: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = bin + ":" + saved;
  try { return await action(); } finally { process.env.PATH = saved; }
}

function malformedCaller(roles: string[]): DurableModelCaller {
  return async options => {
    const role = options.model === "deepseek-flash" ? "worker" : "meta";
    roles.push(role);
    if (role === "meta") return callCodex<{ content: string; note: string }>(options);
    const usage = [{ event: {}, inputTokens: 10, outputTokens: 2, totalTokens: 12 }];
    const transcript: any = { requestedModel: options.model, effectiveModelEvidence: options.model, events: [], usage,
      stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
      runtime: "deepseek", usageCompleteness: "complete" };
    return { result: { content: "invalid", note: "failure for intervention" }, requestedModel: options.model, usage, transcript };
  };
}

test("durable malformed terminal retains counted lower bounds and stops the run", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-terminal-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = await fakeCodexBin(root);
  const roles: string[] = [];
  const report = await withFakePath(bin, () => runDurableSwarm({ directory: join(root, "run"), runtime: "deepseek",
    workerModel: "deepseek-flash", size: 2, workers: 1, maxCalls: 6, maxMetaCalls: 1 }, malformedCaller(roles)));
  assert.equal(roles.length, roles.indexOf("meta") + 1, JSON.stringify(roles));
  assert.equal(report.success, false);
  assert.ok(report.finalErrors.includes("token-usage-incomplete"), report.finalErrors.join("\n"));
  const meta = report.calls.find(call => call.role === "meta")!;
  assert.equal(meta.inputTokens, 10);
  assert.equal(meta.outputTokens, 2);
});

test("durable malformed terminal stays locked across resume with zero new calls", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-terminal-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = await fakeCodexBin(root);
  const directory = join(root, "run");
  const roles: string[] = [];
  await withFakePath(bin, () => assert.rejects(runDurableSwarm({ directory, runtime: "deepseek",
    workerModel: "deepseek-flash", size: 2, workers: 1, maxCalls: 6, maxMetaCalls: 1,
    checkpoint: async (name, details) => {
      if (name === "after-call" && details.role === "meta") throw new Error("paused after malformed receipt");
    } }, malformedCaller(roles)), /paused after malformed receipt/));
  let resumed = 0;
  const report = await runDurableSwarm({ directory, resume: true }, async () => {
    resumed++;
    throw new Error("locked run spent again");
  });
  assert.equal(resumed, 0);
  assert.equal(report.success, false);
  const meta = report.calls.find(call => call.role === "meta")!;
  assert.equal(meta.inputTokens, 10);
  assert.equal(meta.outputTokens, 2);
});
