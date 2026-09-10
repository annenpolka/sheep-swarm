import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { capture, dockerAgentConfig, parseDockerEvents, validateFiles } from "../src/docker-agent-worker.ts";

const model = "gpt-5.6-luna";
const event = (type: string, extra: Record<string, unknown> = {}) => ({ type, session_id: "fresh-session", agent_name: "sheep", ...extra });
const usage = (input: number, output: number) => event("token_usage", { usage: {
  input_tokens: input + 3, output_tokens: output, last_message: { Model: `chatgpt/${model}`, input_tokens: input, output_tokens: output, cached_input_tokens: 3, cached_write_tokens: 0 },
} });
const encode = (events: Record<string, unknown>[]) => events.map((e) => JSON.stringify(e)).join("\n");
const normal = () => [event("stream_started"), usage(10, 2), event("agent_choice", { content: '{"ok":true}' }), event("stream_stopped", { reason: "normal" })];

test("Docker Agent v1.137.0 observed Luna tool-run receipt stays compatible", () => {
  // Subset of the real synthetic pilot receipt, 2026-09-10. Source hash is in
  // docs/results/docker-agent-evidence.json; no fixture expectation comes from the parser.
  const fixture = readFileSync(new URL("./fixtures/docker-agent-v1.137.0-local.jsonl", import.meta.url), "utf8");
  const result = parseDockerEvents(fixture, model);
  assert.equal(result.problem, null);
  assert.equal(result.usage.reduce((sum, u) => sum + u.inputTokens!, 0), 5933);
  assert.equal(result.usage.reduce((sum, u) => sum + u.outputTokens!, 0), 333);
  assert.equal(JSON.parse(result.output).content, "export function normalize(value) { return value == null ? '' : value.trim().toLowerCase(); }");
});

test("Docker Agent bills per-message usage including cache, not the last context snapshot", () => {
  const events = normal(); events.splice(2, 0, usage(20, 5));
  const result = parseDockerEvents(encode(events), model);
  assert.equal(result.problem, null);
  assert.equal(result.usage.length, 2);
  assert.equal(result.usage.reduce((sum, u) => sum + u.inputTokens!, 0), 36);
  assert.equal(result.usage.reduce((sum, u) => sum + u.outputTokens!, 0), 7);
  assert.equal(result.effectiveModelEvidence, null, "configured model must not be presented as provider evidence");
  assert.equal(result.configuredModelEvidence, `chatgpt/${model}`);
  assert.equal(result.output, '{"ok":true}');
});

test("Docker Agent tool-mode result excludes earlier prose and invalid output attempts", () => {
  const events = normal();
  events.splice(2, 1, event("agent_choice", { content: "Checking the file." }),
    event("tool_call_response", { tool_definition: { name: "__structured_output__" }, result: { isError: true }, response: "invalid schema" }),
    event("tool_call_response", { tool_definition: { name: "__structured_output__" }, result: { output: '{"ok":true}' }, response: '{"ok":true}' }));
  assert.equal(parseDockerEvents(encode(events), model).output, '{"ok":true}');
});

test("Docker Agent rejects budget/abnormal/missing termination even with valid JSON", () => {
  for (const reason of ["budget_exceeded", "canceled", "error", "loop_detected", undefined]) {
    const events = normal(); events[events.length - 1] = event("stream_stopped", { reason });
    assert.ok(parseDockerEvents(encode(events), model).problem);
  }
  assert.ok(parseDockerEvents(encode(normal().slice(0, -1)), model).problem);
  assert.ok(parseDockerEvents(encode([...normal(), event("error", { error: "late failure" })]), model).problem);
});

test("Docker Agent rejects malformed data, additional sessions, and model mismatch", () => {
  assert.ok(parseDockerEvents(encode(normal()) + "\nnot-json", model).problem);
  assert.ok(parseDockerEvents(encode([...normal(), event("stream_started", { session_id: "another" })]), model).problem);
  const events = normal(); events[1] = event("token_usage", { usage: { input_tokens: 1, output_tokens: 1, last_message: { Model: "chatgpt/other" } } });
  assert.ok(parseDockerEvents(encode(events), model).problem);
});

test("unknown Docker Agent usage is never coerced to zero", () => {
  assert.deepEqual(parseDockerEvents(encode(normal().filter((e) => e.type !== "token_usage")), model).usage, []);
});

test("a new unfinished stream cannot inherit the previous normal stop", () => {
  assert.ok(parseDockerEvents(encode([...normal(), event("stream_started")]), model).problem);
});

test("duplicate or incomplete per-message usage prevents a successful receipt", () => {
  assert.ok(parseDockerEvents(encode([...normal(), usage(10, 2)]), model).problem);
  const events = normal();
  events.splice(2, 0, event("token_usage", { usage: { input_tokens: 999, output_tokens: 1 } }));
  const result = parseDockerEvents(encode(events), model);
  assert.ok(result.problem);
  assert.equal(result.usage.length, 1, "keep the known usage as a lower bound");
});

test("local materialization rejects traversals, hidden state and excessive input", () => {
  validateFiles({ "src/file.mjs": "export const x = 1;" });
  for (const path of ["../escape", "/absolute", "a/../b", ".env", "a/.git/config", "a//b", "C:/file", "a\\b", "x\u0000y"]) {
    assert.throws(() => validateFiles({ [path]: "secret" }), /Unsafe/);
  }
  assert.throws(() => validateFiles({ "large.txt": "x".repeat(4 * 1024 * 1024 + 1) }), /exceeds/);
});

test("local tools expose filesystem and fixed test command with fresh context", () => {
  const config = dockerAgentConfig({ model, prompt: "test", schema: { type: "boolean" }, cwd: "/irrelevant", timeoutMs: 1000, tools: "local" });
  const serialized = JSON.stringify(config);
  assert.ok(serialized.includes('"mode":"tool"'));
  assert.ok(serialized.includes('"skills":false'));
  assert.ok(serialized.includes('node --test visible.test.mjs'));
  for (const forbidden of ['"type":"shell"', '"type":"mcp"', '"sub_agents"', '"handoffs"']) assert.equal(serialized.includes(forbidden), false);
});

test("bounded process capture enforces timeout, cancellation and byte limit", async () => {
  const timed = await capture(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 });
  assert.equal(timed.timedOut, true);
  const controller = new AbortController(); controller.abort();
  const cancelled = await capture(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 1000, signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  const large = await capture(process.execPath, ["-e", "process.stdout.write('x'.repeat(5*1024*1024))"], { timeoutMs: 2000 });
  assert.equal(large.tooLarge, true);
  assert.ok(Buffer.byteLength(large.stdout) <= 4 * 1024 * 1024);
});
