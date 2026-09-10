import assert from "node:assert/strict";
import test from "node:test";
import { TokenBudget } from "../src/token-budget.ts";

const model = "deepseek-requested";
function receipt(rawUsage: Record<string, unknown>, complete = true) {
  return { requestedModel: model, transcript: { runtime: "deepseek", requestedModel: model,
    effectiveModelEvidence: "provider-alias", rawUsage, httpStatus: 200,
    timedOut: false, cancelled: false, usageCompleteness: complete ? "complete" : "partial-or-unknown" } };
}

test("token admission does not need a known monetary cache split", () => {
  const budget = new TokenBudget({ maxTokens: 1000, reserveTokensPerCall: 200 });
  assert.equal(budget.reserve(model, "one"), true);
  const settled = budget.settle("one", receipt({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }));
  assert.equal(settled.tokens, 120);
  assert.equal(budget.snapshot().unknownUsageCalls, 0);
});

test("overflowing normalized totals cannot settle as a free complete call", () => {
  const budget = new TokenBudget({ maxTokens: 1000, reserveTokensPerCall: 200 });
  budget.reserve(model, "overflow");
  const raw = { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0 };
  const settled = budget.settle("overflow", { requestedModel: model, transcript: { requestedModel: model,
    events: [{ type: "turn.completed", usage: raw }] } });
  assert.equal(settled.tokens, null);
  assert.equal(budget.snapshot().locked, true);
});

test("partial usage retains the independently known input lower bound", () => {
  const budget = new TokenBudget({ maxTokens: 1000, reserveTokensPerCall: 200 });
  budget.reserve(model, "partial");
  assert.equal(budget.settle("partial", receipt({ prompt_tokens: 100 }, false)).tokens, null);
  assert.equal(budget.snapshot().observedTokens, 100);
  assert.equal(budget.reserve(model, "next"), false);
});

 test("inconsistent provider totals lock token admission", () => {
  const budget = new TokenBudget({ maxTokens: 1000, reserveTokensPerCall: 200 });
  budget.reserve(model, "invalid");
  assert.equal(budget.settle("invalid", receipt({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 121 })).tokens, null);
  assert.equal(budget.snapshot().locked, true);
});
