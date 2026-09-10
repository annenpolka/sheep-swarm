import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import type { Contents, Verdict } from "./kernel.ts";

const execute = promisify(execFile);
const SOURCE = "lib/thermal.mjs";
const SPEC = "docs/thermal-contract.md";
export interface FixtureEdge { readonly consumer: string; readonly provider: string }
export interface HeldoutFixture {
  readonly task: "thermal-offset-migration-v1";
  readonly artifacts: Contents;
  readonly sourceId: string;
  readonly specId: string;
  readonly changedSource: { readonly id: string; readonly content: string };
  readonly writableIds: readonly string[];
  readonly dependencies: readonly FixtureEdge[];
  readonly verify: (contents: Contents, scope?: readonly string[]) => Promise<Verdict>;
}
interface Raw { temperatureC: number; pressureKPa: number }
interface Sensor { id: string; index: number }
interface Summary { id: string; left: Sensor; right: Sensor }

const specification = `# Thermal API migration

Raw input remains { temperatureC, pressureKPa }. Inputs are finite numbers and pressure is nonnegative.
sample(input) now returns exactly { kelvin, pascals }: K = degrees Celsius + 273.15, Pa = kPa * 1000.
Old Celsius and kPa output fields are removed. The new library is pinned and must not be edited.

Every sensor summarize(input) must return exactly { kelvin, pascals, safe }.
Preserve that sensor's physical temperature interval and maximum pressure from its local code.
Both temperature endpoints and the pressure limit are inclusive. Do not round or widen limits.

Each regional combine(leftInput, rightInput) still returns exactly
{ meanCelsius, maximumKPa, allSafe }. The mean is arithmetic; pressure is the maximum;
allSafe requires both sensors to be safe. These public regional units do not change.

Maintain named exports and dependency imports. Acceptance is fixed outside this workspace.
The comment "contract: docs/thermal-contract.md" declares each module's specification dependency.
`;

function library(migrated: boolean): string {
  return `// contract: ${SPEC}\nexport function sample(input) {\n  return ${migrated
    ? "{ kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000 }"
    : "{ celsius: input.temperatureC, pressureKPa: input.pressureKPa }"};\n}\n`;
}

function createLayout(size: number) {
  if (!Number.isSafeInteger(size) || size < 2 || size > 64) throw new RangeError("heldout size must be from 2 to 64");
  const sensors = Array.from({ length: size }, (_, index): Sensor => ({ id: `sensors/sensor-${index + 1}.mjs`, index }));
  const summaries = Array.from({ length: Math.ceil(size / 4) }, (_, index): Summary => ({
    id: `regions/region-${index + 1}.mjs`, left: sensors[index * 4 % size]!,
    right: sensors[(index * 4 + Math.floor(size / 2) + index) % size]!,
  }));
  const dependencies: FixtureEdge[] = [
    { consumer: SOURCE, provider: SPEC },
    ...sensors.flatMap(sensor => [{ consumer: sensor.id, provider: SOURCE }, { consumer: sensor.id, provider: SPEC }]),
    ...summaries.flatMap(summary => [
      { consumer: summary.id, provider: summary.left.id }, { consumer: summary.id, provider: summary.right.id },
      { consumer: summary.id, provider: SPEC },
    ]),
  ];
  return { sensors, summaries, dependencies };
}

/** A fresh synthetic task with an affine unit conversion, not a real-repository generalization test. */
export function createHeldoutFixture(options: { size?: number; variant?: "baseline" | "migrated" } = {}): HeldoutFixture {
  const size = options.size ?? 8;
  if (options.variant !== undefined && !["baseline", "migrated"].includes(options.variant)) throw new TypeError("unknown heldout variant");
  const migrated = options.variant === "migrated";
  const { sensors, summaries, dependencies } = createLayout(size);
  const artifacts: Record<string, string> = { [SOURCE]: library(migrated), [SPEC]: specification };
  for (const { id, index } of sensors) {
    const temperature = migrated ? "kelvin" : "celsius";
    const pressure = migrated ? "pascals" : "pressureKPa";
    const lower = migrated ? `${-10 + index} + 273.15` : String(-10 + index);
    const upper = migrated ? `${25 + index * 2} + 273.15` : String(25 + index * 2);
    artifacts[id] = `// contract: ${SPEC}
import { sample } from "../lib/thermal.mjs";
export function summarize(input) {
  const value = sample(input);
  return {
    ${temperature}: value.${temperature},
    ${pressure}: value.${pressure},
    safe: value.${temperature} >= ${lower} && value.${temperature} <= ${upper}
      && value.${pressure} <= ${(100 + index * 3) * (migrated ? 1000 : 1)},
  };
}
`;
  }
  for (const { id, left, right } of summaries) artifacts[id] = `// contract: ${SPEC}
import { summarize as leftSensor } from "../${left.id}";
import { summarize as rightSensor } from "../${right.id}";
export function combine(leftInput, rightInput) {
  const left = leftSensor(leftInput);
  const right = rightSensor(rightInput);
  return {
    meanCelsius: ${migrated ? "(left.kelvin + right.kelvin) / 2 - 273.15" : "(left.celsius + right.celsius) / 2"},
    maximumKPa: ${migrated ? "Math.max(left.pascals, right.pascals) / 1000" : "Math.max(left.pressureKPa, right.pressureKPa)"},
    allSafe: left.safe && right.safe,
  };
}
`;
  const writableIds = [...sensors, ...summaries].map(item => item.id);
  return { task: "thermal-offset-migration-v1", artifacts, sourceId: SOURCE, specId: SPEC,
    changedSource: { id: SOURCE, content: library(true) }, writableIds, dependencies,
    verify: (contents, scope) => verifyThermal(contents, size, scope) };
}

/** Discover the declared static dependencies from actual file bytes, without a supplied truth graph. */
export function discoverThermalDependencies(contents: Contents): {
  edges: FixtureEdge[]; filesRead: number; bytesRead: number; durationMs: number;
} {
  const start = performance.now();
  const edges: FixtureEdge[] = [];
  let filesRead = 0, bytesRead = 0;
  for (const [consumer, content] of Object.entries(contents)) {
    if (!consumer.endsWith(".mjs")) continue;
    filesRead++; bytesRead += Buffer.byteLength(content);
    const providers = new Set<string>();
    for (const match of content.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      providers.add(posix.normalize(posix.join(posix.dirname(consumer), match[1]!)));
    }
    for (const match of content.matchAll(/^\/\/\s*contract:\s*(\S+)\s*$/gm)) providers.add(match[1]!);
    for (const provider of providers) {
      if (!Object.hasOwn(contents, provider)) throw new Error(`unresolved dependency ${consumer} -> ${provider}`);
      edges.push({ consumer, provider });
    }
  }
  return { edges, filesRead, bytesRead, durationMs: performance.now() - start };
}

const cases: Raw[] = [
  { temperatureC: -40, pressureKPa: 100 }, { temperatureC: -5, pressureKPa: 99.5 },
  { temperatureC: 0, pressureKPa: 101.3 }, { temperatureC: 20.1, pressureKPa: 101.3 },
  { temperatureC: 100, pressureKPa: 300 }, { temperatureC: 22, pressureKPa: 0 },
];
function safe(sensor: Sensor, input: Raw): boolean {
  return input.temperatureC >= -10 + sensor.index && input.temperatureC <= 25 + sensor.index * 2
    && input.pressureKPa <= 100 + sensor.index * 3;
}
function matches(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") return typeof actual === "number" && Number.isFinite(actual)
    && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
    const a = actual as Record<string, unknown>, e = expected as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(e).length && Object.keys(e).every(key => Object.hasOwn(a, key) && matches(a[key], e[key]));
  }
  return actual === expected;
}
const runner = `import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { SourceTextModule } from "node:vm";
let text = ""; for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
const imports = new Map();
for (const edge of request.imports) {
  if (!imports.has(edge.consumer)) {
    const parsed = new SourceTextModule(await readFile(resolve(edge.consumer), "utf8"));
    imports.set(edge.consumer, new Set(parsed.moduleRequests.map(item => resolve(dirname(edge.consumer), item.specifier))));
  }
  if (!imports.get(edge.consumer).has(resolve(edge.provider))) {
    throw new Error("missing required import: " + edge.consumer + " -> " + edge.provider);
  }
}
const outputs = [];
for (const call of request.calls) {
  try { const module = await import(pathToFileURL(resolve(call.id)).href); outputs.push({ output: await module[call.method](...call.args) }); }
  catch (error) { outputs.push({ error: String(error?.message ?? error) }); }
}
process.stdout.write(JSON.stringify(outputs));
`;

async function verifyThermal(contents: Contents, size: number, scope?: readonly string[]): Promise<Verdict> {
  const { sensors, summaries, dependencies } = createLayout(size);
  const ids = [SOURCE, SPEC, ...sensors.map(x => x.id), ...summaries.map(x => x.id)];
  const targets = scope === undefined ? ids : [...new Set(scope)];
  const errors: string[] = [];
  if (!targets.length) errors.push("empty verification scope");
  if (targets.some(id => !ids.includes(id))) errors.push("unknown verification target");
  if (Object.keys(contents).some(id => !ids.includes(id))) errors.push("unexpected artifact");
  if (contents[SOURCE] !== library(true)) errors.push("pinned thermal API was changed");
  const required = new Set([SOURCE, SPEC, ...targets]);
  for (const id of required) for (const edge of dependencies) if (edge.consumer === id) required.add(edge.provider);
  // This immutable oracle list covers the requested modules and their needed providers.
  // A mathematically equivalent raw-input implementation must still retain the required API imports.
  const requiredImports = dependencies.filter(edge => required.has(edge.consumer) && edge.provider !== SPEC);
  for (const id of required) if (typeof contents[id] !== "string") errors.push(`missing artifact ${id}`);
  if (errors.length) return { ok: false, errors };
  const calls: { id: string; method: string; args: Raw[] }[] = [];
  const expected: unknown[] = [];
  for (const input of cases) {
    calls.push({ id: SOURCE, method: "sample", args: [input] });
    expected.push({ kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000 });
  }
  for (const sensor of sensors.filter(sensor => targets.includes(sensor.id))) {
    const boundary = { temperatureC: 25 + sensor.index * 2, pressureKPa: 100 + sensor.index * 3 };
    for (const input of [...cases, boundary,
      { ...boundary, temperatureC: -10 + sensor.index },
      { ...boundary, temperatureC: boundary.temperatureC + 0.01 },
      { ...boundary, pressureKPa: boundary.pressureKPa + 0.01 }]) {
      calls.push({ id: sensor.id, method: "summarize", args: [input] });
      expected.push({ kelvin: input.temperatureC + 273.15, pascals: input.pressureKPa * 1000, safe: safe(sensor, input) });
    }
  }
  for (const summary of summaries.filter(summary => targets.includes(summary.id))) for (let i = 0; i < cases.length; i++) {
    const left = cases[i]!, right = cases[(i + 2) % cases.length]!;
    calls.push({ id: summary.id, method: "combine", args: [left, right] });
    expected.push({ meanCelsius: (left.temperatureC + right.temperatureC) / 2,
      maximumKPa: Math.max(left.pressureKPa, right.pressureKPa), allSafe: safe(summary.left, left) && safe(summary.right, right) });
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sheep-thermal-oracle-")));
  try {
    for (const id of required) { const path = join(directory, id); await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents[id]!); }
    const entry = join(directory, "__oracle-runner.mjs");
    await writeFile(entry, runner);
    const child = execute(process.execPath, ["--experimental-vm-modules", "--permission", `--allow-fs-read=${directory}`,
      "--preserve-symlinks", "--preserve-symlinks-main", "--disable-proto=throw", "--max-old-space-size=64", entry],
    { cwd: directory, env: {}, timeout: 3000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    child.child.stdin!.end(JSON.stringify({ calls, imports: requiredImports }));
    const observations: unknown = JSON.parse((await child).stdout);
    if (!Array.isArray(observations) || observations.length !== calls.length) errors.push("invalid observation count");
    else for (let i = 0; i < calls.length; i++) {
      const observation = observations[i] as { output?: unknown; error?: string } | null;
      if (!observation || !matches(observation.output, expected[i])) errors.push(`${calls[i]!.id}: ${observation?.error
        ?? `expected ${JSON.stringify(expected[i])}; received ${JSON.stringify(observation?.output)}`}`);
    }
  } catch (error) { errors.push(`thermal oracle execution failed: ${String(error).slice(0, 1000)}`); }
  finally { await rm(directory, { recursive: true, force: true }); }
  return { ok: !errors.length, errors };
}
