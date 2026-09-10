import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnosticCases, TOOL_SUMMARY, PROGRESS } from "../experiments/docker-diagnostics-task.ts";
import { capture } from "../src/docker-agent-worker.ts";

for (const target of [TOOL_SUMMARY, PROGRESS]) test(`swarm-authored ${target} passes frozen visible and additional cases without mutating inputs`, async () => {
  const url = new URL(`../${target}`, import.meta.url);
  const module = await import(url.href);
  const invoke = module[target === TOOL_SUMMARY ? "summarizeTools" : "summarizeProgress"];
  for (const row of diagnosticCases(target, true)) {
    const input = structuredClone(row.input), before = structuredClone(input);
    if (row.throws) assert.throws(() => invoke(input), TypeError);
    else assert.deepEqual(invoke(input), row.expected);
    assert.deepEqual(input, before);
  }
});

test("diagnostic CLI reads actual saved receipts and preserves unknown completion", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "docker-diagnostics-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const source = join(directory, "result.json");
  const report = { family: "semantic", success: true, terminationReason: "completed",
    budget: { unknownUsageCalls: 1, activeReservations: 0, exceeded: false },
    stages: [{ stage: 0, success: true, qualityPass: true, protocolClean: true }],
    calls: [{ id: "call-1", target: "module", model: "gpt-5.6-luna", outcome: "committed", writtenIds: ["module"] }] };
  await writeFile(source, JSON.stringify(report));
  const args = ["--permission", `--allow-fs-read=${root}`, `--allow-fs-read=${directory}`, join(root, "scripts/summarize-docker-mechanism.mjs"), source];
  assert.notEqual((await capture(process.execPath, args, { timeoutMs: 3000 })).exitCode, 0);
  await writeFile(join(directory, "call-1.json"), JSON.stringify({ transcript: { usageCompleteness: "partial-or-unknown", cleanupSucceeded: true,
    events: [{ type: "tool_call", tool_call: { id: "tool-1", function: { name: "check_local" } } },
      { type: "tool_call_response", tool_call_id: "tool-1", result: { isError: false } }] } }));
  const result = await capture(process.execPath, args, { timeoutMs: 3000 });
  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.progress.complete, false); assert.equal(parsed.progress.unknownUsageCalls, 1);
  assert.equal(parsed.calls[0].tools.calls, 1); assert.equal(parsed.calls[0].tools.structuredOutputDelivered, false);
  assert.equal(parsed.calls[0].usageCompleteness, "partial-or-unknown");
});
