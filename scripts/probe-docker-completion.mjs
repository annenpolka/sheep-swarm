import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createMechanismFixture } from "../src/mechanism-fixture.ts";
import { callDockerAgent, dockerWorkspaceWrites } from "../src/docker-agent-worker.ts";
import { CodexWorkerError } from "../src/codex-worker.ts";
import { createDockerFixtureObserver } from "../src/docker-fixture-observer.ts";
import { CreditBudget } from "../src/credit-budget.ts";
import { parseRateCard } from "../src/cost-estimate.ts";

const directory = resolve(`.sheep/docker-completion-probe-${Date.now()}`); await mkdir(directory);
const fixture = createMechanismFixture({ family: "semantic", groups: 1, observe: createDockerFixtureObserver(join(directory, "acceptance")) });
const target = process.argv[2] ?? fixture.writableIds[0], current = { ...fixture.artifacts, ...fixture.changesForStage(0) };
if (!fixture.writableIds.includes(target)) throw new Error("Unknown probe target");
const ids = [target, fixture.specId, fixture.guidanceId, "lib/decode.mjs", "config/domain-registry.json", "policies/policy-003.json"];
const files = Object.fromEntries(ids.map(id => [id, current[id]]));
files["visible.test.mjs"] = fixture.visibleFeedback(files, 0, [target]).source;
const model = "gpt-5.6-luna";
const rateCard = parseRateCard(JSON.parse(await readFile(new URL("../pricing/openai-2026-09-10.json", import.meta.url), "utf8")));
const budget = new CreditBudget({ maxCredits: 1, rateCard, reservations: { [model]: 0.5 } });
if (!budget.reserve(model, "call-1")) throw new Error("Cannot reserve the single probe call");
let receipt = {}, failure, verdict;
try {
  receipt = await callDockerAgent({ model, tools: "local", files, maxTokens: 60000, timeoutMs: 240000,
    cwd: directory, outputDirectory: join(directory, "transcripts"),
    schema: { type: "object", additionalProperties: false, required: ["writes", "readRequests", "note"], properties: {
      writes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "content"], properties: { id: { type: "string" }, content: { type: "string" } } } },
      readRequests: { type: "array", items: { type: "string" } }, note: { type: "string" } } },
    prompt: `Implement only ${target} according to docs/event-contract.md and the supplied registry and policy. All needed public inputs are already in the workspace. Run check_local before editing, edit only the target, and run check_local again. Do not change tests, dependencies, or pinned files. Finish by CALLING __structured_output__ with {"writes":[],"readRequests":[],"note":"short summary"}. Do not emit the file body or plain-text JSON as your final message. The actual file delta is the proposal.` });
} catch (error) {
  failure = String(error);
  receipt = error instanceof CodexWorkerError ? { error: error.code, transcript: error.transcript } : { error: String(error) };
} finally {
  budget.settle("call-1", receipt);
  await writeFile(join(directory, "call-1.json"), JSON.stringify(receipt, null, 2) + "\n");
}
if (!failure) try {
  const changes = dockerWorkspaceWrites(receipt.transcript);
  if (Object.keys(changes).length !== 1 || !Object.hasOwn(changes, target)) throw new Error("Unexpected write scope");
  verdict = await fixture.verify({ ...current, ...changes }, 0, [target], "visible", ids);
  if (!verdict.ok) throw new Error(verdict.errors.join("\n"));
} catch (error) { failure = String(error); }
const snapshot = budget.snapshot();
const success = !failure && verdict?.ok === true && snapshot.unknownUsageCalls === 0 && !snapshot.exceeded
  && snapshot.activeReservations === 0 && receipt.transcript.cleanupSucceeded === true;
const report = { success, modelCalls: 1, directory, target, budget: snapshot, verdict: verdict ?? null, failure: failure ?? null };
await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!success) process.exitCode = 1;
