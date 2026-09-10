import assert from "node:assert/strict";
import test from "node:test";
import { createFixture, verifyFixture } from "../src/fixture.ts";

test("baseline and migrated implementations meet their fixed physical-unit contracts", async () => {
  for (const size of [4, 16]) {
    const baseline = createFixture({ size });
    const migrated = createFixture({ size, variant: "migrated" });
    assert.deepEqual(await verifyFixture(baseline.artifacts, undefined, { size, contract: "baseline" }), { ok: true, errors: [] });
    assert.deepEqual(await migrated.verify(migrated.artifacts), { ok: true, errors: [] });
    assert.equal(baseline.writableIds.length, size + Math.ceil(size / 4));
  }
});

test("the changed source alone breaks consumers and reports", async () => {
  const fixture = createFixture({ size: 4 });
  const changed = { ...fixture.artifacts, [fixture.changedSource.id]: fixture.changedSource.content };
  const result = await fixture.verify(changed);
  assert.equal(result.ok, false);
  for (const id of fixture.writableIds) assert.ok(result.errors.some(error => error.startsWith(id)));
  assert.ok(result.errors.every(error => !error.startsWith(fixture.sourceId)));
});

test("local acceptance permits one consumer repair without hiding unfinished global work", async () => {
  const fixture = createFixture({ size: 4 });
  const migrated = createFixture({ size: 4, variant: "migrated" });
  const id = fixture.consumerIds[0]!;
  const partiallyFixed = {
    ...fixture.artifacts,
    [fixture.changedSource.id]: fixture.changedSource.content,
    [id]: migrated.artifacts[id]!,
  };
  assert.deepEqual(await fixture.verify(partiallyFixed, [id]), { ok: true, errors: [] });
  assert.equal((await fixture.verify(partiallyFixed)).ok, false);
  assert.equal((await fixture.verify(partiallyFixed, [fixture.reportIds[0]!])).ok, false);
});

test("reports need a second-stage repair after their provider consumers migrate", async () => {
  const fixture = createFixture({ size: 8 });
  const migrated = createFixture({ size: 8, variant: "migrated" });
  const contents = { ...migrated.artifacts };
  for (const id of fixture.reportIds) contents[id] = fixture.artifacts[id]!;
  for (const id of fixture.consumerIds) assert.equal((await fixture.verify(contents, [id])).ok, true);
  const result = await fixture.verify(contents);
  assert.equal(result.ok, false);
  assert.ok(result.errors.every(error => fixture.reportIds.some(id => error.startsWith(id))));
  assert.deepEqual(await fixture.verify(migrated.artifacts), { ok: true, errors: [] });
});

test("the host oracle catches unit mistakes, wrong thresholds, and extra compatibility fields", async () => {
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const id = fixture.consumerIds[0]!;
  const right = fixture.artifacts[id]!;
  for (const wrong of [
    right.replace("durationSeconds: reading.durationSeconds", "durationSeconds: reading.durationSeconds * 1000"),
    right.replace("reading.durationSeconds <= 0.3", "reading.durationSeconds <= 300"),
    right.replace("reading.kibibytes / reading.durationSeconds", "reading.kibibytes * 1.024 / reading.durationSeconds"),
    right.replace("healthy:", "durationMs: reading.durationSeconds * 1000, healthy:"),
    right.replace("reading.durationSeconds === 0 ? 0", "reading.durationSeconds === 0 ? Infinity"),
  ]) {
    assert.notEqual(wrong, right);
    assert.equal((await fixture.verify({ ...fixture.artifacts, [id]: wrong }, [id])).ok, false);
  }
});

test("changing the task specification or deleting an artifact cannot weaken acceptance", async () => {
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const baseline = createFixture({ size: 4 });
  assert.equal((await fixture.verify({ ...baseline.artifacts, [fixture.specId]: "Old API is now correct." })).ok, false);
  const incomplete = { ...fixture.artifacts };
  delete incomplete[fixture.consumerIds[3]!];
  assert.equal((await fixture.verify(incomplete)).ok, false);
  assert.equal((await fixture.verify(fixture.artifacts, [])).ok, false);
  assert.equal((await fixture.verify({ ...fixture.artifacts, "../escape.mjs": "" })).ok, false);
});

test("all imports and true shared-contract dependencies survive scale increases", () => {
  for (const size of [4, 8, 16, 32, 64]) {
    const fixture = createFixture({ size });
    const edges = new Set(fixture.dependencies.map(edge => `${edge.consumer}->${edge.provider}`));
    assert.equal(edges.size, fixture.dependencies.length);
    for (const id of fixture.consumerIds) {
      assert.ok(edges.has(`${id}->${fixture.sourceId}`));
      assert.ok(edges.has(`${id}->${fixture.specId}`));
    }
    for (const id of fixture.reportIds) {
      const imports = [...fixture.artifacts[id]!.matchAll(/from "\.\.\/(consumers\/[^\"]+)"/g)];
      assert.equal(imports.length, 2);
      for (const match of imports) assert.ok(edges.has(`${id}->${match[1]}`));
      assert.ok(edges.has(`${id}->${fixture.specId}`));
    }
  }
});

test("candidate execution has finite duration and cannot read outside its temporary fixture", async () => {
  const fixture = createFixture({ size: 4, variant: "migrated" });
  const id = fixture.consumerIds[0]!;
  const blocked = await fixture.verify({
    ...fixture.artifacts,
    [id]: 'import { readFileSync } from "node:fs"; export function summarize() { return readFileSync("/etc/hosts", "utf8"); }',
  }, [id]);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some(error => error.includes("Access to this API has been restricted")));
  const timedOut = await verifyFixture({ ...fixture.artifacts, [id]: "while (true) {}" }, [id], { size: 4, timeoutMs: 150 });
  assert.equal(timedOut.ok, false);
  assert.ok(timedOut.errors.some(error => error.startsWith("fixture execution failed:")));
});
