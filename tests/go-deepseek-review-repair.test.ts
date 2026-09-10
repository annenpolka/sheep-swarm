import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callDeepSeek, type DeepSeekTranscript } from "../src/deepseek-worker.ts";
import { runDurableSwarm, type DurableModelCaller } from "../src/durable-run.ts";
import { runMechanism } from "../src/mechanism-run.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { apiRun, unknownUsageForRun } from "../src/model-runtime.ts";

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
const base = { model: "deepseek-flash", prompt: "test", cwd: tmpdir(), schema,
  apiKey: "FAKE_SECRET_123", timeoutMs: 1000, maxTokens: 128 };
const body = (): any => ({ model: "deepseek-flash", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }] });

test("DeepSeek tool-less boundary rejects refusal and malformed tool_calls but allows an empty array", async () => {
  const mutations = [
    (message: any) => { message.refusal = "declined"; },
    (message: any) => { message.function_call = { name: "execute", arguments: "{}" }; },
    (message: any) => { message.tool_calls = { name: "execute" }; },
    (message: any) => { message.tool_calls = [{ id: "1" }]; },
  ];
  for (const mutate of mutations) {
    const response = body();
    mutate(response.choices[0].message);
    await assert.rejects(callDeepSeek({ ...base, fetch: async () => new Response(JSON.stringify(response)) }));
  }
  const empty = body();
  empty.choices[0].message.tool_calls = [];
  const result = await callDeepSeek<{ ok: boolean }>({ ...base, fetch: async () => new Response(JSON.stringify(empty)) });
  assert.deepEqual(result.result, { ok: true });
});

test("DeepSeek redaction scrubs nested keys and prototype-shaped keys without leaking", async () => {
  const raw = `{"model":"deepseek-flash","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,` +
    `"FAKE_SECRET_123":{"FAKE_SECRET_123":"echo"},"__proto__":{"polluted":"FAKE_SECRET_123"}},` +
    `"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"{\\"ok\\":true}"}}]}`;
  const result = await callDeepSeek<{ ok: boolean }>({ ...base, fetch: async () => new Response(raw) });
  assert.deepEqual(result.result, { ok: true });
  assert.equal(JSON.stringify(result.transcript).includes(base.apiKey), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("DeepSeek non-2xx receipts keep numeric lower bounds but remain unknown", async () => {
  const payload = body();
  payload.usage.diagnostic = base.apiKey;
  await assert.rejects(callDeepSeek({ ...base, fetch: async () => new Response(JSON.stringify(payload), { status: 429 }) }),
    (error: any) => {
      assert.ok(error instanceof CodexWorkerError);
      const transcript = error.transcript as DeepSeekTranscript;
      assert.equal(transcript.httpStatus, 429);
      assert.equal(transcript.usageCompleteness, "partial-or-unknown");
      assert.equal(transcript.usage[0]?.inputTokens, 10);
      assert.equal(transcript.usage[0]?.outputTokens, 2);
      assert.equal(JSON.stringify(transcript).includes(base.apiKey), false);
      return true;
    });
});

test("unknown-usage rule never requires provider rawUsage and preserves counted normalized receipts", () => {
  assert.equal(unknownUsageForRun({ usage: [{ inputTokens: 10, outputTokens: 2, totalTokens: 12 }] }, "codex", true), false);
  assert.equal(unknownUsageForRun({ usage: [] }, "codex", true), true);
  assert.equal(unknownUsageForRun({ usage: [] }, "codex", false), false);
  assert.equal(unknownUsageForRun({ usage: [{ inputTokens: 3 }] }, "codex", true), true);
  assert.equal(unknownUsageForRun({ usageCompleteness: "complete" }, "deepseek", true), false);
  assert.equal(unknownUsageForRun({ usageCompleteness: "partial-or-unknown" }, "opencode-go", true), true);
  assert.equal(unknownUsageForRun({ usage: [] }, "deepseek", true), true);
  assert.equal(apiRun("codex", "codex"), false);
  assert.equal(apiRun("codex", "deepseek"), true);
});

const workerKnown: DurableModelCaller = async options => {
  const usage = [{ event: {}, inputTokens: 10, outputTokens: 2, totalTokens: 12 }];
  const transcript: any = { requestedModel: options.model, effectiveModelEvidence: options.model, events: [], usage,
    stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1,
    runtime: "deepseek", usageCompleteness: "complete" };
  return { result: { content: "invalid", note: "failure for intervention" }, requestedModel: options.model, usage, transcript };
};

async function directory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-review-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "run");
}

test("mixed durable success-path Codex meta without counted usage locks admission", async t => {
  const calls: string[] = [];
  const caller: DurableModelCaller = async options => {
    const role = (JSON.parse(options.prompt) as { role: string }).role;
    calls.push(role);
    if (role === "meta") {
      const transcript: any = { requestedModel: options.model, effectiveModelEvidence: options.model, events: [], usage: [],
        stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1 };
      return { result: { content: "Clarified guidance.", note: "meta update" }, requestedModel: options.model, usage: [], transcript };
    }
    return workerKnown(options);
  };
  await runDurableSwarm({ directory: await directory(t), runtime: "deepseek", workerModel: "deepseek-flash",
    size: 2, workers: 1, maxCalls: 6, maxMetaCalls: 1 }, caller);
  assert.notEqual(calls.indexOf("meta"), -1);
  assert.equal(calls.length, calls.indexOf("meta") + 1, JSON.stringify(calls));
});

test("a reserved mixed-run Codex meta call cannot regain admission on resume", async t => {
  const run = await directory(t);
  await assert.rejects(runDurableSwarm({ directory: run, runtime: "deepseek", workerModel: "deepseek-flash",
    size: 2, workers: 1, maxCalls: 6, maxMetaCalls: 1,
    checkpoint: async (name, details) => {
      if (name === "before-call" && details.role === "meta") throw new Error("crash after meta reservation");
    } }, workerKnown), /crash after meta reservation/);
  let resumed = 0;
  const report = await runDurableSwarm({ directory: run, resume: true }, async () => {
    resumed++;
    throw new Error("locked run spent again");
  });
  assert.equal(resumed, 0);
  assert.equal(report.success, false);
  assert.ok(report.finalErrors.includes("token-usage-incomplete"), report.finalErrors.join("\n"));
  assert.ok(report.unknownCalls >= 1);
});

test("mechanism requires Docker cleanup only for the invoked Docker meta role", async t => {
  const root = await mkdtemp(join(tmpdir(), "go-review-reverse-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runMechanism({ outputDirectory: join(root, "run"), runtime: "codex", metaRuntime: "docker-agent",
    family: "static", groups: 1, workers: 1, concurrency: 1, budgetMode: "tokens", maxTokens: 10_000,
    reserveTokensPerCall: 100, maxCalls: 6, maxMetaCalls: 1 }, async options => {
    const input = JSON.parse(options.prompt.split("PUBLIC_INPUT_JSON\n")[1]!);
    const usage = [{ event: {}, inputTokens: 10, outputTokens: 2, totalTokens: 12 }];
    const transcript: any = { requestedModel: options.model, effectiveModelEvidence: options.model, usage,
      stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 1, events: [] };
    if (input.role === "meta") Object.assign(transcript, { runtime: "docker-agent", runtimeVersion: "v1.137.0",
      usageCompleteness: "complete", cleanupSucceeded: false,
      events: [{ type: "stream_started", session_id: "fake" }, { type: "stream_stopped", session_id: "fake", reason: "normal" }] });
    return { requestedModel: options.model, usage, transcript,
      result: { writes: [{ id: input.target, content: input.role === "meta" ? "Clarified guidance." : "invalid" }],
        readRequests: [], note: "injected" } };
  });
  assert.ok(report.finalErrors.includes("sandbox-cleanup-unverified"), JSON.stringify(report.finalErrors));
});
