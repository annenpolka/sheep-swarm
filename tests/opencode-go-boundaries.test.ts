import assert from "node:assert/strict";
import test from "node:test";
import { callOpenCodeGo } from "../src/opencode-go-worker.ts";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const secret = "parent-private-test-credential";
const options = { model: "deepseek-flash", prompt: "Return the requested JSON result.", schema,
  apiKey: secret, sessionId: "parent-boundary-session", timeoutMs: 1000, maxTokens: 128, cwd: process.cwd() };
const rawUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 10 } };
const body = () => ({ model: "provider-alias", choices: [{ finish_reason: "stop",
  message: { role: "assistant", content: '{"ok":true}' } }], usage: structuredClone(rawUsage) });
function fetchBody(value: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("Go adapter scrubs reflected credentials from normalized usage as well as raw transcript", async () => {
  const response = { ...body(), usage: { ...rawUsage, provider_note: secret, [secret]: "reflected key" } };
  const result = await callOpenCodeGo({ ...options, fetch: fetchBody(response) });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("Go chat output must belong to the assistant role", async () => {
  const response = body(); response.choices[0]!.message.role = "user";
  await assert.rejects(callOpenCodeGo({ ...options, fetch: fetchBody(response) }));
});

test("Go Responses output cannot hide a function call beside valid JSON", async () => {
  const response = { model: "gpt-5.6-luna", status: "completed", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    output: [{ type: "function_call", name: "execute", arguments: "{}", call_id: "forbidden" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}' }] }] };
  await assert.rejects(callOpenCodeGo({ ...options, model: "gpt-5.6-luna", fetch: fetchBody(response) }));
});

test("Go malformed cache and reasoning counters cannot report complete usage", async () => {
  for (const usage of [
    { ...rawUsage, prompt_tokens_details: { cached_tokens: -1 } },
    { ...rawUsage, prompt_tokens_details: { cached_tokens: 101 } },
    { ...rawUsage, completion_tokens_details: { reasoning_tokens: 21 } },
    { ...rawUsage, total_tokens: "120" },
  ]) {
    const result = await callOpenCodeGo({ ...options, fetch: fetchBody({ ...body(), usage }) });
    assert.equal(result.transcript.usageCompleteness, "partial-or-unknown", JSON.stringify(usage));
  }
});

test("Go protocol usage must not accept counters belonging only to another protocol", async () => {
  const response = { model: "gpt-5.6-luna", status: "completed", usage: rawUsage,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}' }] }] };
  const result = await callOpenCodeGo({ ...options, model: "gpt-5.6-luna", fetch: fetchBody(response) });
  assert.equal(result.transcript.usageCompleteness, "partial-or-unknown");
});

test("Go standalone adapter requires an explicit output cap before network", async () => {
  const { maxTokens: _maxTokens, ...unbounded } = options;
  let calls = 0;
  await assert.rejects(callOpenCodeGo({ ...unbounded, fetch: async () => { calls++; return new Response(JSON.stringify(body())); } }));
  assert.equal(calls, 0);
});

test("Go timeout and cancellation settle once without a replacement request", async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const pendingFetch: typeof fetch = async (_input, init) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
        if (cancel) controller.abort();
      });
    };
    await assert.rejects(callOpenCodeGo({ ...options, timeoutMs: 15, signal: controller.signal, fetch: pendingFetch }), error => {
      const failure = error as Error & { code: string; transcript: { cancelled: boolean; timedOut: boolean } };
      assert.equal(failure.code, cancel ? "cancelled" : "timeout");
      assert.equal(failure.transcript.cancelled, cancel);
      assert.equal(failure.transcript.timedOut, !cancel);
      assert.equal(JSON.stringify(failure).includes(secret), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Go Messages requires an assistant response and complete end-of-turn", async () => {
  for (const [role, stopReason] of [["user", "end_turn"], ["assistant", "max_tokens"]]) {
    const response = { model: "minimax-m3", type: "message", role, stop_reason: stopReason,
      usage: { input_tokens: 85, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 20 },
      content: [{ type: "text", text: '{"ok":true}' }] };
    await assert.rejects(callOpenCodeGo({ ...options, model: "minimax-m3", fetch: fetchBody(response) }));
  }
});
