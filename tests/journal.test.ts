import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { JournalError, SqliteJournal } from "../src/journal.ts";
import type { JournalErrorCode } from "../src/journal.ts";
import { SwarmKernel } from "../src/kernel.ts";
import type { KernelState } from "../src/kernel.ts";

function location(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "sheep-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "state.sqlite");
}
function journal(t: TestContext, file: string): SqliteJournal {
  const result = new SqliteJournal(file); t.after(() => result.close()); return result;
}
function database(t: TestContext, file: string): DatabaseSync {
  const result = new DatabaseSync(file); t.after(() => result.close()); return result;
}
const hasCode = (code: JournalErrorCode) => (error: unknown) => error instanceof JournalError && error.code === code;
const simple = (): KernelState => new SwarmKernel({ artifacts: { result: "old" }, now: () => 100 }).exportState();
const digest = (payload: string) => createHash("sha256").update(payload).digest("hex");

async function populated(): Promise<KernelState> {
  const target = new SwarmKernel({ artifacts: { provider: "v0", consumer: "v0", other: "empty", policy: "old" }, now: () => 100 });
  target.addDependency("consumer", "provider");
  target.change("provider", "v1"); target.deliverAll();
  const obligation = target.pending()[0]!;
  const context = target.checkout("worker", ["provider", "consumer"]);
  const lease = target.grant("worker", ["consumer"]);
  target.seen(obligation.id, "worker");
  const candidate = target.prepare({ id: "consumer-change", agent: "worker", context: context.id,
    writes: { consumer: "v1" }, lease, obligations: [obligation.id] });
  await target.validate(candidate.id, () => ({ ok: true, errors: [] })); target.commit(candidate.id);
  const metaContext = target.checkout("meta", ["policy"]);
  const metaLease = target.grant("meta", ["policy"], 10_000, "meta");
  const intervention = target.prepare({ id: "clarification", agent: "meta", context: metaContext.id,
    writes: { policy: "clarified" }, lease: metaLease, kind: "intervention", reason: "observed repeated ambiguity" });
  await target.validate(intervention.id, () => ({ ok: true, errors: [] })); target.commit(intervention.id);
  target.change("provider", "v2"); // Its outbox entry must survive with the earlier handled receipt.
  target.addDependency("other", "provider", 1, 1);
  const running = target.pending()[0]!; target.seen(running.id, "other-worker");
  target.openClaim("other", "missing independent evidence");
  target.reserve("other", "other-worker");
  target.scheduleRetry("retry-other", 200);
  target.beginWork("investigation", "other-worker");
  target.closeInput();
  return target.exportState();
}

test("journal begins empty and round-trips full kernel state through an actual database reopen", async (t) => {
  const file = location(t);
  const first = journal(t, file);
  assert.equal(first.load(), null);
  const state = await populated();
  assert.ok(state.events.some((event) => !event.delivered));
  assert.ok(state.obligations.some((work) => work.state === "handled"));
  assert.ok(state.obligations.some((work) => work.state === "running"));
  assert.ok(state.trace.some((entry) => entry.type === "intervention"));
  assert.equal(first.save(state, 0), 1);
  first.close();
  const reopened = journal(t, file);
  assert.deepEqual(reopened.load(), { generation: 1, state });
  const db = database(t, file);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  const row = db.prepare("SELECT payload,sha256 FROM swarm_snapshot WHERE singleton=1").get()!;
  assert.equal(row.sha256, digest(row.payload as string));
});

test("two connections reject stale generations and retain the winning snapshot", (t) => {
  const file = location(t);
  const a = journal(t, file); const b = journal(t, file);
  assert.equal(a.load(), null); assert.equal(b.load(), null);
  const first = simple();
  assert.equal(a.save(first, 0), 1);
  const losing = simple(); losing.artifacts.result!.content = "losing-write";
  assert.throws(() => b.save(losing, 0), hasCode("generation-conflict"));
  assert.deepEqual(b.load(), { generation: 1, state: first });
  const next = simple(); next.artifacts.result!.content = "winning-next-write";
  assert.equal(b.save(next, 1), 2);
  assert.throws(() => a.save(losing, 1), hasCode("generation-conflict"));
  assert.deepEqual(a.load(), { generation: 2, state: next });
});

test("an SQL failure rolls back payload, checksum, and generation together", (t) => {
  const file = location(t); const target = journal(t, file); const db = database(t, file);
  const state = simple(); target.save(state, 0);
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON swarm_snapshot BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;");
  const changed = simple(); changed.artifacts.result!.content = "must-not-partially-commit";
  assert.throws(() => target.save(changed, 1), hasCode("sqlite-error"));
  assert.deepEqual(target.load(), { generation: 1, state });
  db.exec("DROP TRIGGER reject_update");
  assert.equal(target.save(changed, 1), 2);
  assert.deepEqual(target.load(), { generation: 2, state: changed });
});

test("checksum corruption is rejected both on read and before a replacement save", (t) => {
  const file = location(t); const target = journal(t, file); const db = database(t, file);
  target.save(simple(), 0);
  const corrupt = JSON.stringify({ overwritten: true });
  db.prepare("UPDATE swarm_snapshot SET payload=? WHERE singleton=1").run(corrupt);
  assert.throws(() => target.load(), hasCode("corrupt-payload"));
  assert.throws(() => target.save(simple(), 1), hasCode("corrupt-payload"));
  assert.equal(db.prepare("SELECT payload FROM swarm_snapshot WHERE singleton=1").get()?.payload, corrupt);
  target.close();
  assert.throws(() => journal(t, file).load(), hasCode("corrupt-payload"));
});

test("matching checksums do not excuse invalid JSON or dangling state references", async (t) => {
  const file = location(t); const target = journal(t, file); const db = database(t, file);
  target.save(simple(), 0);
  const invalidJson = "{broken";
  db.prepare("UPDATE swarm_snapshot SET payload=?,sha256=? WHERE singleton=1").run(invalidJson, digest(invalidJson));
  assert.throws(() => target.load(), hasCode("corrupt-payload"));
  const state = await populated();
  state.dependencies[0]!.provider = "nonexistent-artifact";
  const payload = JSON.stringify(state);
  db.prepare("UPDATE swarm_snapshot SET payload=?,sha256=? WHERE singleton=1").run(payload, digest(payload));
  assert.throws(() => target.load(), hasCode("invalid-state"));
});

test("invalid state cannot overwrite a previously valid generation", async (t) => {
  const target = journal(t, location(t)); const state = await populated(); target.save(state, 0);
  const handledWithoutReceipt = structuredClone(state);
  handledWithoutReceipt.obligations.find((work) => work.state === "handled")!.receipt = null;
  assert.throws(() => target.save(handledWithoutReceipt, 1), hasCode("invalid-state"));
  const duplicate = structuredClone(state); duplicate.events.push({ ...duplicate.events[0]! });
  assert.throws(() => target.save(duplicate, 1), hasCode("invalid-state"));
  const badSerial = structuredClone(state); badSerial.serial = 0;
  assert.throws(() => target.save(badSerial, 1), hasCode("invalid-state"));
  const futureRead = structuredClone(state); futureRead.contexts[0]!.reads.provider!.version = 999;
  assert.throws(() => target.save(futureRead, 1), hasCode("invalid-state"));
  assert.deepEqual(target.load(), { generation: 1, state });
});

test("lossy or circular payload values are rejected instead of silently disappearing", (t) => {
  const target = journal(t, location(t)); const state = simple(); target.save(state, 0);
  const lossy = simple(); lossy.trace.push({ sequence: 1, time: 0, type: "example", details: { lost: undefined } });
  assert.throws(() => target.save(lossy, 1), hasCode("invalid-state"));
  const circular = simple();
  const details: Record<string, unknown> = {}; details.self = details;
  circular.trace.push({ sequence: 1, time: 0, type: "example", details });
  assert.throws(() => target.save(circular, 1), hasCode("invalid-state"));
  const transforming = simple();
  transforming.trace.push({ sequence: 1, time: 0, type: "example", details: { toJSON: () => "silently replaced" } });
  assert.throws(() => target.save(transforming, 1), hasCode("invalid-state"));
  assert.deepEqual(target.load(), { generation: 1, state });
});

test("unsupported schema versions and unrelated unversioned databases are preserved", (t) => {
  const futureFile = location(t); const future = database(t, futureFile);
  future.exec("PRAGMA user_version=99");
  assert.throws(() => new SqliteJournal(futureFile), hasCode("unsupported-schema"));
  assert.equal(future.prepare("PRAGMA user_version").get()?.user_version, 99);
  const unrelatedFile = location(t); const unrelated = database(t, unrelatedFile);
  unrelated.exec("CREATE TABLE important(value TEXT); INSERT INTO important VALUES('preserve');");
  assert.throws(() => new SqliteJournal(unrelatedFile), hasCode("unsupported-schema"));
  assert.equal(unrelated.prepare("SELECT value FROM important").get()?.value, "preserve");
});

test("generation validation, independent loaded objects, and closing have explicit contracts", (t) => {
  const target = journal(t, location(t)); const state = simple();
  for (const generation of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => target.save(state, generation), hasCode("invalid-generation"));
  assert.equal(target.load(), null);
  assert.equal(target.save(state, 0), 1);
  target.load()!.state.artifacts.result!.content = "changed outside the journal";
  assert.deepEqual(target.load(), { generation: 1, state });
  target.close(); target.close();
  assert.throws(() => target.load(), hasCode("journal-closed"));
  assert.throws(() => target.save(state, 1), hasCode("journal-closed"));
  assert.throws(() => new SqliteJournal(":memory:"), hasCode("invalid-path"));
});
