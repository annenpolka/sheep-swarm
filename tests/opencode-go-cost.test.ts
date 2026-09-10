import assert from "node:assert/strict";
import test from "node:test";
import { extractTokenUsage, estimateCallCost, estimateTokenCost, parseRateCard, type TokenRates } from "../src/cost-estimate.ts";

const rates: TokenRates = { input: 10, cachedInput: 1, cacheWrite: 12, output: 50 };
const card = parseRateCard({ format: 1, usdPerCredit: null, models: {
  "go/model": { apiUsdPerMillion: rates, codexCreditsPerMillion: null },
} });
function receipt(apiFormat: string, rawUsage: unknown, extra: Record<string, unknown> = {}) {
  return { transcript: { runtime: "opencode-go", apiFormat, rawUsage,
    usageCompleteness: "complete", httpStatus: 200, ...extra } };
}

test("OpenCode Go chat completions extracts totals, cache detail, and reasoning once", () => {
  const usage = extractTokenUsage(receipt("chat-completions", {
    prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
    prompt_tokens_details: { cached_tokens: 60 },
    completion_tokens_details: { reasoning_tokens: 20 },
  }));
  assert.equal(usage.source, "opencode-go.chat-completions");
  assert.deepEqual([usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens], [100, 60, 30, 20]);
  assert.equal(estimateTokenCost(usage, rates, "Go test").lower, 0.00196);
});

test("OpenCode Go responses uses input/output totals and cached input detail", () => {
  const usage = extractTokenUsage(receipt("responses", {
    input_tokens: 200, output_tokens: 40, total_tokens: 240,
    input_tokens_details: { cached_tokens: 150 },
  }));
  assert.equal(usage.source, "opencode-go.responses");
  assert.equal(usage.inputTokens, 200);
  assert.equal(usage.cachedInputTokens, 150);
  assert.equal(usage.outputTokens, 40);
  assert.ok(usage.issues.some(issue => issue.includes("Cache write") && issue.includes("unknown")));
});

test("Anthropic messages adds uncached input and cache fields exactly once", () => {
  const usage = extractTokenUsage(receipt("messages", {
    input_tokens: 100, output_tokens: 25,
    cache_read_input_tokens: 70, cache_creation_input_tokens: 10,
  }));
  assert.equal(usage.source, "opencode-go.messages");
  assert.deepEqual([usage.inputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens, usage.outputTokens], [180, 70, 10, 25]);
  assert.ok(Math.abs(estimateTokenCost(usage, rates, "Go test").lower - 0.00244) < 1e-12);
});

test("missing cache split keeps input/output metered but leaves price non-exact", () => {
  const usage = extractTokenUsage(receipt("responses", { input_tokens: 100, output_tokens: 10, total_tokens: 110 }));
  const cost = estimateCallCost(usage, "go/model", card).apiUsd;
  assert.equal(cost.lower, 0);
  assert.equal(cost.upper, null);
  assert.ok(cost.unknownReasons.length > 0);
});

test("partial or failed Go calls retain known lower counts and cannot become exact", () => {
  const usage = extractTokenUsage(receipt("chat-completions", {
    prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
  }, { usageCompleteness: "partial-or-unknown", httpStatus: 502 }));
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 10);
  assert.equal(estimateCallCost(usage, "go/model", card).apiUsd.upper, null);
});

test("contradictory totals and cache arithmetic are invalid", () => {
  for (const rawUsage of [
    { prompt_tokens: 100, completion_tokens: 10, total_tokens: 999 },
    { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 101 } },
    { input_tokens: 100, output_tokens: 10, total_tokens: 110, output_tokens_details: { reasoning_tokens: 11 } },
  ]) {
    const usage = extractTokenUsage(receipt(rawUsage.input_tokens === undefined ? "chat-completions" : "responses", rawUsage));
    assert.ok(usage.issues.some(issue => issue.startsWith("Invalid OpenCode Go")));
    assert.equal(estimateCallCost(usage, "go/model", card).apiUsd.upper, null);
  }
});

test("negative nested counters and missing complete totals are invalid", () => {
  const cases = [
    receipt("responses", { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: -1 } }),
    receipt("responses", { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_tokens_details: { reasoning_tokens: -1 } }),
    receipt("responses", { input_tokens: 100, output_tokens: 20 }),
  ];
  for (const data of cases) {
    const usage = extractTokenUsage(data);
    assert.ok(usage.issues.some(issue => issue.startsWith("Invalid OpenCode Go")));
    assert.equal(estimateCallCost(usage, "go/model", card).apiUsd.upper, null);
  }
});

test("chat cache hit and miss counters are checked against total input", () => {
  const usage = extractTokenUsage(receipt("chat-completions", {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 91,
  }));
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.cachedInputTokens, 10);
  assert.ok(usage.issues.some(issue => issue.includes("hit/miss partition")));
  assert.equal(estimateCallCost(usage, "go/model", card).apiUsd.upper, null);
});

test("invalid message cache retains the uncached input lower bound", () => {
  const usage = extractTokenUsage(receipt("messages", {
    input_tokens: 100, output_tokens: 20, cache_read_input_tokens: -1,
  }, { usageCompleteness: "partial-or-unknown" }));
  assert.equal(usage.inputTokens, 100);
  assert.ok(usage.issues.some(issue => issue.startsWith("Invalid OpenCode Go")));
  assert.equal(estimateCallCost(usage, "go/model", card).apiUsd.upper, null);
});

test("ambiguous apiFormat is rejected and Go model identity has no implicit provider pricing", () => {
  const usage = extractTokenUsage(receipt("openai", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }));
  assert.equal(usage.source, "ambiguous");
  assert.equal(usage.inputTokens, null);
  assert.equal(estimateCallCost(usage, "go/model", card).apiUsd.upper, null);
  assert.equal(estimateCallCost(extractTokenUsage(receipt("chat-completions", {
    prompt_tokens: 10, completion_tokens: 2, total_tokens: 12,
  })), "same-model-name", card).apiUsd.upper, null);
});
