import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createMechanismFixture } from "../src/mechanism-fixture.ts";
import { createDockerFixtureObserver } from "../src/docker-fixture-observer.ts";

const directory = resolve(`.sheep/docker-mechanism-probe-${Date.now()}`); await mkdir(directory);
const observations = [];
const observe = createDockerFixtureObserver(join(directory, "acceptance"));
const check = async (label, fixture, contents, stage, expected) => {
  const result = await fixture.verify(contents, stage, undefined, "final");
  observations.push({ label, expected, ...result });
  assert.equal(result.ok, expected, label); assert.notEqual(result.executionFailure, true);
  console.log(JSON.stringify({ label, expected, ok: result.ok }));
};
try {
  for (const family of ["static", "semantic", "staged"]) {
    const fixture = createMechanismFixture({ family, groups: 1, observe });
    for (let stage = 0; stage < fixture.stageCount; stage++) await check(`${family} gold stage ${stage}`, fixture, fixture.goldForStage(stage), stage, true);
  }
  const fixture = createMechanismFixture({ family: "semantic", groups: 1, observe });
  await check("semantic old targets", fixture, { ...fixture.artifacts, ...fixture.changesForStage(0) }, 0, false);
  const gold = fixture.goldForStage(0), target = fixture.writableIds[1];
  await check("negative-time mutation", fixture, { ...gold, [target]: gold[target].replace("Math.floor", "Math.trunc") }, 0, false);
  const ingest = fixture.writableIds[0];
  await check("missing required decoder import", fixture, { ...gold, [ingest]: gold[ingest].replace('import { decode }', '// import { decode }') }, 0, false);
  assert.ok(observations.at(-1).errors.some(error => error.includes("missing required import")));
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: true, modelCalls: 0, observations }, null, 2) + "\n");
  console.log(JSON.stringify({ success: true, modelCalls: 0, directory }));
} catch (error) {
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: false, modelCalls: 0, error: String(error), observations }, null, 2) + "\n"); throw error;
}
