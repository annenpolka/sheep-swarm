import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDurableSwarm } from "../src/durable-run.ts";
import { createFixture } from "../src/fixture.ts";
import { SqliteJournal } from "../src/journal.ts";
import { SwarmKernel } from "../src/kernel.ts";
import type { CodexCallOptions, CodexCallResult, CodexUsage } from "../src/codex-worker.ts";

const fixedModel = async (options: CodexCallOptions): Promise<CodexCallResult<{ content: string; note: string }>> => {
  const request = JSON.parse(options.prompt) as { role: string; target: string };
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const context = JSON.parse(options.prompt) as { context?: { contents?: Record<string, string> } };
  let content = request.role === "meta" ? fixture.artifacts[fixture.specId]! : fixture.artifacts[request.target]!;
  if (request.role === "worker" && Object.values(context.context?.contents ?? {}).some((value) => value.includes("Round returned")))
    content = content.replace("durationSeconds: reading.durationSeconds", "durationSeconds: Math.floor(reading.durationSeconds)").replace("kibibytesPerSecond: rate", "kibibytesPerSecond: Math.floor(rate)");
  const usage: readonly CodexUsage[] = [{ event: {}, inputTokens: 10, outputTokens: 20 }];
  return {
  result: { content, note: "fixed crash oracle" }, requestedModel: options.model, usage,
  transcript: { events: [], usage: [], requestedModel: options.model, effectiveModelEvidence: null, stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 0 },
  };
};

async function waitFor(path: string, childEnded: () => string | null): Promise<void> {
  for (let attempt = 0; attempt < 3000; attempt++) {
    const ended = childEnded();
    if (ended !== null) throw new Error(`child exited before checkpoint publication: ${ended}`);
    try { await access(path); return; }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

const boundaries = ["initialized", "before-call", "after-call", "after-seen", "before-commit", "after-commit", "before-delivery", "after-delivery", "before-intervention", "after-intervention", "completed"] as const;

for (const boundary of boundaries) {
  test(`SIGKILL at ${boundary} resumes without false completion`, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), "sheep-durable-crash-"));
    const directory = join(parent, "run");
    const child = spawn(process.execPath, ["--experimental-strip-types", "tests/durable-crash-child.ts", directory, boundary], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let journal: SqliteJournal | undefined;
    let ended: string | null = null;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", (error) => { ended = String(error); });
      child.once("close", (code, signal) => { ended = `code=${code}, signal=${signal}`; resolve({ code, signal }); });
    });
    t.after(async () => { child.kill("SIGKILL"); await closed; journal?.close(); await rm(parent, { recursive: true, force: true }); });
    child.stdout.resume(); child.stderr.resume();
    await waitFor(join(directory, `checkpoint-${boundary}.json`), () => ended);
    const marker = JSON.parse(await readFile(join(directory, `checkpoint-${boundary}.json`), "utf8")) as { name: string; details: { generation: number; callId?: string } };
    assert.equal(marker.name, boundary);
    assert.ok(Number.isSafeInteger(marker.details.generation) && marker.details.generation > 0);
    assert.equal(child.kill("SIGKILL"), true);
    assert.equal((await closed).signal, "SIGKILL");
    const resumed = await runDurableSwarm({ directory, resume: true, size: 4, workers: 4, maxCalls: 20, maxMetaCalls: 4, timeoutMs: 5000,
      fault: boundary === "before-intervention" || boundary === "after-intervention" ? "rounded-guidance" : "none" }, fixedModel);
    assert.equal(resumed.success, true, resumed.finalErrors.join("\n"));
    assert.ok(Array.isArray(resumed.calls));
    assert.equal(new Set(resumed.calls.map((call: { id: string }) => call.id)).size, resumed.calls.length);
    assert.ok(resumed.calls.every((call: { status: string }) => ["reserved", "responded", "committed", "rejected", "error", "unknown", "abandoned"].includes(call.status)));
    if (marker.details.callId !== undefined) {
      const interrupted = resumed.calls.find((call: { id: string }) => call.id === marker.details.callId);
      assert.ok(interrupted, `checkpoint call ${marker.details.callId} must remain recorded`);
      if (boundary === "before-call") assert.equal(interrupted!.status, "unknown");
      if (boundary === "after-call" || boundary === "before-commit") assert.equal(interrupted!.status, "abandoned");
      if (boundary === "after-commit") assert.equal(interrupted!.status, "committed");
    }
    if (boundary === "before-call") assert.ok(resumed.usageUnknownCalls >= 1);
    assert.ok(resumed.finalErrors.every((error: string) => !/duplicate|double|stale proposal/i.test(error)));
    journal = new SqliteJournal(join(directory, "state.sqlite"));
    const snapshot = journal.load();
    assert.ok(snapshot);
    const state = snapshot.state;
    const fixture = createFixture({ size: 4, variant: "migrated" });
    const contents = Object.fromEntries(Object.entries(state.artifacts).map(([id, artifact]) => [id, artifact.content]));
    assert.deepEqual(await fixture.verify(contents), { ok: true, errors: [] });
    assert.equal(state.artifacts[fixture.sourceId]!.version, 1);
    for (const id of fixture.writableIds) {
      assert.equal(state.artifacts[id]!.version, 1);
      const commits = state.candidates.filter((candidate) => candidate.state === "committed" && Object.hasOwn(candidate.proposal.writes, id));
      assert.equal(commits.length, 1, `expected exactly one committed write for ${id}`);
    }
    const committedWrites = state.candidates.filter((candidate) => candidate.state === "committed").flatMap((candidate) => Object.keys(candidate.proposal.writes));
    assert.equal(new Set(committedWrites).size, committedWrites.length);
    assert.ok(state.events.every((event) => event.delivered));
    assert.ok(state.obligations.every((obligation) => obligation.state === "handled"));
    assert.ok(state.claims.every((claim) => !claim.open));
    const restored = SwarmKernel.restore(state, { recover: true });
    const committed = state.candidates.find((candidate) => candidate.state === "committed");
    if (committed) assert.throws(() => restored.commit(committed.id));
    const lease = state.leases[0];
    const context = state.contexts.find((item) => item.agent === lease?.agent);
    if (lease && context) assert.throws(() => restored.prepare({ id: "stale-recovery-proposal", agent: lease.agent, context: context.id, writes: {}, lease: { id: lease.id, epoch: lease.epoch } }));
    journal.close();
  });
}
