import assert from "node:assert/strict";
import test from "node:test";
import { parseRepoTask, safeRepoPath } from "../src/repo-manifest.ts";
import { manifest } from "./repo-test-helpers.ts";

test("repository manifest normalizes optional fields without mutating inputs", () => {
  const input = manifest(), before = JSON.stringify(input), task = parseRepoTask(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(task.context, []); assert.deepEqual(task.files[0]!.dependsOn, []);
  assert.deepEqual(task.files[0]!.checks, []); assert.equal(task.checks[0]!.timeoutMs, 30000);
  assert.equal(safeRepoPath("日本語/with space.py"), "日本語/with space.py");
});
test("repository paths reject traversal, secrets, metadata and normalization tricks", () => {
  for (const path of ["", "/a", "a/../b", "./a", "a//b", "a/", "a\\b", "a\nb", ".git/config", "x/.git/a", ".GIT/config", ".ENV.local", ".env", "x/.env.local", ".sheep/a", "node_modules/a", ".sheep-internal/goal", "bad\ud800"])
    assert.throws(() => safeRepoPath(path), path);
});
test("repository manifest rejects malformed plans before execution", () => {
  const bad: unknown[] = [null, {}, { ...manifest(), typo: 1 }, { ...manifest(), version: 2 }, { ...manifest(), files: [] },
    { ...manifest(), protected: [] }, { ...manifest(), checks: [] }, { ...manifest(), goal: " " },
    { ...manifest(), protected: ["a.mjs"] }, { ...manifest(), context: ["x", "x"] },
    { ...manifest(), files: [...manifest().files, ...manifest().files] },
    { ...manifest(), files: [{path:"a",instructions:"x"},{path:"a/b",instructions:"x"}] },
    { ...manifest(), checks: [{argv:["node","bad\0arg"]}] },
    { ...manifest(), files: [{ path: "a", instructions: "x", dependsOn: ["missing"] }] },
    { ...manifest(), files: [{ path: "a", instructions: "x", dependsOn: ["a"] }] },
    { ...manifest(), files: [{ path: "a", instructions: "x", dependsOn: ["b"] }, { path: "b", instructions: "x", dependsOn: ["a"] }] },
    { ...manifest(), checks: [{ argv: ["node"], timeoutMs: 0 }] }, { ...manifest(), checks: [{ argv: ["node"], timeoutMs: 1.5 }] },
    { ...manifest(), checks: [{ argv: ["node"], typo: true }] }, { ...manifest(), checks: [{ argv: [" "] }] },
    { ...manifest(), files: [{ ...manifest().files[0], typo: true }] },
    JSON.parse('{"version":1,"goal":"g","files":[],"checks":[],"protected":[],"__proto__":{}}')];
  for (const value of bad) assert.throws(() => parseRepoTask(value), JSON.stringify(value));
});
