import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createFixture } from "../src/fixture.ts";
import { createDockerFixtureObserver } from "../src/docker-fixture-observer.ts";

const directory = resolve(`.sheep/docker-swarm-probe-${new Date().toISOString().replaceAll(":", "-")}`);
await mkdir(directory);
const fixed = createFixture({ size: 4, variant: "migrated", observe: createDockerFixtureObserver(join(directory, "acceptance")) });
const old = createFixture({ size: 4 });
const target = fixed.consumerIds[0];
const observations = [];
try {
  for (const [label, files, scope, expected] of [
    ["migrated whole fixture", fixed.artifacts, undefined, true],
    ["changed library with old targets", { ...old.artifacts, [fixed.sourceId]: fixed.artifacts[fixed.sourceId] }, undefined, false],
    ["exclusive threshold mutation", { ...fixed.artifacts, [target]: fixed.artifacts[target].replace("<= 0.3", "< 0.3") }, [target], false],
    ["host API import", { ...fixed.artifacts, [target]: 'import fs from "node:fs"; export function summarize(){return fs.readFileSync("/etc/hosts");}' }, [target], false],
    ["candidate infinite loop", { ...fixed.artifacts, [target]: 'while(true){}' }, [target], false],
  ]) {
    const result = await fixed.verify(files, scope);
    observations.push({ label, expected, ...result });
    assert.equal(result.ok, expected, label);
    // A transport/setup failure must never masquerade as a successful mutation rejection.
    if (!expected && label !== "candidate infinite loop") assert.ok(result.errors.every(error => !error.startsWith("fixture execution failed:")), result.errors.join("\n"));
    if (label === "candidate infinite loop") assert.ok(result.errors.some(error => error.includes("exec failed") || error.includes("invocation failed")));
  }
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: true, modelCalls: 0, observations }, null, 2) + "\n");
  console.log(JSON.stringify({ success: true, directory, modelCalls: 0 }));
} catch (error) {
  await writeFile(join(directory, "result.json"), JSON.stringify({ success: false, error: String(error), observations }, null, 2) + "\n");
  throw error;
}
