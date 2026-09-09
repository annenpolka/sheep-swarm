import { appendFile, access, rename, writeFile } from "node:fs/promises";
import { runDurableSwarm } from "../src/durable-run.ts";
import { createFixture } from "../src/fixture.ts";
import type { CodexCallOptions, CodexCallResult, CodexUsage } from "../src/codex-worker.ts";

const directory = process.argv[2];
const boundary = process.argv[3];
if (!directory || !boundary) throw new Error("directory and boundary are required");

const model = async (options: CodexCallOptions): Promise<CodexCallResult<{ content: string; note: string }>> => {
  const request = JSON.parse(options.prompt) as { role: string; target: string };
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const context = JSON.parse(options.prompt) as { context?: { contents?: Record<string, string> } };
  let content = request.role === "meta" ? fixture.artifacts[fixture.specId]! : fixture.artifacts[request.target]!;
  if (request.role === "worker" && Object.values(context.context?.contents ?? {}).some((value) => value.includes("Round returned")))
    content = content.replace("durationSeconds: reading.durationSeconds", "durationSeconds: Math.floor(reading.durationSeconds)").replace("kibibytesPerSecond: rate", "kibibytesPerSecond: Math.floor(rate)");
  const usage: readonly CodexUsage[] = [{ event: {}, inputTokens: 10, outputTokens: 20 }];
  return {
  result: { content, note: "fixed crash oracle" },
  requestedModel: options.model,
  usage,
  transcript: { events: [], usage: [], requestedModel: options.model, effectiveModelEvidence: null,
    stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 0 },
  };
};

const checkpoint = async (name: string, details: Record<string, unknown>) => {
  if (name !== boundary) return;
  const marker = `${directory}/checkpoint-${boundary}.json`;
  const pending = `${marker}.pending-${process.pid}`;
  // Existence is the readiness signal: publish only after the complete JSON file is closed.
  // A direct writeFile(marker, ...) briefly exposes an empty/truncated marker to the parent.
  await writeFile(pending, JSON.stringify({ name, details }), { flag: "wx" });
  await rename(pending, marker);
  while (true) {
    try { await access(`${directory}/continue`); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
};

const result = await runDurableSwarm({ directory, size: 4, workers: 4, maxCalls: 20, maxMetaCalls: 4, timeoutMs: 5000,
  fault: boundary === "before-intervention" || boundary === "after-intervention" ? "rounded-guidance" : "none", checkpoint }, model);
await appendFile(`${directory}/child-result.jsonl`, JSON.stringify(result) + "\n");
