import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SwarmKernel, KernelError } from "../src/kernel.ts";
import { SqliteJournal } from "../src/journal.ts";

test("recovery atomically fences leases and candidates while returning seen work to pending", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sheep-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new SqliteJournal(join(directory, "state.sqlite")); t.after(() => journal.close());
  let generation = 0;
  const save = (state: ReturnType<SwarmKernel["exportState"]>) => { generation = journal.save(state, generation); };
  const target = new SwarmKernel({ artifacts: { provider: "old", consumer: "old" }, now: () => 10, save });
  target.addDependency("consumer", "provider"); target.change("provider", "new"); target.deliverAll();
  const work = target.pending()[0]!; target.seen(work.id, "worker");
  const context = target.checkout("worker", ["provider", "consumer"]);
  const lease = target.grant("worker", ["consumer"]);
  const candidate = target.prepare({ id: "old-proposal", agent: "worker", context: context.id,
    writes: { consumer: "new" }, lease, obligations: [work.id] });
  await target.validate(candidate.id, () => ({ ok: true, errors: [] }));
  target.reserve("consumer", "worker"); target.beginWork("call-1", "worker");
  target.setApplication({ remainingBudget: 3, callReservations: [{ id: "call-1", state: "reserved" }] });
  const snapshot = journal.load()!;
  const restored = SwarmKernel.restore(snapshot.state, { now: () => 20, save });
  const state = restored.exportState();
  assert.equal(generation, snapshot.generation + 1);
  assert.equal(state.obligations[0]!.state, "pending");
  assert.equal(state.obligations[0]!.agent, null);
  assert.equal(state.obligations[0]!.receipt, null);
  assert.equal(state.candidates[0]!.state, "discarded");
  assert.equal(state.leases[0]!.epoch, lease.epoch + 1);
  assert.ok(state.leases[0]!.expiresAt <= 20);
  assert.equal(state.activeWork.length, 0); assert.equal(state.reservations.length, 0);
  assert.deepEqual(restored.application(), snapshot.state.application);
  assert.deepEqual(journal.load()?.state, state);
  assert.throws(() => restored.commit(candidate.id), (error: unknown) => error instanceof KernelError && error.code === "candidate-not-validated");
  assert.throws(() => restored.prepare({ id: "stale-authority", agent: "worker", context: context.id,
    writes: { consumer: "new" }, lease }), (error: unknown) => error instanceof KernelError && error.code === "invalid-authority");
});

test("a durable save failure fences further mutation and acceptance until the journal is reloaded", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sheep-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "state.sqlite");
  const journal = new SqliteJournal(file); t.after(() => journal.close());
  const db = new DatabaseSync(file); t.after(() => db.close());
  let generation = 0;
  const save = (state: ReturnType<SwarmKernel["exportState"]>) => { generation = journal.save(state, generation); };
  const target = new SwarmKernel({ artifacts: { item: "durable-old" }, save });
  target.setApplication({ started: true });
  const before = journal.load();
  db.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON swarm_snapshot BEGIN SELECT RAISE(ABORT, 'disk write failure'); END;");
  const failed = (error: unknown) => error instanceof KernelError && error.code === "persistence-failed";
  assert.throws(() => target.change("item", "not-durable"), failed);
  assert.deepEqual(journal.load(), before);
  assert.throws(() => target.change("item", "must-not-continue"), failed);
  assert.throws(() => target.closeInput(), failed);
  assert.throws(() => target.addDependency("item", "item"), failed);
  assert.throws(() => target.setApplication({ completed: true }), failed);
  await assert.rejects(target.complete(() => ({ ok: true, errors: [] })), failed);
  db.exec("DROP TRIGGER fail_save");
  const restored = SwarmKernel.restore(journal.load()!.state, { save });
  assert.equal(restored.contents().item, "durable-old");
  restored.change("item", "durable-new");
  assert.equal(journal.load()?.state.artifacts.item?.content, "durable-new");
});

test("committed writes and undelivered outbox survive recovery without reapplying a proposal", async () => {
  const target = new SwarmKernel({ artifacts: { provider: "old", consumer: "old", downstream: "old" }, now: () => 0 });
  target.addDependency("consumer", "provider"); target.addDependency("downstream", "consumer");
  target.change("provider", "new"); target.deliverAll();
  const work = target.pending().filter((item) => item.consumer === "consumer");
  const context = target.checkout("writer", ["consumer", "provider"]); const lease = target.grant("writer", ["consumer"]);
  const candidate = target.prepare({ id: "one-change", agent: "writer", context: context.id,
    writes: { consumer: "new" }, lease, obligations: work.map((item) => item.id) });
  await target.validate(candidate.id, () => ({ ok: true, errors: [] })); const committed = target.commit(candidate.id);
  const restored = SwarmKernel.restore(target.exportState(), { now: () => 1 });
  assert.equal(restored.artifact("consumer").version, 1);
  assert.ok(restored.events().some((event) => !event.delivered));
  restored.deliverAll(); restored.deliverAll();
  assert.equal(restored.events().filter((event) => event.artifact === "consumer").length, 1);
  assert.equal(restored.pending().filter((item) => item.consumer === "downstream" && item.provider === "consumer").length, 1);
  const before = restored.exportState();
  assert.throws(() => restored.commit(candidate.id));
  assert.deepEqual(restored.exportState(), before);
  assert.equal(restored.exportState().candidates.find((item) => item.id === candidate.id)?.validation?.id, committed.validation);
});

test("restore rejects invalid snapshots before calling persistence", () => {
  const state = new SwarmKernel({ artifacts: { item: "old" } }).exportState();
  state.dependencies.push({ consumer: "missing", provider: "item" });
  let saves = 0;
  assert.throws(() => SwarmKernel.restore(state, { save: () => { saves++; } }),
    (error: unknown) => error instanceof KernelError && error.code === "invalid-state");
  assert.equal(saves, 0);
});
