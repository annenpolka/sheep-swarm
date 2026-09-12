import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { assertOpenCodeGoModel, callOpenCodeGo, type OpenCodeGoOptions } from "../src/opencode-go-worker.ts";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
function opts(model: string, fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}): OpenCodeGoOptions {
  return { model, prompt: "return it", schema, cwd: process.cwd(), timeoutMs: 500, maxTokens: 128, apiKey: "secret", fetch, ...extra } as OpenCodeGoOptions;
}
function fake(body: unknown, status = 200): { fetch: typeof globalThis.fetch; init: RequestInit | undefined; url: string } {
  const seen: { fetch: typeof globalThis.fetch; init: RequestInit | undefined; url: string } = { init: undefined, url: "" } as never;
  seen.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.url = String(input); seen.init = init; return new Response(JSON.stringify(body), { status }); }) as typeof globalThis.fetch;
  return seen;
}
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };

test("catalog rejects prefixed and unknown ids before network", async () => {
  assert.doesNotThrow(() => assertOpenCodeGoModel("gpt-5.6-luna"));
  assert.throws(() => assertOpenCodeGoModel("opencode-go/gpt-5.6-luna"), RangeError);
  let called = false;
  const fetch = (async () => { called = true; return new Response("{}"); }) as typeof globalThis.fetch;
  await assert.rejects(callOpenCodeGo(opts("unknown", fetch)), RangeError);
  assert.equal(called, false);
});

test("chat completions sends schema prompt, JSON mode and session header", async () => {
  const seen = fake({ model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }], usage });
  const result = await callOpenCodeGo(opts("deepseek-flash", seen.fetch, { sessionId: "conversation-1" }));
  assert.equal(seen.url, "https://opencode.ai/zen/go/v1/chat/completions");
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers["user-agent"], "sheep-swarm/0.0.0"); assert.equal(headers["x-opencode-session"], "conversation-1");
  const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
  assert.deepEqual(body.response_format, { type: "json_object" }); assert.equal(body.tools, undefined);
  assert.equal(result.transcript.apiFormat, "chat-completions"); assert.equal(result.transcript.usageCompleteness, "complete");
});

test("responses Luna and Anthropic messages parse their native output shapes", async () => {
  const responses = fake({ model: "gpt-5.6-luna", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}' }] }], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } });
  const luna = await callOpenCodeGo(opts("gpt-5.6-luna", responses.fetch));
  assert.equal(JSON.parse(String(responses.init?.body)).thinking, undefined);
  assert.equal(luna.transcript.thinking, null);
  assert.deepEqual(luna.result, { ok: true }); assert.equal(luna.transcript.apiFormat, "responses");
  const messages = fake({ model: "qwen3.8-max", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 14, cache_read_input_tokens: 4 } });
  const qwen = await callOpenCodeGo(opts("qwen3.8-max", messages.fetch));
  assert.equal(qwen.transcript.apiFormat, "messages"); assert.equal(qwen.transcript.usageCompleteness, "complete"); assert.equal(qwen.usage[0]?.inputTokens, 12);
  const messageHeaders = messages.init?.headers as Record<string, string>;
  assert.equal(messageHeaders["x-api-key"], "secret"); assert.equal(messageHeaders["anthropic-version"], "2023-06-01");
});

test("DeepSeek thinking is explicit and invalid profiles never reach the provider", async () => {
  const seen = fake({ model: "deepseek-flash", choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }], usage });
  await callOpenCodeGo(opts("deepseek-flash", seen.fetch));
  assert.deepEqual(JSON.parse(String(seen.init?.body)).thinking, { type: "enabled" });
  for (const thinking of ["disabled", "enabled"]) {
    await callOpenCodeGo(opts("deepseek-flash", seen.fetch, { thinking }));
    assert.deepEqual(JSON.parse(String(seen.init?.body)).thinking, { type: thinking });
  }
  const noCall = (async () => { assert.fail("invalid thinking profile reached network"); }) as typeof globalThis.fetch;
  await assert.rejects(callOpenCodeGo(opts("deepseek-flash", noCall, { thinking: "fast" })), /thinking/);
  await assert.rejects(callOpenCodeGo(opts("grok-4.6", noCall, { thinking: "disabled" })), /thinking/);
});

test("HTTP failures keep status and redacted raw usage without retry", async () => {
  let calls = 0; const seen = fake({ model: "deepseek-flash", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, note: "secret" } }, 429);
  const original = seen.fetch; seen.fetch = (async (...args: Parameters<typeof original>) => { calls++; return original(...args); }) as typeof globalThis.fetch;
  await assert.rejects(callOpenCodeGo(opts("deepseek-flash", seen.fetch)), (error: unknown) => error instanceof CodexWorkerError && error.code === "nonzero-exit" && (error.transcript as unknown as { httpStatus: number | null }).httpStatus === 429 && error.transcript.stdout.includes("secret") === false);
  assert.equal(calls, 1);
});

test("session bounds and oversized response are rejected", async () => {
  const good = fake({ model: "gpt-5.6-luna", status: "completed", output_text: '{"ok":true}', usage });
  await assert.rejects(callOpenCodeGo(opts("gpt-5.6-luna", good.fetch, { sessionId: "bad\nvalue" })), RangeError);
  const large = fake("x".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(callOpenCodeGo(opts("deepseek-flash", large.fetch)), (error: unknown) => error instanceof CodexWorkerError && error.code === "output-too-large");
});
