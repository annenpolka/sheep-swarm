import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBudget } from "../src/token-budget.ts";

const MODEL = "gpt-5.6-luna";
const receipt = (input: number | null, output: number | null, extra: Record<string, unknown> = {}) => ({
  requestedModel: MODEL,
  transcript: { requestedModel: MODEL, runtime: "codex", events: [{ type: "turn.completed",
    usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: output, ...extra } }] },
});

test("token reservations admit concurrency against the aggregate cap", () => {
  const budget = new TokenBudget({ maxTokens: 25, reserveTokensPerCall: 10 });
  assert.equal(budget.reserve(MODEL, "a"), true);
  assert.equal(budget.reserve(MODEL, "b"), true);
  assert.equal(budget.canReserve(MODEL), false);
  budget.settle("a", receipt(2, 1));
  assert.equal(budget.canReserve(MODEL), true);
  assert.equal(budget.reserve(MODEL, "c"), true);
  budget.settle("b", receipt(2, 1));
  budget.settle("c", receipt(2, 1));
  const snapshot = budget.snapshot();
  assert.equal(snapshot.unit, "tokens");
  assert.equal(snapshot.observedTokens, 9);
  assert.equal(snapshot.reservedTokens, 0);
  assert.equal(snapshot.activeReservations, 0);
  assert.equal(snapshot.exceeded, false);
});

test("duplicate and unknown call IDs are rejected", () => {
  const budget = new TokenBudget({ maxTokens: 100, reserveTokensPerCall: 10 });
  assert.equal(budget.reserve(MODEL, "a"), true);
  assert.throws(() => budget.reserve(MODEL, "a"), /already reserved/);
  assert.throws(() => budget.settle("missing", receipt(1, 1)), /was not reserved/);
  budget.settle("a", receipt(1, 1));
  assert.throws(() => budget.settle("a", receipt(1, 1)), /already settled/);
});

test("a settled overrun is reported while the reservation cap still gates admission", () => {
  const budget = new TokenBudget({ maxTokens: 100, reserveTokensPerCall: 10 });
  budget.reserve(MODEL, "a");
  const settled = budget.settle("a", receipt(8, 5));
  assert.equal(settled.tokens, 13);
  assert.equal(settled.overrun, true);
  assert.equal(budget.snapshot().reservationOverruns, 1);
  assert.equal(budget.snapshot().observedTokens, 13);
});

test("incomplete usage preserves the known lower bound but never counts as complete", () => {
  const budget = new TokenBudget({ maxTokens: 100, reserveTokensPerCall: 10 });
  budget.reserve(MODEL, "partial");
  const partial = budget.settle("partial", receipt(5, null));
  assert.equal(partial.tokens, null);
  assert.ok(partial.usage.issues.length > 0);
  assert.equal(budget.snapshot().observedTokens, 5);
  assert.equal(budget.snapshot().unknownUsageCalls, 1);
  assert.equal(budget.snapshot().locked, true);
});

test("missing output, invalid counts, and identity mismatch are unknown and lock admission", () => {
  for (const bad of [receipt(5, null), receipt(-1, 4), { transcript: { runtime: "codex", events: [] } }]) {
    const budget = new TokenBudget({ maxTokens: 100, reserveTokensPerCall: 10 });
    budget.reserve(MODEL, "a");
    const settled = budget.settle("a", bad);
    assert.equal(settled.tokens, null);
    assert.equal(budget.snapshot().unknownUsageCalls, 1);
    assert.equal(budget.canReserve(MODEL), false);
  }
});

test("observed tokens beyond the cap lock the budget", () => {
  const budget = new TokenBudget({ maxTokens: 10, reserveTokensPerCall: 5 });
  assert.equal(budget.reserve(MODEL, "a"), true);
  budget.settle("a", receipt(6, 6));
  const snapshot = budget.snapshot();
  assert.equal(snapshot.exceeded, true);
  assert.equal(snapshot.locked, true);
  assert.equal(budget.canReserve(MODEL), false);
});
