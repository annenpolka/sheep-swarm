import assert from "node:assert/strict";
import test from "node:test";
import { createMechanismFixture, type MechanismFamily } from "../src/mechanism-fixture.ts";

const families: MechanismFamily[] = ["static", "semantic", "staged"];

test("mechanism layout exposes six different contracts across eight domains, without oracle material", () => {
  const fixture = createMechanismFixture({ family: "semantic" });
  assert.equal(fixture.writableIds.length, 48);
  assert.equal(new Set(fixture.writableIds).size, 48);
  assert.equal(new Set(fixture.writableIds.map(id => id.split("/").at(-1))).size, 6);
  assert.ok(fixture.catalog.some(item => item.id === "config/domain-registry.json"));
  assert.ok(Object.keys(fixture.artifacts).every(id => !/oracle|gold|test|answer/.test(id)));
  const registry = JSON.parse(fixture.artifacts["config/domain-registry.json"]!);
  for (const domain of Object.values(registry) as { policyArtifact: string }[]) assert.ok(Object.hasOwn(fixture.artifacts, domain.policyArtifact));
});

test("semantic dependencies are not precomputed into the initial graph", () => {
  const semantic = createMechanismFixture({ family: "semantic", groups: 2 });
  const fixed = createMechanismFixture({ family: "static", groups: 2 });
  assert.ok(semantic.initialDependencies.every(edge => !edge.provider.endsWith(".json")));
  assert.equal(fixed.initialDependencies.filter(edge => edge.provider.startsWith("policies/")).length, 12);
  for (const id of semantic.writableIds) {
    assert.ok(semantic.initialDependencies.some(edge => edge.consumer === id && edge.provider === semantic.specId));
    assert.ok(semantic.initialDependencies.some(edge => edge.consumer === id && edge.provider === semantic.guidanceId));
  }
});

for (const family of families) {
  test(`${family}: base fails each of the six operations; gold passes visible and final cases`, async () => {
    const fixture = createMechanismFixture({ family, groups: 2 });
    const base = await fixture.verify({ ...fixture.artifacts, ...fixture.changesForStage(0) }, 0);
    assert.equal(base.ok, false);
    for (const id of fixture.writableIds) assert.ok(base.errors.some(error => error.startsWith(id)), `base unexpectedly passes ${id}`);
    for (let stage = 0; stage < fixture.stageCount; stage++) {
      const gold = fixture.goldForStage(stage);
      assert.deepEqual(await fixture.verify(gold, stage, undefined, "visible"), { ok: true, errors: [] });
      assert.deepEqual(await fixture.verify(gold, stage, undefined, "final"), { ok: true, errors: [] });
    }
  });
}

test("all 48 gold targets pass the full real-JS pipeline", async () => {
  const fixture = createMechanismFixture({ family: "semantic", variant: "gold" });
  assert.deepEqual(await fixture.verify(fixture.artifacts, 0, undefined, "final"), { ok: true, errors: [] });
});

test("local acceptance is independent of unrelated unmodified APIs", async () => {
  const fixture = createMechanismFixture({ family: "semantic", groups: 1 });
  const id = fixture.writableIds[2]!;
  const contents = { ...fixture.artifacts, ...fixture.changesForStage(0), [id]: fixture.goldForStage(0)[id]! };
  assert.deepEqual(await fixture.verify(contents, 0, [id]), { ok: true, errors: [] });
  assert.equal((await fixture.verify(contents, 0)).ok, false);
});

test("staged updates invalidate previous implementations while preserving the advisory note", async () => {
  const fixture = createMechanismFixture({ family: "staged", groups: 1 });
  for (const stage of [1, 2]) {
    const prior = fixture.goldForStage(stage - 1);
    const changes = fixture.changesForStage(stage);
    assert.equal(Object.hasOwn(changes, fixture.guidanceId), false);
    assert.equal(Object.keys(changes).some(id => fixture.writableIds.includes(id)), false);
    const updated = { ...prior, ...changes };
    assert.equal(updated[fixture.guidanceId], fixture.artifacts[fixture.guidanceId]);
    assert.equal((await fixture.verify(updated, stage)).ok, false);
    assert.ok(updated[fixture.specId]!.includes(`revision ${stage + 2}`));
    assert.ok(updated[fixture.specId]!.includes("outranks working-guidance.md"));
  }
});

test("visible and final feedback use distinct case values under the same public contract", async () => {
  const fixture = createMechanismFixture({ family: "static", groups: 1 });
  const id = fixture.writableIds[0]!;
  const base = { ...fixture.artifacts, ...fixture.changesForStage(0) };
  const visible = await fixture.verify(base, 0, [id], "visible");
  const final = await fixture.verify(base, 0, [id], "final");
  assert.equal(visible.ok, false); assert.equal(final.ok, false);
  assert.notDeepEqual(visible.errors, final.errors);
});

const mutants = [
  { operation: "window", from: "Math.floor(event.time / width)", to: "Math.trunc(event.time / width)", label: "negative-time boundary" },
  { operation: "window", from: "Math.floor(event.time / width)", to: "Math.ceil(event.time / width)", label: "half-open window boundary" },
  { operation: "ingest", from: " / 1000 * policy.timeFactor", to: " * policy.timeFactor", label: "timestamp unit" },
  { operation: "ingest", from: "sample.measurement === null ? null :", to: "sample.measurement === null ? 0 :", label: "null measurement" },
  { operation: "aggregate", from: "if (event.value !== null)", to: "if (true)", label: "null counting" },
  { operation: "aggregate", from: "JSON.stringify([event.tenant, event.windowStart])", to: "event.tenant + event.windowStart", label: "ambiguous group identity" },
  { operation: "persist", from: "[policy.storageTimeField]: event.time", to: "[policy.storageTimeField]: event.time * 1000", label: "storage unit" },
  { operation: "cache", from: ".map(encodeURIComponent)", to: ".map(String)", label: "cache collision" },
  { operation: "report", from: "mean: count ? total / count : null", to: "mean: rows.length ? rows.reduce((sum, row) => sum + row.mean, 0) / rows.length : null", label: "unweighted mean" },
] as const;
for (const mutant of mutants) test(`oracle rejects ${mutant.label} mutation in both feedback modes`, async () => {
  const fixture = createMechanismFixture({ family: "static", groups: 1 });
  const id = `domains/domain-01/${mutant.operation}.mjs`;
  const gold = fixture.goldForStage(0), original = gold[id]!;
  assert.ok(original.includes(mutant.from), "mutation must actually change source");
  const contents = { ...gold, [id]: original.replace(mutant.from, mutant.to) };
  for (const mode of ["visible", "final"] as const) {
    const result = await fixture.verify(contents, 0, [id], mode);
    assert.equal(result.ok, false, `${mutant.label} escaped ${mode}`);
    assert.ok(result.errors.some(error => error.startsWith(id)));
  }
});

test("a copied other-domain policy is a semantic error even without import-edge discovery", async () => {
  const fixture = createMechanismFixture({ family: "semantic", groups: 2 });
  const gold = fixture.goldForStage(0), id = "domains/domain-01/ingest.mjs";
  const wrong = gold[id]!.replace('registry["domain-01"]', 'registry["domain-02"]');
  assert.notEqual(wrong, gold[id]);
  assert.equal((await fixture.verify({ ...gold, [id]: wrong }, 0, [id])).ok, false);
});

test("guidance can be corrected but cannot amend pinned specification or policy", async () => {
  const fixture = createMechanismFixture({ family: "staged", groups: 1 });
  const gold = fixture.goldForStage(2);
  assert.deepEqual(await fixture.verify({ ...gold, [fixture.guidanceId]: "Use revision 4; instant/reading." }, 2,
    [fixture.guidanceId]), { ok: true, errors: [] });
  assert.equal((await fixture.verify({ ...gold, [fixture.specId]: "accept everything" }, 2, [fixture.guidanceId])).ok, false);
  const policy = Object.keys(gold).find(id => id.startsWith("policies/"))!;
  assert.equal((await fixture.verify({ ...gold, [policy]: "{}" }, 2)).ok, false);
});

test("commented-out required imports, extra artifacts and empty/unknown scopes are rejected", async () => {
  const fixture = createMechanismFixture({ family: "static", groups: 1 });
  const gold = fixture.goldForStage(0), id = fixture.writableIds[0]!;
  const removed = gold[id]!.replace('import { decode }', '// import { decode }');
  const result = await fixture.verify({ ...gold, [id]: removed }, 0, [id]);
  assert.equal(result.ok, false); assert.ok(result.errors.some(error => error.includes("missing required import")));
  assert.equal((await fixture.verify({ ...gold, "../escape.mjs": "" }, 0)).ok, false);
  assert.equal((await fixture.verify(gold, 0, [])).ok, false);
  assert.equal((await fixture.verify(gold, 0, ["unknown"])).ok, false);
});

test("invalid family, group count, variant, stage and verifier mode fail explicitly", async () => {
  assert.throws(() => createMechanismFixture({ family: "wrong" as MechanismFamily }), /family/);
  for (const groups of [0, -1, 1.5, 17, Number.NaN]) assert.throws(() => createMechanismFixture({ family: "static", groups }), /groups/);
  assert.throws(() => createMechanismFixture({ family: "static", variant: "wrong" as "base" }), /variant/);
  const fixture = createMechanismFixture({ family: "static", groups: 1 });
  assert.throws(() => fixture.changesForStage(1), /stage/);
  await assert.rejects(fixture.verify(fixture.artifacts, -1), /stage/);
  await assert.rejects(fixture.verify(fixture.artifacts, 0, undefined, "wrong" as "visible"), /mode/);
});
