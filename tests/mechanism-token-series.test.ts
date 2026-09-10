import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTokenSeries } from "../scripts/mechanism-token-experiment.mjs";

async function root(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sheep-token-series-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "run");
}
const WORKER_MODEL = "m";
function child(options: { failCondition?: string; unknownUsage?: boolean; skipReceipt?: boolean; exit?: number } = {}) {
  return async (args: string[], _logPath: string) => {
    const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
    const family = get("--family")!, method = get("--method")!, directory = get("--output")!;
    const id = `${family}-${method}`;
    if (options.failCondition === id) return options.exit ?? 1;
    await mkdir(directory, { recursive: true });
    const calls = [{ id: "call-1", role: "worker", model: WORKER_MODEL, tokens: 10 }];
    if (!options.skipReceipt) await writeFile(join(directory, "call-1.json"), JSON.stringify({ requestedModel: WORKER_MODEL,
      transcript: { runtime: "deepseek", requestedModel: WORKER_MODEL, effectiveModelEvidence: "alias", httpStatus: 200,
        usageCompleteness: "complete", rawUsage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10,
          prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 8 } } }));
    const result = { format: 1, family, method, success: true,
      budget: { unit: "tokens", observedTokens: options.unknownUsage ? 0 : 10, unknownUsageCalls: options.unknownUsage ? 1 : 0, activeReservations: 0 },
      configuration: { runtime: "deepseek", metaRuntime: "codex", workerModel: WORKER_MODEL, metaModel: "gpt-6-astra" }, calls };
    await writeFile(join(directory, "result.json"), JSON.stringify(result));
    return options.exit ?? 0;
  };
}
const argv = (output: string, extra: string[] = []) => ["--runtime", "deepseek", "--worker-model", WORKER_MODEL, "--output", output, "--max-tokens", "100", "--reserve-tokens", "5", ...extra];

test("token series completes sequential conditions under the aggregate budget", async t => {
  const output = await root(t);
  const report = await runTokenSeries(argv(output, ["--families", "static", "--methods", "sheep,single-worker"]), { runChild: child() });
  assert.equal(report.status, "completed");
  assert.equal(report.runs.length, 2);
  assert.equal(report.observedTokens, 20);
  const written = JSON.parse(await readFile(join(output, "token-series.json"), "utf8"));
  assert.equal(written.status, "completed");
});

test("token series stops on unknown usage before the next condition", async t => {
  const output = await root(t);
  const report = await runTokenSeries(argv(output, ["--families", "static,semantic", "--methods", "sheep"]), { runChild: child({ unknownUsage: true }) });
  assert.equal(report.status, "stopped");
  assert.equal(report.stopReason, "unknown-usage");
  assert.equal(report.runs.length, 0);
});

test("token series stops on a missing receipt", async t => {
  const output = await root(t);
  const report = await runTokenSeries(argv(output), { runChild: child({ skipReceipt: true }) });
  assert.equal(report.stopReason, "missing-receipt");
});

test("token series stops on a nonzero child exit", async t => {
  const output = await root(t);
  const report = await runTokenSeries(argv(output), { runChild: child({ failCondition: "static-sheep", exit: 3 }) });
  assert.equal(report.stopReason, "subprocess-failed");
});

test("token series refuses a condition it cannot reserve", async t => {
  const output = await root(t);
  const report = await runTokenSeries(["--output", output, "--max-tokens", "4", "--reserve-tokens", "5"], { runChild: child() });
  assert.equal(report.stopReason, "token-series-admission-limit");
  assert.equal(report.runs.length, 0);
});
