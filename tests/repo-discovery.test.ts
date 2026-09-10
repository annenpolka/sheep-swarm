import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {repository,manifest} from './repo-test-helpers.ts';
import {runRepository} from '../src/repo-run.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {RepositoryDiscovery} from '../src/repo-discovery.ts';
import {SwarmKernel} from '../src/kernel.ts';
import {REPO_WORKER_SCHEMA,parseWorkerResponse} from '../src/worker-proposal.ts';
import {assertSupportedSchema} from '../src/codex-worker.ts';
import type {RepoCaller} from '../src/repo-types.ts';

const profile={runtime:'opencode-go' as const,workerModel:'deepseek-flash',workers:4,concurrency:2,maxCalls:12,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:1000};
const wire=(kind:string,extra:Record<string,unknown>={})=>({kind,content:'',paths:[],observed:[],missing:[],hypothesis:'',note:'fixture',...extra});
function respond(result:ReturnType<typeof wire>,unknown=false):RepoCaller{return async o=>({requestedModel:o.model,result,usage:unknown?[]:[{event:{},inputTokens:10,outputTokens:5}],
  transcript:{requestedModel:o.model,effectiveModelEvidence:'test-only',events:[],usage:unknown?[]:[{event:{},inputTokens:10,outputTokens:5}],stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,usageCompleteness:unknown?'partial-or-unknown':'complete'}});}
function task(readable:string[]=[]){return {...manifest(),version:2,discovery:{mode:'static+reads',readable,maxReadCalls:2,maxDeliveredBytes:65536}};}
const files=(prompt:string)=>JSON.parse(/Local files:\n([^\n]+)\n/.exec(prompt)![1]!) as Record<string,string>;
const target=(prompt:string)=>/Update only (\S+) to satisfy/.exec(prompt)![1]!;
const json=async(root:string,file:string)=>JSON.parse(await readFile(join(root,file),'utf8'));

test('v2 transport matches adapter schema and rejects action mixing before authority',()=>{
  assertSupportedSchema(REPO_WORKER_SCHEMA);
  assert.equal(parseWorkerResponse(wire('read',{paths:['registry.json']})).kind,'read');
  assert.equal(parseWorkerResponse(wire('uncertain',{missing:['policy']})).kind,'uncertain');
  for(const value of [wire('write',{content:'ok',paths:['registry.json']}),wire('read',{paths:['../secret']}),wire('write',{extra:true}),wire('uncertain'),wire('done')])assert.throws(()=>parseWorkerResponse(value));
});

test('v2 validates discovery without altering the v1 contract',()=>{
  assert.equal(parseRepoTask(manifest()).version,1);
  const d=parseRepoTask(task()).discovery!;assert.equal(d.maxReadCalls,2);
  for(const bad of [{...manifest(),discovery:{}},{...task(),discovery:{mode:'auto',readable:[]}},
    {...task(),discovery:{mode:'static',readable:['check.mjs']}},{...task(),discovery:{mode:'static',readable:['.env']}},
    {...task(),discovery:{mode:'static',readable:[],maxReadCalls:33}},
    {...task(),discovery:{mode:'static',readable:[],maxDeliveredBytes:-1}}])assert.throws(()=>parseRepoTask(bad));
});

test('two separate reads deliver only requested public contents, then fixed acceptance permits apply',async t=>{
  const root=await repository({'registry.json':'{"policy":"policy.json"}','policy.json':'{"value":42}','unrelated.json':'UNRELATED_SECRET'});t.after(()=>rm(root,{recursive:true,force:true}));
  const responses=[wire('read',{paths:['registry.json']}),wire('read',{paths:['policy.json']}),wire('write',{content:'export const value=42;\n'})];let calls=0;
  const r=await runRepository({...profile,repository:root,task:task(['registry.json','policy.json','unrelated.json']),outputDirectory:join(root,'run'),apply:true},async o=>{
    const local=files(o.prompt);assert.equal(local['check.mjs'],undefined);assert.equal(local['unrelated.json'],undefined);assert.doesNotMatch(o.prompt,/UNRELATED_SECRET/);
    assert.equal(local['registry.json']!==undefined,calls>=1);assert.equal(local['policy.json']!==undefined,calls>=2);
    return respond(responses[calls++]!)(o);
  });
  assert.equal(r.success,true,r.errors.join('\n'));assert.equal(r.applied,true);assert.equal(calls,3);assert.equal(r.budget.observedTokens,45);
  const reads=await json(join(root,'run'),'read-deliveries.json');assert.equal(reads.requests.length,2);
  assert.equal(reads.deliveries.some((d:{callId:string})=>d.callId==='call-1'),false);
  const claims=await json(join(root,'run'),'uncertainties.json');assert.ok(claims.claims.length>=2);assert.ok(claims.claims.every((c:{open:boolean;resolution:string})=>!c.open&&c.resolution));
  const state=await json(join(root,'run','swarm'),'kernel-state.json');assert.ok(state.leases.filter((l:{role:string})=>l.role==='worker').every((l:{scope:string[]})=>l.scope.length===1&&l.scope[0]==='a.mjs'));
  assert.equal(await readFile(join(root,'policy.json'),'utf8'),'{"value":42}');
});

test('static imports schedule providers first and keep other target instructions local',async t=>{
  const root=await repository({'a.mjs':"export {value} from './b.mjs';",'b.mjs':'export const value=0;','c.mjs':'export const value=0;'});t.after(()=>rm(root,{recursive:true,force:true}));
  const spec={...task(),files:[{path:'a.mjs',instructions:'A_ONLY_INSTRUCTION'},{path:'b.mjs',instructions:'B_ONLY_INSTRUCTION'},{path:'c.mjs',instructions:'C_ONLY_INSTRUCTION'}]};const seen:string[]=[];
  const r=await runRepository({...profile,repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{
    const id=target(o.prompt);seen.push(id);const local=files(o.prompt);
    for(const label of ['a','b','c'])if(`${label}.mjs`!==id)assert.doesNotMatch(o.prompt,new RegExp(`${label.toUpperCase()}_ONLY_INSTRUCTION`));
    if(id==='a.mjs'){assert.equal(local['b.mjs'],'export const value=42;');assert.equal(local['c.mjs'],undefined);}
    return respond(wire('write',{content:id==='a.mjs'?"export {value} from './b.mjs';":'export const value=42;'}))(o);
  });assert.equal(r.success,true,r.errors.join('\n'));assert.ok(seen.indexOf('b.mjs')<seen.indexOf('a.mjs'));
});

test('a new static import must wait for a metered delivery before its write can commit',async t=>{
  const root=await repository({'b.mjs':'export const value=42;'});t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const r=await runRepository({...profile,repository:root,task:task(['b.mjs']),outputDirectory:join(root,'run')},async o=>{
    assert.equal(files(o.prompt)['b.mjs']!==undefined,calls++>0);
    return respond(wire('write',{content:"export {value} from './b.mjs';"}))(o);
  });assert.equal(r.success,true,r.errors.join('\n'));assert.equal(calls,2);
  const state=await json(join(root,'run','swarm'),'kernel-state.json');assert.equal(state.candidates.some((c:{proposal:{id:string}})=>c.proposal.id==='call-1'),false);
});

for(const scenario of ['unpublished','read-limit','byte-limit','mixed','uncertain','unknown'] as const)test(`unresolved ${scenario} cannot pass or apply`,async t=>{
  const root=await repository({'policy.json':'{"value":42}'});t.after(()=>rm(root,{recursive:true,force:true}));const spec=task(['policy.json']);
  if(scenario==='read-limit')spec.discovery.maxReadCalls=0;
  if(scenario==='byte-limit')spec.discovery.maxDeliveredBytes=1;
  let calls=0;
  const r=await runRepository({...profile,repository:root,task:spec,outputDirectory:join(root,'run'),apply:true},async o=>{
    calls++;assert.equal(files(o.prompt)['check.mjs'],undefined);
    const response=scenario==='mixed'?wire('write',{content:'export const value=42;',paths:['policy.json']}):scenario==='uncertain'?wire('uncertain',{observed:['missing rules'],missing:['policy'],hypothesis:'unverified claim'}):wire('read',{paths:[scenario==='unpublished'?'check.mjs':'policy.json']});
    return respond(response,scenario==='unknown')(o);
  });assert.equal(r.success,false);assert.equal(r.applied,false);assert.equal(await readFile(join(root,'a.mjs'),'utf8'),'export const value = 0;\n');
  if(['unpublished','read-limit','byte-limit','unknown'].includes(scenario))assert.equal(calls,1);
  const reads=await json(join(root,'run'),'read-deliveries.json');assert.equal(reads.deliveries.length,0);
  if(scenario==='uncertain'){const u=await json(join(root,'run'),'uncertainties.json');assert.ok(u.claims.every((c:{source:string;open:boolean})=>c.source==='model-claim'&&c.open));}
});

test('static cycles and unresolvable imports fail preflight without provider calls',async t=>{
  for(const text of ["import './a.mjs';","import 'unavailable-package';"]){
    const root=await repository({'a.mjs':text});t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
    await assert.rejects(runRepository({...profile,repository:root,task:task(),outputDirectory:join(root,'run')},async o=>{calls++;return respond(wire('write'))(o);}));assert.equal(calls,0);
  }
});

test('delivered old versions register catch-up obligations and stale writes remain fenced',async t=>{
  const root=await repository({'policy.json':'old'});t.after(()=>rm(root,{recursive:true,force:true}));
  const snapshot=await captureRepository(root,parseRepoTask(task(['policy.json'])));const d=await RepositoryDiscovery.create(snapshot);
  const k=new SwarmKernel({artifacts:{...d.artifacts,'.sheep-internal/goal.md':'goal','.sheep-internal/guidance.md':'guide'}});
  const first=k.checkout('worker',d.contextIds(k,'a.mjs'));
  await d.propose(k,'a.mjs',first,'request',wire('read',{paths:['policy.json']}));
  assert.equal(k.exportState().dependencies.some(e=>e.provider==='policy.json'),false);
  const supplied=k.checkout('worker',d.contextIds(k,'a.mjs'));d.beforeCall('a.mjs',supplied);
  k.change('policy.json','new');d.delivered(k,'a.mjs',supplied,'delivery');
  assert.ok(k.pending().some(p=>p.consumer==='a.mjs'&&p.provider==='policy.json'));
  const lease=k.grant('worker',['a.mjs']);assert.throws(()=>k.prepare({id:'stale',agent:'worker',context:supplied.id,writes:{'a.mjs':'export const value=42;'},lease,obligations:[]}));
});

test('cumulative byte limit counts repeated additional contents and readable files require UTF-8',async t=>{
  const root=await repository({'policy.json':'abcd'});t.after(()=>rm(root,{recursive:true,force:true}));const spec=task(['policy.json']);spec.discovery.maxDeliveredBytes=7;
  const d=await RepositoryDiscovery.create(await captureRepository(root,parseRepoTask(spec)));
  const k=new SwarmKernel({artifacts:{...d.artifacts,'.sheep-internal/goal.md':'goal','.sheep-internal/guidance.md':'guide'}});
  const initial=k.checkout('worker',d.contextIds(k,'a.mjs'));await d.propose(k,'a.mjs',initial,'r',wire('read',{paths:['policy.json']}));
  const supplied=k.checkout('worker',d.contextIds(k,'a.mjs'));d.beforeCall('a.mjs',supplied);d.delivered(k,'a.mjs',supplied,'d1');assert.throws(()=>d.beforeCall('a.mjs',supplied),/read-byte-limit/);
  await writeFile(join(root,'policy.json'),Buffer.from([0xff]));await assert.rejects(captureRepository(root,parseRepoTask(spec)),/UTF-8/);
});

test('static-only control stops explicit semantic reads with a recorded unresolved request',async t=>{
  const root=await repository({'policy.json':'{"value":42}'});t.after(()=>rm(root,{recursive:true,force:true}));const spec=task(['policy.json']);spec.discovery.mode='static';let calls=0;
  const r=await runRepository({...profile,repository:root,task:spec,outputDirectory:join(root,'run')},async o=>{calls++;return respond(wire('read',{paths:['policy.json']}))(o);});
  assert.equal(calls,1);assert.equal(r.success,false);const reads=await json(join(root,'run'),'read-deliveries.json');assert.equal(reads.requests[0].reason,'additional-read-disabled');assert.equal(reads.deliveries.length,0);
});

test('delivered evidence epochs trigger catch-up even when provider bytes did not change',async t=>{
  const root=await repository({'policy.json':'same'});t.after(()=>rm(root,{recursive:true,force:true}));
  const d=await RepositoryDiscovery.create(await captureRepository(root,parseRepoTask(task(['policy.json']))));
  const k=new SwarmKernel({artifacts:{...d.artifacts,'.sheep-internal/goal.md':'goal','.sheep-internal/guidance.md':'guide'}});
  const first=k.checkout('w',d.contextIds(k,'a.mjs'));await d.propose(k,'a.mjs',first,'r',wire('read',{paths:['policy.json']}));
  const observed=k.checkout('w',d.contextIds(k,'a.mjs'));
  // A host correction updates evidence without changing its bytes.
  k.correct('policy.json','new host evidence, unchanged bytes');
  assert.equal(k.artifact('policy.json').content,'same');assert.ok(k.artifact('policy.json').evidenceEpoch>observed.reads['policy.json']!.evidenceEpoch);
  d.delivered(k,'a.mjs',observed,'stale');assert.ok(k.pending().some(p=>p.consumer==='a.mjs'&&p.provider==='policy.json'));
});

test('upper observes structured uncertainty selectively and cannot erase it before a worker validation',async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));let lower=0,upper=0;
  const r=await runRepository({...profile,maxMetaCalls:1,repository:root,task:task(),outputDirectory:join(root,'run')},async o=>{
    if(o.model==='gpt-6-astra'){
      upper++;assert.match(o.prompt,/model-claim/);assert.match(o.prompt,/UNVERIFIED_HYPOTHESIS/);assert.doesNotMatch(o.prompt,/import assert/);
      return respond(wire('write',{content:'Follow the immutable target instructions; uncertainty claims remain unverified.'}))(o);
    }
    lower++;return respond(lower<=2?wire('uncertain',{observed:['current value is zero'],missing:['shared clarification'],hypothesis:'UNVERIFIED_HYPOTHESIS'}):wire('write',{content:'export const value=42;'}))(o);
  });assert.equal(r.success,true,r.errors.join('\n'));assert.equal(upper,1);assert.equal(lower,3);
  const u=await json(join(root,'run'),'uncertainties.json');assert.ok(u.claims.every((c:{open:boolean;resolution:string})=>!c.open&&c.resolution));
});
