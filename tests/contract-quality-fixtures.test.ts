import assert from 'node:assert/strict';
import test from 'node:test';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {qualityFixture,freshFixture,parallelFixture} from '../experiments/contract-quality-fixtures.ts';
import {repository} from './repo-test-helpers.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
import {RepositoryDiscovery} from '../src/repo-discovery.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
for(const name of ['multiple','healthy','branching','independent','propagation','parallel'] as const)test(`frozen fixture baseline/reference/mutant: ${name}`,async t=>{
 const f=name==='parallel'?parallelFixture():name==='independent'||name==='propagation'?freshFixture(name):await qualityFixture(name);
 const root=await repository(f.files);t.after(()=>rm(root,{recursive:true,force:true}));
 const snapshot=await captureRepository(root,f.task),out=join(root,'checks');
 const baseline=await runRepoChecks(snapshot,{},f.task.checks,out);
 const reference=await runRepoChecks(snapshot,f.reference,[...f.task.files.flatMap(f=>f.checks),...f.task.checks],out);
 const mutant=await runRepoChecks(snapshot,f.mutant,f.task.checks,out);
 assert.equal(baseline.ok,false);assert.equal(reference.ok,true,JSON.stringify(reference));assert.equal(mutant.ok,false);
 for(const result of [baseline,reference,mutant])assert.ok(!result.executionFailure);
 if(name==='parallel'){
  const selected=await RepositoryDiscovery.create(await captureRepository(root,parseRepoTask({...f.task,activation:{changedPaths:f.changedPaths}})));
  assert.deepEqual(selected.activation.activeTargets.sort(),['compute-0.mjs','compute-1.mjs','report-0.mjs','report-1.mjs']);
  assert.equal(selected.activation.unaffectedTargets.length,12);
 }
});
