import { assertSupportedSchema, conforms, CodexWorkerError,
  type CodexCallOptions, type CodexCallResult, type CodexTranscript, type CodexUsage } from "./codex-worker.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekOptions extends CodexCallOptions {
  /** Explicit option only; otherwise DEEPSEEK_API_KEY. No host authentication store is read. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  /** Test seam. Production uses Node's global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface DeepSeekTranscript extends CodexTranscript {
  runtime: "deepseek";
  httpStatus: number | null;
  responseModel: string | null;
  usageCompleteness: "complete" | "partial-or-unknown";
  /** Provider usage object as received; cache/reasoning counters are evidence, not billing. */
  rawUsage: unknown;
}

export type DeepSeekResult<T = unknown> = CodexCallResult<T> & { transcript: DeepSeekTranscript };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function counter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join("[REDACTED]");
}

/** Deep-clone while replacing the credential anywhere it appears in reflected metadata. */
function redactValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redact(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value !== null && typeof value === "object") {
    // Object.fromEntries defines own data properties, so a reflected "__proto__"
    // or "constructor" key is scrubbed without mutating any prototype.
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [redact(key, secret), redactValue(item, secret)]));
  }
  return value;
}

/** https anywhere, http only for loopback tests. No credentials, query, or fragment. */
export function resolveDeepSeekBaseUrl(explicit?: string): URL {
  const raw = explicit ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new RangeError("Invalid DeepSeek base URL"); }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new RangeError("DeepSeek base URL must not contain credentials, query, or fragment");
  if (url.hostname === "") throw new RangeError("DeepSeek base URL must name a host");
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new RangeError("DeepSeek base URL must use https; http is allowed only for loopback tests");
  return url;
}

/** Append /chat/completions without doubling an existing /v1 or versioned prefix. */
export function deepSeekEndpoint(base: URL): string {
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/chat/completions`;
}

/** Complete only when every present counter is a valid value that reconciles with the totals. */
export function parseDeepSeekUsage(raw: unknown): { usage: CodexUsage[]; completeness: "complete" | "partial-or-unknown" } {
  const unknown = { usage: [], completeness: "partial-or-unknown" as const };
  const usage = asRecord(raw);
  if (!usage) return unknown;
  const inputTokens = counter(usage.prompt_tokens);
  const outputTokens = counter(usage.completion_tokens);
  const totalTokens = counter(usage.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return unknown;
  if (inputTokens + outputTokens !== totalTokens) return unknown;

  const hitPresent = Object.hasOwn(usage, "prompt_cache_hit_tokens");
  const missPresent = Object.hasOwn(usage, "prompt_cache_miss_tokens");
  const hit = counter(usage.prompt_cache_hit_tokens);
  const miss = counter(usage.prompt_cache_miss_tokens);
  // A present cache counter must be a bounded integer, and hit/miss must appear together and sum to the input.
  if (hitPresent && (hit === undefined || hit > inputTokens)) return unknown;
  if (missPresent && (miss === undefined || miss > inputTokens)) return unknown;
  if (hitPresent !== missPresent) return unknown;
  if (hitPresent && hit! + miss! !== inputTokens) return unknown;

  if (Object.hasOwn(usage, "prompt_tokens_details")) {
    const details = asRecord(usage.prompt_tokens_details);
    if (!details) return unknown;
    if (Object.hasOwn(details, "cached_tokens")) {
      const cached = counter(details.cached_tokens);
      if (cached === undefined || cached > inputTokens) return unknown;
      if (hitPresent && cached !== hit) return unknown;
    }
  }
  // Reasoning tokens are a bounded subset of the completion count; an out-of-range value is not billable evidence.
  if (Object.hasOwn(usage, "completion_tokens_details")) {
    const details = asRecord(usage.completion_tokens_details);
    if (!details) return unknown;
    if (Object.hasOwn(details, "reasoning_tokens")) {
      const reasoning = counter(details.reasoning_tokens);
      if (reasoning === undefined || reasoning > outputTokens) return unknown;
    }
  }
  return { usage: [{ event: { type: "deepseek.usage", usage }, inputTokens, outputTokens, totalTokens }], completeness: "complete" };
}

/**
 * Direct DeepSeek chat-completions call. The provider receives the supplied local
 * prompt and schema only; no tools, no CLI, no implicit host credential store.
 * Failures carry a bounded redacted transcript; the error message never includes
 * the provider body or a fetch cause that might hold headers.
 */
export async function callDeepSeek<T = unknown>(options: DeepSeekOptions): Promise<DeepSeekResult<T>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(options.maxTokens) || (options.maxTokens ?? 0) < 1) throw new RangeError("maxTokens must be a positive integer");
  assertSupportedSchema(options.schema);
  const base = resolveDeepSeekBaseUrl(options.baseUrl);
  const endpoint = deepSeekEndpoint(base);
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "")
    throw new Error("A DeepSeek API key is required; pass apiKey or set DEEPSEEK_API_KEY");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available");

  const startedAt = Date.now();
  let httpStatus: number | null = null;
  let responseModel: string | null = null;
  let bodyText = "";
  let usage: CodexUsage[] = [];
  let rawUsage: unknown;
  let usageCompleteness: DeepSeekTranscript["usageCompleteness"] = "partial-or-unknown";
  let timedOut = false;
  let cancelled = false;

  const transcript = (): DeepSeekTranscript => ({
    runtime: "deepseek", httpStatus, responseModel, usageCompleteness, rawUsage,
    events: [], usage, requestedModel: options.model, effectiveModelEvidence: responseModel,
    stdout: redact(bodyText, apiKey), stderr: "", exitCode: null, signal: null,
    timedOut, cancelled, durationMs: Date.now() - startedAt,
  });

  if (options.signal?.aborted) {
    cancelled = true;
    throw new CodexWorkerError("cancelled", "DeepSeek call was cancelled before the request", transcript());
  }

  const controller = new AbortController();
  const onAbort = () => { cancelled = true; controller.abort(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: "system", content: "You are one artifact-local code worker. Respond with a single JSON object and nothing else. The object must conform to this JSON Schema: " + JSON.stringify(options.schema) },
            { role: "user", content: options.prompt },
          ],
          response_format: { type: "json_object" },
          stream: false,
          max_tokens: options.maxTokens,
          thinking: { type: "disabled" },
        }),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new CodexWorkerError("timeout", "DeepSeek request timed out", transcript());
      if (cancelled) throw new CodexWorkerError("cancelled", "DeepSeek request was cancelled", transcript());
      throw new CodexWorkerError("nonzero-exit", "DeepSeek request failed before a response", transcript());
    }

    httpStatus = response.status;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BODY_BYTES) { tooLarge = true; await reader.cancel().catch(() => {}); controller.abort(); break; }
          chunks.push(Buffer.from(value));
        }
      } catch {
        if (timedOut) throw new CodexWorkerError("timeout", "DeepSeek request timed out while reading the response", transcript());
        if (cancelled) throw new CodexWorkerError("cancelled", "DeepSeek request was cancelled while reading the response", transcript());
        throw new CodexWorkerError("nonzero-exit", "DeepSeek response body could not be read", transcript());
      } finally { reader.releaseLock(); }
    }
    bodyText = Buffer.concat(chunks).toString("utf8");
    if (tooLarge) throw new CodexWorkerError("output-too-large", "DeepSeek response exceeded the bounded capture size", transcript());

    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { parsed = undefined; }
    const body = asRecord(parsed);
    if (body) {
      // Provider metadata is reflected, so the credential is scrubbed before it can be persisted or reported.
      responseModel = typeof body.model === "string" && body.model !== "" ? redact(body.model, apiKey) : null;
      const parsedUsage = parseDeepSeekUsage(body.usage);
      usage = redactValue(parsedUsage.usage, apiKey) as CodexUsage[];
      rawUsage = redactValue(body.usage, apiKey);
      usageCompleteness = parsedUsage.completeness;
    }
    if (!response.ok) {
      // A non-2xx receipt is never a complete metered total even when its usage
      // counters happen to reconcile. Keep any numeric lower bound, drop to unknown.
      usageCompleteness = "partial-or-unknown";
      throw new CodexWorkerError("nonzero-exit", `DeepSeek request failed with HTTP ${String(response.status)}`, transcript());
    }
    if (!body) throw new CodexWorkerError("malformed-events", "DeepSeek response is not a JSON object", transcript());
    const choices = Array.isArray(body.choices) ? body.choices : undefined;
    if (!choices || choices.length === 0) throw new CodexWorkerError("missing-output", "DeepSeek response contained no choices", transcript());
    const choice = asRecord(choices[0]);
    if (!choice) throw new CodexWorkerError("malformed-events", "DeepSeek choice was not an object", transcript());
    const finish = choice.finish_reason;
    if (finish !== "stop") throw new CodexWorkerError("missing-output", `DeepSeek response did not finish cleanly (${redact(String(finish), apiKey)})`, transcript());
    const message = asRecord(choice.message);
    const content = message && typeof message.content === "string" ? message.content : undefined;
    if (content === undefined || content.trim() === "")
      throw new CodexWorkerError("missing-output", "DeepSeek response contained no assistant content", transcript());
    const messageRecord = message!;
    if (messageRecord.role !== "assistant")
      throw new CodexWorkerError("missing-output", "DeepSeek response was not an assistant completion", transcript());
    // Tool-less contract: any refusal or legacy/malformed tool-call evidence is rejected,
    // matching the Go adapter. An explicit empty tool_calls array remains acceptable.
    if (messageRecord.refusal || messageRecord.function_call
      || (Object.hasOwn(messageRecord, "tool_calls")
        && (!Array.isArray(messageRecord.tool_calls) || messageRecord.tool_calls.length > 0)))
      throw new CodexWorkerError("missing-output", "DeepSeek response returned a refusal or tool call, which are unsupported", transcript());
    let result: T;
    try { result = JSON.parse(content) as T; } catch {
      throw new CodexWorkerError("malformed-output", "DeepSeek assistant content is not valid JSON", transcript());
    }
    if (!conforms(result, options.schema))
      throw new CodexWorkerError("malformed-output", "DeepSeek assistant content does not match the requested schema", transcript());
    return { result, requestedModel: options.model, usage, transcript: transcript() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
