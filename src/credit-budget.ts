import { estimateCallCost, extractTokenUsage, parseRateCard, type RateCard, type TokenUsage } from "./cost-estimate.ts";

export interface CreditBudgetOptions {
  readonly maxCredits: number;
  readonly reservations: Readonly<Record<string, number>>;
  readonly rateCard: RateCard;
}

export interface CreditSettlement {
  /** Standard-rate estimate, not an observed provider debit. Null is never a free call. */
  readonly credits: number | null;
  readonly overrun: boolean;
  readonly usage: TokenUsage;
}

export interface CreditBudgetCall {
  readonly callId: string;
  readonly model: string;
  readonly reservedCredits: number;
  readonly status: "reserved" | "settled";
  readonly credits: number | null;
  readonly knownCreditsLower: number;
  readonly overrun: boolean;
  readonly modelIdentity: "pending" | "requested-only" | "matching-evidence" | "conflicting-or-missing";
  readonly issues: readonly string[];
}

export interface CreditBudgetSnapshot {
  readonly maxCredits: number;
  /** Sum of priced lower bounds, including any partially observed failed calls. */
  readonly observedCredits: number;
  readonly reservedCredits: number;
  readonly unknownUsageCalls: number;
  readonly exceeded: boolean;
  readonly admissionDenied: boolean;
  readonly reservationOverruns: number;
  readonly activeReservations: number;
  readonly settledCalls: number;
  readonly locked: boolean;
  readonly calls: readonly CreditBudgetCall[];
}

interface BudgetEntry {
  call: CreditBudgetCall;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Prices and usage arithmetic can differ by a few floating-point ulps at an exact boundary.
function exceeds(value: number, limit: number): boolean {
  return !Number.isFinite(value) || value - limit > Number.EPSILON * 8 * Math.max(Math.abs(value), Math.abs(limit));
}

function identity(receipt: unknown, model: string, callId: string): {
  state: CreditBudgetCall["modelIdentity"];
  issues: string[];
} {
  const data = record(receipt), transcript = record(data?.transcript), issues: string[] = [];
  let requested = false, emitted = false;
  for (const [label, row] of [["receipt", data], ["transcript", transcript]] as const) {
    if (!row) continue;
    if (Object.hasOwn(row, "requestedModel")) {
      if (row.requestedModel === model) requested = true;
      else issues.push(`${label}: requested model differs from the reservation or is invalid`);
    }
    if (Object.hasOwn(row, "effectiveModelEvidence") && row.effectiveModelEvidence !== null) {
      if (row.effectiveModelEvidence === model) emitted = true;
      else issues.push(`${label}: effective model differs from the reservation or is invalid`);
    }
    if (Object.hasOwn(row, "model") && row.model !== model) issues.push(`${label}: model differs from the reservation or is invalid`);
    if (Object.hasOwn(row, "callId") && row.callId !== callId) issues.push(`${label}: call ID differs from the reservation`);
  }
  // Top-level id, when supplied by a saved call wrapper, is distinct from CLI thread/item IDs.
  if (data && Object.hasOwn(data, "id") && data.id !== callId) issues.push("receipt: call ID differs from the reservation");
  if (Array.isArray(transcript?.events)) {
    for (const value of transcript.events) {
      const event = record(value);
      if (!event) continue;
      for (const key of ["effective_model", "effectiveModel", "model", "model_name", "modelName"]) {
        if (!Object.hasOwn(event, key) || event[key] === null) continue;
        if (event[key] === model) emitted = true;
        else issues.push("transcript event: model differs from the reservation or is invalid");
      }
    }
  }
  if (!requested) issues.push("Missing matching requested model identity");
  return { state: issues.length ? "conflicting-or-missing" : emitted ? "matching-evidence" : "requested-only", issues: [...new Set(issues)] };
}

/**
 * Synchronous admission for a single-process experiment. Every role and retry must reserve
 * a new call ID and settle its raw receipt, including errors. Reservations are estimates:
 * already admitted provider calls may overrun them and may complete after admission locks.
 * This is not a provider-enforced spending cap or a purchased-credit balance.
 */
export class CreditBudget {
  readonly #maxCredits: number;
  readonly #reservations: Readonly<Record<string, number>>;
  readonly #rateCard: RateCard;
  readonly #calls = new Map<string, BudgetEntry>();
  #admissionDenied = false;

  constructor(options: CreditBudgetOptions) {
    if (!Number.isFinite(options.maxCredits) || options.maxCredits < 0) throw new RangeError("maxCredits must be finite and nonnegative");
    const reservations: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [model, value] of Object.entries(options.reservations)) {
      if (!model.trim() || !Number.isFinite(value) || value <= 0) throw new RangeError("Model reservations must be finite and positive");
      reservations[model] = value;
    }
    this.#maxCredits = options.maxCredits;
    this.#reservations = reservations;
    // Parsing creates an independent validated copy, preventing later caller mutations.
    this.#rateCard = parseRateCard(options.rateCard);
  }

  canReserve(model: string): boolean {
    if (!Object.hasOwn(this.#reservations, model) || !Object.hasOwn(this.#rateCard.models, model)
      || this.#rateCard.models[model]?.codexCreditsPerMillion === null) return false;
    const current = this.snapshot();
    return !current.locked && !exceeds(current.observedCredits + current.reservedCredits + this.#reservations[model]!, this.#maxCredits);
  }

  reserve(model: string, callId: string): boolean {
    if (typeof callId !== "string" || !callId.trim()) throw new RangeError("A nonempty call ID is required");
    if (this.#calls.has(callId)) throw new Error(`Call ID already reserved: ${callId}`);
    if (!this.canReserve(model)) { this.#admissionDenied = true; return false; }
    this.#calls.set(callId, { call: { callId, model, reservedCredits: this.#reservations[model]!, status: "reserved",
      credits: null, knownCreditsLower: 0, overrun: false, modelIdentity: "pending", issues: [] } });
    return true;
  }

  settle(callId: string, receipt: unknown): CreditSettlement {
    const entry = this.#calls.get(callId);
    if (!entry) throw new Error(`Call was not reserved: ${callId}`);
    if (entry.call.status !== "reserved") throw new Error(`Call was already settled: ${callId}`);
    const usage = extractTokenUsage(receipt);
    const modelIdentity = identity(receipt, entry.call.model, callId);
    let estimate;
    try { estimate = estimateCallCost(usage, entry.call.model, this.#rateCard).codexCredits; }
    catch {
      // A malformed extreme rate/usage combination must lock admission, not leave a free retry.
      estimate = { lower: 0, upper: null, exact: false, unknownReasons: ["Credit estimate arithmetic failed"] };
    }
    const identityValid = modelIdentity.state !== "conflicting-or-missing";
    // An identity conflict makes the requested model's prices inapplicable to this receipt.
    const lower = identityValid ? estimate.lower : 0;
    const known = identityValid && usage.source !== "missing" && usage.source !== "ambiguous"
      && usage.issues.length === 0 && estimate.exact;
    const credits = known ? estimate.lower : null;
    const overrun = exceeds(lower, entry.call.reservedCredits);
    entry.call = { ...entry.call, status: "settled", credits, knownCreditsLower: lower, overrun,
      modelIdentity: modelIdentity.state,
      issues: [...new Set([...modelIdentity.issues, ...usage.issues, ...estimate.unknownReasons])] };
    return { credits, overrun, usage };
  }

  snapshot(): CreditBudgetSnapshot {
    const calls = [...this.#calls.values()].map(({ call }) => ({ ...call, issues: [...call.issues] }));
    const observedCredits = calls.reduce((sum, call) => sum + call.knownCreditsLower, 0);
    const pending = calls.filter(call => call.status === "reserved");
    const reservedCredits = pending.reduce((sum, call) => sum + call.reservedCredits, 0);
    const unknownUsageCalls = calls.filter(call => call.status === "settled" && call.credits === null).length;
    const exceeded = exceeds(observedCredits, this.#maxCredits);
    return { maxCredits: this.#maxCredits, observedCredits, reservedCredits, unknownUsageCalls, exceeded,
      admissionDenied: this.#admissionDenied, reservationOverruns: calls.filter(call => call.overrun).length,
      activeReservations: pending.length, settledCalls: calls.length - pending.length,
      locked: unknownUsageCalls > 0 || exceeded, calls };
  }
}
