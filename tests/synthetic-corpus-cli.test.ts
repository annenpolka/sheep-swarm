import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateSyntheticTask, materializeSyntheticTask, preflightSyntheticTask} from '../scripts/synthetic-corpus.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import type {Built} from '../experiments/synthetic-corpus/common.ts';

/** Handwritten fixture independent of the delegated generators. */
function fixture(): Built {
  return {
    metadata: {id: 'cli-test', family: 'handwritten', variant: 0, split: 'dev', targetCount: 1,
      topology: 'independent', defect: 'always null', defectedPaths: ['a.mjs'], mutants: []},
    files: {
      'a.mjs': 'export const f=x=>null;\n',
      'public.mjs': "import assert from 'node:assert/strict';import {f} from './a.mjs';assert.equal(f(' Alpha '),'alpha');\n",
      'holdout.mjs': "import assert from 'node:assert/strict';import {f} from './a.mjs';assert.equal(f(' Alpha '),'alpha');assert.equal(f('B'),'b');\n",
    },
    task: parseRepoTask({version: 1, goal: 'Normalize strings', files: [{path: 'a.mjs',
      instructions: 'Trim strings and lowercase; return null for other inputs.', checks: [{argv: ['node', 'public.mjs']}]}],
      context: ['public.mjs'], protected: ['holdout.mjs'], checks: [{argv: ['node', 'holdout.mjs']}]}),
    reference: {'a.mjs': 'export const f=x=>typeof x==="string"?x.trim().toLowerCase():null;\n'},
    mutants: [
      {id: 'constant', description: 'Returns constant', patch: {'a.mjs': 'export const f=x=>"alpha";\n'}, predictedPublicPass: true},
      {id: 'case', description: 'Omits lowercase', patch: {'a.mjs': 'export const f=x=>typeof x==="string"?x.trim():null;\n'}, predictedPublicPass: false},
    ],
    hashes: {public: 'test-public', private: 'test-private'},
  };
}

test('corpus materialization exports baseline and manifest, protects existing directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheep-corpus-cli-test-'));
  try {
    const f = fixture(), dest = join(root, 'task');
    await materializeSyntheticTask(f, dest);
    assert.deepEqual((await readdir(dest)).sort(), ['a.mjs', 'holdout.mjs', 'public.mjs', 'task.json']);
    assert.equal(await readFile(join(dest, 'a.mjs'), 'utf8'), f.files['a.mjs']);
    await assert.rejects(materializeSyntheticTask(f, dest), {code: 'EEXIST'});
    assert.equal(await readFile(join(dest, 'a.mjs'), 'utf8'), f.files['a.mjs']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('corpus validation rejects hidden files in public context and out-of-scope patches', () => {
  const f = fixture();
  assert.throws(() => validateSyntheticTask({...f, task: {...f.task, context: ['public.mjs', 'holdout.mjs']}}), /private file is readable/);
  assert.throws(() => validateSyntheticTask({...f, mutants: [{...f.mutants[0]!, patch: {'holdout.mjs': 'process.exit(0)'}}, f.mutants[1]!]}), /invalid target patch/);
});

test('corpus preflight detects a semantic mutant that passes public checks', async () => {
  const r = await preflightSyntheticTask(fixture());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.reference?.finalPass, true);
  assert.equal(r.baseline?.finalAssertionFailure, true);
  assert.equal(r.mutants[0]?.result.publicPass, true);
  assert.equal(r.mutants[0]?.result.finalAssertionFailure, true);
});

test('corpus preflight does not count syntax errors as semantic kills', async () => {
  const f = fixture();
  const r = await preflightSyntheticTask({...f, mutants: [{...f.mutants[0]!, patch: {'a.mjs': 'export const f = ;'}}, f.mutants[1]!]});
  assert.equal(r.ok, false);
  assert.equal(r.mutants[0]?.result.syntax, false);
});

test('corpus preflight rejects surviving mutations', async () => {
  const f = fixture();
  const r = await preflightSyntheticTask({...f, mutants: [{...f.mutants[0]!, patch: {'a.mjs': f.reference['a.mjs']! + '// semantic no-op\n'}}, f.mutants[1]!]});
  assert.equal(r.ok, false);
  assert.equal(r.mutants[0]?.result.finalPass, true);
});
