import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {STRATEGIES,sweepPlan,summarizeSweep,digest,type SweepCase,type SweepRow} from '../experiments/packet-sweep.ts';
// @ts-expect-error host-only orchestration; importing does not dispatch calls
import {runSeries,interruptedPacketAudit} from '../scripts/packet-sweep.mjs';
const cases:SweepCase[]=Array.from({length:8},(_,i)=>({id:'case-'+i,family:'test',split:'dev',targetCount:4,topology:'independent',dependencyDepth:0,
 conditions:STRATEGIES.map(method=>({method,signature:['packet-all','packet-8','packet-4'].includes(method)?'same':method,packetSize:method==='legacy-single'?null:method==='packet-all'?'all':Number(method.slice(7))}))}));
test('sweep deduplicates equivalent partitions and rotates actual method order without evaluation',()=>{
 const plan=sweepPlan(cases);assert.equal(plan.length,32);assert.deepEqual(plan,sweepPlan([...cases].reverse()));
 for(const c of cases){const rows=plan.filter(p=>p.id===c.id);assert.equal(rows.length,4);assert.deepEqual(rows.flatMap(p=>p.aliases).sort(),[...STRATEGIES].sort());}
 const positions=new Map<string,number[]>();for(let i=0;i<plan.length;i++){const method=plan[i]!.method;if(!positions.has(method))positions.set(method,[0,0,0,0]);positions.get(method)![i%4]!++;}
 for(const counts of positions.values())assert.deepEqual(counts,[2,2,2,2]);
 assert.throws(()=>sweepPlan([{...cases[0]!,split:'evaluation'}]));assert.throws(()=>sweepPlan([cases[0]!,cases[0]!]));
});
test('equivalent aliases are not wins and failed or invalid observations do not enter completion ratios',()=>{
 const row=(id:string,method:SweepRow['method'],aliases:SweepRow['aliases'],success:boolean,elapsedMs:number,evidenceErrors:string[]=[]):SweepRow=>({id,method,aliases,success,elapsedMs,evidenceErrors,tokens:evidenceErrors.length?null:100,calls:1});
 const rows=[row('case-0','packet-all',['packet-all','packet-8','packet-4'],true,10),row('case-0','packet-2',['packet-2'],true,20),row('case-0','legacy-single',['legacy-single'],true,5),
  row('case-1','packet-all',['packet-all','packet-8','packet-4'],true,10),row('case-1','packet-2',['packet-2'],false,8),
  row('case-2','packet-all',['packet-all'],true,10),row('case-2','packet-2',['packet-2'],false,4,['unknown usage'])];
 const s=summarizeSweep(cases,rows).overall;
 const pairs=s.pairs['packet-all']!;
 assert.equal(pairs['packet-8']!.equivalentCases,2);assert.equal(pairs['packet-8']!.completePairs,0);
 assert.equal(pairs['packet-2']!.completePairs,2);assert.equal(pairs['packet-2']!.bothSuccess,1);assert.equal(pairs['packet-2']!.referenceOnly,1);assert.equal(pairs['packet-2']!.medianReferenceOverMethod,0.5);
 assert.equal(s.methods['packet-2']!.cases,2);assert.throws(()=>summarizeSweep(cases,[...rows,rows[0]!]));
});
test('series refuses an evidence stop or uncertain in-flight run before model dispatch',async t=>{
 const root=await mkdtemp(join(tmpdir(),'packet-series-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const previous=process.env.OPENCODE_GO_API_KEY;process.env.OPENCODE_GO_API_KEY='not-a-real-key';t.after(()=>{if(previous===undefined)delete process.env.OPENCODE_GO_API_KEY;else process.env.OPENCODE_GO_API_KEY=previous;});
 const bytes=JSON.stringify({plan:[]});await writeFile(join(root,'profile.json'),bytes);
 for(const state of [{stopReason:'evidence-stop',inFlight:null},{stopReason:null,inFlight:{id:'uncertain'}}]){
  await writeFile(join(root,'series.json'),JSON.stringify({profileHash:digest(bytes),results:[],...state}));
  await assert.rejects(()=>runSeries(root),/cannot resume/);
 }
});


test('external interruption accounts receipt-complete calls beyond a stale checkpoint without scoring them',async t=>{
 const root=await mkdtemp(join(tmpdir(),'packet-interruption-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'budget.json'),JSON.stringify({calls:[{callId:'call-1'},{callId:'call-2'}],observedTokens:0,activeReservations:2}));
 await writeFile(join(root,'kernel.json'),'{}');
 for(const id of ['call-1','call-2'])await writeFile(join(root,id+'.request.json'),'{}');
 const tr={requestedModel:'deepseek-flash',effectiveModelEvidence:'deepseek-flash',thinking:'enabled',usageCompleteness:'complete',httpStatus:200,timedOut:false,cancelled:false,rawUsage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}};
 await writeFile(join(root,'call-1.json'),JSON.stringify({transcript:tr}));
 const partial=await interruptedPacketAudit(root);assert.equal(partial.calls,2);assert.equal(partial.knownTokens,30);assert.equal(partial.totalTokens,null);assert.deepEqual(partial.unknownCalls,['call-2']);assert.equal(partial.quality,null);
 await writeFile(join(root,'call-2.json'),JSON.stringify({transcript:tr}));
 const drained=await interruptedPacketAudit(root);assert.equal(drained.knownTokens,60);assert.equal(drained.totalTokens,60);assert.equal(drained.checkpointObservedTokens,0);assert.equal(drained.checkpointActiveReservations,2);assert.deepEqual(drained.evidenceErrors,[]);
 assert.ok(drained.hashes['call-2.json']);assert.equal(drained.completionMs,null);
 // A partial receipt still carries unknown usage, even with numerical fields.
 await writeFile(join(root,'call-2.json'),JSON.stringify({transcript:{...tr,usageCompleteness:'partial'}}));
 assert.equal((await interruptedPacketAudit(root)).totalTokens,null);
});
