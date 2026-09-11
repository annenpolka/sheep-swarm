import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildSyntheticTask, listSyntheticTasks} from '../experiments/synthetic-corpus/index.ts';
import {validateSyntheticTask, preflightSyntheticTask} from '../scripts/synthetic-corpus.ts';

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  }
  return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

test('synthetic corpus has deterministic, distinct inputs and disjoint family splits', () => {
  const specs = listSyntheticTasks(), groups = new Map<string, Set<string>>(), counts = new Map<string, number>();
  const identities = new Set<string>();
  assert.equal(specs.length, 256);
  assert.equal(new Set(specs.map(x => x.id)).size, 256);
  for (const s of specs) {
    const f = buildSyntheticTask(s.id);
    validateSyntheticTask(f);
    assert.equal(hash(f), hash(buildSyntheticTask(s.id)));
    const publicFiles = Object.fromEntries(Object.entries(f.files).filter(([p]) => !f.task.protected.includes(p)));
    assert.equal(f.hashes.public, hash({files: publicFiles, task: f.task}));
    assert.equal(f.hashes.private, hash({holdout: Object.fromEntries(f.task.protected.map(p => [p, f.files[p]])), reference: f.reference, mutants: f.mutants.map(m => ({id: m.id, patch: m.patch}))}));
    identities.add(f.hashes.public);
    groups.set(s.family, new Set([...(groups.get(s.family) ?? []), s.split]));
    counts.set(s.family, (counts.get(s.family) ?? 0) + 1);
    assert.ok([4, 8, 16, 32].includes(s.targetCount));
    assert.ok(f.metadata.defectedPaths.length > 0);
  }
  assert.equal(identities.size, 256);
  assert.equal(groups.size, 16);
  for (const [name, splits] of groups) { assert.equal(splits.size, 1); assert.equal(counts.get(name), 16); }
  const f = buildSyntheticTask(specs[0]!.id), saved = f.files['contract.md'];
  f.files['contract.md'] = 'caller mutation';
  assert.equal(buildSyntheticTask(specs[0]!.id).files['contract.md'], saved);
  assert.throws(() => buildSyntheticTask('syn-units-v16'), /unknown/);
  assert.throws(() => buildSyntheticTask('syn-no-such-family-v00'), /unknown/);
});

test('one task per family passes the baseline/reference/semantic-mutant gate', async () => {
  const selected = listSyntheticTasks().filter(s => s.variant === 0);
  for (const spec of selected) {
    const row = await preflightSyntheticTask(buildSyntheticTask(spec.id));
    assert.equal(row.ok, true, `${spec.id}: ${row.errors.join('; ')}`);
  }
});

/** Caller-selected examples from the written contracts, without generator oracles. */
test('independent contract anchors cover integer strings, sparse bounds and plain objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheep-corpus-anchor-'));
  try {
    for (const id of ['syn-units-v01', 'syn-stats-v07', 'syn-topk-v00']) {
      const f = buildSyntheticTask(id), dir = join(root, id);
      for (const [p, s] of Object.entries(f.reference)) { await mkdir(dirname(join(dir, p)), {recursive: true}); await writeFile(join(dir, p), s); }
      const load = (p: string) => import(pathToFileURL(join(dir, p)).href);
      if (id === 'syn-units-v01') {
        const m = await load('src/parse-0.mjs');
        assert.equal(m.parseUnits('1'), 10);
        assert.equal(m.parseUnits('0.1'), 1);
        assert.equal(m.parseUnits('1.01'), null);
        assert.equal(m.parseUnits('+1'), null);
      } else if (id === 'syn-stats-v07') {
        for (const t of f.task.files.filter(t => t.path.startsWith('src/part-'))) {
          const match = /integers in \[(-?\d+),(-?\d+)\]/.exec(t.instructions)!;
          const lo = Number(match[1]), hi = Number(match[2]);
          assert.ok(lo < hi);
          const m = await load(t.path);
          assert.deepEqual(m.partStats([lo, hi]), {count: 2, sum: lo + hi, min: lo, max: hi});
        }
      } else {
        const m = await load('src/score-0.mjs'), record = {id: ' x ', s: 0, t: 0};
        assert.deepEqual(m.scoreItem(record), record);
        assert.equal(m.scoreItem(Object.assign(new Date(0), record)), null);
        assert.equal(m.scoreItem(Object.assign(Object.create({}), record)), null);
        assert.deepEqual(m.scoreItem(Object.assign(Object.create(null), record)), record);
      }
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});


test('text family reference leaves satisfy independent grammar and ordering anchors', async () => {
  const anchors: Record<string, readonly (readonly [string, string])[]> = {
    'text-normalize': [[' \tAB  C\n', 'ab c'], ['\n\t', '']],
    kvcodec: [['b=2&a=%3d&a=lost', 'a=%3D&b=2'], ['a=b=c', '!'], ['a=%FF', 'a=%FF']],
    rle: [['a9a3', 'b9b3'], ['a0', '!'], ['a1\n', '!']],
    paths: [['../../a', '../../a/'], ['/../../a', 'a/'], ['a/../', '.']],
  };
  const root = await mkdtemp(join(tmpdir(), 'sheep-corpus-text-anchor-'));
  try {
    for (const [family, cases] of Object.entries(anchors)) {
      const f = buildSyntheticTask(`syn-${family}-v00`);
      assert.deepEqual(f.task.files[0]!.dependsOn, []);
      const path = join(root, `${family}.mjs`);
      await writeFile(path, f.reference['src/n0.mjs']!);
      const m = await import(pathToFileURL(path).href);
      for (const [input, expected] of cases) assert.equal(m.run(input), expected, `${family}: ${JSON.stringify(input)}`);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});


test('state-family reference leaves satisfy caller-selected atomicity and lookup anchors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheep-corpus-state-anchor-'));
  try {
    const modules: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
    for (const family of ['inventory', 'workflow', 'permissions', 'ledger']) {
      const f = buildSyntheticTask(`syn-${family}-v00`), path = join(root, `${family}.mjs`);
      assert.deepEqual(f.task.files[0]!.dependsOn, []);
      await writeFile(path, f.reference['src/n0.mjs']!);
      modules[family] = await import(pathToFileURL(path).href);
    }
    const stock = {a: 1, b: 0}, inv = modules['inventory']!['run']!;
    assert.deepEqual(inv(stock, [{sku: 'a', d: -1}]), {a: 0, b: 0});
    assert.equal(inv(stock, [{sku: 'a', d: -1}, {sku: 'missing', d: 1}]), null);
    assert.deepEqual(stock, {a: 1, b: 0});
    const step = modules['workflow']!['step']!;
    assert.equal(step('constructor', 'name'), 'ERR');
    assert.equal(step('s0', 'toString'), 'ERR');
    assert.equal(step('end', 'not-an-event'), 'TERM');
    assert.equal(step('s0', 'e1'), 's1');
    const eff = modules['permissions']!['eff']!;
    assert.deepEqual(eff(['z', 'a', 'z', 'u0'], ['z']), ['a']);
    assert.equal(eff(Array(2), []), null);
    const bal = [3, 1], ledger = modules['ledger']!['run']!;
    assert.deepEqual(ledger(bal, [{f: 0, t: 1, a: 3}]), [0, 4]);
    assert.equal(ledger(bal, [{f: 0, t: 1, a: 2}, {f: 0, t: 1, a: 2}]), null);
    assert.deepEqual(bal, [3, 1]);
    assert.equal(ledger([1, Number.MAX_SAFE_INTEGER], [{f: 0, t: 1, a: 1}]), null);
    assert.equal(ledger(Array(2), []), null);
  } finally { await rm(root, {recursive: true, force: true}); }
});
