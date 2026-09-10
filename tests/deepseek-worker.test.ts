import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { callDeepSeek, deepSeekEndpoint, resolveDeepSeekBaseUrl, type DeepSeekOptions, type DeepSeekTranscript } from "../src/deepseek-worker.ts";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const REQUEST_MODEL = "deepseek-v4.1-flash-expires-on-0910";

function options(extra: Record<string, unknown> = {}): DeepSeekOptions {
  return { model: REQUEST_MODEL, prompt: "Return the requested object.", schema, cwd: process.cwd(),
    timeoutMs: 2_000, maxTokens: 256, apiKey: "test-key", ...extra } as DeepSeekOptions;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "deepseek-flash",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }],
    usage: { prompt_tokens: 39, completion_tokens: 5, total_tokens: 44, prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 39, prompt_tokens_details: { cached_tokens: 0 } },
    ...overrides,
  };
}

interface Captured { url: string; init: RequestInit | undefined; body: Record<string, unknown> }
function jsonFetch(payload: unknown, status = 200): { fetch: typeof globalThis.fetch; captured: Captured } {
  const captured: Captured = { url: "", init: undefined, body: {} };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(input);
    captured.init = init;
    if (typeof init?.body === "string") captured.body = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, captured };
}

test("valid response keeps request and provider model distinct and preserves usage/cache counters", async () => {
  const { fetch } = jsonFetch(validBody());
  const result = await callDeepSeek<{ ok: boolean }>({ ...options(), fetch });
  assert.deepEqual(result.result, { ok: true });
  assert.equal(result.requestedModel, REQUEST_MODEL);
  assert.equal(result.transcript.requestedModel, REQUEST_MODEL);
  assert.equal(result.transcript.responseModel, "deepseek-flash");
  assert.equal(result.transcript.effectiveModelEvidence, "deepseek-flash");
  assert.notEqual(result.requestedModel, result.transcript.responseModel);
  assert.equal(result.transcript.runtime, "deepseek");
  assert.equal(result.transcript.usageCompleteness, "complete");
  assert.equal(result.usage[0]?.inputTokens, 39);
  assert.equal(result.usage[0]?.outputTokens, 5);
  assert.equal(result.usage[0]?.totalTokens, 44);
  assert.equal((result.transcript.rawUsage as Record<string, unknown>).prompt_cache_hit_tokens, 0);
  assert.equal(result.transcript.stdout, JSON.stringify(validBody()));
});

test("request maps the caller schema, tools-less JSON mode, bearer auth and explicit bounds", async () => {
  const { fetch, captured } = jsonFetch(validBody());
  await callDeepSeek({ ...options(), fetch });
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.equal((captured.init?.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.equal((captured.init?.headers as Record<string, string>)["content-type"], "application/json");
  assert.equal(captured.init?.redirect, "error");
  assert.equal(captured.body.model, REQUEST_MODEL);
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.max_tokens, 256);
  assert.deepEqual(captured.body.response_format, { type: "json_object" });
  assert.deepEqual(captured.body.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(captured.body, "tools"), false);
  const messages = captured.body.messages as { role: string; content: string }[];
  assert.equal(messages.find((m) => m.role === "user")?.content, "Return the requested object.");
  assert.ok(messages.some((m) => m.role === "system" && m.content.includes(JSON.stringify(schema))));
});

test("base URL accepts /v1 and loopback http but rejects credentials, query, fragment and remote http", () => {
  assert.equal(deepSeekEndpoint(resolveDeepSeekBaseUrl("https://api.deepseek.com")), "https://api.deepseek.com/chat/completions");
  assert.equal(deepSeekEndpoint(resolveDeepSeekBaseUrl("https://api.deepseek.com/v1/")), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(deepSeekEndpoint(resolveDeepSeekBaseUrl("http://127.0.0.1:8080")), "http://127.0.0.1:8080/chat/completions");
  assert.equal(deepSeekEndpoint(resolveDeepSeekBaseUrl("http://localhost:9999/")), "http://localhost:9999/chat/completions");
  for (const bad of ["http://api.deepseek.com", "https://user:pass@api.deepseek.com",
    "https://api.deepseek.com/?q=1", "https://api.deepseek.com/#x", "not a url"]) {
    assert.throws(() => resolveDeepSeekBaseUrl(bad), RangeError);
  }
});

test("unsupported schema, missing key and missing token bound fail before any request", async () => {
  let called = 0;
  const fetch = (async () => { called++; return new Response("{}"); }) as unknown as typeof globalThis.fetch;
  await assert.rejects(callDeepSeek({ ...options({ schema: { type: "object", minLength: 1 }, fetch }) }), RangeError);
  await assert.rejects(callDeepSeek({ ...options({ apiKey: "", fetch }) }), /API key/);
  await assert.rejects(callDeepSeek({ ...options({ maxTokens: undefined, fetch }) }), RangeError);
  assert.equal(called, 0);
});

test("HTTP auth and rate failures are distinct, bounded and credential-redacted", async () => {
  for (const status of [401, 429]) {
    const secret = "sk-super-secret-value";
    const { fetch } = jsonFetch({ error: { message: `denied ${secret}` }, model: "deepseek-flash" }, status);
    await assert.rejects(callDeepSeek({ ...options({ apiKey: secret }), fetch }), (error: unknown) => {
      assert.ok(error instanceof CodexWorkerError);
      const transcript = error.transcript as DeepSeekTranscript;
      assert.equal(error.code, "nonzero-exit");
      assert.equal(transcript.httpStatus, status);
      assert.equal(transcript.runtime, "deepseek");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("denied"), false);
      assert.equal(String(error.cause ?? "").includes(secret), false);
      assert.equal(error.transcript.stdout.includes(secret), false);
      assert.ok(error.transcript.stdout.includes("[REDACTED]"));
      return true;
    });
  }
});

test("transport failure never forwards a fetch cause that could contain headers", async () => {
  const fetch = (async () => { throw new Error("connect failed for Bearer sk-abc"); }) as typeof globalThis.fetch;
  await assert.rejects(callDeepSeek({ ...options({ apiKey: "sk-abc" }), fetch }), (error: unknown) => {
    assert.ok(error instanceof CodexWorkerError);
    assert.equal(error.code, "nonzero-exit");
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes("sk-abc"), false);
    return true;
  });
});

test("incomplete finish reasons are rejected even with valid JSON content", async () => {
  for (const finish of ["length", "content_filter", "tool_calls", null]) {
    const { fetch } = jsonFetch(validBody({ choices: [{ finish_reason: finish, message: { role: "assistant", content: '{"ok":true}' } }] }));
    await assert.rejects(callDeepSeek({ ...options(), fetch }),
      (error: unknown) => error instanceof CodexWorkerError && error.code === "missing-output"
        && (error.transcript as DeepSeekTranscript).responseModel === "deepseek-flash");
  }
  const tooled = jsonFetch(validBody({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}', tool_calls: [{ id: "1" }] } }] }));
  await assert.rejects(callDeepSeek({ ...options(), fetch: tooled.fetch }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "missing-output");
});

test("malformed bodies and missing choices fail distinctly", async () => {
  const bad = (async () => new Response("not-json", { status: 200 })) as typeof globalThis.fetch;
  await assert.rejects(callDeepSeek({ ...options(), fetch: bad }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-events");
  const empty = jsonFetch({ model: "deepseek-flash", usage: {} });
  await assert.rejects(callDeepSeek({ ...options(), fetch: empty.fetch }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "missing-output");
});

test("assistant JSON that violates the caller schema is rejected", async () => {
  const payload = validBody({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":"yes"}' } }] });
  const { fetch } = jsonFetch(payload);
  await assert.rejects(callDeepSeek({ ...options(), fetch }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "malformed-output");
});

test("missing or inconsistent usage stays unknown and is never zero or free", async () => {
  const missing = jsonFetch({ model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }] });
  const first = await callDeepSeek<{ ok: boolean }>({ ...options(), fetch: missing.fetch });
  assert.deepEqual(first.result, { ok: true });
  assert.equal(first.transcript.usageCompleteness, "partial-or-unknown");
  assert.deepEqual(first.usage, []);

  const inconsistent = jsonFetch(validBody({ usage: { prompt_tokens: 39, completion_tokens: 5, total_tokens: 999 } }));
  const second = await callDeepSeek<{ ok: boolean }>({ ...options(), fetch: inconsistent.fetch });
  assert.equal(second.transcript.usageCompleteness, "partial-or-unknown");
  assert.deepEqual(second.usage, []);
});

test("a pre-aborted signal makes no request", async () => {
  let called = false;
  const fetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof globalThis.fetch;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(callDeepSeek({ ...options({ signal: controller.signal, fetch }) }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "cancelled" && error.transcript.cancelled);
  assert.equal(called, false);
});

function hangingFetch(): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
    });
    resolve(new Response(stream, { status: 200 }));
  })) as typeof globalThis.fetch;
}

test("cancellation and timeout during the response body terminate the call", async () => {
  const controller = new AbortController();
  const pending = callDeepSeek({ ...options({ signal: controller.signal, timeoutMs: 5_000, fetch: hangingFetch() }) });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending,
    (error: unknown) => error instanceof CodexWorkerError && error.code === "cancelled" && error.transcript.cancelled);

  await assert.rejects(callDeepSeek({ ...options({ timeoutMs: 20, fetch: hangingFetch() }) }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "timeout" && error.transcript.timedOut);
});

test("timeout also covers a response that never returns headers", async () => {
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  })) as typeof globalThis.fetch;
  await assert.rejects(callDeepSeek({ ...options({ timeoutMs: 20, fetch }) }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "timeout" && error.transcript.timedOut);
});

test("oversized response bodies are cancelled and rejected", async () => {
  const large = new Uint8Array(4 * 1024 * 1024 + 1);
  const fetch = (async () => new Response(large, { status: 200 })) as typeof globalThis.fetch;
  await assert.rejects(callDeepSeek({ ...options(), fetch }),
    (error: unknown) => error instanceof CodexWorkerError && error.code === "output-too-large");
});
