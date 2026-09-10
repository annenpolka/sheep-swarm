import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "../src/fixture.ts";
import { runDurableSwarm, type DurableModelCaller } from "../src/durable-run.ts";
import { runSwarm } from "../src/swarm.ts";
import { callOpenCodeGo } from "../src/opencode-go-worker.ts";

const model = "gpt-5.6-luna";
const gold = createFixture({ size: 2, variant: "migrated" });
function receipt<T>(result: T, requestedModel = model) {
  const usage = [{ event: {}, inputTokens: 10, outputTokens: 2, totalTokens: 12 }];
  return { result, requestedModel, usage, transcript: { requestedModel, effectiveModelEvidence: "provider-alias",
    runtime: "opencode-go" as const, apiFormat: "responses" as const, httpStatus: 200, usageCompleteness: "complete" as const,
    rawUsage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, events: [], usage,
    stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, cancelled: false, durationMs: 1 } };
}

test("durable Go continues with the same worker session after a committed checkpoint", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-session-continuity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions: string[] = [];
  const caller: DurableModelCaller = async options => {
    assert.equal((options as { maxTokens?: number }).maxTokens, 4096);
    assert.ok(options.sessionId); sessions.push(options.sessionId);
    const input = JSON.parse(options.prompt) as { target: string };
    return receipt({ content: gold.artifacts[input.target]!, note: "fixed oracle" });
  };
  const directory = join(root, "run");
  await assert.rejects(runDurableSwarm({ directory, runtime: "opencode-go", workerModel: model,
    size: 2, workers: 1, maxCalls: 6, maxMetaCalls: 0, maxTokensPerCall: 4096,
    checkpoint: async name => { if (name === "after-delivery" && sessions.length === 1) throw new Error("pause after safe commit"); },
  }, caller), /pause after safe commit/);
  assert.equal(sessions.length, 1);
  const resumed = await runDurableSwarm({ directory, resume: true }, caller);
  assert.equal(resumed.success, true, resumed.finalErrors.join(","));
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions).size, 1, "all requests in this worker conversation retain the saved session");
});

test("swarm rejects a Go reply naming another requested model", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-request-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runSwarm({ outputDirectory: join(root, "run"), runtime: "opencode-go", workerModel: model,
    size: 2, workers: 1, concurrency: 1, maxCalls: 1, maxMetaCalls: 0 }, async () =>
    receipt({ content: "export const anything = true;", note: "wrong requested model" }, "different-model"));
  assert.equal(report.success, false);
  assert.ok(report.calls.some(call => call.errors.some(error => error.includes("model identity"))));
});

test("Go live normalization and receipt arithmetic agree across cache edge cases", async () => {
  for (const [rawUsage, complete] of [
    [{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: {} }, true],
    [{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 10,
      prompt_cache_miss_tokens: 90, prompt_tokens_details: { cached_tokens: 20 } }, false],
    [{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_miss_tokens: 101 }, false],
  ] as const) {
    const response = await callOpenCodeGo({ model: "deepseek-flash", prompt: "Test JSON output", cwd: process.cwd(),
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
      apiKey: "test-only", timeoutMs: 1000, maxTokens: 128, fetch: async () => new Response(JSON.stringify({
        model: "deepseek-flash", usage: rawUsage, choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }],
      })) });
    assert.equal(response.transcript.usageCompleteness, complete ? "complete" : "partial-or-unknown");
  }
});
