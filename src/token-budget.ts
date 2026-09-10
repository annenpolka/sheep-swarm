import { extractTokenUsage, type TokenUsage } from "./cost-estimate.ts";

export interface TokenBudgetOptions {
  readonly maxTokens: number;
  readonly reserveTokensPerCall: number;
}

export interface TokenBudgetSettlement {
  /** Observed input+output tokens, or null when the receipt cannot be metered. Null is never free. */
  readonly tokens: number | null;
  readonly overrun: boolean;
  readonly usage: TokenUsage;
}

export interface TokenBudgetCall {
  readonly callId: string;
  readonly model: string;
  readonly reservedTokens: number;
  readonly status: "reserved" | "settled";
  readonly tokens: number | null;
  /** Lower bound preserved from partial or malformed usage; never treated as complete. */
  readonly knownTokensLower: number;
  readonly overrun: boolean;
  readonly issues: readonly string[];
}

export interface TokenBudgetSnapshot {
  readonly unit: "tokens";
  readonly maxTokens: number;
  readonly observedTokens: number;
  readonly reservedTokens: number;
  readonly unknownUsageCalls: number;
  readonly exceeded: boolean;
  readonly admissionDenied: boolean;
  readonly reservationOverruns: number;
  readonly activeReservations: number;
  readonly settledCalls: number;
  readonly locked: boolean;
  readonly calls: readonly TokenBudgetCall[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requestedIdentity(receipt: unknown, model: string): { ok: boolean; issues: string[] } {
  const data = record(receipt), transcript = record(data?.transcript), issues: string[] = [];
  let matched = false;
  for (const [label, row] of [["receipt", data], ["transcript", transcript]] as const) {
    if (!row || !Object.hasOwn(row, "requestedModel")) continue;
    if (row.requestedModel === model) matched = true;
    else issues.push(`${label}: requested model differs from the reservation`);
  }
  if (!matched) issues.push("Missing matching requested model identity");
  return { ok: !issues.length, issues: [...new Set(issues)] };
}

/**
 * Independent token ledger for metered DeepSeek/Codex runs. It shares CreditBudget's
 * admission discipline but counts requested model tokens instead of priced credits, so it
 * makes no billing claim and needs no rate card. Unknown usage locks admission permanently.
 */
export class TokenBudget {
  readonly #maxTokens: number;
  readonly #reserveTokensPerCall: number;
  readonly #calls = new Map<string, TokenBudgetCall>();
  #admissionDenied = false;

  constructor(options: TokenBudgetOptions) {
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 0)
      throw new RangeError("maxTokens must be a nonnegative safe integer");
    if (!Number.isSafeInteger(options.reserveTokensPerCall) || options.reserveTokensPerCall < 1)
      throw new RangeError("reserveTokensPerCall must be a positive safe integer");
    this.#maxTokens = options.maxTokens;
    this.#reserveTokensPerCall = options.reserveTokensPerCall;
  }

  canReserve(_model: string): boolean {
    const current = this.snapshot();
    return !current.locked && current.observedTokens + current.reservedTokens + this.#reserveTokensPerCall <= this.#maxTokens;
  }

  reserve(model: string, callId: string): boolean {
    if (typeof callId !== "string" || !callId.trim()) throw new RangeError("A nonempty call ID is required");
    if (this.#calls.has(callId)) throw new Error(`Call ID already reserved: ${callId}`);
    if (!this.canReserve(model)) { this.#admissionDenied = true; return false; }
    this.#calls.set(callId, { callId, model, reservedTokens: this.#reserveTokensPerCall, status: "reserved",
      tokens: null, knownTokensLower: 0, overrun: false, issues: [] });
    return true;
  }

  settle(callId: string, receipt: unknown): TokenBudgetSettlement {
    const call = this.#calls.get(callId);
    if (!call) throw new Error(`Call was not reserved: ${callId}`);
    if (call.status !== "reserved") throw new Error(`Call was already settled: ${callId}`);
    const usage = extractTokenUsage(receipt);
    const identity = requestedIdentity(receipt, call.model);
    const input = usage.inputTokens, output = usage.outputTokens;
    const total = input !== null && output !== null && Number.isSafeInteger(input + output) ? input + output : null;
    // Independently known input and output counts are a lower bound even when the call is incomplete.
    let lower = 0;
    if (input !== null && Number.isSafeInteger(input)) lower += input;
    if (output !== null && Number.isSafeInteger(output)) lower += output;
    if (!Number.isSafeInteger(lower)) lower = 0;
    // Cache-split precision is a pricing question, not a token-admission requirement.
    const measurable = identity.ok && total !== null && !usage.partial
      && usage.source !== "missing" && usage.source !== "ambiguous"
      && !usage.issues.some(issue => issue.startsWith("Invalid "));
    const tokens = measurable ? total : null;
    const overrun = lower > call.reservedTokens;
    this.#calls.set(callId, { ...call, status: "settled", tokens, knownTokensLower: identity.ok ? lower : 0, overrun,
      issues: [...new Set([...identity.issues, ...usage.issues])] });
    return { tokens, overrun, usage };
  }

  snapshot(): TokenBudgetSnapshot {
    const calls = [...this.#calls.values()].map((call) => ({ ...call, issues: [...call.issues] }));
    const observedTokens = calls.reduce((sum, call) => sum + call.knownTokensLower, 0);
    const pending = calls.filter((call) => call.status === "reserved");
    const reservedTokens = pending.reduce((sum, call) => sum + call.reservedTokens, 0);
    const unknownUsageCalls = calls.filter((call) => call.status === "settled" && call.tokens === null).length;
    const exceeded = observedTokens > this.#maxTokens;
    return { unit: "tokens", maxTokens: this.#maxTokens, observedTokens, reservedTokens, unknownUsageCalls, exceeded,
      admissionDenied: this.#admissionDenied, reservationOverruns: calls.filter((call) => call.overrun).length,
      activeReservations: pending.length, settledCalls: calls.length - pending.length,
      locked: unknownUsageCalls > 0 || exceeded, calls };
  }
}
