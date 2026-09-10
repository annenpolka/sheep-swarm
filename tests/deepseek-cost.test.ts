import assert from "node:assert/strict";
import test from "node:test";
import { estimateCallCost, estimateTokenCost, extractTokenUsage } from "../src/cost-estimate.ts";

function receipt(raw: Record<string, unknown> = {}) {
  return { requestedModel: "deepseek-v4-flash", transcript: {
    runtime: "deepseek", requestedModel: "deepseek-v4-flash", effectiveModelEvidence: "deepseek-flash",
    httpStatus: 200, timedOut: false, cancelled: false, usageCompleteness: "complete",
    rawUsage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60,
      completion_tokens_details: { reasoning_tokens: 5 }, ...raw },
    events: [], usage: [],
  } };
}
const rates = { input: 2, cachedInput: 1, cacheWrite: null, output: 4 };
const close = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-18, `${actual} differs from ${expected}`);
};

test("DeepSeek offline extraction uses one raw receipt including cache and reasoning", () => {
  const usage = extractTokenUsage(receipt());
  assert.equal(usage.source, "deepseek.chat-completion");
  assert.equal(usage.inputTokens, 100); assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cachedInputTokens, 40); assert.equal(usage.cacheWriteInputTokens, 0);
  assert.equal(usage.reasoningOutputTokens, 5); assert.deepEqual(usage.issues, []);
  close(estimateTokenCost(usage, rates, "test").lower, (60 * 2 + 40 + 20 * 4) / 1e6);
});

test("DeepSeek incomplete transport retains a lower bound without claiming exact cost", () => {
  const data = receipt(); data.transcript.usageCompleteness = "partial-or-unknown"; data.transcript.timedOut = true;
  const estimate = estimateTokenCost(extractTokenUsage(data), rates, "test");
  assert.ok(estimate.lower > 0); assert.equal(estimate.upper, null); assert.equal(estimate.exact, false);
});

test("DeepSeek invalid receipt arithmetic and counter types remain unpriceable", () => {
  for (const extra of [{ total_tokens: 121 }, { prompt_cache_hit_tokens: -1 },
    { prompt_cache_miss_tokens: 61 }, { completion_tokens: "20" },
    { completion_tokens_details: { reasoning_tokens: 21 } },
    { prompt_tokens_details: { cached_tokens: 41 } }]) {
    const usage = extractTokenUsage(receipt(extra));
    assert.equal(estimateTokenCost(usage, rates, "test").upper, null);
    assert.ok(usage.issues.some(issue => issue.startsWith("Invalid ")), JSON.stringify(extra));
  }
});

test("DeepSeek unknown cache partition stays an interval rather than zero cache", () => {
  const data = receipt(); delete (data.transcript.rawUsage as Record<string, unknown>).prompt_cache_hit_tokens;
  delete (data.transcript.rawUsage as Record<string, unknown>).prompt_cache_miss_tokens;
  const usage = extractTokenUsage(data); assert.equal(usage.cachedInputTokens, null);
  const estimate = estimateTokenCost(usage, rates, "test");
  close(estimate.lower, (100 + 20 * 4) / 1e6);
  close(estimate.upper, (100 * 2 + 20 * 4) / 1e6);
});

test("DeepSeek unknown beta pricing and Codex credits are never inferred from serving alias", () => {
  const usage = extractTokenUsage(receipt());
  const result = estimateCallCost(usage, "deepseek-v4.1-flash-expires-on-0910", {
    format: 1, usdPerCredit: null,
    models: { "deepseek-v4-flash": { apiUsdPerMillion: rates, codexCreditsPerMillion: null } },
  });
  assert.equal(result.apiUsd.upper, null); assert.equal(result.codexCredits.upper, null);
});
