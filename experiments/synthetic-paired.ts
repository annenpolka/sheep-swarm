import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {RepoTask} from '../src/repo-types.ts';

export type Method = 'single' | 'sheep';
export interface FrozenCase {
  id: string; family: string; variant: number; split: 'dev' | 'evaluation';
  targetCount: number; topology: string; dependencyDepth: number;
  hashes: {public: string; private: string};
}
export interface PairedRow {
  id: string; method: Method; success: boolean; elapsedMs: number;
  completionMs: number | null; tokens: number | null; calls: number;
}
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Longest declared target dependency path in edges; no private defect metadata. */
export function dependencyDepth(task: RepoTask): number {
  const graph = new Map(task.files.map(f => [f.path, f.dependsOn]));
  const cache = new Map<string, number>(), visiting = new Set<string>();
  function depth(path: string): number {
    if (cache.has(path)) return cache.get(path)!;
    assert.ok(graph.has(path), `unknown dependency: ${path}`);
    assert.ok(!visiting.has(path), 'cyclic task dependency');
    visiting.add(path);
    const deps = graph.get(path)!;
    const result = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(path); cache.set(path, result); return result;
  }
  return Math.max(...task.files.map(f => depth(f.path)));
}

/** Fixed hash order disperses families; every family has eight starts per method. */
export function pairedPlan(cases: readonly FrozenCase[]) {
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length, 'duplicate task');
  assert.ok(cases.every(c => c.split === 'dev'), 'dev series must exclude evaluation');
  return [...cases].sort((a, b) => digest('sheep-dev-paired-v1:' + a.id).localeCompare(digest('sheep-dev-paired-v1:' + b.id)))
    .flatMap(c => (c.variant % 2 ? ['sheep', 'single'] as const : ['single', 'sheep'] as const).map(method => ({id: c.id, method})));
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function summarizePaired(cases: readonly FrozenCase[], rows: readonly PairedRow[]) {
  const byId = new Map(cases.map(c => [c.id, new Map<Method, PairedRow>()]));
  for (const row of rows) {
    assert.ok(byId.has(row.id), 'unknown task row');
    assert.ok(row.method === 'single' || row.method === 'sheep');
    assert.ok(!byId.get(row.id)!.has(row.method), 'duplicate task/method');
    assert.equal(typeof row.success, 'boolean');
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs > 0);
    assert.equal(row.completionMs, row.success ? row.elapsedMs : null);
    assert.ok(row.tokens === null || (Number.isSafeInteger(row.tokens) && row.tokens >= 0));
    assert.ok(Number.isSafeInteger(row.calls) && row.calls >= 0);
    byId.get(row.id)!.set(row.method, row);
  }
  function group(selected: readonly FrozenCase[]) {
    let paired = 0, both = 0, neither = 0, singleOnly = 0, sheepOnly = 0, sheepFaster = 0, singleFaster = 0;
    const ratios: number[] = [], differences: number[] = [];
    const subset = rows.filter(r => selected.some(c => c.id === r.id));
    for (const c of selected) {
      const single = byId.get(c.id)!.get('single'), sheep = byId.get(c.id)!.get('sheep');
      if (!single || !sheep) continue;
      paired++;
      if (single.success && sheep.success) {
        both++; ratios.push(single.elapsedMs / sheep.elapsedMs); differences.push(single.elapsedMs - sheep.elapsedMs);
        if (single.elapsedMs > sheep.elapsedMs) sheepFaster++;
        if (single.elapsedMs < sheep.elapsedMs) singleFaster++;
      } else if (single.success) singleOnly++;
      else if (sheep.success) sheepOnly++;
      else neither++;
    }
    const methods = Object.fromEntries((['single', 'sheep'] as const).map(method => {
      const rs = subset.filter(r => r.method === method);
      return [method, {runs: rs.length, successes: rs.filter(r => r.success).length,
        calls: rs.reduce((n, r) => n + r.calls, 0), knownTokens: rs.reduce((n, r) => n + (r.tokens ?? 0), 0),
        totalTokens: rs.some(r => r.tokens === null) ? null : rs.reduce((n, r) => n + r.tokens!, 0),
        elapsedMs: rs.reduce((n, r) => n + r.elapsedMs, 0),
        medianCompletionMs: median(rs.filter(r => r.success).map(r => r.elapsedMs))}];
    }));
    return {plannedPairs: selected.length, completedPairs: paired, bothSuccess: both, neitherSuccess: neither,
      singleOnlySuccess: singleOnly, sheepOnlySuccess: sheepOnly, sheepFaster, singleFaster,
      medianSingleOverSheep: median(ratios), medianSingleMinusSheepMs: median(differences), methods};
  }
  const strata = (key: 'family' | 'topology' | 'targetCount' | 'dependencyDepth') =>
    Object.fromEntries([...new Set(cases.map(c => String(c[key])))].sort().map(v => [v, group(cases.filter(c => String(c[key]) === v))]));
  const jointKey = (c: FrozenCase) => `${c.family}/${c.topology}/${c.targetCount}/${c.dependencyDepth}`;
  return {overall: group(cases), family: strata('family'), topology: strata('topology'), targetCount: strata('targetCount'), dependencyDepth: strata('dependencyDepth'),
    joint: Object.fromEntries([...new Set(cases.map(jointKey))].sort().map(k => [k, group(cases.filter(c => jointKey(c) === k))]))};
}
