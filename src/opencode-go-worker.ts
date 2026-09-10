import { randomUUID } from "node:crypto";
import { extractTokenUsage } from "./cost-estimate.ts";
import { assertSupportedSchema, conforms, CodexWorkerError,
  type CodexCallOptions, type CodexCallResult, type CodexTranscript, type CodexUsage } from "./codex-worker.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const MAX_SESSION_BYTES = 256;

export type OpenCodeGoProtocol = "chat-completions" | "responses" | "messages";
export interface OpenCodeGoOptions extends CodexCallOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxTokens?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Explicit DeepSeek thinking control; omission keeps the provider default. */
  readonly thinking?: "enabled" | "disabled";
}
export interface OpenCodeGoTranscript extends CodexTranscript {
  runtime: "opencode-go";
  apiFormat: OpenCodeGoProtocol;
  httpStatus: number | null;
  responseModel: string | null;
  usageCompleteness: "complete" | "partial-or-unknown";
  rawUsage: unknown;
  sessionId: string;
}
export type OpenCodeGoResult<T = unknown> = CodexCallResult<T> & { transcript: OpenCodeGoTranscript };

const CATALOG: Readonly<Record<string, OpenCodeGoProtocol>> = {
  "grok-4.6": "responses", "gpt-5.6-luna": "responses", "muse-spark-1.3-contributor": "responses", "muse-spark-1.2-contributor": "responses",
  "glm-5.3-flash": "chat-completions", "glm-5.3": "chat-completions", "glm-5.2": "chat-completions", "glm-5.1": "chat-completions",
  "kimi-k3": "chat-completions", "kimi-k2.7-code": "chat-completions", "kimi-k2.6": "chat-completions", "longcat-2.0": "chat-completions",
  "deepseek-flash": "chat-completions", "deepseek-v4-pro": "chat-completions", "deepseek-v4-flash": "chat-completions", "deepseek-v4-flash-vision-exp": "chat-completions",
  "mimo-v2.5": "chat-completions", "mimo-v2.5-pro": "chat-completions", "hy4-preview": "chat-completions", "hy3": "chat-completions",
  "minimax-m3": "messages", "minimax-m2.7": "messages", "minimax-m2.5": "messages",
  "qwen3.8-max": "messages", "qwen3.8-flash": "messages", "qwen3.7-max": "messages", "qwen3.7-plus": "messages", "qwen3.6-plus": "messages",
};

export function assertOpenCodeGoModel(model: string): void {
  if (typeof model !== "string" || !Object.hasOwn(CATALOG, model)) throw new RangeError(`Unsupported OpenCode Go model: ${String(model)}`);
}
export function openCodeGoProtocol(model: string): OpenCodeGoProtocol { assertOpenCodeGoModel(model); return CATALOG[model]!; }

function record(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function redact(value: string, secret: string): string { return secret === "" ? value : value.split(secret).join("[REDACTED]"); }
function safeValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redact(value, secret);
  if (Array.isArray(value)) return value.map(v => safeValue(v, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [redact(k, secret), safeValue(v, secret)]));
  return value;
}
function resolveBase(raw?: string): URL {
  let url: URL; try { url = new URL(raw ?? process.env.OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL); } catch { throw new RangeError("Invalid OpenCode Go base URL"); }
  if (url.username || url.password || url.search || url.hash) throw new RangeError("OpenCode Go base URL must not contain credentials, query, or fragment");
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new RangeError("OpenCode Go base URL must use https; http is allowed only for loopback tests");
  return url;
}
function endpoint(base: URL, format: OpenCodeGoProtocol): string { return `${base.origin}${base.pathname.replace(/\/+$/, "")}/${format === "chat-completions" ? "chat/completions" : format}`; }
function validSession(value: string): boolean { return value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_SESSION_BYTES && !/[\r\n]/.test(value); }

function parseUsage(raw: unknown, format: OpenCodeGoProtocol, secret: string): { usage: CodexUsage[]; complete: boolean } {
  // Use the same provider-specific arithmetic for live normalization and receipt auditing.
  const parsed = extractTokenUsage({ transcript: { runtime: "opencode-go", apiFormat: format,
    rawUsage: raw, usageCompleteness: "complete", httpStatus: 200 } });
  const input = parsed.inputTokens, output = parsed.outputTokens;
  const complete = input !== null && output !== null && Number.isSafeInteger(input + output)
    && !parsed.partial && !parsed.issues.some(issue => issue.startsWith("Invalid "));
  const usage: CodexUsage[] = input === null && output === null ? [] : [{
    event: { type: "opencode-go.usage", usage: safeValue(raw, secret) },
    ...(input === null ? {} : { inputTokens: input }),
    ...(output === null ? {} : { outputTokens: output }),
    ...(complete ? { totalTokens: input! + output! } : {}),
  }];
  return { usage, complete };
}

/** Direct, bounded, tool-less Go request. No implicit host authentication or retry. */
export async function callOpenCodeGo<T = unknown>(options: OpenCodeGoOptions): Promise<OpenCodeGoResult<T>> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive integer");
  if (!Number.isSafeInteger(options.maxTokens) || (options.maxTokens ?? 0) < 1)
    throw new RangeError("maxTokens must be a positive integer");
  assertSupportedSchema(options.schema);
  assertOpenCodeGoModel(options.model);
  if (options.thinking !== undefined &&
    ((options.thinking !== "enabled" && options.thinking !== "disabled") || !options.model.startsWith("deepseek-")))
    throw new RangeError("thinking must be enabled or disabled and requires an OpenCode Go DeepSeek model");
  const format = CATALOG[options.model]!;
  const base = resolveBase(options.baseUrl);
  const apiKey = options.apiKey ?? process.env.OPENCODE_GO_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "")
    throw new Error("An OpenCode Go API key is required; pass apiKey or set OPENCODE_GO_API_KEY");
  const sessionId = options.sessionId ?? randomUUID();
  if (!validSession(sessionId))
    throw new RangeError("sessionId must be non-empty, at most 256 UTF-8 bytes, and contain no CR/LF");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available");

  const startedAt = Date.now();
  let status: number | null = null;
  let responseModel: string | null = null;
  let rawUsage: unknown;
  let usage: CodexUsage[] = [];
  let complete = false, bodyText = "", timedOut = false, cancelled = false;
  const transcript = (): OpenCodeGoTranscript => ({
    runtime: "opencode-go", apiFormat: format, httpStatus: status, responseModel,
    usageCompleteness: complete ? "complete" : "partial-or-unknown",
    rawUsage: safeValue(rawUsage, apiKey), sessionId, events: [], usage,
    requestedModel: options.model, effectiveModelEvidence: responseModel,
    stdout: redact(bodyText, apiKey), stderr: "", exitCode: null, signal: null,
    timedOut, cancelled, durationMs: Date.now() - startedAt,
  });
  if (options.signal?.aborted) {
    cancelled = true;
    throw new CodexWorkerError("cancelled", "OpenCode Go call was cancelled before the request", transcript());
  }
  const controller = new AbortController();
  const abort = () => { cancelled = true; controller.abort(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
  try {
    const instruction = "Respond with one JSON object only, conforming to this JSON Schema: " + JSON.stringify(options.schema);
    let payload: Record<string, unknown>;
    if (format === "chat-completions") {
      payload = { model: options.model, messages: [
        { role: "system", content: instruction }, { role: "user", content: options.prompt },
      ], response_format: { type: "json_object" }, stream: false, max_tokens: options.maxTokens,
      ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking } }) };
    } else if (format === "responses") {
      payload = { model: options.model, input: [
        { role: "system", content: [{ type: "input_text", text: instruction }] },
        { role: "user", content: [{ type: "input_text", text: options.prompt }] },
      ], text: { format: { type: "json_schema", name: "sheep_response", strict: true, schema: options.schema } },
      stream: false, store: false, max_output_tokens: options.maxTokens };
    } else {
      payload = { model: options.model, system: instruction,
        messages: [{ role: "user", content: options.prompt }], stream: false, max_tokens: options.maxTokens };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json", "user-agent": "sheep-swarm/0.0.0", "x-opencode-session": sessionId,
    };
    if (format === "messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else headers.authorization = `Bearer ${apiKey}`;

    let response: Response;
    try {
      response = await fetchImpl(endpoint(base, format), { method: "POST", redirect: "error", headers,
        body: JSON.stringify(payload), signal: controller.signal });
    } catch {
      if (timedOut) throw new CodexWorkerError("timeout", "OpenCode Go request timed out", transcript());
      if (cancelled) throw new CodexWorkerError("cancelled", "OpenCode Go request was cancelled", transcript());
      throw new CodexWorkerError("nonzero-exit", "OpenCode Go request failed before a response", transcript());
    }
    status = response.status;
    const reader = response.body?.getReader(), chunks: Buffer[] = [];
    let bytes = 0, tooLarge = false;
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BODY_BYTES) {
            tooLarge = true;
            await reader.cancel().catch(() => {});
            controller.abort();
            break;
          }
          chunks.push(Buffer.from(next.value));
        }
      } catch {
        if (timedOut) throw new CodexWorkerError("timeout", "OpenCode Go response timed out while reading", transcript());
        if (cancelled) throw new CodexWorkerError("cancelled", "OpenCode Go response was cancelled while reading", transcript());
        throw new CodexWorkerError("nonzero-exit", "OpenCode Go response body could not be read", transcript());
      } finally { reader.releaseLock(); }
    }
    bodyText = Buffer.concat(chunks).toString("utf8");
    if (tooLarge) throw new CodexWorkerError("output-too-large", "OpenCode Go response exceeded the bounded capture size", transcript());
    let parsed: unknown;
    try { parsed = JSON.parse(bodyText); } catch { parsed = undefined; }
    const body = record(parsed);
    if (body) {
      responseModel = typeof body.model === "string" ? redact(body.model, apiKey) : null;
      rawUsage = body.usage;
      const parsedUsage = parseUsage(body.usage, format, apiKey);
      usage = parsedUsage.usage;
      complete = parsedUsage.complete;
    }
    if (!response.ok) {
      complete = false;
      throw new CodexWorkerError("nonzero-exit", `OpenCode Go request failed with HTTP ${String(status)}`, transcript());
    }
    if (!body) throw new CodexWorkerError("malformed-events", "OpenCode Go response is not a JSON object", transcript());
    const reject = (message: string): never => { throw new CodexWorkerError("missing-output", message, transcript()); };
    let content: string | undefined;
    if (format === "chat-completions") {
      const choice = Array.isArray(body.choices) ? record(body.choices[0]) : undefined;
      const message = choice && record(choice.message);
      if (choice?.finish_reason !== "stop") reject("OpenCode Go response did not finish cleanly");
      if (message?.role !== "assistant") reject("OpenCode Go completion was not an assistant message");
      if (message?.refusal || message?.function_call
        || (Object.hasOwn(message!, "tool_calls") && (!Array.isArray(message!.tool_calls) || message!.tool_calls.length)))
        reject("OpenCode Go returned a refusal or tool call");
      content = typeof message!.content === "string" ? message!.content : undefined;
    } else if (format === "responses") {
      if (body.status !== "completed" || body.error || body.incomplete_details) reject("OpenCode Go response did not complete");
      const output = Array.isArray(body.output) ? body.output : [];
      const texts: string[] = [];
      for (const item of output) {
        const row = record(item);
        if (row?.type === "reasoning") continue;
        if (row?.type !== "message" || row.role !== "assistant"
          || (row.status !== undefined && row.status !== "completed")) reject("OpenCode Go returned unsupported response output");
        const parts = Array.isArray(row!.content) ? row!.content : [];
        for (const part of parts) {
          const value = record(part);
          if (value?.type !== "output_text" || typeof value.text !== "string") reject("OpenCode Go returned unsupported message content");
          texts.push(value!.text as string);
        }
      }
      content = texts.join("");
    } else {
      if (body.type !== "message" || body.role !== "assistant" || body.stop_reason !== "end_turn")
        reject("OpenCode Go message did not finish as an assistant turn");
      const parts = Array.isArray(body.content) ? body.content : [];
      const texts: string[] = [];
      for (const part of parts) {
        const value = record(part);
        if (value?.type === "thinking" || value?.type === "redacted_thinking") continue;
        if (value?.type !== "text" || typeof value.text !== "string") reject("OpenCode Go returned unsupported message content");
        texts.push(value!.text as string);
      }
      content = texts.join("");
    }
    if (!content || content.trim() === "") reject("OpenCode Go response contained no assistant content");
    let result: T;
    try { result = JSON.parse(content!) as T; } catch {
      throw new CodexWorkerError("malformed-output", "OpenCode Go assistant content is not valid JSON", transcript());
    }
    if (!conforms(result, options.schema))
      throw new CodexWorkerError("malformed-output", "OpenCode Go assistant content does not match the requested schema", transcript());
    return { result, requestedModel: options.model, usage, transcript: transcript() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
