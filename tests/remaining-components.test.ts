import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {selectImpactedTargets} from '../src/repo-impact.ts';

test('impact selection follows reverse edges, preserves target order and terminates cycles',()=>{
 const input={targets:['b.ts','a.ts','unused.ts'],changedPaths:['policy.json'],edges:[{consumer:'a.ts',provider:'policy.json'},{consumer:'bridge.ts',provider:'a.ts'},{consumer:'b.ts',provider:'bridge.ts'},{consumer:'a.ts',provider:'b.ts'}],uncertainConsumers:[]};
 const saved=JSON.stringify(input);assert.deepEqual(selectImpactedTargets(input),{activeTargets:['b.ts','a.ts'],unaffectedTargets:['unused.ts']});assert.equal(JSON.stringify(input),saved);
 assert.deepEqual(selectImpactedTargets({...input,changedPaths:[]}),{activeTargets:[],unaffectedTargets:input.targets});
 assert.deepEqual(selectImpactedTargets({...input,changedPaths:['unused.ts']}),{activeTargets:['unused.ts'],unaffectedTargets:['b.ts','a.ts']});
 assert.deepEqual(selectImpactedTargets({...input,changedPaths:[],uncertainConsumers:['bridge.ts']}),{activeTargets:['b.ts','a.ts'],unaffectedTargets:['unused.ts']});
 for(const invalid of [null,{}, {...input,targets:['a','a']},{...input,changedPaths:['']},{...input,edges:[{consumer:'a'}]},{...input,uncertainConsumers:[5]}])assert.throws(()=>selectImpactedTargets(invalid));
});

test('scale fixture fixes work independently of N and uses all opaque policies across worlds',async()=>{
 const {buildScalingReadFixture}=await import(pathToFileURL(resolve('scripts/scaling-read-fixture.mjs')).href);
 const a=buildScalingReadFixture({seed:'holdout-contract',world:0,targets:16,documents:64});
 const b=buildScalingReadFixture({seed:'holdout-contract',world:1,targets:16,documents:64});
 assert.deepEqual(a,buildScalingReadFixture({seed:'holdout-contract',world:0,targets:16,documents:64}));
 assert.equal(a.targets.length,16);assert.equal(a.catalog.length,65);assert.deepEqual(a.catalog,b.catalog);
 assert.deepEqual(Object.keys(a.files).filter(p=>a.files[p]!==b.files[p]),['registry.json']);
 for(const p of a.targets)assert.match(p,/^modules\/unit-[0-9]+\.ts$/);
 for(const f of [a,b]){
  const registry=JSON.parse(f.files['registry.json']);assert.equal(new Set(f.expectations.map((e:{policyPath:string})=>e.policyPath)).size,16);
  for(const e of f.expectations){assert.equal(registry[e.target],e.policyPath);assert.deepEqual(e.policy,JSON.parse(f.files[e.policyPath]));assert.match(e.policyPath,/^docs\/[0-9a-f]{16}\.json$/);assert.equal(e.registryPath,'registry.json');assert.ok(e.policy.cap>e.policy.minimum);assert.ok(e.policy.rate>0);}
 }
 for(const invalid of [{seed:'',world:0,targets:16,documents:64},{seed:'x',world:-1,targets:16,documents:64},{seed:'x',world:0,targets:0,documents:64},{seed:'x',world:0,targets:17,documents:16},{seed:'x',world:0,targets:16,documents:257}])assert.throws(()=>buildScalingReadFixture(invalid));
});
