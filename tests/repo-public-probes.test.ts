import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {parseProbeResponse,parseWorkerResponse} from '../src/worker-proposal.ts';
import {runRepository} from '../src/repo-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {RepositoryDiscovery,REPO_GOAL,REPO_GUIDANCE} from '../src/repo-discovery.ts';
import {SwarmKernel} from '../src/kernel.ts';
const bad='export function units(n){return n;}\n',good='export function units(n){return n*100;}\n';
const consumer="import {units} from './provider.mjs';export function total(n){return units(n);}\n";
const probe="import assert from 'node:assert/strict';import {units} from './provider.mjs';try{assert.equal(units(2),200,'PUBLIC_COUNTEREXAMPLE');}catch(error){if(!(error instanceof assert.AssertionError))throw error;console.log(JSON.stringify({probeId:'whole_units',status:'counterexample'}));console.error(error);process.exitCode=1;}\n";
const local="import assert from 'node:assert/strict';const {total}=await import('./consumer.mjs');assert.equal(total(2),200);\n";
const files={'provider.mjs':bad,'consumer.mjs':consumer,'probe.mjs':probe,'local.mjs':local,'hidden.mjs':local+"assert.equal(total(7),700,'HIDDEN_SENTINEL');"};
function task(){return {version:2,goal:'Convert whole units to cents through the provider.',files:[{path:'provider.mjs',instructions:'Export units(n)=n*100 for integer n.'},{path:'consumer.mjs',instructions:'Export total(n) delegating to units(n) from provider.mjs.',checks:[{argv:[process.execPath,'local.mjs']}]}],context:['local.mjs','probe.mjs'],protected:['hidden.mjs'],checks:[{argv:[process.execPath,'hidden.mjs']}],activation:{changedPaths:['consumer.mjs']},discovery:{mode:'static',readable:[],maxReadCalls:2,maxPathsPerRead:8,maxDeliveredBytes:262144},recovery:{maxUpstreamRechecks:1,publicProbes:{maxRequests:4,maxRechecks:1,catalog:[{id:'whole_units',provider:'provider.mjs',description:'A whole value 2 represents 200 cents.',paths:['provider.mjs','probe.mjs'],check:{argv:[process.execPath,'probe.mjs']}}]}}};}
const wire=(kind:string,content='',paths:string[]=[])=>({kind,content,paths,observed:[],missing:[],hypothesis:'',note:'Unverified claim'});

test('public probe manifest and opt-in transport reject hidden inputs, new executable payloads, mixed actions and invalid limits',()=>{
 assert.equal(parseRepoTask(task()).recovery?.publicProbes?.catalog.length,1);
 for(const patch of [{paths:['provider.mjs','hidden.mjs']},{paths:['provider.mjs','consumer.mjs']},{paths:['probe.mjs']},{provider:'hidden.mjs'},{id:'../hidden'},{extra:true}]){
  const f=task();Object.assign(f.recovery.publicProbes.catalog[0]!,patch);assert.throws(()=>parseRepoTask(f));
 }
 for(const key of ['maxRequests','maxRechecks'] as const)for(const value of [-1,65,1.5,null,NaN]){
  const f=task();Object.assign(f.recovery.publicProbes,{[key]:value});assert.throws(()=>parseRepoTask(f));
 }
 assert.deepEqual(parseProbeResponse(wire('diagnose','',['whole_units'])),{kind:'diagnose',id:'whole_units',note:'Unverified claim'});
 for(const v of [wire('diagnose','code',['whole_units']),wire('diagnose','',['whole_units','another']),wire('diagnose','',['../x']),{...wire('diagnose','',['whole_units']),expected:200}])assert.throws(()=>parseProbeResponse(v));
 assert.throws(()=>parseWorkerResponse(wire('diagnose','',['whole_units'])));
 const duplicate=task();duplicate.recovery.publicProbes.catalog.push(duplicate.recovery.publicProbes.catalog[0]!);assert.throws(()=>parseRepoTask(duplicate));
 const empty=task();empty.recovery.publicProbes.catalog=[];assert.throws(()=>parseRepoTask(empty));
 for(const field of ['catalog','maxRequests','maxRechecks']){const f=task();const p=f.recovery.publicProbes as unknown as Record<string,unknown>;delete p[field];assert.throws(()=>parseRepoTask(f));}

});

for(const scenario of ['repair','new-provider','healthy','verify-only','zero-requests','timeout','signal','drift','missing-command','unmarked-exit','wrong-marker','unknown-usage'] as const)test(`public probe end to end: ${scenario}`,async t=>{
 const f=task();if(scenario==='verify-only')f.recovery.publicProbes.maxRechecks=0;
 if(scenario==='zero-requests')f.recovery.publicProbes.maxRequests=0;
 const command=f.recovery.publicProbes.catalog[0]!.check;
 if(scenario==='timeout')Object.assign(command,{argv:[process.execPath,'-e','setTimeout(()=>{},10000)'],timeoutMs:20});
 if(scenario==='signal')command.argv=[process.execPath,'-e','process.kill(process.pid,"SIGTERM")'];
 if(scenario==='drift')command.argv=[process.execPath,'-e',"require('node:fs').writeFileSync('provider.mjs','changed');process.exit(1)"];
 if(scenario==='missing-command')command.argv=['no-such-public-probe-command'];
 if(scenario==='unmarked-exit')command.argv=[process.execPath,'-e','process.exit(1)'];
 if(scenario==='wrong-marker')command.argv=[process.execPath,'-e',`console.log(JSON.stringify({probeId:'different',status:'counterexample'}));process.exit(1)`];
 const initial:Record<string,string>={...files,...(scenario==='healthy'?{'provider.mjs':good}:{})};if(scenario==='new-provider')delete initial['provider.mjs'];
 const root=await repository(initial);t.after(()=>rm(root,{recursive:true,force:true}));
 let providers=0,consumers=0;const prompts:string[]=[];
 const result=await runRepository({repository:root,task:f,outputDirectory:join(root,'run'),runtime:'opencode-go',workerModel:'deepseek-flash',workers:4,concurrency:2,maxCalls:12,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100},async o=>{
  const isProvider=o.prompt.includes('Update only provider.mjs');prompts.push(o.prompt);
  let value;
  if(isProvider){providers++;value=wire('write',providers===1?bad:good);assert.ok(providers<3);}
  else {consumers++;value=scenario==='healthy'||consumers>=2?wire('diagnose','',['whole_units']):wire('write',consumer);
    if((scenario==='repair'||scenario==='new-provider')&&providers===2)value=wire('write',consumer);
    if(scenario==='healthy'&&consumers===2)value=wire('write',consumer);
  }
  const usage=scenario==='unknown-usage'&&value.kind==='diagnose'?[]:[{event:{},inputTokens:10,outputTokens:5}];
  return {requestedModel:o.model,result:value,usage,transcript:{events:[],usage,usageCompleteness:scenario==='unknown-usage'&&value.kind==='diagnose'?'partial-or-unknown':'complete',requestedModel:o.model,effectiveModelEvidence:'injected',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
 });
 const ledger=JSON.parse(await readFile(join(root,'run/swarm/public-probes.json'),'utf8'));
 assert.equal(result.success,scenario==='repair'||scenario==='new-provider'||scenario==='healthy',JSON.stringify({errors:result.errors,calls:result.swarm.calls.map(c=>({target:c.target,outcome:c.outcome,errors:c.errors}))}));assert.equal(result.budget.unknownUsageCalls,scenario==='unknown-usage'?1:0);assert.equal(result.swarm.upperCalls,0);
 for(const prompt of prompts){assert.ok(!prompt.includes('HIDDEN_SENTINEL'));assert.ok(!prompt.includes('hidden.mjs'));}
 if(scenario==='repair'||scenario==='new-provider'){
  assert.equal(providers,2);assert.equal(ledger.rechecks,1);assert.equal(result.discovery?.upstreamRechecks,1);
  const state=JSON.parse(await readFile(join(root,'run/swarm/kernel-state.json'),'utf8'));
  assert.equal(state.dependencies.some((d:{consumer:string;provider:string})=>d.consumer==='provider.mjs'&&d.provider==='consumer.mjs'),false);
  const writes=state.candidates.filter((c:{proposal:{id:string}})=>c.proposal.id.startsWith('probe-')).flatMap((c:{proposal:{writes:Record<string,string>}})=>Object.keys(c.proposal.writes));
  assert.ok(writes.length===1&&writes[0].startsWith('.sheep-internal/recovery/'));
  assert.equal(result.swarm.calls.filter(c=>c.target==='provider.mjs').length,2);
  assert.ok(prompts.some(p=>p.includes('verified-public-probe')&&p.includes('PUBLIC_COUNTEREXAMPLE')));
 }else if(scenario==='healthy'){assert.equal(providers,0);assert.equal(ledger.records[0].status,'probe-passed');}
 else if(scenario==='verify-only'){assert.equal(ledger.requests,1);assert.equal(ledger.rechecks,0);assert.equal(ledger.records[0].status,'verified-recheck-limit');assert.ok(ledger.records.some((r:{status:string})=>r.status==='duplicate-probe'));}
 else if(scenario==='zero-requests'){assert.equal(ledger.requests,0);assert.equal(ledger.records[0].status,'probe-request-limit');}
 else if(scenario==='unknown-usage'){assert.equal(ledger.requests,0);assert.equal(ledger.rechecks,0);assert.equal(consumers,2);}
 else {assert.equal(ledger.records[0].status,'probe-verification-unavailable');assert.equal(consumers,2);assert.equal(ledger.rechecks,0);}
 for(const record of ledger.records)if(record.verification){
  await assert.rejects(readFile(join(record.verification.workspace,'hidden.mjs')));
  await assert.rejects(readFile(join(record.verification.workspace,'consumer.mjs')));
 }
 if(scenario==='new-provider')await assert.rejects(readFile(join(root,'provider.mjs')));else assert.equal(await readFile(join(root,'provider.mjs'),'utf8'),scenario==='healthy'?good:bad);
});

for(const scenario of ['stale','unread','unrelated','dependency-outside','stale-during-verification'] as const)test(`probe observation gate: ${scenario}`,async t=>{
 const f=task();if(scenario==='unrelated'){f.files[1]!.path='unrelated.mjs';f.activation.changedPaths=['unrelated.mjs'];}
 const root=await repository({...files,...(scenario==='unrelated'?{'unrelated.mjs':'export const x=0;'}:{}),...(scenario==='dependency-outside'?{'provider.mjs':"import {x} from './extra.mjs';"+bad,'extra.mjs':'export const x=0;'}:{})});t.after(()=>rm(root,{recursive:true,force:true}));
 if(scenario==='dependency-outside')f.context.push('extra.mjs');
 let calls=0;let kernel:SwarmKernel;
 const d=await RepositoryDiscovery.create(await captureRepository(root,parseRepoTask(f)),async()=>{calls++;kernel.change('provider.mjs',good);return {ok:false,workspace:root,checks:[{argv:[process.execPath,'probe.mjs'],exitCode:1,signal:null,timedOut:false,stdout:JSON.stringify({probeId:'whole_units',status:'counterexample'}),stderr:'',durationMs:1}],errors:[`command exited with code 1: ${process.execPath} probe.mjs`]};});
 kernel=new SwarmKernel({artifacts:{...d.artifacts,[REPO_GOAL]:'goal',[REPO_GUIDANCE]:'guidance'}});for(const edge of d.dependencies())kernel.addDependency(edge.consumer,edge.provider);
 const target=scenario==='unrelated'?'unrelated.mjs':'consumer.mjs';
 // An unrelated worker has only itself delivered, even if another target is public.
 const ids=scenario==='unrelated'?[target]:d.contextIds(kernel,target).filter(p=>scenario!=='unread'||p!=='probe.mjs');
 const context=kernel.checkout('worker',ids);if(scenario==='stale')kernel.change('provider.mjs',good);
 const action=await d.propose(kernel,target,context,'call-1',wire('diagnose','',['whole_units']),['provider.mjs']);
 assert.ok('deferred' in action);assert.equal(calls,scenario==='stale-during-verification'?1:0);assert.equal(d.metrics([]).publicProbeRechecks,0);
 const out=join(root,'ledger');await mkdir(out);await d.save(out);const ledger=JSON.parse(await readFile(join(out,'public-probes.json'),'utf8'));
 assert.equal(ledger.records[0].status,scenario==='stale'||scenario==='stale-during-verification'?'stale-observation':scenario==='unread'?'undelivered-probe-input':scenario==='unrelated'?'not-upstream':'probe-dependency-outside-scope');
});
