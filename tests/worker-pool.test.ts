import assert from "node:assert/strict";
import test from "node:test";
import { WorkerPool, type WorkerAssignment, type WorkerMemory } from "../src/worker-pool.ts";

function finish(pool: WorkerPool, assignment: WorkerAssignment, note = `observed ${assignment.target}`, reads = {
  [assignment.target]: { version: 1, evidenceEpoch: 2 },
}): void {
  pool.finish(assignment.workerId, { target: assignment.target, note, outcome: "committed", reads });
}

test("concurrency and unique active targets hold across multiple assign calls", () => {
  const pool = new WorkerPool({ workers: 4, concurrency: 2 });
  const first = pool.assign([
    { target: "a", neighbors: [] }, { target: "a", neighbors: [] }, { target: "b", neighbors: [] },
  ]);
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map(item => item.workerId)).size, 2);
  assert.deepEqual(first.map(item => item.target), ["a", "b"]);
  assert.deepEqual(pool.assign([{ target: "c", neighbors: [] }]), []);
  finish(pool, first[0]!);
  const second = pool.assign([{ target: "b", neighbors: [] }, { target: "c", neighbors: [] }]);
  assert.equal(second.length, 1);
  assert.equal(second[0]!.target, "c");
  assert.equal(pool.stats().filter(item => item.active).length, 2);
});

test("every individual participates fairly even when repeat jobs match an experienced worker", () => {
  const pool = new WorkerPool({ workers: 8, concurrency: 1 });
  const assigned: string[] = [];
  for (let index = 0; index < 24; index++) {
    const assignment = pool.assign([{ target: "same-artifact", neighbors: ["same-provider"] }])[0]!;
    assigned.push(assignment.workerId);
    finish(pool, assignment, "same recurring job", {
      "same-artifact": { version: index, evidenceEpoch: index },
      "same-provider": { version: 1, evidenceEpoch: 1 },
    });
  }
  assert.equal(new Set(assigned.slice(0, 8)).size, 8);
  assert.equal(new Set(assigned.slice(8, 16)).size, 8);
  assert.ok(pool.stats().every(worker => worker.assignments === 3 && !worker.active));
});

test("read-neighborhood affinity wins between equally used available individuals", () => {
  const pool = new WorkerPool({ workers: 2, concurrency: 2 });
  const initial = pool.assign([{ target: "a", neighbors: [] }, { target: "b", neighbors: [] }]);
  finish(pool, initial[0]!, "worked near alpha", { alpha: { version: 1, evidenceEpoch: 1 } });
  finish(pool, initial[1]!, "worked near beta", { beta: { version: 7, evidenceEpoch: 9 } });
  const next = pool.assign([{ target: "new-b", neighbors: ["beta"] }])[0]!;
  // sheep-1 was assigned earlier; affinity must override that neutral tie breaker.
  assert.equal(next.workerId, initial[1]!.workerId);
  assert.equal(next.memory[0]!.note, "worked near beta");
  assert.deepEqual(next.memory[0]!.reads, { beta: { version: 7, evidenceEpoch: 9 } });
});

test("each worker receives only its own bounded history, including failed observations and versions", () => {
  const pool = new WorkerPool({ workers: 2, concurrency: 2, memoryLimit: 2 });
  for (let round = 0; round < 3; round++) {
    const assignments = pool.assign([{ target: `a-${round}`, neighbors: [] }, { target: `b-${round}`, neighbors: [] }]);
    for (const assignment of assignments) {
      assert.ok(assignment.memory.every(memory => memory.note.startsWith(assignment.workerId)));
      pool.finish(assignment.workerId, {
        target: assignment.target,
        note: `${assignment.workerId}: observation from round ${round}`,
        outcome: round === 1 ? "rejected" : "committed",
        reads: { input: { version: round, evidenceEpoch: round + 10 } },
      });
    }
  }
  for (const worker of pool.stats()) {
    assert.equal(worker.memory.length, 2);
    assert.equal(worker.memory[0]!.outcome, "rejected");
    assert.equal(worker.memory[0]!.reads.input!.version, 1);
    assert.equal(worker.memory[1]!.reads.input!.evidenceEpoch, 12);
    assert.ok(worker.memory.every(memory => memory.note.startsWith(worker.id)));
  }
});

test("the default history limit is four and forgotten reads do not keep affinity forever", () => {
  const pool = new WorkerPool({ workers: 2, concurrency: 2 });
  const originals = pool.assign([{ target: "a0", neighbors: [] }, { target: "b0", neighbors: [] }]);
  finish(pool, originals[0]!, "ordinary");
  finish(pool, originals[1]!, "old beta knowledge", { beta: { version: 0, evidenceEpoch: 0 } });
  for (let round = 1; round <= 4; round++) {
    const assignments = pool.assign([{ target: `a${round}`, neighbors: [] }, { target: `b${round}`, neighbors: [] }]);
    for (const assignment of assignments) finish(pool, assignment);
  }
  assert.ok(pool.stats().every(worker => worker.memory.length === 4));
  assert.ok(pool.stats().every(worker => worker.memory.every(memory => !Object.hasOwn(memory.reads, "beta"))));
  const next = pool.assign([{ target: "new-beta", neighbors: ["beta"] }])[0]!;
  assert.equal(next.workerId, originals[0]!.workerId);
});

test("caller mutations of finish input, assignments and stats never alter pool state", () => {
  const pool = new WorkerPool({ workers: 1, concurrency: 1 });
  const first = pool.assign([{ target: "a", neighbors: [] }])[0]!;
  const observation = {
    target: "a", note: "original", outcome: "committed", reads: { a: { version: 1, evidenceEpoch: 2 } },
  };
  pool.finish(first.workerId, observation);
  observation.note = "changed after finish";
  observation.reads.a.version = 99;
  const second = pool.assign([{ target: "b", neighbors: [] }])[0]!;
  const mutableAssignment = second as { workerId: string; target: string; memory: WorkerMemory[] };
  mutableAssignment.workerId = "other";
  mutableAssignment.target = "other";
  (mutableAssignment.memory[0]!.reads.a as { version: number }).version = 88;
  mutableAssignment.memory.length = 0;
  const stats = pool.stats();
  const mutableStats = stats[0] as unknown as {
    id: string; assignments: number; active: boolean; activeTarget: string | null;
    memory: { note: string; reads: Record<string, { version: number }> }[];
  };
  mutableStats.id = "other";
  mutableStats.assignments = 100;
  mutableStats.active = false;
  mutableStats.activeTarget = null;
  mutableStats.memory[0]!.note = "edited statistics";
  mutableStats.memory[0]!.reads.a!.version = 77;
  assert.deepEqual(pool.stats(), [{
    id: "sheep-1", assignments: 2, active: true, activeTarget: "b",
    memory: [{ target: "a", note: "original", outcome: "committed", reads: { a: { version: 1, evidenceEpoch: 2 } } }],
  }]);
});

test("invalid completion and invalid jobs preserve active assignments and history", () => {
  const pool = new WorkerPool({ workers: 2, concurrency: 1 });
  assert.throws(() => pool.assign([{ target: "valid", neighbors: [] }, { target: "", neighbors: [] }]), /jobs must/);
  assert.ok(pool.stats().every(worker => worker.assignments === 0));
  const assignment = pool.assign([{ target: "a", neighbors: [] }])[0]!;
  const before = pool.stats();
  assert.throws(() => pool.finish(assignment.workerId, { target: "b", note: "", outcome: "failed", reads: {} }), /does not match/);
  assert.throws(() => pool.finish(assignment.workerId, {
    target: "a", note: "", outcome: "failed", reads: { a: { version: -1, evidenceEpoch: 1 } },
  }), /invalid worker observation/);
  assert.deepEqual(pool.stats(), before);
  finish(pool, assignment);
  assert.throws(() => pool.finish(assignment.workerId, { target: "a", note: "", outcome: "done", reads: {} }), /does not match/);
});
