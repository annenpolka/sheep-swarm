/** Offline, conditional estimates; these are not a provider billing statement. */
export interface TokenRates {
  readonly input: number | null;
  readonly cachedInput: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
}

export interface ModelRates {
  readonly apiUsdPerMillion: TokenRates | null;
  readonly codexCreditsPerMillion: TokenRates | null;
}

export interface RateCard {
  readonly format: 1;
  readonly models: Readonly<Record<string, ModelRates>>;
  readonly usdPerCredit: number | null;
}

export interface TokenUsage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly outputTokens: number | null;
  /** Already included in outputTokens; never charged a second time. */
  readonly reasoningOutputTokens: number | null;
  readonly source: "turn.completed" | "raw-usage" | "normalized" | "missing" | "ambiguous";
  readonly issues: readonly string[];
}

export interface CostInterval {
  readonly lower: number;
  readonly upper: number | null;
  readonly exact: boolean;
  readonly unknownReasons: readonly string[];
}

export interface CallEstimate {
  readonly apiUsd: CostInterval;
  readonly codexCredits: CostInterval;
  readonly codexUsdAtAssumedCreditPrice: CostInterval | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validPrice(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseRateCard(value: unknown): RateCard {
  const card = record(value), models = record(card?.models);
  if (card?.format !== 1 || !models || !validPrice(card.usdPerCredit)) throw new Error("Invalid rate card: require format 1, models, and nullable usdPerCredit");
  const parsed: Record<string, ModelRates> = Object.create(null) as Record<string, ModelRates>;
  function prices(value: unknown, label: string): TokenRates | null {
    if (value === null) return null;
    const row = record(value);
    if (!row || !["input", "cachedInput", "cacheWrite", "output"].every(key => Object.hasOwn(row, key) && validPrice(row[key]))) {
      throw new Error(`Invalid rates for ${label}: require nullable, finite, nonnegative input/cachedInput/cacheWrite/output`);
    }
    return { input: row.input as number | null, cachedInput: row.cachedInput as number | null,
      cacheWrite: row.cacheWrite as number | null, output: row.output as number | null };
  }
  for (const [model, value] of Object.entries(models)) {
    const row = record(value);
    if (!model || !row) throw new Error("Invalid model rate row");
    parsed[model] = { apiUsdPerMillion: prices(row.apiUsdPerMillion, `${model}.apiUsdPerMillion`),
      codexCreditsPerMillion: prices(row.codexCreditsPerMillion, `${model}.codexCreditsPerMillion`) };
  }
  return { format: 1, models: parsed, usdPerCredit: card.usdPerCredit };
}

const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function token(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) if (Object.hasOwn(row, key)) return integer(row[key]) ? row[key] : null;
  return null;
}

/** Prefer the terminal turn receipt over cumulative updates and normalized copies. */
export function extractTokenUsage(receipt: unknown): TokenUsage {
  const data = record(receipt), transcript = record(data?.transcript);
  const events = Array.isArray(transcript?.events) ? transcript.events.flatMap(item => record(item) ? [record(item)!] : []) : [];
  const completed = events.filter(event => event.type === "turn.completed" && record(event.usage));
  const raw = events.filter(event => record(event.usage) || event.type === "usage");
  const normalized = Array.isArray(transcript?.usage) ? transcript.usage.flatMap(item => record(item) ? [record(item)!] : []) : [];
  const selected = completed.length ? completed : raw.length ? raw : normalized;
  let source: TokenUsage["source"] = completed.length ? "turn.completed" : raw.length ? "raw-usage" : normalized.length ? "normalized" : "missing";
  if (selected.length > 1) source = "ambiguous";
  const item = selected.length === 1 ? selected[0]! : {};
  // Normalized rows in existing receipts may retain their original event.
  const original = record(record(item.event)?.usage);
  const row = record(item.usage) ?? original ?? item;
  const inputTokens = token(row, "input_tokens", "inputTokens", "prompt_tokens");
  const cachedInputTokens = token(row, "cached_input_tokens", "cachedInputTokens");
  const cacheWriteInputTokens = token(row, "cache_write_input_tokens", "cacheWriteInputTokens");
  const outputTokens = token(row, "output_tokens", "outputTokens", "completion_tokens");
  const reasoningOutputTokens = token(row, "reasoning_output_tokens", "reasoningOutputTokens");
  const issues: string[] = [];
  if (source === "ambiguous") issues.push("Multiple usage receipts with unknown cumulative semantics; not summed");
  if (inputTokens === null) issues.push("Missing or invalid input token count");
  if (outputTokens === null) issues.push("Missing or invalid output token count");
  if (cachedInputTokens === null) issues.push("Cached input token count is unknown");
  if (cacheWriteInputTokens === null) issues.push("Cache write input token count is unknown");
  if (inputTokens !== null && (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > inputTokens) {
    issues.push("Invalid cache token partition exceeds input tokens");
  }
  if (outputTokens !== null && reasoningOutputTokens !== null && reasoningOutputTokens > outputTokens) {
    issues.push("Invalid reasoning token count exceeds output tokens");
  }
  return { inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, source, issues };
}

function interval(lower: number, upper: number | null, reasons: readonly string[]): CostInterval {
  if (!Number.isFinite(lower) || upper !== null && !Number.isFinite(upper)) throw new Error("Cost calculation overflow");
  return { lower, upper, exact: upper !== null && upper === lower,
    unknownReasons: [...new Set(reasons)] };
}

export function sumCostIntervals(values: readonly CostInterval[]): CostInterval {
  return interval(values.reduce((sum, value) => sum + value.lower, 0),
    values.some(value => value.upper === null) ? null : values.reduce((sum, value) => sum + value.upper!, 0),
    values.flatMap(value => value.unknownReasons));
}

/** Input includes cached reads and cache writes; output includes reasoning. */
export function estimateTokenCost(usage: TokenUsage, rates: TokenRates | null, label: string): CostInterval {
  const reasons: string[] = [];
  if (usage.issues.some(issue => issue.startsWith("Invalid ")) || usage.source === "ambiguous") {
    return interval(0, null, [...usage.issues, `${label}: invalid or ambiguous usage cannot be priced`]);
  }
  const prices = rates ?? { input: null, cachedInput: null, cacheWrite: null, output: null };
  const pieces: CostInterval[] = [];
  function fixed(tokens: number, price: number | null, category: string): CostInterval {
    if (tokens === 0) return interval(0, 0, []);
    return price === null ? interval(0, null, [`${label}: ${category} price is unknown`])
      : interval(tokens * price / 1_000_000, tokens * price / 1_000_000, []);
  }
  if (usage.inputTokens === null) pieces.push(interval(0, null, [`${label}: input token count is unknown`]));
  else {
    const cached = usage.cachedInputTokens, written = usage.cacheWriteInputTokens;
    if (cached !== null) pieces.push(fixed(cached, prices.cachedInput, "cached input"));
    if (written !== null) pieces.push(fixed(written, prices.cacheWrite, "cache write"));
    const remaining = usage.inputTokens - (cached ?? 0) - (written ?? 0);
    if (remaining > 0) {
      const possibilities = [prices.input];
      if (cached === null) { possibilities.push(prices.cachedInput); reasons.push(`${label}: cached input split is unknown`); }
      if (written === null) { possibilities.push(prices.cacheWrite); reasons.push(`${label}: cache write input split is unknown`); }
      const known = possibilities.filter((value): value is number => value !== null);
      const minimum = possibilities.some(value => value === null) ? 0 : Math.min(...known);
      const maximum = possibilities.some(value => value === null) ? null : Math.max(...known);
      if (maximum === null) reasons.push(`${label}: an applicable input price is unknown`);
      pieces.push(interval(remaining * minimum / 1_000_000, maximum === null ? null : remaining * maximum / 1_000_000, reasons));
    }
  }
  pieces.push(usage.outputTokens === null ? interval(0, null, [`${label}: output token count is unknown`])
    : fixed(usage.outputTokens, prices.output, "output"));
  return sumCostIntervals(pieces);
}

export function estimateCallCost(usage: TokenUsage, requestedModel: string, card: RateCard): CallEstimate {
  const model = Object.hasOwn(card.models, requestedModel) ? card.models[requestedModel] : undefined;
  const apiUsd = estimateTokenCost(usage, model?.apiUsdPerMillion ?? null, "API USD");
  const codexCredits = estimateTokenCost(usage, model?.codexCreditsPerMillion ?? null, "Codex credits");
  const exchange = card.usdPerCredit;
  const codexUsdAtAssumedCreditPrice = exchange === null ? null : interval(codexCredits.lower * exchange,
    codexCredits.upper === null ? null : codexCredits.upper * exchange, codexCredits.unknownReasons);
  return { apiUsd, codexCredits, codexUsdAtAssumedCreditPrice };
}

export function multiplyCostEstimate(cost: CallEstimate, count: number): CallEstimate {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Call count must be a positive safe integer");
  const multiply = (value: CostInterval) => interval(value.lower * count, value.upper === null ? null : value.upper * count, value.unknownReasons);
  return { apiUsd: multiply(cost.apiUsd), codexCredits: multiply(cost.codexCredits),
    codexUsdAtAssumedCreditPrice: cost.codexUsdAtAssumedCreditPrice === null ? null : multiply(cost.codexUsdAtAssumedCreditPrice) };
}

export function estimatePlannedUsage(value: unknown, card: RateCard) {
  const row = record(value);
  if (!row || typeof row.model !== "string" || !row.model || !integer(row.calls) || row.calls < 1) {
    throw new Error("Scenario rows require model and a positive integer calls");
  }
  for (const key of ["inputTokensPerCall", "cachedInputTokensPerCall", "cacheWriteInputTokensPerCall", "outputTokensPerCall"]) {
    if (!Object.hasOwn(row, key) || row[key] !== null && !integer(row[key])) throw new Error(`Scenario ${key} must be a nonnegative integer or null`);
  }
  const usage = extractTokenUsage({ transcript: { usage: [{ inputTokens: row.inputTokensPerCall,
    cachedInputTokens: row.cachedInputTokensPerCall, cacheWriteInputTokens: row.cacheWriteInputTokensPerCall,
    outputTokens: row.outputTokensPerCall }] } });
  if (usage.issues.some(issue => issue.startsWith("Invalid "))) throw new Error("Scenario cache partition exceeds input");
  const perCall = estimateCallCost(usage, row.model, card);
  return { model: row.model, calls: row.calls, usagePerCall: usage, perCall, total: multiplyCostEstimate(perCall, row.calls) };
}
