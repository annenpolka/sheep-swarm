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
  readonly source: "turn.completed" | "raw-usage" | "normalized" | "docker-agent.per-message" | "deepseek.chat-completion" | "opencode-go.chat-completions" | "opencode-go.responses" | "opencode-go.messages" | "missing" | "ambiguous";
  readonly partial?: boolean;
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
  if (transcript?.runtime === "docker-agent") return dockerUsage(transcript);
  if (transcript?.runtime === "deepseek") return deepSeekUsage(transcript);
  if (transcript?.runtime === "opencode-go") return openCodeGoUsage(transcript);
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

/** Offline usage reader for the OpenCode Go gateway.  Go's subscription is
 * deliberately not treated as either a Codex credit balance or direct API
 * dollars; this only extracts provider-reported token quantities. */
function openCodeGoUsage(transcript: Record<string, unknown>): TokenUsage {
  const row = record(transcript.rawUsage), format = transcript.apiFormat;
  const source = format === "chat-completions" ? "opencode-go.chat-completions"
    : format === "responses" ? "opencode-go.responses"
      : format === "messages" ? "opencode-go.messages" : "ambiguous";
  const unknown = (issue: string): TokenUsage => ({ inputTokens: null, outputTokens: null,
    cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null,
    source, partial: true, issues: [issue] });
  if (!row) return unknown("Missing OpenCode Go usage");
  if (source === "ambiguous") return unknown("Invalid or missing OpenCode Go apiFormat");

  const issues: string[] = [];
  let inputTokens: number | null;
  let outputTokens: number | null;
  let cachedInputTokens: number | null = null;
  let cacheWriteInputTokens: number | null = null;
  let total: number | null = null;
  let reasoningOutputTokens: number | null = null;
  if (format === "chat-completions") {
    inputTokens = token(row, "prompt_tokens");
    outputTokens = token(row, "completion_tokens");
    total = token(row, "total_tokens");
    const details = record(row.prompt_tokens_details), completion = record(row.completion_tokens_details);
    const hit = token(row, "prompt_cache_hit_tokens"), miss = token(row, "prompt_cache_miss_tokens");
    const detailCached = details ? token(details, "cached_tokens") : null;
    const derivedCached = inputTokens !== null && miss !== null && integer(inputTokens - miss) ? inputTokens - miss : null;
    cachedInputTokens = hit ?? detailCached ?? derivedCached;
    reasoningOutputTokens = completion ? token(completion, "reasoning_tokens") : null;
    if (Object.hasOwn(row, "prompt_tokens_details") && !details) issues.push("Invalid OpenCode Go cache details object");
    if (Object.hasOwn(row, "completion_tokens_details") && !completion) issues.push("Invalid OpenCode Go completion details object");
    for (const [sourceRow, key, value, limit] of [
      [row, "prompt_cache_hit_tokens", hit, inputTokens],
      [row, "prompt_cache_miss_tokens", miss, inputTokens],
      [details, "cached_tokens", detailCached, inputTokens],
      [completion, "reasoning_tokens", reasoningOutputTokens, outputTokens],
    ] as const) {
      if (sourceRow && Object.hasOwn(sourceRow, key) && (value === null || limit === null || value > limit))
        issues.push(`Invalid OpenCode Go ${key}`);
    }
    if (hit !== null && miss !== null && inputTokens !== null && hit + miss !== inputTokens)
      issues.push("Invalid OpenCode Go cache hit/miss partition");
    if (hit !== null && detailCached !== null && hit !== detailCached)
      issues.push("Invalid OpenCode Go cache detail contradiction");
  } else if (format === "responses") {
    inputTokens = token(row, "input_tokens");
    outputTokens = token(row, "output_tokens");
    total = token(row, "total_tokens");
    const details = record(row.input_tokens_details), completion = record(row.output_tokens_details);
    cachedInputTokens = details ? token(details, "cached_tokens") : null;
    reasoningOutputTokens = completion ? token(completion, "reasoning_tokens") : null;
    if (Object.hasOwn(row, "input_tokens_details") && !details) issues.push("Invalid OpenCode Go input details object");
    if (Object.hasOwn(row, "output_tokens_details") && !completion) issues.push("Invalid OpenCode Go output details object");
    if (details && Object.hasOwn(details, "cached_tokens") && cachedInputTokens === null) issues.push("Invalid OpenCode Go cached_tokens");
    if (completion && Object.hasOwn(completion, "reasoning_tokens") && reasoningOutputTokens === null) issues.push("Invalid OpenCode Go reasoning_tokens");
  } else {
    // Anthropic Messages reports uncached input_tokens. Cache read/write are
    // additional input subsets, so the metered input total includes each once.
    const baseInput = token(row, "input_tokens");
    outputTokens = token(row, "output_tokens");
    total = null;
    cachedInputTokens = Object.hasOwn(row, "cache_read_input_tokens") ? token(row, "cache_read_input_tokens") : 0;
    cacheWriteInputTokens = Object.hasOwn(row, "cache_creation_input_tokens") ? token(row, "cache_creation_input_tokens") : 0;
    // Preserve a trustworthy uncached base as a lower bound when a cache
    // subset is malformed; the Invalid issue still prevents settlement.
    const sum = baseInput !== null
      ? baseInput + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) : null;
    inputTokens = sum !== null && integer(sum) ? sum : null;
  }
  if (inputTokens === null) issues.push("Missing or invalid OpenCode Go input token count");
  if (outputTokens === null) issues.push("Missing or invalid OpenCode Go output token count");
  const required = format === "chat-completions" ? ["prompt_tokens", "completion_tokens", "total_tokens"]
    : format === "responses" ? ["input_tokens", "output_tokens", "total_tokens"] : ["input_tokens", "output_tokens"];
  for (const key of required) {
    if (!Object.hasOwn(row, key) || token(row, key) === null)
      issues.push(`Invalid OpenCode Go ${key}`);
  }
  if (format === "messages") {
    for (const key of ["cache_read_input_tokens", "cache_creation_input_tokens"])
      if (Object.hasOwn(row, key) && token(row, key) === null) issues.push(`Invalid OpenCode Go ${key}`);
  }
  if (format === "messages" && Object.hasOwn(row, "total_tokens")) {
    total = token(row, "total_tokens");
    if (total === null) issues.push("Invalid OpenCode Go total_tokens");
  }
  if (inputTokens !== null && outputTokens !== null && !integer(inputTokens + outputTokens))
    issues.push("Invalid OpenCode Go total token overflow");
  if (total !== null && (inputTokens === null || outputTokens === null || inputTokens + outputTokens !== total))
    issues.push("Invalid OpenCode Go input/output/total token arithmetic");
  if (inputTokens !== null && (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0) > inputTokens)
    issues.push("Invalid OpenCode Go cache token partition exceeds input tokens");
  if (outputTokens !== null && reasoningOutputTokens !== null && reasoningOutputTokens > outputTokens)
    issues.push("Invalid OpenCode Go reasoning token count exceeds output tokens");
  if (cachedInputTokens === null) issues.push("Cached input token count is unknown");
  if (cacheWriteInputTokens === null) issues.push("Cache write input token count is unknown");
  const partial = transcript.usageCompleteness !== "complete" || transcript.timedOut === true
    || transcript.cancelled === true || transcript.httpStatus !== 200;
  if (partial) issues.push("OpenCode Go usage is a known lower bound; the complete total is unknown");
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens,
    reasoningOutputTokens, source, partial, issues };
}

/** Offline receipt reader; keep independent of execution adapters and their imports. */
function deepSeekUsage(transcript: Record<string, unknown>): TokenUsage {
  const row = record(transcript.rawUsage), issues: string[] = [];
  const inputTokens = row ? token(row, "prompt_tokens") : null;
  const outputTokens = row ? token(row, "completion_tokens") : null;
  const total = row ? token(row, "total_tokens") : null;
  const details = record(row?.prompt_tokens_details), completion = record(row?.completion_tokens_details);
  const hit = row ? token(row, "prompt_cache_hit_tokens") : null;
  const miss = row ? token(row, "prompt_cache_miss_tokens") : null;
  const cachedDetail = details ? token(details, "cached_tokens") : null;
  const reasoningOutputTokens = completion ? token(completion, "reasoning_tokens") : null;
  const cachedInputTokens = hit ?? cachedDetail ?? (inputTokens !== null && miss !== null ? inputTokens - miss : null);
  if (inputTokens === null || outputTokens === null || total === null
    || !integer(inputTokens + outputTokens) || inputTokens + outputTokens !== total)
    issues.push("Invalid DeepSeek input/output/total token arithmetic");
  for (const [source, key, value, limit] of [
    [row, "prompt_cache_hit_tokens", hit, inputTokens],
    [row, "prompt_cache_miss_tokens", miss, inputTokens],
    [details, "cached_tokens", cachedDetail, inputTokens],
    [completion, "reasoning_tokens", reasoningOutputTokens, outputTokens],
  ] as const) {
    if (source && Object.hasOwn(source, key) && (value === null || limit === null || value > limit))
      issues.push(`Invalid DeepSeek ${key}`);
  }
  if (row && ((Object.hasOwn(row, "prompt_tokens_details") && !details)
    || (Object.hasOwn(row, "completion_tokens_details") && !completion)))
    issues.push("Invalid DeepSeek token details object");
  if (hit !== null && miss !== null && hit + miss !== inputTokens
    || hit !== null && cachedDetail !== null && hit !== cachedDetail
    || miss !== null && cachedDetail !== null && miss + cachedDetail !== inputTokens)
    issues.push("Invalid DeepSeek cache partition");
  if (cachedInputTokens === null) issues.push("Cached input token count is unknown");
  const partial = transcript.usageCompleteness !== "complete" || transcript.timedOut === true
    || transcript.cancelled === true || transcript.httpStatus !== 200;
  if (partial) issues.push("DeepSeek usage is a known lower bound; the complete total is unknown");
  return { inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens: 0, reasoningOutputTokens,
    source: row ? "deepseek.chat-completion" : "missing", partial, issues };
}

function dockerUsage(transcript: Record<string, unknown>): TokenUsage {
  const unknown = (issue: string): TokenUsage => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null,
    cacheWriteInputTokens: null, reasoningOutputTokens: null, source: "ambiguous", partial: true, issues: [issue] });
  // Keep the offline estimator self-contained; pinned snapshot dispatchers copy
  // it without installing or importing an execution runtime.
  if (transcript.runtimeVersion !== "v1.137.0" || typeof transcript.requestedModel !== "string" || !Array.isArray(transcript.events))
    return unknown("Unrecognized Docker Agent usage contract");
  const events = transcript.events.map(value => record(value));
  const starts = events.filter(event => event?.type === "stream_started"), stops = events.filter(event => event?.type === "stream_stopped");
  let partial = transcript.usageCompleteness !== "complete" || events.some(event => !event)
    || starts.length !== 1 || stops.length !== 1 || stops[0]?.reason !== "normal"
    || events.indexOf(starts[0]) > events.indexOf(stops[0])
    || new Set(events.filter(event => event?.session_id).map(event => event!.session_id)).size !== 1
    || events.some(event => event?.type === "error" || event?.type === "budget_exceeded");
  const rows: Record<string, unknown>[] = [], seen = new Set<string>();
  for (const event of events.filter(event => event?.type === "token_usage")) {
    const row = record(record(event?.usage)?.last_message), key = JSON.stringify(event);
    if (!row || !["input_tokens", "output_tokens", "cached_input_tokens", "cached_write_tokens"].every(key => integer(row[key]))) { partial = true; continue; }
    if (seen.has(key)) { partial = true; continue; }
    seen.add(key); rows.push(row);
  }
  if (!rows.length) return unknown("Missing Docker Agent per-message usage");
  if (rows.some(row => row.Model !== undefined && row.Model !== transcript.requestedModel && row.Model !== `chatgpt/${transcript.requestedModel}`))
    return unknown("Conflicting Docker Agent configured model");
  const sum = (key: string): number | null => {
    if (!rows.every(row => integer(row[key]))) return null;
    const total = rows.reduce((value, row) => value + (row[key] as number), 0);
    return integer(total) ? total : null;
  };
  const cachedInputTokens = sum("cached_input_tokens"), cacheWriteInputTokens = sum("cached_write_tokens");
  const uncached = sum("input_tokens"), outputTokens = sum("output_tokens");
  if (cachedInputTokens === null || cacheWriteInputTokens === null || uncached === null || outputTokens === null
    || !integer(uncached + cachedInputTokens + cacheWriteInputTokens)) return unknown("Invalid Docker Agent token arithmetic");
  return { inputTokens: uncached + cachedInputTokens + cacheWriteInputTokens, outputTokens,
    cachedInputTokens, cacheWriteInputTokens, reasoningOutputTokens: sum("reasoning_tokens"), source: "docker-agent.per-message", partial,
    issues: partial ? ["Docker Agent usage is a known lower bound; the complete total is unknown"] : [] };
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
  const known = sumCostIntervals(pieces);
  return usage.partial ? interval(known.lower, null, [...known.unknownReasons, ...usage.issues, `${label}: unfinished usage total is unknown`]) : known;
}

export function estimateCallCost(usage: TokenUsage, requestedModel: string, card: RateCard): CallEstimate {
  // OpenCode Go's subscription/accounting contract has no verified per-token
  // USD or Codex-credit rate here. Never reuse a same-named provider rate card.
  const model = usage.source.startsWith("opencode-go.") ? undefined
    : Object.hasOwn(card.models, requestedModel) ? card.models[requestedModel] : undefined;
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
