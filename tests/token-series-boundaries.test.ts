import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runTokenSeries } from "../scripts/mechanism-token-experiment.mjs";

async function output(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "token-series-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true })); return join(root, "run");
}
const argv = (path: string, extra: string[] = []) => ["--output", path, "--runtime", "deepseek", "--worker-model", "m",
  "--max-tokens", "1000", "--reserve-tokens", "100", "--groups", "1", "--workers", "1", "--concurrency", "1", ...extra];
function child(mode: "normal" | "missing-usage" | "forged-summary", calls: string[][]) {
  return async (args: string[]) => {
    calls.push(args);
    const get = (flag: string) => args[args.indexOf(flag) + 1]!;
    const dir = get("--output"); await mkdir(dir);
    const metering = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 };
    const usage = mode === "missing-usage" ? undefined : metering;
    await writeFile(join(dir, "call-1.json"), JSON.stringify({ requestedModel: "m", transcript: {
      runtime: "deepseek", requestedModel: "m", effectiveModelEvidence: "alias", httpStatus: 200,
      rawUsage: usage, usageCompleteness: mode === "missing-usage" ? "partial-or-unknown" : "complete" } }));
    const result = { format: 1, family: get("--family"), method: get("--method"), success: true,
      configuration: { runtime: "deepseek", metaRuntime: get("--meta-runtime"), workerModel: "m", metaModel: "gpt-6-astra",
        budgetMode: "tokens", maxTokens: Number(get("--max-tokens")), reserveTokensPerCall: Number(get("--reserve-tokens")) },
      calls: [{ id: "call-1", role: "worker", model: "m", tokens: 12 }],
      budget: { unit: "tokens", observedTokens: mode === "forged-summary" ? 0 : 12, reservedTokens: 0,
        maxTokens: Number(get("--max-tokens")), unknownUsageCalls: 0, activeReservations: 0,
        settledCalls: 1, exceeded: false, locked: false } };
    await writeFile(join(dir, "result.json"), JSON.stringify(result)); return 0;
  };
}

test("public mechanism dispatcher routes explicit token budget before launching a child", async t => {
  const path = await output(t);
  const child = spawnSync(process.execPath, ["scripts/mechanism-experiment.mjs", "--budget-mode", "tokens",
    ...argv(path, ["--max-tokens", "4", "--reserve-tokens", "5"])], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(child.status, 1);
  const report = JSON.parse(await readFile(join(path, "token-series.json"), "utf8"));
  assert.equal(report.status, "stopped"); assert.equal(report.runs.length, 0);
});

test("token series retains the Codex upper default for DeepSeek workers", async t => {
  const calls: string[][] = [];
  await runTokenSeries(argv(await output(t)), { runChild: child("normal", calls) });
  assert.equal(calls[0]![calls[0]!.indexOf("--meta-runtime") + 1], "codex");
});

for (const mode of ["missing-usage", "forged-summary"] as const) {
  test(`token series audits receipts before admitting the next condition: ${mode}`, async t => {
    const calls: string[][] = [];
    const report = await runTokenSeries(argv(await output(t), ["--methods", "sheep,single-worker"]), { runChild: child(mode, calls) });
    assert.equal(report.status, "stopped"); assert.equal(calls.length, 1);
  });
}

test("token series refuses to reuse an existing output directory", async t => {
  const path = await output(t); await mkdir(path); await writeFile(join(path, "token-series.json"), "preserved");
  const calls: string[][] = [];
  await assert.rejects(runTokenSeries(argv(path), { runChild: child("normal", calls) }));
  assert.equal(calls.length, 0); assert.equal(await readFile(join(path, "token-series.json"), "utf8"), "preserved");
});

test("token series consumes its total call cap before considering the next condition", async t => {
  const calls: string[][] = [];
  const report = await runTokenSeries(argv(await output(t), ["--methods", "sheep,single-worker", "--max-calls", "1"]), { runChild: child("normal", calls) });
  assert.equal(report.status, "stopped"); assert.equal(calls.length, 1);
});

test("token series saves pending execution evidence before the child can spend", async t => {
  const path = await output(t), calls: string[][] = [];
  let pendingSeen = false;
  const run = child("normal", calls);
  await runTokenSeries(argv(path), { runChild: async (args: string[]) => {
    try {
      const text = await readFile(join(path, "token-series.json"), "utf8");
      pendingSeen = JSON.parse(text).status !== "completed" && text.includes("static-sheep");
    } catch { /* A missing pending receipt is precisely the failure being tested. */ }
    return run(args);
  } });
  assert.equal(pendingSeen, true);
});

 test("public dispatcher accepts the equals spelling of the budget flag", async t => {
  const path = await output(t);
  const run = spawnSync(process.execPath, ["scripts/mechanism-experiment.mjs", "--budget-mode=tokens",
    ...argv(path, ["--max-tokens", "4", "--reserve-tokens", "5"])], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(await readFile(join(path, "token-series.json"), "utf8")).stopReason, "token-series-admission-limit");
});
 test("a failed child retains its observed spend and stops the next condition", async t => {
  const calls: string[][] = [], run = child("normal", calls);
  const report = await runTokenSeries(argv(await output(t), ["--methods", "sheep,single-worker"]), {
    runChild: async args => { await run(args); return 2; },
  });
  assert.equal(report.status, "stopped"); assert.equal(report.observedTokens, 12);
  assert.equal(report.failedAttempt?.calls, 1); assert.equal(calls.length, 1);
});
 test("a launch error is recorded as incomplete usage without retry", async t => {
  const path = await output(t);
  const report = await runTokenSeries(argv(path), { runChild: async () => { throw new Error("cannot spawn"); } });
  assert.equal(report.status, "stopped"); assert.equal(report.usageComplete, false);
  assert.equal(report.failedAttempt?.id, "static-sheep"); assert.equal(report.pending, null);
  assert.equal(JSON.parse(await readFile(join(path, "token-series.json"), "utf8")).status, "stopped");
});
