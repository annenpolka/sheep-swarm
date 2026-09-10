import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { callDockerAgent } from "./docker-agent-worker.ts";
import { SwarmKernel } from "./kernel.ts";
import { verifySandboxPilot } from "./docker-sandbox-verifier.ts";

const { values } = parseArgs({ options: { response: { type: "string" } } });
const directory = resolve(`.sheep/docker-agent-pilot-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(directory);
const files = {
  "normalize.mjs": "export function normalize(value) { return value.trim().toLowerCase(); }\n",
  "contract.md": "normalize(null) and normalize(undefined) return the empty string. Trim and lowercase strings. Preserve other existing behavior.\n",
  "visible.test.mjs": `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from './normalize.mjs';
test('visible contract', () => { assert.equal(normalize(null), ''); assert.equal(normalize(' Hi '), 'hi'); });
`,
};
const kernel = new SwarmKernel({ artifacts: files, verificationPolicy: "sandbox-pilot-v1" });
const context = kernel.checkout("sheep", Object.keys(files));
const lease = kernel.grant("sheep", ["normalize.mjs"], 600_000);
const responseBytes = values.response ? await readFile(resolve(values.response), "utf8") : null;
const response: Awaited<ReturnType<typeof callDockerAgent<{ content: string; note: string }>>> = responseBytes
  ? JSON.parse(responseBytes) : await callDockerAgent<{ content: string; note: string }>({
  model: "gpt-5.6-luna", cwd: directory, outputDirectory: directory, timeoutMs: 240_000,
  maxTokens: 30_000, tools: "local", files,
  prompt: "Read contract.md and normalize.mjs. Run check_local first to observe the failure, edit only normalize.mjs, and run check_local again. Return the complete replacement file as content and a short note. Do not change tests. Use the provided tools to do the work.",
  schema: { type: "object", properties: { content: { type: "string" }, note: { type: "string" } }, required: ["content", "note"], additionalProperties: false },
});
if (response.requestedModel !== "gpt-5.6-luna" || response.transcript.runtime !== "docker-agent" || !response.transcript.cleanupSucceeded || response.transcript.usageCompleteness !== "complete")
  throw new Error("Expected a completed Docker Agent Luna receipt with cleanup and usage");
await writeFile(join(directory, "response.json"), JSON.stringify(response, null, 2) + "\n");
const changes = response.transcript.workspaceChanges;
if (typeof changes["normalize.mjs"] !== "string" || Object.values(changes).some((v) => v === null))
  throw new Error("Workspace did not export the target change, or contains a deletion");
// Pass every exported change to the existing lease check: never silently drop an out-of-scope write.
const candidate = kernel.prepare({ id: "sandbox-pilot", agent: "sheep", context: context.id, writes: changes as Record<string, string>, lease, obligations: [] });
const verdict = await kernel.validate(candidate.id, async (contents) => {
  const acceptance = await verifySandboxPilot(contents["normalize.mjs"]!);
  await writeFile(join(directory, "acceptance.json"), JSON.stringify(acceptance, null, 2) + "\n");
  return { ok: acceptance.ok, errors: acceptance.errors };
});
if (!verdict.ok) throw new Error(`Frozen pilot oracle rejected the candidate; evidence: ${directory}`);
kernel.commit(candidate.id);
await writeFile(join(directory, "result.json"), JSON.stringify({ success: true, runtime: "docker-agent", model: "gpt-5.6-luna", directory,
  responseSource: values.response ? { path: resolve(values.response), sha256: createHash("sha256").update(responseBytes!).digest("hex"), newModelCalls: 0 } : null,
  changedPaths: Object.keys(changes), reportedContentMatches: changes["normalize.mjs"] === response.result.content,
  usage: response.usage, cleanupSucceeded: response.transcript.cleanupSucceeded,
  effectiveModelEvidence: response.transcript.effectiveModelEvidence, kernel: kernel.exportState(),
  limitation: "One local tool pilot; separate isolated oracle, no swarm quality/cost claim" }, null, 2) + "\n");
console.log(JSON.stringify({ success: true, directory }, null, 2));
