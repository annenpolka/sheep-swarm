import assert from "node:assert/strict";
import { test } from "node:test";
import { schedules } from "../experiments/schedules.ts";
import { simulate } from "../experiments/write-skew.ts";

test("reference fixture covers all six legal, unique schedules", () => {
  assert.equal(schedules.length, 6); // 4! / (2 * 2)
  assert.equal(new Set(schedules.map((s) => s.join(","))).size, 6);
  for (const schedule of schedules) {
    assert.deepEqual([...schedule].sort(), ["A:commit", "A:read", "B:commit", "B:read"]);
    for (const worker of ["A", "B"] as const) {
      const actions: readonly string[] = schedule;
      assert.ok(actions.indexOf(`${worker}:read`) < actions.indexOf(`${worker}:commit`));
    }
  }
});

test("write-set-only control reproduces the report's four unsafe schedules", () => {
  const results = schedules.map((s) => simulate(s, "write-set"));
  assert.deepEqual(results.map((r) => r.invariant), [true, false, false, true, false, false]);
  for (const result of results.filter((r) => !r.invariant)) {
    assert.deepEqual(result.final, { x: 0, y: 0 });
    assert.equal(result.trace.filter((s) => s.outcome === "committed").length, 2);
  }
});

test("checking all observed reads prevents this counterexample", () => {
  const results = schedules.map((s) => simulate(s, "read-set"));
  assert.ok(results.every((r) => r.invariant));
  assert.deepEqual(results.map((r) => r.trace.filter((s) => s.outcome === "stale").length),
    [0, 1, 1, 0, 1, 1]);
  assert.ok(results.every((r) => r.trace.filter((s) => s.outcome === "committed").length === 1));
});
