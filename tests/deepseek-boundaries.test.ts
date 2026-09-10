import assert from "node:assert/strict";
import test from "node:test";
import { callDeepSeek, parseDeepSeekUsage } from "../src/deepseek-worker.ts";

// Caller-owned counterexamples from independent adapter review.
const secret = "caller-reflected-api-key";
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
const normal = { model: "provider-alias", usage,
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }] };
const options = { model: "deepseek-audit", prompt: "Return JSON", apiKey: secret, cwd: process.cwd(),
  timeoutMs: 1000, maxTokens: 256,
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } };

test("reflected credentials cannot escape through parsed response metadata or error messages", async () => {
  for (const response of [
    { ...normal, model: secret, usage: { ...usage, diagnostic: secret } },
    { ...normal, choices: [{ finish_reason: secret, message: { role: "assistant", content: '{"ok":true}' } }] },
  ]) {
    let evidence: unknown;
    try { evidence = await callDeepSeek({ ...options, fetch: async () => new Response(JSON.stringify(response)) }); }
    catch (error) { evidence = { ...(error as object), message: String(error) }; }
    assert.equal(JSON.stringify(evidence).includes(secret), false, "all persisted metadata must redact the credential");
  }
});

test("invalid optional cache and reasoning counters cannot become complete usage", () => {
  for (const extra of [
    { prompt_cache_hit_tokens: -1 }, { prompt_cache_hit_tokens: 999 },
    { prompt_cache_miss_tokens: "10" }, { prompt_cache_miss_tokens: 11 },
    { prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens_details: { cached_tokens: 11 } },
    { completion_tokens_details: { reasoning_tokens: 3 } },
    { completion_tokens_details: { reasoning_tokens: -1 } },
  ]) {
    assert.equal(parseDeepSeekUsage({ ...usage, ...extra }).completeness, "partial-or-unknown", JSON.stringify(extra));
  }
});

test("schema-shaped user messages are not assistant completion evidence", async () => {
  const response = { ...normal, choices: [{ finish_reason: "stop", message: { role: "user", content: '{"ok":true}' } }] };
  await assert.rejects(callDeepSeek({ ...options, fetch: async () => new Response(JSON.stringify(response)) }));
});

test("valid reasoning usage is included in completion tokens and remains complete", () => {
  for (const reasoningTokens of [0, 1, 2]) {
    const parsed = parseDeepSeekUsage({ ...usage,
      prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: reasoningTokens } });
    assert.equal(parsed.completeness, "complete");
    assert.equal(parsed.usage[0]?.inputTokens, 10);
    assert.equal(parsed.usage[0]?.outputTokens, 2);
    assert.equal(parsed.usage[0]?.totalTokens, 12);
  }
});
