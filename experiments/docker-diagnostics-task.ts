import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { CodeFixture, FixtureObserver, FixtureResult, Invocation } from "../src/fixture.ts";
import type { SwarmTask } from "../src/swarm.ts";

export const TOOL_SUMMARY = "scripts/lib/docker-tool-summary.mjs";
export const PROGRESS = "scripts/lib/mechanism-progress.mjs";
const SOURCE = "docs/runtime-contract.md", SPEC = "docs/implementation-task.md";
const targets = [TOOL_SUMMARY, PROGRESS];
export interface AuditCase { input: unknown; expected?: unknown; throws?: "TypeError" }
const call = (id: string, name: string) => ({ type: "tool_call", tool_call: { id, function: { name } } });
const response = (id: string, isError = false) => ({ type: "tool_call_response", tool_call_id: id, result: { isError } });
const toolResult = (calls: number, byTool: Record<string, number>, responded: number, pending: string[], errors: string[], structuredOutputDelivered = false) =>
  ({ calls, byTool, responded, pending, errors, structuredOutputDelivered });
const stage = (index: number) => ({ stage: index, success: true, qualityPass: true, protocolClean: true });
const base = () => ({ family: "semantic", success: true, terminationReason: "completed", stages: [stage(0)], calls: [],
  budget: { unknownUsageCalls: 0, activeReservations: 0, exceeded: false } });
const progress = (overrides: Record<string, unknown> = {}) => ({ complete: true, expectedStages: 1, stages: [stage(0)],
  calls: 0, lowerCalls: 0, upperCalls: 0, readCalls: 0, committedTargets: [], unknownUsageCalls: 0, terminationReason: "completed", ...overrides });

/** Frozen independent examples; none are computed by the candidate helpers. */
export function diagnosticCases(target: string, final = false): AuditCase[] {
  if (target === TOOL_SUMMARY) {
    const cases: AuditCase[] = [
      { input: [], expected: toolResult(0, {}, 0, [], []) },
      { input: [call("a", "read_file"), response("a")], expected: toolResult(1, { read_file: 1 }, 1, [], []) },
      { input: [call("b", "check_local"), response("b", true), call("a", "write_file")], expected: toolResult(2, { check_local: 1, write_file: 1 }, 1, ["a"], ["b"]) },
      { input: [null, { type: "partial_tool_call", tool_call: { id: "x", function: { name: "edit_file" } } }, response("unknown"), { type: "toolset_info" }], expected: toolResult(0, {}, 0, [], []) },
      { input: [call("a", "__structured_output__"), response("a"), call("a", "other"), response("a")], expected: toolResult(1, { __structured_output__: 1 }, 1, [], [], true) },
      { input: [call("a", "__structured_output__"), response("a"), response("a", true)], expected: toolResult(1, { __structured_output__: 1 }, 1, [], ["a"]) },
      { input: null, throws: "TypeError" },
    ];
    if (final) {
      cases.push({ input: {}, throws: "TypeError" }, { input: "events", throws: "TypeError" });
      for (let i = 0; i < 40; i++) {
        const id = `call-${i}`, second = `second-${i}`, name = ["__proto__", "constructor", "read_file", "check_local", "__structured_output__"][i % 5]!;
        const hasResponse = i % 3 !== 0, failed = i % 4 === 0;
        const input = [response(second), call(id, name), call(second, name), call(id, "duplicate"),
          ...(hasResponse ? [response(id, failed), response(id)] : []), null,
          { type: "tool_call", tool_call: { id: "", function: { name: "bad" } } }];
        cases.push({ input, expected: toolResult(2, { [name]: 2 }, hasResponse ? 2 : 1,
          hasResponse ? [] : [id], hasResponse && failed ? [id] : [], name === "__structured_output__") });
      }
    }
    return cases;
  }
  if (target !== PROGRESS) throw new Error("unknown diagnostics target");
  const cases: AuditCase[] = [
    { input: base(), expected: progress() },
    { input: { ...base(), family: "staged", stages: [stage(0), stage(1), stage(2)] }, expected: progress({ expectedStages: 3, stages: [stage(0), stage(1), stage(2)] }) },
    { input: { ...base(), family: "staged" }, expected: progress({ complete: false, expectedStages: 3 }) },
    { input: { ...base(), budget: { unknownUsageCalls: 1, activeReservations: 0, exceeded: false } }, expected: progress({ complete: false, unknownUsageCalls: 1 }) },
    { input: { ...base(), calls: [{ model: "gpt-5.6-luna", outcome: "read-requested" },
      { model: "gpt-6-astra", outcome: "committed", writtenIds: ["guidance"] },
      { model: "gpt-5.6-luna", outcome: "committed", writtenIds: ["a", "guidance", "b"] }] },
      expected: progress({ calls: 3, lowerCalls: 2, upperCalls: 1, readCalls: 1, committedTargets: ["guidance", "a", "b"] }) },
    { input: null, throws: "TypeError" }, { input: {}, throws: "TypeError" },
  ];
  if (final) {
    for (const budget of [{ unknownUsageCalls: 0, activeReservations: 1, exceeded: false },
      { unknownUsageCalls: 0, activeReservations: 0, exceeded: true }, { unknownUsageCalls: 0 }]) {
      cases.push({ input: { ...base(), budget }, expected: progress({ complete: false }) });
    }
    for (const invalid of [{ ...base(), family: "unknown" }, { ...base(), calls: null }, { ...base(), stages: null },
      { ...base(), budget: null }, { ...base(), budget: { unknownUsageCalls: -1 } }, { ...base(), terminationReason: null }]) cases.push({ input: invalid, throws: "TypeError" });
    for (let i = 0; i < 24; i++) {
      const rows = [stage(0), stage(1), stage(2)];
      if (i % 4 === 0) rows[1]!.qualityPass = false;
      if (i % 4 === 1) rows[1]!.protocolClean = false;
      if (i % 4 === 2) rows[1]!.stage = 4;
      if (i % 4 === 3) rows[1]!.success = false;
      cases.push({ input: { ...base(), family: "staged", stages: rows, calls: [{ model: "gpt-5.6-luna", outcome: "committed", writtenIds: [`artifact-${i}`] }] },
        expected: progress({ complete: false, expectedStages: 3, stages: rows, calls: 1, lowerCalls: 1, committedTargets: [`artifact-${i}`] }) });
    }
    cases.push({ input: { ...base(), success: false }, expected: progress({ complete: false }) },
      { input: { ...base(), terminationReason: "budget-unknown" }, expected: progress({ complete: false, terminationReason: "budget-unknown" }) });
  }
  return cases;
}
function method(target: string) { return target === TOOL_SUMMARY ? "summarizeTools" : "summarizeProgress"; }
function expected(test: AuditCase) { return test.throws ? { kind: "throw", name: test.throws, unchanged: true } : { kind: "value", value: test.expected, unchanged: true }; }
export function diagnosticVisibleTest(target: string): string {
  return `import assert from 'node:assert/strict';
import { ${method(target)} as invoke } from './${target}';
const cases=${JSON.stringify(diagnosticCases(target))};
for(const c of cases){const before=JSON.stringify(c.input);let result;
 try{result={kind:'value',value:invoke(c.input),unchanged:JSON.stringify(c.input)===before};}
 catch(e){result={kind:'throw',name:e.name,unchanged:JSON.stringify(c.input)===before};}
 assert.deepEqual(JSON.parse(JSON.stringify(result)),c.throws?{kind:'throw',name:c.throws,unchanged:true}:{kind:'value',value:c.expected,unchanged:true});
}
console.log('Visible diagnostics checks passed: '+cases.length);
`;
}
export function createDiagnosticsFixture(observe?: FixtureObserver): CodeFixture {
  if (!observe) throw new Error("Diagnostics implementation requires an isolated observer");
  const spec = readFileSync(new URL("../docs/tasks/docker-goal-completion.md", import.meta.url), "utf8");
  const contract = "Revision 2: Implement the two pure diagnostics functions exactly as specified in implementation-task.md. Do not alter inputs, tests or dependencies.\n";
  const artifacts = { [SPEC]: spec, [SOURCE]: "Revision 1: diagnostics functions are not implemented.\n",
    ...Object.fromEntries(targets.map(id => [id, `export function ${method(id)}() { throw new Error('Not implemented'); }\n`])) };
  const verify = async (contents: Readonly<Record<string, string>>, scope: readonly string[] = targets): Promise<FixtureResult> => {
    const errors: string[] = [];
    if (contents[SOURCE] !== contract || contents[SPEC] !== spec) errors.push("Pinned implementation contract changed");
    if (Object.keys(contents).sort().join() !== Object.keys(artifacts).sort().join()) errors.push("Unexpected artifact set");
    if (!scope.length || scope.some(id => !Object.hasOwn(artifacts, id))) errors.push("Unknown verification scope");
    if (errors.length) return { ok: false, errors };
    const selected = scope.filter(id => targets.includes(id));
    if (!selected.length) return { ok: true, errors: [] };
    const files = { ...contents }, calls: Invocation[] = [], checks: AuditCase[] = [];
    for (const id of selected) {
      const wrapper = `wrapper-${targets.indexOf(id)}.mjs`;
      files[wrapper] = `import { ${method(id)} as invoke } from './${id}';
export function check(input){const before=JSON.stringify(input);try{return {kind:'value',value:invoke(input),unchanged:JSON.stringify(input)===before};}
catch(e){return {kind:'throw',name:e.name,unchanged:JSON.stringify(input)===before};}}`;
      for (const test of diagnosticCases(id, true)) { calls.push({ id: wrapper, method: "check", args: [test.input] }); checks.push(test); }
    }
    try {
      const rows = await observe(files, calls, 3000);
      if (!Array.isArray(rows) || rows.length !== checks.length) throw new Error("Invalid diagnostic observations");
      for (let i = 0; i < checks.length; i++) if (!isDeepStrictEqual(rows[i]?.output, expected(checks[i]!)))
        errors.push(`Diagnostic case ${i} (${calls[i]!.id}) failed: ${JSON.stringify(rows[i])}`);
      return { ok: !errors.length, errors };
    } catch (error) { return { ok: false, errors: [String(error)], executionFailure: true }; }
  };
  return { artifacts, dependencies: targets.map(consumer => ({ consumer, provider: SOURCE })), sourceId: SOURCE, specId: SPEC,
    changedSource: { id: SOURCE, content: contract }, consumerIds: targets, reportIds: [], writableIds: targets,
    visibleTest: diagnosticVisibleTest, verify };
}
export const diagnosticsTask: SwarmTask = { id: "docker-diagnostics-implementation-v1", createFixture: createDiagnosticsFixture };
