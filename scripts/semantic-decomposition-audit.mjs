import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {transientReceipt} from '../experiments/transport-retry.ts';
import {compileWorkPlan,workPlanSchema} from '../src/repo-work-plan.ts';
import {prepareRepositoryPackets} from '../src/repo-packet-run.ts';
import {packetReceiptAudit} from './packet-sweep.mjs';
import {receiptAudit} from './synthetic-paired-benchmark.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const line=(request,prefix)=>{const s=request.prompt.split('\n').find(s=>s.startsWith(prefix));assert.ok(s,'missing '+prefix);return JSON.parse(s.slice(prefix.length));};
export async function semanticReceiptAudit(directory,method,run,options,independent) {
 const problems=[],task=options.task;let transient=0,inputTokens=0,outputTokens=0;
 assert.ok(run.budget.calls.length>0);assert.equal(run.budget.activeReservations,0);
 for(const call of run.budget.calls) {
  assert.equal(call.status,'settled');const dir=method==='planned'&&call.callId!=='planner-1'?join(directory,'workers'):directory;
  const r=await load(join(dir,call.callId+'.json')),t=r.transcript,u=extractTokenUsage(r),lower=(u.inputTokens??0)+(u.outputTokens??0);
  assert.equal(call.knownTokensLower,lower);inputTokens+=u.inputTokens??0;outputTokens+=u.outputTokens??0;
  if(call.tokens!==null){assert.equal(call.tokens,lower);assert.equal(u.partial,false);}
  if(transientReceipt(r)){transient++;continue;}
  if(call.tokens===null||r.requestedModel!=='deepseek-flash'||t?.requestedModel!=='deepseek-flash'||t?.effectiveModelEvidence!=='deepseek-flash'||t?.thinking!=='enabled'||t?.httpStatus!==200||t?.timedOut||t?.cancelled||t?.usageCompleteness!=='complete')problems.push(call.callId+': invalid model/usage evidence');
  if(r.error&&r.error!=='malformed-output')problems.push(call.callId+': non-transient error');
 }
 assert.equal(inputTokens+outputTokens,run.budget.observedTokens);
 if(run.budget.reservationOverruns)problems.push('reservation-overrun');
 const prepared=await prepareRepositoryPackets({...options,packetSize:'all'});
 if(method==='planned') {
  const request=await load(join(directory,'planner-1.request.json')),receipt=await load(join(directory,'planner-1.json'));
  assert.deepEqual(line(request,'Public files: '),prepared.initial);
  assert.deepEqual(line(request,'Targets: '),task.files.map(f=>({path:f.path,instructions:f.instructions})));
  assert.deepEqual(line(request,'Public dependency edges: '),prepared.plan.graphEdges);
  assert.deepEqual(request.schema,workPlanSchema(task.files.map(f=>f.path),prepared.plan.publicPaths));
  assert.equal(run.plannerCalls,1);assert.equal(run.lowerCalls,run.budget.calls.length);
  if(run.proposedPacketCount!==null) {
   const compiled=compileWorkPlan(receipt.result,task.files.map(f=>f.path),prepared.plan.publicPaths,prepared.plan.graphEdges);
   assert.deepEqual(await load(join(directory,'work-plan.json')),compiled.raw);assert.deepEqual(await load(join(directory,'compiled-plan.json')),compiled);
   assert.equal(run.proposedPacketCount,compiled.raw.packets.length);
   if(run.worker) {
    const wd=join(directory,'workers'),worker=await load(join(wd,'result.json'));assert.deepEqual(worker,run.worker);
    assert.equal(worker.budget.maxTokens,run.budget.maxTokens-run.budget.calls[0].knownTokensLower);
    assert.deepEqual(run.budget.calls.slice(1),worker.budget.calls);
    const expected=(await prepareRepositoryPackets({...options,packetSize:'all',workPlan:compiled.raw})).plan;
    assert.deepEqual(worker.plan,expected);assert.equal(run.executedPacketCount,expected.packets.length);
    const kernel=await load(join(wd,'kernel.json'));
    for(const call of worker.calls) {
     const p=expected.packets.find(p=>p.id===call.packet),ctx=kernel.contexts.find(c=>c.id===call.readContext),req=await load(join(wd,call.id+'.request.json'));
     assert.ok(p&&ctx);const id='.sheep-internal/packet-baseline/'+p.id;
     assert.deepEqual(req.reads,ctx.reads);assert.deepEqual(Object.keys(req.reads).sort(),[id,...p.currentReadPaths].sort());
     assert.deepEqual(line(req,'Assigned targets: '),p.paths);
     const baseline=line(req,'Public baseline: ');
     assert.equal(JSON.stringify(baseline),ctx.contents[id]);
     assert.deepEqual(baseline,{goal:task.goal,instructions:task.files.filter(f=>p.paths.includes(f.path)).map(f=>({path:f.path,instructions:f.instructions})),files:Object.fromEntries(p.contextPaths.map(path=>[path,prepared.initial[path]])),objective:p.work.objective,invariants:p.work.invariants});
     assert.deepEqual(line(req,'Current packet/dependency files: '),Object.fromEntries(p.currentReadPaths.map(path=>[path,ctx.contents[path]])));
    }
    assert.deepEqual(await load(join(directory,'artifacts.json')),Object.fromEntries(task.files.map(f=>[f.path,kernel.artifacts[f.path].content])));
   }else assert.deepEqual(await load(join(directory,'artifacts.json')),{...prepared.snapshot.initialTargets});
  }else {assert.equal(run.worker,undefined);assert.deepEqual(await load(join(directory,'artifacts.json')),{...prepared.snapshot.initialTargets});}
 }else if(!transient&&!problems.length) {
  if(method==='single')await receiptAudit(directory,'single',run,task);else await packetReceiptAudit(directory,run,task,prepared.plan);
 }
 const checks=[...(run.worker?.verifications??run.verifications??[]),independent];
 if(checks.some(c=>c.executionFailure||c.checks.some(x=>x.timedOut||x.signal!==null)))problems.push('verification infrastructure');
 const transportRetryable=transient>0&&!problems.length&&['transport-failure','unknown-usage'].includes(run.termination);
 if(run.infrastructureFailure&&!transportRetryable)problems.push('non-transient infrastructure');
 return {transportRetryable,evidenceErrors:problems.concat(transient?['transient transport failure']:[]),inputTokens,outputTokens};
}
