import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Contents } from "./kernel.ts";
import type { FixtureObserver, FixtureResult } from "./fixture.ts";

export type MechanismFamily = "static" | "semantic" | "staged";
export interface MechanismFixture {
  readonly task: string;
  readonly family: MechanismFamily;
  readonly stageCount: number;
  readonly artifacts: Contents;
  readonly writableIds: readonly string[];
  readonly specId: string;
  readonly guidanceId: string;
  readonly catalog: readonly { readonly id: string; readonly description: string }[];
  readonly initialDependencies: readonly { readonly consumer: string; readonly provider: string }[];
  readonly changesForStage: (stage: number) => Contents;
  readonly verify: (contents: Contents, stage: number, scope?: readonly string[], mode?: "visible" | "final", suppliedIds?: readonly string[]) => Promise<FixtureResult>;
  readonly visibleFeedback: (contents: Contents, stage: number, targets: readonly string[]) => { source: string; readyTargets: string[]; requiredReads: string[] };
  readonly goldForStage: (stage: number) => Contents;
}

const execute = promisify(execFile);
const SPEC = "docs/event-contract.md";
const GUIDANCE = "docs/working-guidance.md";
const SOURCE = "lib/decode.mjs";
const REGISTRY = "config/domain-registry.json";
const operations = ["ingest", "window", "aggregate", "persist", "cache", "report"] as const;
type Operation = typeof operations[number];
interface Layout { readonly group: string; readonly index: number; readonly ids: Readonly<Record<Operation, string>> }
interface Policy {
  readonly version: number; readonly timeFactor: number; readonly valueScale: number; readonly windowSeconds: number;
  readonly storageTimeField: string; readonly storageValueField: string; readonly cacheNamespace: string;
}
interface Raw { readonly id: string; readonly tenant: string; readonly iso: string; readonly value: number | null }
type Data = Record<string, unknown>;

function layout(groups: number): Layout[] {
  return Array.from({ length: groups }, (_, index) => {
    const group = `domain-${String(index + 1).padStart(2, "0")}`;
    const ids = Object.fromEntries(operations.map(op => [op, `domains/${group}/${op}.mjs`])) as Record<Operation, string>;
    return { group, index, ids };
  });
}
function fields(stage: number) {
  if (stage < 0) return { time: "timestampMs", value: "measurement" };
  return { time: ["time", "at", "instant"][Math.max(0, stage)]!, value: ["value", "amount", "reading"][Math.max(0, stage)]! };
}
function policyFor(item: Layout, stage: number): Policy {
  return {
    version: stage + 2, timeFactor: stage < 0 ? 1000 : [1, 1000, 1_000_000][stage]!,
    valueScale: stage < 0 ? 1 : (item.index + 1) * [0.1, 0.25, 0.5][stage]!,
    windowSeconds: 60 + item.index * 30 + Math.max(stage, 0) * 15,
    storageTimeField: stage < 0 ? "epoch_ms" : ["event_seconds", "event_millis", "event_micros"][stage]!,
    storageValueField: stage < 0 ? "raw_value" : ["normalized_value", "normalized_amount", "normalized_reading"][stage]!,
    cacheNamespace: `${item.group}:v${stage + 2}`,
  };
}
function policyId(item: Layout, family: MechanismFamily): string {
  return family === "static" ? `policies/${item.group}.mjs` : `policies/policy-${String(item.index * 7 + 3).padStart(3, "0")}.json`;
}
function source(stage: number): string {
  return stage < 0 ? `export function decode(raw) {
  return { id: raw.id, tenant: raw.tenant, milliseconds: Date.parse(raw.iso), value: raw.value };
}
` : `// The migration's pinned public decoder. ISO input uses UTC and has millisecond precision.
export function decode(raw) {
  return { eventId: raw.id, tenantKey: raw.tenant, epochMilliseconds: Date.parse(raw.iso), measurement: raw.value };
}
`;
}
function specification(family: MechanismFamily, stage: number): string {
  const f = fields(stage);
  return `# Event processing contract, revision ${stage + 2}

This is the current normative contract. It outranks working-guidance.md and private notes.
Implement every domain's six named run(input) functions. Inputs conform to the schemas below;
numbers are finite, ISO times use UTC millisecond precision, and measurement may be null.
Do not round values, collapse null into zero, add compatibility fields, or change pinned files.
All returned objects have exactly the fields specified. The six operations are different APIs.

Canonical event: { id: string, tenant: string, ${f.time}: number, ${f.value}: number|null }.
The timestamp unit is controlled by the domain policy's timeFactor: units per second.
Policy valueScale converts raw values, windowSeconds is a physical interval in seconds.
All policy values are normative. ${family === "static"
    ? "Read the explicitly imported policies/<domain>.mjs, which exports policy. Keep that import."
    : `Read ${REGISTRY}, then resolve the domain entry's policyArtifact and read that JSON artifact.
The public artifact catalog lists both registry and policy files. These are semantic dependencies:
there is no static JS import edge from a worker module to its JSON policy. You may request any
catalog ID to inspect it; every read used to decide an edit must be reported. Do not guess policy
paths or numbers from another domain. Runtime JSON reads relative to import.meta.url are allowed.`}

1. ingest.run(raw): raw = {id, tenant, iso, value}. Use decode from ../../lib/decode.mjs,
which now returns {eventId, tenantKey, epochMilliseconds, measurement}. Return the canonical
event, converting milliseconds to the policy timestamp unit and measurement by valueScale;
null remains null. Retain the decoder import and use its public values.
2. window.run(event): consume a canonical event. Return exactly {id, tenant, windowStart,
${f.value}}. windowStart = floor(timestamp / (windowSeconds * timeFactor)) *
(windowSeconds * timeFactor), in the same timestamp unit. Windows are half-open, including
the lower bound and excluding the upper; use mathematical floor even before the Unix epoch.
3. aggregate.run(windowedEvents): group by the pair (tenant, windowStart), without ambiguous
string concatenation. Return one {tenant, windowStart, count, total, mean} per group, sorted by
tenant in JavaScript code-point order, then numeric windowStart ascending. Every event creates
its group. count counts non-null measurements only; total sums non-null measurements; mean
is total/count or null when count is zero. Empty input returns [].
4. persist.run(event): return a storage object with exactly {v, tenant, id, [storageTimeField],
[storageValueField]}. v = policy.version; copy canonical timestamp/value into the policy's
storage field names. This operation returns an object, not JSON text. Preserve null and units.
5. cache.run(event): return [cacheNamespace, tenant, id, windowStart].map(encodeURIComponent)
.join("|"). Compute windowStart exactly as window.run. Encode each component separately so
separators, percent signs, Unicode, distinct tenants and distinct IDs cannot collide.
6. report.run(aggregates): return exactly {domain, rows, count, total, mean, latestWindowSeconds}.
domain is this module's domain name; rows counts all aggregate rows, count/total sum those
fields, mean is the pooled total/count or null if count is zero (not a mean of row means).
latestWindowSeconds is maximum windowStart/timeFactor, or null for empty input.

An outside verifier runs local cases and the complete ingest -> window -> aggregate -> report
pipeline, alongside persistence/cache checks. Visible and final cases follow this same contract;
final-case values are withheld from runtime feedback. Guidance can be amended, this contract cannot.
`;
}
function guidance(): string {
  return `# Working guidance for revision 2

The normative event-contract.md is authoritative and must be checked each time it changes.
For revision 2, canonical fields are time/value, timestamps are seconds (timeFactor=1).
Preserve null measurements; floor windows and keep cache component encoding. Obtain each
domain's policy before editing. This note is advisory: if a newer revision differs, use that
revision and report the obsolete assumption in your private observation instead of seeking approval.
`;
}
function moduleText(item: Layout, family: MechanismFamily, op: Operation, stage: number): string {
  const f = fields(stage), old = stage < 0;
  const getPolicy = family === "static"
    ? `import { policy } from "../../${policyId(item, family)}";\n`
    : `import { readFileSync } from "node:fs";
const registry = JSON.parse(readFileSync(new URL("../../${REGISTRY}", import.meta.url), "utf8"));
const policy = JSON.parse(readFileSync(new URL("../../" + registry["${item.group}"].policyArtifact, import.meta.url), "utf8"));
`;
  const prelude = `// contract: ${SPEC}\n// guidance: ${GUIDANCE}\n// domain: ${item.group}\n${getPolicy}`;
  switch (op) {
    case "ingest": return prelude + `import { decode } from "../../${SOURCE}";
export function run(raw) {
  const sample = decode(raw);
  return { id: sample.${old ? "id" : "eventId"}, tenant: sample.${old ? "tenant" : "tenantKey"},
    ${f.time}: sample.${old ? "milliseconds" : "epochMilliseconds"} / 1000 * policy.timeFactor,
    ${f.value}: sample.${old ? "value" : "measurement"} === null ? null : sample.${old ? "value" : "measurement"} * policy.valueScale };
}
`;
    case "window": return prelude + `export function run(event) {
  const width = policy.windowSeconds * policy.timeFactor;
  return { id: event.id, tenant: event.tenant, windowStart: Math.floor(event.${f.time} / width) * width, ${f.value}: event.${f.value} };
}
`;
    case "aggregate": return prelude + `export function run(events) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.tenant, event.windowStart]);
    if (!groups.has(key)) groups.set(key, { tenant: event.tenant, windowStart: event.windowStart, count: 0, total: 0, mean: null });
    const row = groups.get(key);
    if (event.${f.value} !== null) { row.count++; row.total += event.${f.value}; }
  }
  return [...groups.values()].map(row => ({ ...row, mean: row.count ? row.total / row.count : null }))
    .sort((a, b) => a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : a.windowStart - b.windowStart);
}
`;
    case "persist": return prelude + `export function run(event) {
  return { v: policy.version, tenant: event.tenant, id: event.id,
    [policy.storageTimeField]: event.${f.time}, [policy.storageValueField]: event.${f.value} };
}
`;
    case "cache": return prelude + `export function run(event) {
  const width = policy.windowSeconds * policy.timeFactor;
  const start = Math.floor(event.${f.time} / width) * width;
  return [policy.cacheNamespace, event.tenant, event.id, start].map(encodeURIComponent).join("|");
}
`;
    case "report": return prelude + `export function run(rows) {
  const count = rows.reduce((sum, row) => sum + row.count, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return { domain: "${item.group}", rows: rows.length, count, total, mean: count ? total / count : null,
    ${old ? "latestWindowMillis" : "latestWindowSeconds"}: rows.length ? Math.max(...rows.map(row => row.windowStart)) / policy.timeFactor : null };
}
`;
  }
}

/** Six heterogeneous APIs per domain. Fixture answers and case values stay outside artifacts. */
export function createMechanismFixture(options: {
  family: MechanismFamily; groups?: number; variant?: "base" | "gold"; observe?: FixtureObserver;
}): MechanismFixture {
  if (!options || !["static", "semantic", "staged"].includes(options.family)) throw new TypeError("unknown mechanism family");
  const groups = options.groups ?? 8;
  if (!Number.isSafeInteger(groups) || groups < 1 || groups > 16) throw new RangeError("mechanism groups must be from 1 to 16");
  if (options.variant !== undefined && !["base", "gold"].includes(options.variant)) throw new TypeError("unknown mechanism variant");
  const family = options.family, domains = layout(groups), stageCount = family === "staged" ? 3 : 1;
  const writableIds = domains.flatMap(item => operations.map(op => item.ids[op]));
  const assertStage = (stage: number) => {
    if (!Number.isSafeInteger(stage) || stage < 0 || stage >= stageCount) throw new RangeError("stage out of range");
  };
  const pinned = (stage: number): Contents => {
    const result: Record<string, string> = { [SPEC]: specification(family, Math.max(0, stage)), [SOURCE]: source(stage) };
    if (family !== "static") result[REGISTRY] = JSON.stringify(Object.fromEntries(domains.map(item => [item.group,
      { policyArtifact: policyId(item, family) }])), null, 2) + "\n";
    for (const item of domains) result[policyId(item, family)] = family === "static"
      ? `export const policy = ${JSON.stringify(policyFor(item, stage), null, 2)};\n`
      : JSON.stringify(policyFor(item, stage), null, 2) + "\n";
    return Object.freeze(result);
  };
  const full = (stage: number): Contents => Object.freeze({ ...pinned(stage), [GUIDANCE]: guidance(),
    ...Object.fromEntries(domains.flatMap(item => operations.map(op => [item.ids[op], moduleText(item, family, op, stage)]))) });
  const artifacts = options.variant === "gold" ? full(0) : full(-1);
  const initialDependencies = domains.flatMap(item => operations.flatMap(op => [
    { consumer: item.ids[op], provider: SPEC }, { consumer: item.ids[op], provider: GUIDANCE },
    ...(op === "ingest" ? [{ consumer: item.ids[op], provider: SOURCE }] : []),
    ...(family === "static" ? [{ consumer: item.ids[op], provider: policyId(item, family) }] : []),
  ]));
  const catalog = Object.keys(artifacts).map(id => ({ id, description: id === SPEC ? "Current normative operation contracts and revision"
    : id === GUIDANCE ? "Mutable advisory guidance; lower authority than current contract"
    : id === REGISTRY ? "Domain registry: resolves domain names to semantic policy artifact IDs"
    : id === SOURCE ? "Pinned public ISO event decoder API"
    : id.startsWith("policies/") ? "Normative domain policy values; use registry to resolve ownership"
    : `${id.split("/")[1]} ${id.split("/")[2]!.replace(".mjs", "")} operation; export run(input)` }));
  return {
    task: `event-mechanisms-${family}-v1`, family, stageCount, artifacts,
    writableIds: Object.freeze(writableIds), specId: SPEC, guidanceId: GUIDANCE,
    catalog: Object.freeze(catalog), initialDependencies: Object.freeze(initialDependencies),
    changesForStage: stage => { assertStage(stage); return pinned(stage); },
    goldForStage: stage => { assertStage(stage); return full(stage); },
    visibleFeedback: (contents, stage, targets) => {
      assertStage(stage);
      if (!targets.length || targets.some(id => !writableIds.includes(id) && id !== GUIDANCE)) throw new Error("invalid visible scope");
      const current = pinned(stage), readyTargets: string[] = [], required = new Set<string>();
      for (const id of targets) {
        if (id === GUIDANCE) { readyTargets.push(id); continue; }
        const item = domains.find(item => operations.some(op => item.ids[op] === id))!;
        const needed = [SPEC, ...(id === item.ids.ingest ? [SOURCE] : [])];
        if (family === "static") needed.push(policyId(item, family));
        else {
          needed.push(REGISTRY);
          // Do not reveal ownership or values before the public registry is delivered.
          if (contents[REGISTRY] === current[REGISTRY]) {
            needed.push((JSON.parse(contents[REGISTRY]!) as Record<string, { policyArtifact: string }>)[item.group]!.policyArtifact);
          }
        }
        const missing = needed.filter(key => contents[key] !== current[key]);
        for (const key of missing) required.add(key);
        if (!missing.length && typeof contents[id] === "string") readyTargets.push(id);
      }
      const checks = mechanismChecks(domains, family, stage, readyTargets, "visible");
      return { readyTargets, requiredReads: [...required], source: visibleTestSource(checks) };
    },
    verify: async (contents, stage, scope, mode = "visible", suppliedIds) => {
      assertStage(stage);
      if (mode !== "visible" && mode !== "final") throw new TypeError("unknown oracle mode");
      return verifyMechanism(contents, domains, family, stage, pinned(stage), writableIds, scope, mode, options.observe, suppliedIds);
    },
  };
}

function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") return typeof actual === "number" && Number.isFinite(actual)
    && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((item, index) => matches(actual[index], item));
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const a = actual as Data, e = expected as Data;
    return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => Object.hasOwn(a, key) && matches(a[key], e[key]));
  }
  return actual === expected;
}

// Independent host calculations below are deliberately not generated from the candidate module text.
function expectedEvent(raw: Raw, policy: Policy, stage: number): Data {
  const f = fields(stage);
  return { id: raw.id, tenant: raw.tenant, [f.time]: Date.parse(raw.iso) * (policy.timeFactor / 1000),
    [f.value]: raw.value === null ? null : raw.value * policy.valueScale };
}
function expectedWindow(event: Data, policy: Policy, stage: number): Data {
  const f = fields(stage), seconds = (event[f.time] as number) / policy.timeFactor;
  let bucket = Math.trunc(seconds / policy.windowSeconds);
  if (seconds < 0 && seconds % policy.windowSeconds !== 0) bucket--;
  return { id: event.id, tenant: event.tenant, windowStart: bucket * policy.windowSeconds * policy.timeFactor,
    [f.value]: event[f.value] };
}
function expectedAggregate(events: readonly Data[], stage: number): Data[] {
  const value = fields(stage).value;
  const pairs: { tenant: string; start: number }[] = [];
  for (const event of events) if (!pairs.some(pair => pair.tenant === event.tenant && pair.start === event.windowStart)) {
    pairs.push({ tenant: event.tenant as string, start: event.windowStart as number });
  }
  return pairs.sort((a, b) => a.tenant < b.tenant ? -1 : a.tenant > b.tenant ? 1 : a.start - b.start).map(pair => {
    const values = events.filter(event => event.tenant === pair.tenant && event.windowStart === pair.start && event[value] !== null).map(event => event[value] as number);
    const total = values.reduce((a, b) => a + b, 0);
    return { tenant: pair.tenant, windowStart: pair.start, count: values.length, total, mean: values.length ? total / values.length : null };
  });
}
function expectedReport(rows: readonly Data[], item: Layout, policy: Policy): Data {
  let count = 0, total = 0, latest: number | null = null;
  for (const row of rows) {
    count += row.count as number; total += row.total as number;
    const at = (row.windowStart as number) / policy.timeFactor;
    if (latest === null || at > latest) latest = at;
  }
  return { domain: item.group, rows: rows.length, count, total, mean: count === 0 ? null : total / count, latestWindowSeconds: latest };
}

interface Call { readonly id: string; readonly input: unknown; readonly label: string; readonly pipeline?: Readonly<Record<Operation, string>> }
const runner = `import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { SourceTextModule } from "node:vm";
let body = ""; for await (const chunk of process.stdin) body += chunk;
const request = JSON.parse(body);
for (const edge of request.imports) {
  const module = new SourceTextModule(await readFile(resolve(edge.consumer), "utf8"));
  const paths = module.moduleRequests.map(item => resolve(dirname(edge.consumer), item.specifier));
  if (!paths.includes(resolve(edge.provider))) throw new Error("missing required import: " + edge.consumer + " -> " + edge.provider);
}
const outputs = [];
const invoke = async (id, input) => (await import(pathToFileURL(resolve(id)).href)).run(input);
for (const call of request.calls) {
  try {
    if (!call.pipeline) outputs.push({ output: await invoke(call.id, call.input) });
    else {
      const modules = call.pipeline;
      const events = await Promise.all(call.input.map(raw => invoke(modules.ingest, raw)));
      const windows = await Promise.all(events.map(event => invoke(modules.window, event)));
      const aggregate = await invoke(modules.aggregate, windows);
      const report = await invoke(modules.report, aggregate);
      const stored = await Promise.all(events.map(event => invoke(modules.persist, event)));
      const keys = await Promise.all(events.map(event => invoke(modules.cache, event)));
      outputs.push({ output: { report, stored, keys } });
    }
  } catch (error) { outputs.push({ error: String(error?.message ?? error) }); }
}
process.stdout.write(JSON.stringify(outputs));
`;

async function verifyMechanism(contents: Contents, domains: readonly Layout[], family: MechanismFamily, stage: number,
  pinned: Contents, writableIds: readonly string[], scope: readonly string[] | undefined, mode: "visible" | "final", observe?: FixtureObserver, suppliedIds?: readonly string[]): Promise<FixtureResult> {
  const targets = scope === undefined ? [...writableIds] : [...new Set(scope)];
  const errors: string[] = [];
  if (!targets.length) errors.push("empty verification scope");
  if (targets.some(id => !writableIds.includes(id) && id !== GUIDANCE)) errors.push("unknown verification target");
  const allowed = new Set([...Object.keys(pinned), GUIDANCE, ...writableIds]);
  if (Object.keys(contents).some(id => !allowed.has(id))) errors.push("unexpected artifact");
  for (const [id, content] of Object.entries(pinned)) if (contents[id] !== content) errors.push(`pinned artifact changed or missing: ${id}`);
  for (const id of allowed) if (typeof contents[id] !== "string") errors.push(`missing artifact: ${id}`);
  if (errors.length) return { ok: false, errors };
  const { calls, expected, imports } = mechanismChecks(domains, family, stage, targets, mode);
  // A guidance-only edit is accepted structurally. It cannot alter the immutable semantic oracle.
  if (!calls.length) return { ok: true, errors: [] };
  let directory: string | undefined;
  let executionFailure = false;
  try {
    let observations: unknown;
    if (observe) observations = await observe(suppliedIds ? Object.fromEntries(suppliedIds.map(id => [id, contents[id]!])) : contents, calls.map(call => ({ id: call.id, method: "run", args: [call.input],
      ...(call.pipeline ? { pipeline: call.pipeline } : {}) })), 3000, imports);
    else {
      directory = await realpath(await mkdtemp(join(tmpdir(), "sheep-mechanism-oracle-")));
      for (const [id, content] of Object.entries(contents)) {
        const path = join(directory, id); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
      }
      const entry = join(directory, "__outside-runner.mjs"); await writeFile(entry, runner);
      const child = execute(process.execPath, ["--experimental-vm-modules", "--permission", `--allow-fs-read=${directory}`,
        "--disable-proto=throw", "--max-old-space-size=96", entry], {
        cwd: directory, env: {}, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      });
      child.child.stdin!.end(JSON.stringify({ calls, imports }));
      observations = JSON.parse((await child).stdout);
    }
    if (!Array.isArray(observations) || observations.length !== calls.length) { executionFailure = true; errors.push("invalid observation count"); }
    else for (let index = 0; index < calls.length; index++) {
      const observation = observations[index] as { output?: unknown; error?: string } | null;
      if (!observation || !matches(observation.output, expected[index])) errors.push(`${calls[index]!.id} (${calls[index]!.label}): ${observation?.error
        ?? `expected ${JSON.stringify(expected[index])}; received ${JSON.stringify(observation?.output)}`}`);
    }
  } catch (error) { executionFailure = true; errors.push(`mechanism oracle execution failed: ${String(error).slice(0, 1000)}`); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  return { ok: !errors.length, errors, ...(executionFailure ? { executionFailure: true as const } : {}) };
}

function mechanismChecks(domains: readonly Layout[], family: MechanismFamily, stage: number,
  targets: readonly string[], mode: "visible" | "final") {
  const calls: Call[] = [], expected: unknown[] = [];
  const imports: { consumer: string; provider: string }[] = [];
  const add = (id: string, input: unknown, output: unknown, label: string) => { calls.push({ id, input, label }); expected.push(output); };
  for (const item of domains) {
    const policy = policyFor(item, stage), f = fields(stage), final = mode === "final";
    // Public-contract boundaries appear in both modes, with distinct concrete nonzero values.
    const offset = final ? policy.windowSeconds * 4 : 0;
    const seconds = [offset - 0.001, offset, offset + policy.windowSeconds - 0.001,
      offset + policy.windowSeconds, -policy.windowSeconds - 0.001, -policy.windowSeconds];
    const raw: Raw[] = seconds.map((second, index) => ({
      id: ["a|b", "b", "event%3", "観測", "repeat", "last"][index]!,
      tenant: ["one", "one", "one", "two|a", "two", "null-only"][index]!,
      iso: new Date(second * 1000).toISOString(), value: [final ? 17.25 : 3.5, null, 0, final ? -6.75 : -2, final ? 13 : 9, null][index]!,
    }));
    const events = raw.map(row => expectedEvent(row, policy, stage));
    const windows = events.map(event => expectedWindow(event, policy, stage));
    const aggregate = expectedAggregate(windows, stage);
    const persisted = (event: Data): Data => ({ v: policy.version, tenant: event.tenant, id: event.id,
      [policy.storageTimeField]: event[f.time], [policy.storageValueField]: event[f.value] });
    const cached = (event: Data): string => [policy.cacheNamespace, event.tenant, event.id,
      expectedWindow(event, policy, stage).windowStart].map(value => encodeURIComponent(String(value))).join("|");
    for (const op of operations) {
      const id = item.ids[op];
      if (!targets.includes(id)) continue;
      if (op === "ingest") imports.push({ consumer: id, provider: SOURCE });
      if (family === "static") imports.push({ consumer: id, provider: policyId(item, family) });
      switch (op) {
        case "ingest": raw.forEach((value, index) => add(id, value, events[index], `raw-${index}`)); break;
        case "window": events.forEach((value, index) => add(id, value, windows[index], `boundary-${index}`)); break;
        case "aggregate": {
          add(id, windows, aggregate, "mixed-null-groups"); add(id, [], [], "empty");
          const width = policy.windowSeconds * policy.timeFactor;
          const concatenated = width * 10;
          const hostile = [
            { id: "x", tenant: "a" + width, windowStart: 0, [f.value]: 2 },
            { id: "y", tenant: "a", windowStart: concatenated, [f.value]: 8 },
            { id: "z", tenant: "a", windowStart: concatenated, [f.value]: null },
            { id: "n", tenant: "none", windowStart: -width, [f.value]: null },
          ];
          add(id, hostile, expectedAggregate(hostile, stage), "group-identity"); break;
        }
        case "persist": events.forEach((value, index) => add(id, value, persisted(value), `stored-${index}`)); break;
        case "cache": {
          events.forEach((value, index) => add(id, value, cached(value), `key-${index}`));
          for (const value of [{ ...events[1], tenant: "a|b", id: "c" }, { ...events[1], tenant: "a", id: "b|c" }]) add(id, value, cached(value), "collision");
          break;
        }
        case "report": {
          add(id, aggregate, expectedReport(aggregate, item, policy), "pooled-mean");
          add(id, [], expectedReport([], item, policy), "empty");
          const unequal = [{ tenant: "a", windowStart: -2 * policy.windowSeconds * policy.timeFactor, count: 1, total: 2, mean: 2 },
            { tenant: "b", windowStart: -policy.windowSeconds * policy.timeFactor, count: 3, total: 18, mean: 6 }];
          add(id, unequal, expectedReport(unequal, item, policy), "unequal-counts-negative-time"); break;
        }
      }
    }
    if (operations.every(op => targets.includes(item.ids[op]))) {
      calls.push({ id: item.ids.report, input: raw, label: "end-to-end", pipeline: item.ids });
      expected.push({ report: expectedReport(aggregate, item, policy), stored: events.map(persisted), keys: events.map(cached) });
    }
  }
  return { calls, expected, imports };
}

function visibleTestSource(checks: ReturnType<typeof mechanismChecks>): string {
  // Only the visible generator can reach this bundle; unready scopes have no cases.
  return `import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const {calls,expected}=${JSON.stringify(checks)};
assert.ok(calls.length, 'Request the required public files in a separate call before checking or editing.');
const same=(a,e)=>typeof e==='number'?typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-e)<=1e-9*Math.max(1,Math.abs(e)):
 Array.isArray(e)?Array.isArray(a)&&a.length===e.length&&e.every((v,i)=>same(a[i],v)):
 e&&typeof e==='object'?a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===Object.keys(e).length&&Object.keys(e).every(k=>Object.hasOwn(a,k)&&same(a[k],e[k])):a===e;
const invoke=async(id,input)=>(await import(pathToFileURL(resolve(id)).href)).run(input);
for(let i=0;i<calls.length;i++){
 const c=calls[i]; let actual;
 if(!c.pipeline)actual=await invoke(c.id,c.input);
 else {
  const p=c.pipeline, events=await Promise.all(c.input.map(raw=>invoke(p.ingest,raw)));
  const windows=await Promise.all(events.map(e=>invoke(p.window,e)));
  const rows=await invoke(p.aggregate,windows);
  actual={report:await invoke(p.report,rows),stored:await Promise.all(events.map(e=>invoke(p.persist,e))),keys:await Promise.all(events.map(e=>invoke(p.cache,e)))};
 }
 assert.ok(same(actual,expected[i]), c.id+' ('+c.label+'): expected '+JSON.stringify(expected[i])+'; received '+JSON.stringify(actual));
}
console.log('Visible mechanism checks passed: '+calls.length);
`;
}
