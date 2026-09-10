import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CreditBudget } from "../src/credit-budget.ts";
import { parseRateCard } from "../src/cost-estimate.ts";

const luna = "gpt-5.6-luna", astra = "gpt-6-astra";
const card = parseRateCard(JSON.parse(readFileSync(new URL("../pricing/openai-2026-09-10.json", import.meta.url), "utf8")));
const options = { maxCredits: 30, reservations: { [luna]: 0.25, [astra]: 15 }, rateCard: card };
function receipt(model = luna, overrides: Record<string, unknown> = {}) {
  return { requestedModel: model, transcript: { requestedModel: model, effectiveModelEvidence: null as string | null,
    events: [{ type: "turn.completed", usage: { input_tokens: 25_000, cached_input_tokens: 0,
      cache_write_input_tokens: 0, output_tokens: 2000, ...overrides } }] } };
}
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test("synchronous reservation prevents concurrent jobs from oversubscribing shared credits", async () => {
  const budget = new CreditBudget({ ...options, maxCredits: 1 });
  const admitted = await Promise.all(Array.from({ length: 16 }, (_, i) => Promise.resolve().then(() => budget.reserve(luna, `call-${i}`))));
  assert.equal(admitted.filter(Boolean).length, 4);
  assert.equal(budget.snapshot().reservedCredits, 1);
  assert.equal(budget.snapshot().activeReservations, 4);
  assert.equal(budget.snapshot().admissionDenied, true);
  assert.equal(budget.snapshot().exceeded, false);
});

test("all roles and retries pay model-specific cached input and output prices exactly once", () => {
  const budget = new CreditBudget(options);
  for (const [id, model] of [["lower-1", luna], ["retry-2", luna], ["upper-3", astra]] as const) {
    assert.equal(budget.reserve(model, id), true);
    const result = budget.settle(id, receipt(model, { input_tokens: 20_000, cached_input_tokens: 15_000,
      output_tokens: 250, reasoning_output_tokens: 100 }));
    near(result.credits!, model === luna ? 0.04 : 1.9375);
    assert.equal(result.overrun, false);
  }
  const state = budget.snapshot();
  near(state.observedCredits, 2.0175);
  assert.equal(state.reservedCredits, 0);
  assert.equal(state.settledCalls, 3);
  assert.equal(state.unknownUsageCalls, 0);
  assert.equal(state.calls[0]?.modelIdentity, "requested-only");
});

test("unused reservation is released after a known charge", () => {
  const budget = new CreditBudget({ ...options, maxCredits: 0.5 });
  assert.equal(budget.reserve(luna, "first"), true);
  assert.equal(budget.reserve(luna, "second"), true);
  assert.equal(budget.canReserve(luna), false);
  budget.settle("first", receipt(luna, { input_tokens: 0, output_tokens: 0 }));
  assert.equal(budget.canReserve(luna), true);
  assert.equal(budget.reserve(luna, "third"), true);
  assert.equal(budget.snapshot().reservedCredits, 0.5);
});

test("failed calls retain terminal or raw usage and retries require a distinct reservation", () => {
  const budget = new CreditBudget(options);
  assert.equal(budget.reserve(luna, "failed"), true);
  const data = receipt();
  const raw = { code: "nonzero-exit", transcript: { ...data.transcript,
    events: [...data.transcript.events.map(event => ({ ...event, type: "usage" })), { type: "turn.failed" }], exitCode: 1 } };
  const result = budget.settle("failed", raw);
  near(result.credits!, 0.185);
  assert.equal(result.usage.source, "raw-usage");
  assert.equal(budget.reserve(luna, "retry"), true);
  budget.settle("retry", receipt());
  near(budget.snapshot().observedCredits, 0.37);
});

test("missing usage releases its reservation but locks admission without erasing previous charges", () => {
  const budget = new CreditBudget(options);
  budget.reserve(luna, "known"); budget.settle("known", receipt());
  budget.reserve(luna, "unknown");
  assert.equal(budget.settle("unknown", { transcript: { requestedModel: luna, events: [] } }).credits, null);
  const state = budget.snapshot();
  near(state.observedCredits, 0.185);
  assert.equal(state.reservedCredits, 0);
  assert.equal(state.unknownUsageCalls, 1);
  assert.equal(state.locked, true);
  assert.equal(budget.reserve(astra, "blocked"), false);
  assert.equal(budget.snapshot().calls.length, 2);
});

test("partial or ambiguous usage fails closed while retaining any defensible priced lower bound", () => {
  const budget = new CreditBudget(options);
  budget.reserve(luna, "partial"); budget.reserve(luna, "ambiguous");
  assert.equal(budget.settle("partial", receipt(luna, { output_tokens: undefined })).credits, null);
  near(budget.snapshot().observedCredits, 0.125);
  const data = receipt();
  data.transcript.events.push({ ...data.transcript.events[0]! });
  const result = budget.settle("ambiguous", data);
  assert.equal(result.usage.source, "ambiguous");
  assert.equal(result.credits, null);
  near(budget.snapshot().observedCredits, 0.125);
  assert.equal(budget.snapshot().unknownUsageCalls, 2);
});

test("unknown applicable cache-write price and missing cache split are not silently treated as zero", () => {
  for (const overrides of [{ cache_write_input_tokens: 1000 }, { cached_input_tokens: undefined }]) {
    const budget = new CreditBudget(options);
    budget.reserve(luna, "unknown-price");
    const result = budget.settle("unknown-price", receipt(luna, overrides));
    assert.equal(result.credits, null);
    assert.equal(budget.canReserve(luna), false);
    assert.ok(budget.snapshot().observedCredits > 0);
    assert.equal(budget.snapshot().unknownUsageCalls, 1);
  }
});

test("actual reservation overrun locks further calls after total exceeds budget but admitted work can settle", () => {
  const budget = new CreditBudget({ ...options, maxCredits: 0.5 });
  budget.reserve(luna, "expensive"); budget.reserve(luna, "in-flight");
  const result = budget.settle("expensive", receipt(luna, { input_tokens: 120_000, output_tokens: 0 }));
  near(result.credits!, 0.6);
  assert.equal(result.overrun, true);
  assert.equal(budget.snapshot().exceeded, true);
  assert.equal(budget.snapshot().reservationOverruns, 1);
  assert.equal(budget.reserve(luna, "too-late"), false);
  near(budget.settle("in-flight", receipt()).credits!, 0.185);
  near(budget.snapshot().observedCredits, 0.785);
  assert.equal(budget.snapshot().activeReservations, 0);
});

test("overrun below total cap is recorded and outstanding reservations still count toward admission", () => {
  const budget = new CreditBudget({ ...options, maxCredits: 1 });
  for (let i = 0; i < 3; i++) assert.equal(budget.reserve(luna, `call-${i}`), true);
  assert.equal(budget.settle("call-0", receipt(luna, { input_tokens: 70_000, output_tokens: 0 })).overrun, true);
  assert.equal(budget.snapshot().exceeded, false);
  assert.equal(budget.canReserve(luna), false);
  budget.settle("call-1", receipt(luna, { input_tokens: 0, output_tokens: 0 }));
  assert.equal(budget.canReserve(luna), true);
});

test("duplicate reservation or settlement and settlement without reservation cannot alter the ledger", () => {
  const budget = new CreditBudget(options);
  budget.reserve(luna, "call");
  assert.throws(() => budget.reserve(astra, "call"), /already reserved/);
  assert.throws(() => budget.settle("absent", receipt()), /not reserved/);
  budget.settle("call", receipt());
  const before = budget.snapshot();
  assert.throws(() => budget.settle("call", receipt(astra)), /already settled/);
  assert.deepEqual(budget.snapshot(), before);
});

test("conflicting model or call identity cannot be charged using the cheaper reserved model", () => {
  const variants: unknown[] = [
    receipt(astra),
    { ...receipt(), model: astra },
    { ...receipt(), callId: "different" },
    { ...receipt(), id: "different" },
    { transcript: { ...receipt().transcript, requestedModel: undefined } },
    { transcript: { ...receipt().transcript, effectiveModelEvidence: astra } },
    { transcript: { ...receipt().transcript, events: [...receipt().transcript.events, { type: "thread.started", model: astra }] } },
  ];
  for (const data of variants) {
    const budget = new CreditBudget(options);
    budget.reserve(luna, "call");
    assert.equal(budget.settle("call", data).credits, null);
    assert.equal(budget.snapshot().calls[0]?.modelIdentity, "conflicting-or-missing");
    assert.equal(budget.canReserve(luna), false);
    assert.equal(budget.snapshot().observedCredits, 0);
  }
});

test("matching model evidence is recorded without treating CLI thread IDs as call IDs", () => {
  const budget = new CreditBudget(options);
  budget.reserve(luna, "call");
  const data = receipt();
  budget.settle("call", { ...data, callId: "call", transcript: { ...data.transcript,
    effectiveModelEvidence: luna, events: [{ type: "thread.started", id: "unrelated-thread", model: luna }, ...data.transcript.events] } });
  assert.equal(budget.snapshot().calls[0]?.modelIdentity, "matching-evidence");
  assert.equal(budget.snapshot().unknownUsageCalls, 0);
});

test("invalid limits and reservations fail at construction, missing model price cannot be admitted", () => {
  for (const maxCredits of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => new CreditBudget({ ...options, maxCredits }));
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new CreditBudget({ ...options, reservations: { [luna]: value } }));
  }
  const budget = new CreditBudget({ ...options, reservations: { absent: 1 } });
  assert.equal(budget.reserve("absent", "call"), false);
  assert.equal(budget.snapshot().calls.length, 0);
  assert.equal(new CreditBudget({ ...options, maxCredits: 0 }).canReserve(luna), false);
});

test("snapshots and constructor inputs cannot mutate admission accounting", () => {
  const mutable = JSON.parse(JSON.stringify(options));
  const budget = new CreditBudget(mutable);
  mutable.reservations[luna] = 0;
  mutable.rateCard.models[luna].codexCreditsPerMillion.input = 0;
  budget.reserve(luna, "call");
  near(budget.settle("call", receipt()).credits!, 0.185);
  const exposed = budget.snapshot();
  Reflect.set(exposed.calls[0]!, "knownCreditsLower", 0);
  (exposed.calls[0]!.issues as string[]).push("injected");
  near(budget.snapshot().observedCredits, 0.185);
  assert.deepEqual(budget.snapshot().calls[0]?.issues, []);
});

test("decimal reservation boundaries do not reject an otherwise exact fit", () => {
  const budget = new CreditBudget({ ...options, maxCredits: 0.3, reservations: { [luna]: 0.1 } });
  assert.equal(budget.reserve(luna, "one"), true);
  assert.equal(budget.reserve(luna, "two"), true);
  assert.equal(budget.reserve(luna, "three"), true);
  assert.equal(budget.reserve(luna, "four"), false);
});

test("near-zero reservations cannot bypass a zero cap and overflowing totals deny admission", () => {
  const zero = new CreditBudget({ ...options, maxCredits: 0, reservations: { [luna]: 1e-20 } });
  assert.equal(zero.reserve(luna, "tiny"), false);
  const huge = new CreditBudget({ ...options, maxCredits: 1.5e308, reservations: { [luna]: 1e308 } });
  assert.equal(huge.reserve(luna, "first"), true);
  assert.equal(huge.reserve(luna, "second"), false);
});

test("arithmetic failure settles as unknown and prevents continued admission", () => {
  const unusualCard = JSON.parse(JSON.stringify(card));
  unusualCard.models[luna].codexCreditsPerMillion.input = 1e308;
  const budget = new CreditBudget({ ...options, rateCard: unusualCard });
  budget.reserve(luna, "overflow");
  assert.equal(budget.settle("overflow", receipt()).credits, null);
  assert.equal(budget.snapshot().activeReservations, 0);
  assert.equal(budget.snapshot().unknownUsageCalls, 1);
  assert.equal(budget.canReserve(luna), false);
});
