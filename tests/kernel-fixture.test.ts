import assert from "node:assert/strict";
import test from "node:test";
import { createFixture } from "../src/fixture.ts";
import { KernelError, SwarmKernel } from "../src/kernel.ts";

function setup(applyMigration = true) {
  const fixture = createFixture({ size: 4 });
  // Deterministic test worker only. Real workers must never receive this reference.
  const reference = createFixture({ size: 4, variant: "migrated" });
  const kernel = new SwarmKernel({ artifacts: { ...fixture.artifacts }, now: () => 1000 });
  for (const { consumer, provider } of fixture.dependencies) kernel.addDependency(consumer, provider);
  function migrate() {
    kernel.change(fixture.changedSource.id, fixture.changedSource.content);
    kernel.closeInput();
    kernel.deliverAll();
  }
  if (applyMigration) migrate();

  function prepare(id: string, content = reference.artifacts[id]!) {
    const agent = `test-worker:${id}`;
    const work = kernel.pending().filter(item => item.consumer === id);
    const reads = new Set([id, ...work.map(item => item.provider)]);
    // Include all real transitive imports, including the source read by providers.
    for (const consumer of reads) {
      for (const edge of fixture.dependencies) if (edge.consumer === consumer) reads.add(edge.provider);
    }
    const context = kernel.checkout(agent, [...reads]);
    const lease = kernel.grant(agent, [id]);
    for (const obligation of work) kernel.seen(obligation.id, agent);
    const candidate = kernel.prepare({
      id: `proposal:${context.id}`,
      agent,
      context: context.id,
      writes: { [id]: content },
      lease: { id: lease.id, epoch: lease.epoch },
      obligations: work.map(item => item.id),
    });
    return { candidate, context, lease, agent, work };
  }

  async function repair(id: string) {
    const { candidate } = prepare(id);
    assert.deepEqual(await kernel.validate(candidate.id, contents => fixture.verify(contents, [id])), {
      ok: true, errors: [],
    });
    const committed = kernel.commit(candidate.id);
    assert.equal(committed.events.length, 1);
    kernel.deliverAll();
    return committed;
  }
  return { fixture, reference, kernel, migrate, prepare, repair };
}

const refuses = (code: string) => (error: unknown) => error instanceof KernelError && error.code === code;

test("kernel and external Node oracle converge through consumer and report commits", async () => {
  const { fixture, reference, kernel, repair } = setup();
  assert.equal(kernel.pending().length, fixture.writableIds.length);
  for (const id of fixture.consumerIds) await repair(id);
  assert.ok(kernel.pending().every(item => fixture.reportIds.includes(item.consumer)));
  assert.equal((await fixture.verify(kernel.contents())).ok, false);
  for (const id of fixture.reportIds) await repair(id);

  assert.deepEqual(kernel.pending(), []);
  assert.ok(kernel.events().every(item => item.delivered));
  assert.ok(kernel.obligations().every(item => item.receipt?.outcome === "handled"));
  assert.deepEqual(kernel.contents(), reference.artifacts);
  assert.deepEqual(await kernel.complete(contents => fixture.verify(contents)), { ok: true, errors: [] });
  assert.equal(kernel.trace().filter(item => item.type === "committed").length, fixture.writableIds.length);
  for (const id of fixture.writableIds) assert.equal(kernel.artifact(id).version, 1);
});

test("one accepted local patch leaves both protocol work and final acceptance incomplete", async () => {
  const { fixture, kernel, repair } = setup();
  const id = fixture.consumerIds[0]!;
  await repair(id);
  assert.deepEqual(await fixture.verify(kernel.contents(), [id]), { ok: true, errors: [] });
  assert.equal((await fixture.verify(kernel.contents())).ok, false);
  assert.ok(kernel.pending().some(item => item.consumer !== id));
  const completion = await kernel.complete(contents => fixture.verify(contents));
  assert.equal(completion.ok, false);
  assert.ok(completion.errors.includes("pending-work"));
});

test("a worker checkout taken before the source migration cannot submit a patch", () => {
  const { fixture, reference, kernel, migrate } = setup(false);
  const id = fixture.consumerIds[0]!;
  const context = kernel.checkout("old-worker", [id, fixture.sourceId, fixture.specId]);
  const lease = kernel.grant("old-worker", [id]);
  migrate();
  const before = kernel.contents();
  assert.throws(() => kernel.prepare({
    id: "stale-context-proposal",
    agent: "old-worker",
    context: context.id,
    writes: { [id]: reference.artifacts[id]! },
    lease: { id: lease.id, epoch: lease.epoch },
  }), refuses("stale-read"));
  assert.deepEqual(kernel.contents(), before);
  assert.equal(kernel.artifact(id).version, 0);
});

test("meta clarification makes an already validated worker proposal stale", async () => {
  const { fixture, kernel, prepare } = setup();
  const id = fixture.consumerIds[0]!;
  const worker = prepare(id);
  assert.equal((await kernel.validate(worker.candidate.id, contents => fixture.verify(contents, [id]))).ok, true);

  const metaContext = kernel.checkout("meta", [fixture.specId, fixture.sourceId]);
  const authority = kernel.grant("meta", [fixture.specId], 60_000, "meta");
  const clarification = `${metaContext.contents[fixture.specId]}\nClarification: convert latency thresholds to seconds; 300 ms means 0.3 s.\n`;
  const intervention = kernel.prepare({
    id: "meta-unit-clarification",
    agent: "meta",
    context: metaContext.id,
    writes: { [fixture.specId]: clarification },
    lease: { id: authority.id, epoch: authority.epoch },
    kind: "intervention",
    reason: "Observed repeated errors around latency threshold units.",
  });
  assert.equal((await kernel.validate(intervention.id, contents => fixture.verify(contents, [fixture.specId]))).ok, true);
  kernel.commit(intervention.id);
  kernel.deliverAll();

  assert.equal(kernel.artifact(fixture.specId).version, 1);
  assert.ok(kernel.trace().some(item => item.type === "intervention"));
  assert.throws(() => kernel.commit(worker.candidate.id), refuses("stale-read"));
  assert.equal(kernel.artifact(id).version, 0);
  assert.ok(kernel.pending().some(item => item.consumer === id && item.provider === fixture.specId));
});

test("semantic threshold mistakes fail validation and cannot receive a successful commit", async () => {
  const { fixture, reference, kernel, prepare } = setup();
  const id = fixture.consumerIds[0]!;
  const correct = reference.artifacts[id]!;
  const wrong = correct.replace("reading.durationSeconds <= 0.3", "reading.durationSeconds <= 300");
  assert.notEqual(wrong, correct);
  const before = kernel.contents();
  const { candidate } = prepare(id, wrong);
  const validation = await kernel.validate(candidate.id, contents => fixture.verify(contents, [id]));
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(error => error.includes(id) && error.includes("healthy")));
  assert.throws(() => kernel.commit(candidate.id), refuses("candidate-not-validated"));
  assert.deepEqual(kernel.contents(), before);
  assert.ok(kernel.pending().some(item => item.consumer === id));
  assert.ok(kernel.obligations().filter(item => item.consumer === id).every(item => item.receipt === null));
});
