import {createHash} from 'node:crypto';
import {parseRepoTask} from '../../src/repo-manifest.ts';
import type {RepoTask} from '../../src/repo-types.ts';

export const COUNTS = [4, 8, 16, 32] as const;
export const TOPOLOGIES = ['independent', 'chain', 'fanout', 'fanin', 'diamond', 'sparse'] as const;
export type Topology = (typeof TOPOLOGIES)[number];
export type Split = 'dev' | 'evaluation';

/** Deterministic PRNG; every generated task derives all parameters from it. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function ri(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}
export function lit(v: unknown): string {
  return JSON.stringify(v);
}
export function sha256Text(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
/** Apply a textual defect/mutation; throws when the pattern is absent or the edit is a no-op. */
export function mustReplace(src: string, from: string, to: string): string {
  if (!src.includes(from)) throw new Error(`mutation pattern absent: ${JSON.stringify(from.slice(0, 80))}`);
  const out = src.replace(from, to);
  if (out === src) throw new Error('mutation produced identical source');
  return out;
}

export type Case = readonly [readonly unknown[], unknown];

/** Render `assert.deepEqual(f(...args), expected);` lines against binding `f`. */
export function calls(cases: readonly Case[]): string {
  return cases.map(([a, o]) => `assert.deepEqual(f(...${lit(a)}),${lit(o)});`).join('\n');
}
/** Standard check body for a module exporting one function `name`. */
export function fnBody(name: string, cases: readonly Case[], extra = ''): string {
  return `const f=m.${name};\n` + calls(cases) + (extra === '' ? '' : '\n' + extra);
}
/** Assert the call leaves a deep-frozen-by-snapshot argument untouched. */
export function keepInputs(argLists: readonly (readonly unknown[])[]): string {
  return argLists
    .map((a) => `{const x=${lit(a)};const before=JSON.stringify(x);f(...x);assert.equal(JSON.stringify(x),before);}`)
    .join('\n');
}
export function raw(...lines: readonly string[]): string {
  return lines.join('\n');
}
/** Spec-side publicPass computation: true when the simulated mutant agrees with
 *  the reference semantics on every listed public case (own + consumer). */
export function flagOf(
  groups: readonly (readonly [readonly Case[], (a: readonly unknown[]) => unknown, (a: readonly unknown[]) => unknown])[],
): boolean {
  for (const [cases, base, mut] of groups) {
    for (const [a] of cases) {
      if (JSON.stringify(base(a)) !== JSON.stringify(mut(a))) return false;
    }
  }
  return true;
}
export function mod(...parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join('\n') + '\n';
}

/** The shared public check dynamically imports the requested target: no literal
 *  specifiers, so the static dependency scanner sees no check->target edges. */
export function publicCheckSource(entries: readonly {path: string; body: string}[]): string {
  const parts = [
    `import assert from 'node:assert/strict';`,
    `const t=process.argv[2];`,
    `const m=await import('./'+t);`,
    `switch(t){`,
  ];
  for (const e of entries) parts.push(`case ${lit(e.path)}:{`, e.body, `break;}`);
  parts.push(`default:throw new Error('unknown target '+t);`, `}`, `console.log('public ok',t);`);
  return parts.join('\n') + '\n';
}
/** The hidden oracle iterates the same dynamic-import pattern and embeds only
 *  literal expectations computed by the generator's independent spec code. */
export function holdoutSource(entries: readonly {path: string; body: string}[]): string {
  const parts = [
    `import assert from 'node:assert/strict';`,
    `for(const t of ${lit(entries.map((e) => e.path))}){`,
    `const m=await import('./'+t);`,
    `switch(t){`,
  ];
  for (const e of entries) parts.push(`case ${lit(e.path)}:{`, e.body, `break;}`);
  parts.push(`default:throw new Error('unknown target '+t);`, `}`, `}`, `console.log('holdout passed');`);
  return parts.join('\n') + '\n';
}

export interface MutantSpec {
  /** Short kind id; the task-level mutant id is prefixed with the node key. */
  readonly id: string;
  readonly description: string;
  /** Complete file content replacing the reference version of this node. */
  readonly content: string;
  /** Generator prediction for local public cases. Full public-check execution is authoritative; downstream consumers can disagree. */
  readonly publicPass: boolean;
}
export interface NodeOut {
  readonly key: string;
  /** Family-local role name used to locate defect targets. */
  readonly role: string;
  readonly deps: readonly string[];
  readonly instructions: string;
  readonly reference: string;
  readonly baseline: string;
  /** Assertions inside `case path: { ... }`; `m` is the imported module. */
  readonly publicBody: string;
  readonly holdBody: string;
  readonly mutants: readonly MutantSpec[];
}
export interface FamilyBuild {
  readonly goal: string;
  /** Human description of the seeded baseline defect. */
  readonly defect: string;
  readonly nodes: readonly NodeOut[];
  readonly context?: Record<string, string>;
}
export interface Family {
  readonly name: string;
  readonly title: string;
  readonly shapes: readonly Topology[];
  build(variant: number, topology: Topology, count: number): FamilyBuild;
}
export type SpecGen = Family['build'];

export interface MutantOut {
  readonly id: string;
  readonly description: string;
  readonly patch: Record<string, string>;
  readonly predictedPublicPass: boolean;
}
export interface TaskMeta {
  readonly id: string;
  readonly family: string;
  readonly variant: number;
  readonly split: Split;
  readonly targetCount: number;
  readonly topology: Topology;
  readonly defect: string;
  readonly defectedPaths: readonly string[];
  readonly mutants: readonly {id: string; description: string; predictedPublicPass: boolean}[];
}
export interface Built {
  readonly metadata: TaskMeta;
  readonly files: Record<string, string>;
  readonly task: RepoTask;
  readonly reference: Record<string, string>;
  readonly mutants: readonly MutantOut[];
  readonly hashes: {public: string; private: string};
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function pickMutants(nodes: readonly NodeOut[], variant: number): readonly {key: string; m: MutantSpec}[] {
  const pool = nodes.flatMap((n) => n.mutants.map((m) => ({key: n.key, m})));
  if (pool.length < 2) throw new Error('family produced fewer than two mutants');
  const out: {key: string; m: MutantSpec}[] = [];
  const seen = new Set<string>();
  const keys = new Set<string>();
  const take = (c: {key: string; m: MutantSpec}, freshKey: boolean): boolean => {
    const cid = c.key + '' + c.m.id;
    if (seen.has(cid) || (freshKey && keys.has(c.key))) return false;
    seen.add(cid);
    keys.add(c.key);
    out.push(c);
    return true;
  };
  const start = variant % pool.length;
  for (let k = 0; out.length < 3 && k < pool.length; k++) take(pool[(start + 2 * k + 1) % pool.length]!, true);
  for (let k = 0; out.length < 2 && k < pool.length; k++) take(pool[(start + k) % pool.length]!, false);
  if (!out.some((c) => c.m.publicPass)) {
    const alt = pool.find((c) => c.m.publicPass && !keys.has(c.key)) ?? pool.find((c) => c.m.publicPass);
    if (alt) take(alt, false);
  }
  return out;
}

const CHECK_TIMEOUT_MS = 15000;
const FINAL_TIMEOUT_MS = 60000;
/** Portable argv[0]: 'node' resolves through PATH at run time and keeps the
 *  generated manifest + hashes machine-independent. */
const NODE = 'node';

export function assemble(family: Family, familyIndex: number, variant: number): Built {
  const topology = family.shapes[variant % family.shapes.length]!;
  const count = COUNTS[Math.floor(variant / family.shapes.length) % COUNTS.length]!;
  const b = family.build(variant, topology, count);
  const keys = new Set<string>();
  for (const n of b.nodes) {
    if (keys.has(n.key)) throw new Error(`${family.name} v${variant}: duplicate node key ${n.key}`);
    keys.add(n.key);
  }
  if (b.nodes.length !== count) throw new Error(`${family.name} v${variant}: built ${b.nodes.length} nodes for count ${count}`);
  for (const n of b.nodes) {
    for (const d of n.deps) {
      if (d === n.key) throw new Error(`${family.name} v${variant}: self dependency ${d}`);
      if (!keys.has(d)) throw new Error(`${family.name} v${variant}: ${n.key} depends on unknown ${d}`);
    }
  }
  const pathOf = (key: string) => `src/${key}.mjs`;
  const files: Record<string, string> = {};
  for (const n of b.nodes) files[pathOf(n.key)] = n.baseline;
  for (const [p, c] of Object.entries(b.context ?? {})) {
    if (Object.hasOwn(files, p)) throw new Error(`${family.name} v${variant}: context path collides with target: ${p}`);
    files[p] = c;
  }
  files['contract.md'] =
    `# Task contract\n\n${b.goal}\n\n` + b.nodes.map((n) => `## ${pathOf(n.key)}\n\n${n.instructions}`).join('\n\n') + '\n';
  files['public-check.mjs'] = publicCheckSource(b.nodes.map((n) => ({path: pathOf(n.key), body: n.publicBody})));
  // The hidden oracle re-runs every public case plus held-out cases: a mutant
  // that breaks a public requirement can never survive the final check.
  files['holdout.mjs'] = holdoutSource(
    b.nodes.map((n) => ({path: pathOf(n.key), body: `{${n.publicBody}}\n{${n.holdBody}}`})),
  );
  const context = ['contract.md', 'public-check.mjs', ...Object.keys(b.context ?? {})];
  const task = parseRepoTask({
    version: 2,
    goal: b.goal,
    files: b.nodes.map((n) => ({
      path: pathOf(n.key),
      instructions: n.instructions,
      dependsOn: n.deps.map(pathOf),
      checks: [{argv: [NODE, 'public-check.mjs', pathOf(n.key)], timeoutMs: CHECK_TIMEOUT_MS}],
    })),
    context,
    protected: ['holdout.mjs'],
    checks: [{argv: [NODE, 'holdout.mjs'], timeoutMs: FINAL_TIMEOUT_MS}],
    discovery: {mode: 'static', readable: [], maxReadCalls: 0, maxPathsPerRead: 8, maxDeliveredBytes: 262144},
  });
  const reference: Record<string, string> = {};
  for (const n of b.nodes) reference[pathOf(n.key)] = n.reference;
  const defectedPaths = b.nodes.filter((n) => n.baseline !== n.reference).map((n) => pathOf(n.key));
  if (defectedPaths.length === 0) throw new Error(`${family.name} v${variant}: baseline identical to reference`);
  const picked = pickMutants(b.nodes, variant);
  const mutants = picked.map((c, i) => ({
    id: `m${i}-${c.key}-${c.m.id}`,
    description: c.m.description,
    predictedPublicPass: c.m.publicPass,
    patch: {[pathOf(c.key)]: c.m.content},
  }));
  const split: Split = familyIndex < 8 ? 'dev' : 'evaluation';
  const metadata: TaskMeta = {
    id: `syn-${family.name}-v${String(variant).padStart(2, '0')}`,
    family: family.name,
    variant,
    split,
    targetCount: count,
    topology,
    defect: b.defect,
    defectedPaths,
    mutants: mutants.map((m) => ({id: m.id, description: m.description, predictedPublicPass: m.predictedPublicPass})),
  };
  // Disjoint identities: the public side covers exactly what a worker sees
  // (baseline files minus protected holdouts, plus the manifest); the private
  // side covers the fixed oracle and all solution maps.
  const publicFiles: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) if (!task.protected.includes(p)) publicFiles[p] = c;
  return {
    metadata,
    files,
    task,
    reference,
    mutants,
    hashes: {
      public: sha256Text(stable({files: publicFiles, task})),
      private: sha256Text(
        stable({
          holdout: Object.fromEntries(task.protected.map((p) => [p, files[p] ?? ''])),
          reference,
          mutants: mutants.map((m) => ({id: m.id, patch: m.patch})),
        }),
      ),
    },
  };
}

/** Build a node; baseline defaults to reference and mutants default to none. */
export function N(n: Omit<NodeOut, 'baseline' | 'mutants'> & {baseline?: string; mutants?: readonly MutantSpec[]}): NodeOut {
  return {...n, baseline: n.baseline ?? n.reference, mutants: n.mutants ?? []};
}

/** Replace one node's baseline with a defected rendering; no-op edits throw. */
export function seedDefect(nodes: NodeOut[], key: string, mutate: (reference: string) => string): void {
  const index = nodes.findIndex((n) => n.key === key);
  if (index < 0) throw new Error(`defect target absent: ${key}`);
  const next = mutate(nodes[index]!.reference);
  if (next === nodes[index]!.reference) throw new Error(`defect no-op on ${key}`);
  nodes[index] = {...nodes[index]!, baseline: next};
}
export function findKey(nodes: readonly NodeOut[], role: string, index = 0): string {
  const hits = nodes.filter((n) => n.role === role);
  const hit = hits[index];
  if (hit === undefined) throw new Error(`role ${role}[${index}] absent`);
  return hit.key;
}

/** Sparse layout sizes: 1 conf + `pairs` (src->sink) branches + 1 join +
 *  `solos` free-standing leaves === count. The join consumes the shared conf
 *  plus the even-numbered sinks, so odd branches never feed it. */
export function sparsePlan(count: number): {pairs: number; solos: number} {
  if (count === 4) return {pairs: 1, solos: 0};
  const rest = count - 2;
  const pairs = Math.floor(rest / 3);
  return {pairs, solos: rest - pairs * 2};
}
export function sparseJoinSinks(pairs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < pairs; i += 2) out.push(i);
  return out;
}

/** Defected or mutated targets plus every transitive dependent: the checks that
 *  can possibly observe the change. */
export function observerTargets(task: RepoTask, changedPaths: readonly string[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const f of task.files) {
    for (const d of f.dependsOn) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [f.path]);
      else list.push(f.path);
    }
  }
  const out = new Set<string>(changedPaths);
  const queue = [...changedPaths];
  while (queue.length > 0) {
    const p = queue.pop()!;
    for (const c of dependents.get(p) ?? []) {
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
    }
  }
  return out;
}
