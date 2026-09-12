import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {dependencyDepth, digest, pairedPlan, summarizePaired, type FrozenCase, type PairedRow} from '../experiments/synthetic-paired.ts';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
// @ts-expect-error host-only orchestration with no calls at import time
import {verifyCorpus, receiptAudit, runSeries} from '../scripts/synthetic-paired-benchmark.mjs';

const cases: FrozenCase[] = Array.from({length: 5}, (_, variant) => ({id: `t${variant}`, family: 'example', variant,
  split: 'dev', targetCount: 4, topology: 'chain', dependencyDepth: 3, hashes: {public: 'p', private: 'q'}}));
test('paired speed excludes failures and missing partners, preserving discordant success counts', () => {
  const row = (id: string, method: 'single' | 'sheep', success: boolean, elapsedMs: number): PairedRow =>
    ({id, method, success, elapsedMs, completionMs: success ? elapsedMs : null, tokens: 12, calls: 1});
  const rows = [row('t0', 'single', true, 100), row('t0', 'sheep', true, 25),
    row('t1', 'single', true, 500), row('t1', 'sheep', false, 1),
    row('t2', 'single', false, 1), row('t2', 'sheep', true, 700),
    row('t3', 'single', false, 3), row('t3', 'sheep', false, 4), row('t4', 'single', true, 900)];
  const s = summarizePaired(cases, rows);
  assert.equal(s.overall.plannedPairs, 5); assert.equal(s.overall.completedPairs, 4);
  assert.equal(s.overall.bothSuccess, 1); assert.equal(s.overall.neitherSuccess, 1);
  assert.equal(s.overall.singleOnlySuccess, 1); assert.equal(s.overall.sheepOnlySuccess, 1);
  assert.equal(s.overall.medianSingleOverSheep, 4); assert.equal(s.overall.medianSingleMinusSheepMs, 75);
  assert.deepEqual(s.family['example'], s.overall);
  assert.equal(summarizePaired(cases, [{...rows[0]!, tokens: null}]).overall.methods['single']!.totalTokens, null);
  assert.throws(() => summarizePaired(cases, [rows[0]!, rows[0]!]));
  assert.throws(() => summarizePaired(cases, [{...rows[0]!, success: false}]));
});

test('PR 8 public/private hashes stay fixed for all 256 cases and dev schedule is balanced', async () => {
  const lock = await verifyCorpus();
  const selected = (lock.cases as FrozenCase[]).filter(c => c.split === 'dev'), plan = pairedPlan(selected);
  assert.equal(selected.length, 128); assert.equal(plan.length, 256);
  assert.deepEqual(plan, pairedPlan([...selected].reverse()));
  const firstCounts: Record<string, Record<string, number>> = {};
  for (let i = 0; i < plan.length; i += 2) {
    const a = plan[i]!, b = plan[i + 1]!;
    assert.equal(a.id, b.id); assert.notEqual(a.method, b.method);
    const c = selected.find(c => c.id === a.id)!;
    const counts = firstCounts[c.family] ??= {single: 0, sheep: 0}; counts[a.method]!++;
  }
  for (const counts of Object.values(firstCounts)) assert.deepEqual(counts, {single: 8, sheep: 8});
  assert.throws(() => pairedPlan(lock.cases), /evaluation/);
  const fixture = buildSyntheticTask('syn-units-v00');
  assert.equal(dependencyDepth(fixture.task), 2);
  assert.throws(() => dependencyDepth({...fixture.task, files: fixture.task.files.map(f => ({...f, dependsOn: [f.path]}))}), /cyclic/);
});

test('receipt audit rejects unknown usage and protected context independently of runner success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paired-audit-'));
  try {
    const task = buildSyntheticTask('syn-units-v00').task;
    const context = Object.fromEntries([...task.files.map(f => f.path), ...task.context].map(p => [p, 'public']));
    await writeFile(join(root, 'call-1.request.json'), JSON.stringify({prompt: `Public files: ${JSON.stringify(context)}`}));
    const receipt = {transcript: {requestedModel: 'deepseek-flash', effectiveModelEvidence: 'deepseek-flash', thinking: 'enabled',
      httpStatus: 200, usageCompleteness: 'complete', timedOut: false, cancelled: false,
      rawUsage: {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30}}};
    const write = () => writeFile(join(root, 'call-1.json'), JSON.stringify(receipt));
    await write();
    const run = {calls: [{id: 'call-1'}], budget: {observedTokens: 30, unknownUsageCalls: 0, activeReservations: 0, reservationOverruns: 0, exceeded: false}};
    const usage = await receiptAudit(root, 'single', run, task);
    assert.equal(usage.tokens, 30); assert.equal(usage.reasoningTokens, null);
    receipt.transcript.usageCompleteness = 'unknown'; await write();
    await assert.rejects(receiptAudit(root, 'single', run, task));
    receipt.transcript.usageCompleteness = 'complete'; await write();
    await writeFile(join(root, 'call-1.request.json'), JSON.stringify({prompt: `Public files: ${JSON.stringify({...context, 'holdout.mjs': 'secret'})}`}));
    await assert.rejects(receiptAudit(root, 'single', run, task));
  } finally {await rm(root, {recursive: true, force: true});}
});

test('series refuses interrupted or evidence-stopped execution before runtime or model access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paired-stop-')), previousKey = process.env['OPENCODE_GO_API_KEY'];
  process.env['OPENCODE_GO_API_KEY'] = 'test-no-network';
  try {
    const bytes = '{}\n'; await writeFile(join(root, 'profile.json'), bytes);
    for (const state of [{stopReason: 'evidence-stop', inFlight: null}, {stopReason: null, inFlight: {id: 't0', method: 'single'}}]) {
      await writeFile(join(root, 'series.json'), JSON.stringify({profileHash: digest(bytes), ...state}));
      await assert.rejects(runSeries(root), /stopped series|interrupted call/);
    }
    assert.deepEqual(JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')), {});
  } finally {
    if (previousKey === undefined) delete process.env['OPENCODE_GO_API_KEY']; else process.env['OPENCODE_GO_API_KEY'] = previousKey;
    await rm(root, {recursive: true, force: true});
  }
});
