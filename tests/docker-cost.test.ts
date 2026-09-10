import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { extractTokenUsage, estimateTokenCost } from "../src/cost-estimate.ts";
import { CreditBudget } from "../src/credit-budget.ts";

const model = "gpt-5.6-luna";
const events = readFileSync(new URL("./fixtures/docker-agent-v1.137.0-local.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
const prices = { input: 1, cachedInput: 0.5, cacheWrite: 2, output: 4 };
function receipt() { return { requestedModel: model, transcript: { runtime: "docker-agent", runtimeVersion: "v1.137.0", requestedModel: model,
  effectiveModelEvidence: null, usageCompleteness: "complete", events: structuredClone(events) } }; }
test("Docker cost extraction sums observed per-message usage instead of the last context snapshot", () => {
  const usage = extractTokenUsage(receipt());
  assert.equal(usage.source, "docker-agent.per-message"); assert.equal(usage.inputTokens, 5933); assert.equal(usage.outputTokens, 333);
  assert.equal(usage.cachedInputTokens, 0); assert.equal(usage.cacheWriteInputTokens, 0);
  assert.deepEqual(usage.issues, []);
  assert.equal(estimateTokenCost(usage, prices, "synthetic").lower, (5933 + 333 * 4) / 1e6);
});
test("Docker cache reads and writes are included once, and runtime cost=0 is ignored", () => {
  const data = receipt();
  const row = data.transcript.events.find(event => event.type === "token_usage").usage.last_message;
  row.cached_input_tokens = 10; row.cached_write_tokens = 4; row.Cost = 0;
  const usage = extractTokenUsage(data);
  assert.equal(usage.inputTokens, 5947); assert.equal(usage.cachedInputTokens, 10); assert.equal(usage.cacheWriteInputTokens, 4);
  assert.equal(estimateTokenCost(usage, prices, "synthetic").lower, (5933 + 5 + 8 + 333 * 4) / 1e6);
});
test("partial Docker usage keeps a priced lower bound and locks credit admission", () => {
  const data = receipt(); data.transcript.events.pop(); data.transcript.usageCompleteness = "partial-or-unknown";
  const usage = extractTokenUsage(data), estimate = estimateTokenCost(usage, prices, "synthetic");
  assert.ok(estimate.lower > 0); assert.equal(estimate.upper, null); assert.equal(estimate.exact, false);
  const budget = new CreditBudget({ maxCredits: 10, reservations: { [model]: 1 }, rateCard: { format: 1, usdPerCredit: null,
    models: { [model]: { apiUsdPerMillion: null, codexCreditsPerMillion: prices } } } });
  assert.equal(budget.reserve(model, "interrupted"), true);
  assert.equal(budget.settle("interrupted", data).credits, null);
  assert.equal(budget.snapshot().unknownUsageCalls, 1); assert.ok(budget.snapshot().observedCredits > 0);
  assert.equal(budget.reserve(model, "next"), false);
});
test("duplicate events cannot turn into exact cost and unsupported versions never inherit known semantics", () => {
  const data = receipt(); data.transcript.events.push(data.transcript.events.find(event => event.type === "token_usage"));
  assert.equal(estimateTokenCost(extractTokenUsage(data), prices, "synthetic").upper, null);
  data.transcript.runtimeVersion = "unknown";
  assert.equal(extractTokenUsage(data).source, "ambiguous");
  const conflict = receipt(); conflict.transcript.events.find(event => event.type === "token_usage").usage.last_message.Model = "chatgpt/another-model";
  assert.equal(extractTokenUsage(conflict).source, "ambiguous");
});
