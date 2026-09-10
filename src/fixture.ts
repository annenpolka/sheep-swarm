import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SOURCE_ID = "lib/measure.mjs";
const SPEC_ID = "docs/contract.md";
const DEFAULT_SIZE = 16;

export type FixtureVariant = "baseline" | "migrated";
export type FixtureContents = Readonly<Record<string, string>>;
/** Observations only: expected values and comparison remain in the trusted caller. */
export type FixtureObserver = (files: FixtureContents, calls: readonly Invocation[], timeoutMs: number,
  imports?: readonly { consumer: string; provider: string }[]) => Promise<unknown>;
export interface FixtureResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly executionFailure?: true;
}
export interface CodeFixture {
  readonly artifacts: FixtureContents;
  readonly dependencies: readonly { readonly consumer: string; readonly provider: string }[];
  readonly changedSource: { readonly id: string; readonly content: string };
  readonly sourceId: string;
  readonly specId: string;
  readonly consumerIds: readonly string[];
  readonly reportIds: readonly string[];
  readonly writableIds: readonly string[];
  readonly visibleTest: (target: string) => string;
  /** Always checks the migrated contract, independently of the initial variant. */
  readonly verify: (contents: FixtureContents, scope?: readonly string[]) => Promise<FixtureResult>;
}

interface Consumer {
  readonly id: string;
  readonly name: string;
  readonly index: number;
}
interface Report {
  readonly id: string;
  readonly left: Consumer;
  readonly right: Consumer;
}
interface RawMeasurement {
  readonly durationMs: number;
  readonly transferredBytes: number;
}
export interface Invocation {
  readonly id: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

function layout(size: number) {
  if (!Number.isSafeInteger(size) || size < 2 || size > 256) {
    throw new RangeError("fixture size must be an integer from 2 to 256 (direct consumer count)");
  }
  const consumers = Array.from({ length: size }, (_, index): Consumer => {
    const name = `consumer-${String(index + 1).padStart(3, "0")}`;
    return { id: `consumers/${name}.mjs`, name, index };
  });
  const reports = Array.from({ length: Math.ceil(size / 4) }, (_, index): Report => ({
    id: `reports/report-${String(index + 1).padStart(3, "0")}.mjs`,
    left: consumers[(index * 4) % size]!,
    right: consumers[(index * 4 + Math.max(1, Math.floor(size / 2))) % size]!,
  }));
  const dependencies = [
    { consumer: SOURCE_ID, provider: SPEC_ID },
    ...consumers.flatMap(({ id }) => [
      { consumer: id, provider: SOURCE_ID },
      { consumer: id, provider: SPEC_ID },
    ]),
    ...reports.flatMap(({ id, left, right }) => [
      { consumer: id, provider: left.id },
      { consumer: id, provider: right.id },
      { consumer: id, provider: SPEC_ID },
    ]),
  ];
  return { consumers, reports, dependencies };
}

function source(variant: FixtureVariant): string {
  return variant === "baseline"
    ? `export function measure(input) {\n  return { durationMs: input.durationMs, bytes: input.transferredBytes };\n}\n`
    : `export function measure(input) {\n  return { durationSeconds: input.durationMs / 1000, kibibytes: input.transferredBytes / 1024 };\n}\n`;
}

function healthExpression(consumer: Consumer, variant: FixtureVariant): string {
  const i = consumer.index;
  switch (i % 3) {
    case 0:
      return variant === "baseline"
        ? `reading.durationMs <= ${300 + i * 75}`
        : `reading.durationSeconds <= ${(300 + i * 75) / 1000}`;
    case 1:
      return variant === "baseline"
        ? `rate >= ${(1 + i % 7) * 1024}`
        : `rate >= ${1 + i % 7}`;
    default:
      return variant === "baseline"
        ? `reading.bytes <= ${2048 + i * 333}`
        : `reading.kibibytes <= ${(2048 + i * 333) / 1024}`;
  }
}

function consumerSource(consumer: Consumer, variant: FixtureVariant): string {
  const old = variant === "baseline";
  const duration = old ? "durationMs" : "durationSeconds";
  const rate = old ? "bytesPerSecond" : "kibibytesPerSecond";
  const calculation = old
    ? "reading.bytes / (reading.durationMs / 1000)"
    : "reading.kibibytes / reading.durationSeconds";
  return `import { measure } from "../lib/measure.mjs";

// Preserve this consumer's health policy while migrating the units and output fields.
export function summarize(input) {
  const reading = measure(input);
  const rate = reading.${duration} === 0 ? 0 : ${calculation};
  return {
    name: ${JSON.stringify(consumer.name)},
    ${duration}: reading.${duration},
    ${rate}: rate,
    healthy: ${healthExpression(consumer, variant)},
  };
}
`;
}

function reportSource(report: Report, variant: FixtureVariant): string {
  const old = variant === "baseline";
  return `import { summarize as summarizeLeft } from "../${report.left.id}";
import { summarize as summarizeRight } from "../${report.right.id}";

// The report's public units remain seconds and KiB/s across the migration.
export function evaluate(leftInput, rightInput) {
  const left = summarizeLeft(leftInput);
  const right = summarizeRight(rightInput);
  return {
    totalDurationSeconds: ${old ? "(left.durationMs + right.durationMs) / 1000" : "left.durationSeconds + right.durationSeconds"},
    meanKiBPerSecond: ${old ? "(left.bytesPerSecond + right.bytesPerSecond) / (2 * 1024)" : "(left.kibibytesPerSecond + right.kibibytesPerSecond) / 2"},
    allHealthy: left.healthy && right.healthy,
  };
}
`;
}

const SPEC = `# Measurement API migration

Raw inputs remain { durationMs, transferredBytes }, with finite non-negative numbers.
The library's new measure(input) output is exactly { durationSeconds, kibibytes }.
One second is 1000 milliseconds; one KiB is 1024 bytes. Old output fields disappear.

Every consumer's summarize(input) must return exactly:
{ name, durationSeconds, kibibytesPerSecond, healthy }.
Keep its existing name and the physical meaning of its existing health policy.
Convert thresholds when necessary. A zero duration produces a throughput of zero.
Threshold comparisons are inclusive; do not round measurements or change thresholds.
Different consumers check latency, throughput, or transferred size: read the local code.

Reports combine two consumer summaries, sometimes from distant parts of the fixture.
Their evaluate(leftInput, rightInput) output remains exactly:
{ totalDurationSeconds, meanKiBPerSecond, allHealthy }.
Total duration is the sum; mean throughput is the arithmetic mean, including zero;
allHealthy is true only when both consumers are healthy.

Update affected consumers and reports after the library changes. Preserve the new
library contract and all public exports. Do not restore old fields as compatibility aliases.
Acceptance checks live outside these artifacts; changing this document does not change them.
`;

/**
 * size is work size, not agent count. No teams or worker assignments are generated.
 * Returned migrated code is for deterministic verification, never a worker's context.
 */
export function createFixture(
  options: { readonly size?: number; readonly variant?: FixtureVariant; readonly observe?: FixtureObserver } = {},
): CodeFixture {
  const size = options.size ?? DEFAULT_SIZE;
  const variant = options.variant ?? "baseline";
  if (variant !== "baseline" && variant !== "migrated") throw new TypeError("unknown fixture variant");
  const { consumers, reports, dependencies } = layout(size);
  const artifacts: Record<string, string> = { [SOURCE_ID]: source(variant), [SPEC_ID]: SPEC };
  for (const consumer of consumers) artifacts[consumer.id] = consumerSource(consumer, variant);
  for (const report of reports) artifacts[report.id] = reportSource(report, variant);
  return {
    artifacts,
    dependencies,
    changedSource: { id: SOURCE_ID, content: source("migrated") },
    sourceId: SOURCE_ID,
    specId: SPEC_ID,
    consumerIds: consumers.map(({ id }) => id),
    reportIds: reports.map(({ id }) => id),
    writableIds: [...consumers, ...reports].map(({ id }) => id),
    visibleTest: (target) => {
      const consumer = consumers.find(({ id }) => id === target);
      const report = reports.find(({ id }) => id === target);
      if (!consumer && !report) throw new Error("Visible tests require a writable fixture target");
      // A small feedback subset; the unchanged acceptance oracle also checks boundaries.
      const left = { durationMs: 2000, transferredBytes: 8192 };
      const right = { durationMs: 0, transferredBytes: 4096 };
      const method = consumer ? "summarize" : "evaluate";
      const args = consumer ? [left] : [left, right];
      const expected = consumer ? expectedConsumer(consumer, left, "migrated") : expectedReport(report!, left, right);
      return `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { ${method} } from ${JSON.stringify("./" + target)};\ntest('visible migration feedback', () => assert.deepEqual(${method}(...${JSON.stringify(args)}), ${JSON.stringify(expected)}));\n`;
    },
    verify: (contents, scope) => verifyFixture(contents, scope, { size, ...(options.observe ? { observe: options.observe } : {}) }),
  };
}

// Inputs and expected values belong to the host oracle, not to candidate artifacts.
// The formulas below consume raw physical units and never call generated source code.
const CASES: readonly RawMeasurement[] = [
  { durationMs: 0, transferredBytes: 0 },
  { durationMs: 0, transferredBytes: 1536 },
  { durationMs: 1500, transferredBytes: 1536 },
  { durationMs: 250, transferredBytes: 131072 },
  { durationMs: 2750, transferredBytes: 4608 },
  { durationMs: 1000, transferredBytes: 1000 },
];

function consumerCases(consumer: Consumer): readonly RawMeasurement[] {
  const i = consumer.index;
  const boundary = i % 3 === 0
    ? { durationMs: 300 + i * 75, transferredBytes: 4096 }
    : i % 3 === 1
      ? { durationMs: 1000, transferredBytes: (1 + i % 7) * 1024 }
      : { durationMs: 1000, transferredBytes: 2048 + i * 333 };
  return [
    ...CASES,
    boundary,
    { durationMs: boundary.durationMs + 1, transferredBytes: boundary.transferredBytes + 1 },
    { durationMs: boundary.durationMs - 1, transferredBytes: boundary.transferredBytes - 1 },
  ];
}

function expectedConsumer(consumer: Consumer, raw: RawMeasurement, contract: FixtureVariant) {
  const i = consumer.index;
  const rateBytes = raw.durationMs === 0 ? 0 : raw.transferredBytes * 1000 / raw.durationMs;
  const healthy = i % 3 === 0
    ? raw.durationMs <= 300 + i * 75
    : i % 3 === 1
      ? rateBytes >= (1 + i % 7) * 1024
      : raw.transferredBytes <= 2048 + i * 333;
  return contract === "baseline"
    ? { name: consumer.name, durationMs: raw.durationMs, bytesPerSecond: rateBytes, healthy }
    : { name: consumer.name, durationSeconds: raw.durationMs / 1000, kibibytesPerSecond: rateBytes / 1024, healthy };
}

function expectedReport(report: Report, left: RawMeasurement, right: RawMeasurement) {
  const rate = (raw: RawMeasurement) => raw.durationMs === 0
    ? 0 : raw.transferredBytes * 1000 / (raw.durationMs * 1024);
  return {
    totalDurationSeconds: (left.durationMs + right.durationMs) / 1000,
    meanKiBPerSecond: (rate(left) + rate(right)) / 2,
    allHealthy: expectedConsumer(report.left, left, "migrated").healthy
      && expectedConsumer(report.right, right, "migrated").healthy,
  };
}

// This subprocess returns observations only. Expected values remain in the parent.
const RUNNER = `import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const calls = JSON.parse(input);
const observations = [];
for (const call of calls) {
  try {
    const module = await import(pathToFileURL(resolve(call.id)).href);
    observations.push({ id: call.id, output: await module[call.method](...call.args) });
  } catch (error) {
    observations.push({ id: call.id, error: String(error?.message ?? error) });
  }
}
process.stdout.write(JSON.stringify(observations));
`;

function equivalent(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") {
    return typeof actual === "number" && Number.isFinite(actual)
      && Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const wanted = expected as Record<string, unknown>;
    const observed = actual as Record<string, unknown>;
    const keys = Object.keys(wanted);
    return Object.keys(observed).length === keys.length
      && keys.every(key => Object.hasOwn(observed, key) && equivalent(observed[key], wanted[key]));
  }
  return actual === expected;
}

/**
 * Prefer fixture.verify: its closure fixes size independently of candidate contents.
 * This standalone entry defaults to 16 direct consumers; pass size for other layouts.
 * Scope validates named artifacts with their real dependency closure. A local pass
 * is not final success; omitted scope checks every expected artifact and report.
 * Node permissions reduce accidental access; they are not an adversarial sandbox.
 */
export async function verifyFixture(
  contents: FixtureContents,
  scope?: readonly string[],
  options: { readonly size?: number; readonly contract?: FixtureVariant; readonly timeoutMs?: number; readonly observe?: FixtureObserver } = {},
): Promise<FixtureResult> {
  const { consumers, reports, dependencies } = layout(options.size ?? DEFAULT_SIZE);
  const contract = options.contract ?? "migrated";
  if (contract !== "baseline" && contract !== "migrated") throw new TypeError("unknown oracle contract");
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new RangeError("fixture timeout must be from 1 to 30000 milliseconds");
  }
  const allIds = [SOURCE_ID, SPEC_ID, ...consumers.map(x => x.id), ...reports.map(x => x.id)];
  const allowed = new Set(allIds);
  const targets = scope === undefined ? allIds : [...new Set(scope)];
  const errors: string[] = [];
  if (targets.length === 0) errors.push("verification scope must not be empty");
  for (const id of targets) if (!allowed.has(id)) errors.push(`unknown scope artifact: ${id}`);
  for (const id of Object.keys(contents)) {
    // Only generated, known relative paths are written, never candidate-supplied paths.
    if (!allowed.has(id)) errors.push(`unexpected artifact: ${id}`);
  }
  const required = new Set([SOURCE_ID, SPEC_ID, ...targets]);
  for (const id of required) {
    for (const edge of dependencies) if (edge.consumer === id) required.add(edge.provider);
  }
  for (const id of required) if (typeof contents[id] !== "string") errors.push(`missing artifact: ${id}`);
  if (contents[SOURCE_ID] !== source(contract)) errors.push(`source contract must remain ${contract}`);
  if (errors.length) return { ok: false, errors };

  const calls: Invocation[] = [];
  const expected: unknown[] = [];
  // Checking the source on every scope stops a local patch from reverting the migration.
  for (const raw of CASES) {
    calls.push({ id: SOURCE_ID, method: "measure", args: [raw] });
    expected.push(contract === "baseline"
      ? { durationMs: raw.durationMs, bytes: raw.transferredBytes }
      : { durationSeconds: raw.durationMs / 1000, kibibytes: raw.transferredBytes / 1024 });
  }
  for (const consumer of consumers) {
    if (!targets.includes(consumer.id)) continue;
    for (const raw of consumerCases(consumer)) {
      calls.push({ id: consumer.id, method: "summarize", args: [raw] });
      expected.push(expectedConsumer(consumer, raw, contract));
    }
  }
  for (const report of reports) {
    if (!targets.includes(report.id)) continue;
    for (let i = 0; i < CASES.length; i++) {
      const left = CASES[i]!;
      const right = CASES[(i + 2) % CASES.length]!;
      calls.push({ id: report.id, method: "evaluate", args: [left, right] });
      expected.push(expectedReport(report, left, right));
    }
  }

  try {
    const files = Object.fromEntries([...required].map(id => [id, contents[id]!]));
    const observations = await (options.observe ?? observeFixtureOnHost)(files, calls, timeoutMs);
    if (!Array.isArray(observations) || observations.length !== calls.length) {
      return { ok: false, errors: ["oracle received an invalid observation count"] };
    }
    for (let i = 0; i < calls.length; i++) {
      const observation: unknown = observations[i];
      if (observation === null || typeof observation !== "object") {
        errors.push(`${calls[i]!.id} case ${i}: missing observation`);
        continue;
      }
      const item = observation as Record<string, unknown>;
      if (item.id !== calls[i]!.id || !equivalent(item.output, expected[i])) {
        errors.push(`${calls[i]!.id} case ${i}: ${typeof item.error === "string"
          ? item.error : `expected ${JSON.stringify(expected[i])}; observed ${JSON.stringify(item.output)}`}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`fixture execution failed: ${message.slice(0, 1500)}`], executionFailure: true };
  }
  return { ok: errors.length === 0, errors };
}

/** Legacy fixture runner; Node permissions are not an adversarial sandbox. */
const observeFixtureOnHost: FixtureObserver = async (files, calls, timeoutMs) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "sheep-swarm-fixture-")));
  try {
    for (const [id, content] of Object.entries(files)) {
      const path = join(directory, id);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    const runnerPath = join(directory, "__fixture-runner.mjs");
    await writeFile(runnerPath, RUNNER, "utf8");
    const child = execute(process.execPath, [
      "--permission", `--allow-fs-read=${directory}`, "--disable-proto=throw",
      "--preserve-symlinks", "--preserve-symlinks-main",
      "--max-old-space-size=64", runnerPath,
    ], { cwd: directory, env: {}, timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
    child.child.stdin!.end(JSON.stringify(calls));
    const { stdout } = await child;
    return JSON.parse(stdout) as unknown;
  } finally { await rm(directory, { recursive: true, force: true }); }
};
