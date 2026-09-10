import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHeldoutFixture } from "../src/heldout-fixture.ts";
import { createDockerFixtureObserver } from "../src/docker-fixture-observer.ts";

const directory = resolve(`.sheep/docker-comparison-probe-${Date.now()}`); await mkdir(directory);
const fixture = createHeldoutFixture({ size: 4, variant: "migrated", observe: createDockerFixtureObserver(join(directory, "acceptance")) });
const old = createHeldoutFixture({ size: 4 }), target = fixture.writableIds[0], right = fixture.artifacts[target];
const noImport = right.replace('import { sample } from "../lib/thermal.mjs";', '// import { sample } from "../lib/thermal.mjs";')
  .replace("const value = sample(input);", "const value = { kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000 };");
const observations = [];
try {
  for (const [label, contents, expected] of [
    ["fixed whole fixture", fixture.artifacts, true],
    ["old targets", { ...old.artifacts, [fixture.sourceId]: fixture.artifacts[fixture.sourceId] }, false],
    ["wrong threshold", { ...fixture.artifacts, [target]: right.replace("value.kelvin >= -10 + 273.15", "value.kelvin >= -10") }, false],
    ["value-equivalent missing import", { ...fixture.artifacts, [target]: noImport }, false],
  ]) {
    const result = await fixture.verify(contents); observations.push({ label, expected, ...result });
    assert.equal(result.ok, expected, label); assert.notEqual(result.executionFailure, true);
    if (label.includes("missing import")) assert.ok(result.errors.some(error => error.includes("missing required import")));
  }
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: true, modelCalls: 0, observations }, null, 2) + "\n");
  console.log(JSON.stringify({ success: true, modelCalls: 0, directory }));
} catch (error) {
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: false, error: String(error), observations }, null, 2) + "\n"); throw error;
}
