import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseRateCard, extractTokenUsage, estimateCallCost, estimateTokenCost, estimatePlannedUsage,
  sumCostIntervals, type TokenRates } from "../src/cost-estimate.ts";

const rates: TokenRates = { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 };
const cardData = { format: 1, usdPerCredit: null, models: {
  upper: { apiUsdPerMillion: rates, codexCreditsPerMillion: { input: 250, cachedInput: 25, cacheWrite: null, output: 1250 } },
} };
const card = parseRateCard(cardData);
function receipt(usage: Record<string, unknown>, events: unknown[] = []) {
  return { transcript: { requestedModel: "upper", effectiveModelEvidence: null,
    events: [...events, { type: "turn.completed", usage }],
    usage: [{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }],
    stdout: "PRIVATE TRANSCRIPT", outputLastMessage: "PRIVATE OUTPUT" } };
}
function known(overrides: Record<string, unknown> = {}) {
  return extractTokenUsage(receipt({ input_tokens: 20_000, cached_input_tokens: 15_000, cache_write_input_tokens: 0,
    output_tokens: 250, reasoning_output_tokens: 100, ...overrides }));
}
function near(value: number, expected: number) { assert.ok(Math.abs(value - expected) < 1e-10, `${value} != ${expected}`); }

test("cached input and reasoning are subsets, not additional billed tokens", () => {
  const cost = estimateCallCost(known(), "upper", card);
  near(cost.apiUsd.lower, 0.0775);
  near(cost.codexCredits.lower, 1.9375);
  assert.equal(cost.apiUsd.exact, true);
  assert.equal(cost.codexUsdAtAssumedCreditPrice, null);
});

test("terminal usage wins over progress updates and normalized receipt copies", () => {
  const data = receipt({ input_tokens: 100, cached_input_tokens: 50, cache_write_input_tokens: 0, output_tokens: 10 },
    [{ type: "usage", input_tokens: 80, output_tokens: 8 }]);
  const usage = extractTokenUsage(data);
  assert.equal(usage.source, "turn.completed");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 10);
});

test("multiple terminal usage events are ambiguous and never blindly summed", () => {
  const usage = extractTokenUsage(receipt({ input_tokens: 200, output_tokens: 20 },
    [{ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } }]));
  assert.equal(usage.source, "ambiguous");
  const cost = estimateTokenCost(usage, rates, "API");
  assert.equal(cost.upper, null);
  assert.equal(cost.exact, false);
});

test("normalized fallback recovers cache fields retained inside the original event", () => {
  const usage = extractTokenUsage({ transcript: { usage: [{ inputTokens: 100, outputTokens: 20,
    event: { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20 } } }] } });
  assert.equal(usage.source, "normalized");
  assert.equal(usage.cachedInputTokens, 80);
});

test("missing cached count bounds all-cached through all-uncached, not zero cache", () => {
  const usage = extractTokenUsage(receipt({ input_tokens: 100_000, cache_write_input_tokens: 0, output_tokens: 0 }));
  const cost = estimateTokenCost(usage, rates, "API");
  near(cost.lower, 0.1);
  near(cost.upper!, 1);
  assert.equal(cost.exact, false);
});

test("unknown cache creation includes its higher rate and unknown credit upper bound", () => {
  const usage = extractTokenUsage(receipt({ input_tokens: 100_000, cached_input_tokens: 40_000, output_tokens: 0 }));
  const cost = estimateCallCost(usage, "upper", card);
  near(cost.apiUsd.lower, 0.64);
  near(cost.apiUsd.upper!, 0.79);
  assert.equal(cost.codexCredits.upper, null);
  assert.ok(cost.codexCredits.unknownReasons.length);
});

test("explicit zero cache writes require no cache-write price; positive writes do", () => {
  assert.equal(estimateCallCost(known(), "upper", card).codexCredits.exact, true);
  const cost = estimateCallCost(known({ cache_write_input_tokens: 1000 }), "upper", card);
  near(cost.apiUsd.lower, 0.08);
  assert.equal(cost.codexCredits.upper, null);
});

test("missing usage or missing model prices produce unknown bounds", () => {
  const missing = estimateCallCost(extractTokenUsage(null), "upper", card);
  assert.equal(missing.apiUsd.upper, null);
  assert.equal(missing.apiUsd.exact, false);
  const unknownModel = estimateCallCost(known(), "unknown", card);
  assert.equal(unknownModel.apiUsd.upper, null);
  const partial = estimateCallCost(known({ output_tokens: -1 }), "upper", card);
  near(partial.apiUsd.lower, 0.065);
  assert.equal(partial.apiUsd.upper, null);
});

test("impossible cache partitions and reasoning totals cannot yield plausible prices", () => {
  for (const usage of [known({ cached_input_tokens: 20_001 }), known({ cache_write_input_tokens: 6000 }), known({ reasoning_output_tokens: 251 })]) {
    const cost = estimateCallCost(usage, "upper", card);
    assert.equal(cost.apiUsd.upper, null);
    assert.ok(cost.apiUsd.unknownReasons.some(reason => reason.startsWith("Invalid ")));
  }
});

test("rate validation requires explicit unknowns and rejects nonsensical prices", () => {
  for (const bad of [undefined, {}, { ...cardData, usdPerCredit: -1 },
    { ...cardData, models: { upper: { apiUsdPerMillion: { ...rates, input: Number.NaN }, codexCreditsPerMillion: null } } },
    { ...cardData, models: { upper: { apiUsdPerMillion: { input: 1, output: 2 }, codexCreditsPerMillion: null } } }]) {
    assert.throws(() => parseRateCard(bad));
  }
  const nullModel = parseRateCard({ format: 1, usdPerCredit: null, models: { upper: { apiUsdPerMillion: null, codexCreditsPerMillion: null } } });
  assert.equal(estimateCallCost(known(), "upper", nullModel).apiUsd.upper, null);
});

test("forecast counts calls without inferring long-context tier from their aggregate", () => {
  const result = estimatePlannedUsage({ model: "upper", calls: 100, inputTokensPerCall: 20_000,
    cachedInputTokensPerCall: 15_000, cacheWriteInputTokensPerCall: 0, outputTokensPerCall: 250 }, card);
  near(result.total.apiUsd.lower, 7.75);
  near(result.total.codexCredits.lower, 193.75);
  const converted = estimateCallCost(known(), "upper", parseRateCard({ ...cardData, usdPerCredit: 0.04 }));
  near(converted.codexUsdAtAssumedCreditPrice!.lower, 0.0775);
  assert.throws(() => estimatePlannedUsage({ model: "upper", calls: 0 }, card));
  assert.throws(() => estimatePlannedUsage({ model: "upper", calls: 1, inputTokensPerCall: 10,
    cachedInputTokensPerCall: 11, cacheWriteInputTokensPerCall: 0, outputTokensPerCall: 1 }, card));
});

test("known work stays in the lower subtotal when another call has unknown usage", () => {
  const cost = sumCostIntervals([estimateCallCost(known(), "upper", card).apiUsd,
    estimateCallCost(extractTokenUsage(null), "upper", card).apiUsd]);
  near(cost.lower, 0.0775);
  assert.equal(cost.upper, null);
});

test("CLI counts retries once, separates preliminary work, retains hashes, and records missing calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "sheep-cost-estimate-"));
  try {
    const run = join(root, "luna-4-initial"), prelim = join(root, "comparison-v1", "trial");
    await mkdir(run, { recursive: true }); await mkdir(prelim, { recursive: true });
    const raw = JSON.stringify(receipt({ input_tokens: 20_000, cached_input_tokens: 15_000, cache_write_input_tokens: 0, output_tokens: 250 }));
    await writeFile(join(run, "call-1.json"), raw);
    await writeFile(join(run, "call-2.json"), raw); // A second real call can have identical content: do not deduplicate by hash.
    await writeFile(join(run, "result.json"), JSON.stringify({ configuration: { workers: 4, prompt: "PRIVATE CONFIG", cwd: root },
      method: { private: "PRIVATE METHOD" }, success: { private: "PRIVATE SUCCESS" }, calls: [{ id: "call-1", model: "upper", outcome: "rejected" },
      { id: "call-2", model: "upper", outcome: "committed" }, { id: "call-3", model: "upper", status: "unknown" }] }));
    await writeFile(join(prelim, "compare-call-1.json"), raw);
    await mkdir(join(run, "transcripts")); await writeFile(join(run, "transcripts", "call-99.json"), raw);
    await writeFile(join(root, "rates.json"), JSON.stringify(cardData));
    const output = join(root, "estimate.json");
    const child = spawnSync(process.execPath, ["scripts/estimate-costs.mjs", "--rates", join(root, "rates.json"), "--root", root, "--output", output], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const bytes = await readFile(output, "utf8"), report = JSON.parse(bytes);
    assert.equal(report.total.calls, 4);
    assert.equal(report.total.receiptMissingCalls, 1);
    assert.equal(report.byFamily.find((row: { family: string }) => row.family === "m2-normal").calls, 3);
    assert.equal(report.byFamily.find((row: { family: string }) => row.family === "m5-preliminary").calls, 1);
    near(report.total.apiUsd.lower, 0.2325);
    assert.equal(report.total.apiUsd.upper, null);
    assert.equal(report.calls.find((row: { callId: string }) => row.callId === "call-1").sha256, createHash("sha256").update(raw).digest("hex"));
    assert.ok(!bytes.includes("PRIVATE"));
    assert.ok(!bytes.includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI rejects nonexistent, empty, missing declared run, and changed result inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sheep-cost-provenance-"));
  try {
    const ratePath = join(root, "rates.json"); await writeFile(ratePath, JSON.stringify(cardData));
    const invoke = (scanRoot: string) => spawnSync(process.execPath, ["scripts/estimate-costs.mjs", "--rates", ratePath,
      "--root", scanRoot, "--output", join(root, "estimate.json")], { encoding: "utf8" });
    assert.notEqual(invoke(join(root, "nonexistent")).status, 0);
    assert.notEqual(invoke(root).status, 0);
    const family = join(root, "comparison-v2"); await mkdir(family);
    await writeFile(join(family, "experiment.json"), JSON.stringify({ runs: [{ id: "run-1", resultSha256: "a".repeat(64) }] }));
    assert.notEqual(invoke(root).status, 0);
    await mkdir(join(family, "run-1")); await writeFile(join(family, "run-1", "result.json"), "{}");
    assert.match(invoke(root).stderr, /Result hash mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI model evidence conflicts prevent an apparently exact model-specific cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "sheep-cost-model-"));
  try {
    const run = join(root, "luna-4-initial"); await mkdir(run);
    const data = receipt({ input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 });
    await writeFile(join(run, "call-1.json"), JSON.stringify({ transcript: { ...data.transcript, effectiveModelEvidence: "different-model" } }));
    await writeFile(join(run, "call-2.json"), JSON.stringify({ transcript: { ...data.transcript,
      requestedModel: { private: "PRIVATE REQUEST" }, effectiveModelEvidence: { private: "PRIVATE EVIDENCE" } } }));
    await writeFile(join(root, "rates.json"), JSON.stringify(cardData));
    const output = join(root, "estimate.json");
    const child = spawnSync(process.execPath, ["scripts/estimate-costs.mjs", "--rates", join(root, "rates.json"), "--root", root, "--output", output], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.total.modelIdentityConflictingCalls, 1);
    assert.equal(report.total.modelIdentityUnverifiedCalls, 2);
    assert.equal(report.total.apiUsd.upper, null);
    assert.ok(!JSON.stringify(report).includes("PRIVATE"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI --run estimates arbitrary future run and experiment directories with relative provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "sheep-cost-new-run-"));
  try {
    const experiment = join(root, "arbitrary-future-experiment"), run = join(experiment, "new-trial");
    await mkdir(run, { recursive: true });
    await writeFile(join(root, "rates.json"), JSON.stringify(cardData));
    await writeFile(join(run, "call-1.json"), JSON.stringify(receipt({ input_tokens: 20_000, cached_input_tokens: 15_000,
      cache_write_input_tokens: 0, output_tokens: 250 })));
    const result = JSON.stringify({ success: true, calls: [{ id: "call-1", model: "upper" }] });
    await writeFile(join(run, "result.json"), result);
    await writeFile(join(experiment, "experiment.json"), JSON.stringify({ runs: [{ id: "new-trial",
      resultSha256: createHash("sha256").update(result).digest("hex") }] }));
    const output = join(root, "estimate.json");
    for (const directory of [run, experiment]) {
      const args = ["scripts/estimate-costs.mjs", "--rates", join(root, "rates.json"), "--run", directory, "--output", output];
      const child = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(child.status, 0, child.stderr);
      const bytes = await readFile(output, "utf8"), report = JSON.parse(bytes);
      assert.equal(report.total.calls, 1);
      near(report.total.apiUsd.lower, 0.0775);
      assert.equal(report.byFamily[0].family, "custom-run");
      assert.equal(report.byRun[0].run, directory === run ? "." : "new-trial");
      assert.equal(report.calls[0].path, directory === run ? "call-1.json" : "new-trial/call-1.json");
      assert.deepEqual(report.missingFamilies, []);
      assert.ok(!bytes.includes(root));
      assert.notEqual(spawnSync(process.execPath, [...args, "--root", root]).status, 0);
      assert.notEqual(spawnSync(process.execPath, [...args, "--scenario", "other.json"]).status, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI forecast accepts explicit unknown cache and keeps credit dollar conversion optional", async () => {
  const root = await mkdtemp(join(tmpdir(), "sheep-cost-forecast-"));
  try {
    await writeFile(join(root, "rates.json"), JSON.stringify(cardData));
    await writeFile(join(root, "scenario.json"), JSON.stringify({ rows: [{ model: "upper", calls: 10,
      inputTokensPerCall: 100_000, cachedInputTokensPerCall: null, cacheWriteInputTokensPerCall: 0, outputTokensPerCall: 0 }] }));
    const output = join(root, "estimate.json");
    const child = spawnSync(process.execPath, ["scripts/estimate-costs.mjs", "--rates", join(root, "rates.json"),
      "--scenario", join(root, "scenario.json"), "--output", output, "--usd-per-credit", "0.04"], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.mode, "planned-usage");
    near(report.total.apiUsd.lower, 1);
    near(report.total.apiUsd.upper, 10);
    near(report.total.codexUsdAtAssumedCreditPrice.lower, 1);
    near(report.total.codexUsdAtAssumedCreditPrice.upper, 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});
