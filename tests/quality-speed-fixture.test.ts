import assert from 'node:assert/strict';
import test from 'node:test';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
// @ts-expect-error host-only JS fixture
import {buildQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';
// @ts-expect-error independent host-only reference
import {referenceContents} from '../scripts/quality-speed-reference.mjs';
test('quality-speed fixtures reject baseline and subtle mutants and accept independent references',async t=>{
 for(const family of ['independent','propagation'])for(const variant of [0,1,2]){
  const f=buildQualitySpeedFixture(family,variant),reference=referenceContents(family);const root=await repository(f.files);t.after(()=>rm(root,{recursive:true,force:true}));const task=parseRepoTask(f.task),snapshot=await captureRepository(root,task);const checks=[...task.files.flatMap(f=>f.checks),...task.checks];
  assert.equal((await runRepoChecks(snapshot,{},task.checks,join(root,'baseline'))).ok,false);
  const good=await runRepoChecks(snapshot,reference,checks,join(root,'reference'));assert.equal(good.ok,true,JSON.stringify(good));
  const mutant={...reference};
  mutant['amount.mjs']=reference['amount.mjs'].replace('const digits=parts[0]',"if(value===String(value).trim()&&value.startsWith('00'))return null;const digits=parts[0]");
  assert.equal((await runRepoChecks(snapshot,mutant,task.checks,join(root,'mutant'))).ok,false);
 }
});
