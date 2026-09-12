import assert from 'node:assert/strict';
import test from 'node:test';
import {rm,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {RepositoryDiscovery,REPO_GOAL,REPO_GUIDANCE} from '../src/repo-discovery.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {SwarmKernel} from '../src/kernel.ts';
// @ts-expect-error host fixture
import {buildQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';

test('recovery manifest is strict and cannot be enabled on v1',()=>{
 const f=buildQualitySpeedFixture('propagation',1);
 for(const recovery of [{},{maxUpstreamRechecks:0},{maxUpstreamRechecks:65},{maxUpstreamRechecks:1.5},{maxUpstreamRechecks:1,extra:true},{maxUpstreamRechecks:1,review:"other"},{maxUpstreamRechecks:1,review:null},null])assert.throws(()=>parseRepoTask({...f.task,recovery}));
 assert.equal(parseRepoTask({...f.task,recovery:{maxUpstreamRechecks:1}}).recovery?.review,'focused');
 assert.equal(parseRepoTask({...f.task,recovery:{maxUpstreamRechecks:1,review:'contract'}}).recovery?.review,'contract');
 assert.throws(()=>parseRepoTask({...f.task,version:1,discovery:undefined,recovery:{maxUpstreamRechecks:1}}));
});
for(const stale of [false,true])test(`recovery evidence: ${stale?'stale observations cannot reactivate':'root-only evidence avoids reverse dependencies and respects total cap'}`,async t=>{
 const f=buildQualitySpeedFixture('propagation',1),root=await repository(f.files);t.after(()=>rm(root,{recursive:true,force:true}));
 const task=parseRepoTask({...f.task,recovery:{maxUpstreamRechecks:1}});
 const discovery=await RepositoryDiscovery.create(await captureRepository(root,task));
 const kernel=new SwarmKernel({artifacts:{...discovery.artifacts,[REPO_GOAL]:'goal',[REPO_GUIDANCE]:'guidance'}});
 for(const edge of discovery.dependencies())kernel.addDependency(edge.consumer,edge.provider);
 const context=kernel.checkout('worker',discovery.contextIds(kernel,'invoice.mjs'));
 if(stale)kernel.change('amount.mjs','changed');
 kernel.closeInput();
 await discovery.rejected(kernel,'invoice.mjs',context,'call-1',{commands:[['node','public-check.mjs','invoice.mjs']],diagnostic:'PUBLIC_MARKER'},['amount.mjs','cart.mjs']);
 const out=join(root,'evidence');await mkdir(out);await discovery.save(out);
 const recovery=JSON.parse(await readFile(join(out,'upstream-recovery.json'),'utf8'));
 if(stale){assert.deepEqual(recovery.rechecked,[]);assert.equal(recovery.observations[0].reason,'stale-observation');return;}
 assert.deepEqual(recovery.rechecked,['amount.mjs']);
 assert.deepEqual(kernel.exportState().historical,[]);
 assert.equal(kernel.pending().some(w=>w.consumer.startsWith('.sheep-internal/recovery/')),false);
 assert.ok(kernel.pending().some(w=>w.consumer==='amount.mjs'));
 const next=kernel.checkout('worker-2',discovery.contextIds(kernel,'invoice.mjs'));
 await discovery.rejected(kernel,'invoice.mjs',next,'call-2',{commands:[['node','public-check.mjs']],diagnostic:'AGAIN'},['cart.mjs']);
 assert.equal(discovery.metrics([]).upstreamRechecks,1);
});
