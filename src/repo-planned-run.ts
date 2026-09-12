import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {captureRepository} from './repo-files.ts';
import {prepareRepositoryPackets,preparePacketOutput,runPacketRepository,type PacketCaller} from './repo-packet-run.ts';
import {workPlanSchema,compileWorkPlan,type WorkPlan} from './repo-work-plan.ts';
import {TokenBudget,type TokenBudgetSnapshot} from './token-budget.ts';
import {callOpenCodeGo} from './opencode-go-worker.ts';
import {CodexWorkerError,type CodexCallResult} from './codex-worker.ts';
import {unknownUsageForRun} from './model-runtime.ts';
import type {RepoRunOptions} from './repo-types.ts';
const save=async(p:string,x:unknown)=>{const t=p+'.'+randomUUID()+'.tmp';await writeFile(t,JSON.stringify(x,null,2)+'\n');await rename(t,p);};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function plannedBudget(planner:TokenBudgetSnapshot,workers?:TokenBudgetSnapshot):TokenBudgetSnapshot {
 if(!workers)return planner;
 const calls=[...planner.calls,...workers.calls],observedTokens=calls.reduce((n,c)=>n+c.knownTokensLower,0),unknownUsageCalls=calls.filter(c=>c.tokens===null&&c.status==='settled').length;
 const activeReservations=calls.filter(c=>c.status==='reserved').length,reservedTokens=calls.filter(c=>c.status==='reserved').reduce((n,c)=>n+c.reservedTokens,0),exceeded=observedTokens>planner.maxTokens;
 return {...planner,calls,observedTokens,unknownUsageCalls,activeReservations,reservedTokens,settledCalls:calls.length-activeReservations,exceeded,
  admissionDenied:planner.admissionDenied||workers.admissionDenied,reservationOverruns:calls.filter(c=>c.overrun).length,locked:unknownUsageCalls>0||exceeded};
}
/** One planner call followed by bounded workers. No hidden feedback returns to either. */
export async function runPlannedRepository(options:RepoRunOptions,caller:PacketCaller=callOpenCodeGo) {
 if(options.packetSize!==undefined||options.workPlan!==undefined)throw new Error('planner chooses packet scopes; packetSize/workPlan must not be supplied');
 const started=performance.now(),fixed={...options,packetSize:'all' as const};
 const {snapshot,initial,plan,config}=await prepareRepositoryPackets(fixed),task=snapshot.task;
 const output=await preparePacketOutput(snapshot,options.outputDirectory),plannerBudget=new TokenBudget(config);
 const targets=task.files.map(f=>f.path),schema=workPlanSchema(targets,plan.publicPaths);
 const prompt=[
  'Plan this repository repair. Return a WorkPlan only, not implementation code. You have one planning call.',
  'Choose semantic responsibilities, not a fixed file count. Prefer one packet when splitting adds no value. A single packet covering all targets is valid.',
  'Classify every target as writable in packets or untouched. Overlapping writes and dependency cycles will be merged by the host. Use dependsOn for provider packets. Include needed public inputs in relevantPaths.',
  'Untouched is a hypothesis: the final fixed oracle still checks the whole repository. Workers receive only their selected public input and dependency versions, so include the information needed to implement each objective and preserve invariants.',
  'Host task instructions, allowed paths and checks are authoritative. No tools, code execution, upper consultation or changes to acceptance criteria.',
  `Goal: ${task.goal}`,`Targets: ${JSON.stringify(task.files.map(f=>({path:f.path,instructions:f.instructions})))}`,
  `Public files: ${JSON.stringify(initial)}`,`Public dependency edges: ${JSON.stringify(plan.graphEdges)}`].join('\n');
 const id='planner-1';
 await save(join(output,'profile.json'),{format:1,method:'planned',model:'opencode-go/deepseek-flash',thinking:'enabled',upperCalls:0,taskDeadlineMs:null,...config,sourceHead:snapshot.head,sourceHash:hash(initial),publicPaths:plan.publicPaths});
 await save(join(output,'task.json'),task);await save(join(output,'artifacts.json'),snapshot.initialTargets);
 await save(join(output,id+'.request.json'),{prompt,schema,publicPaths:plan.publicPaths,publicInputHash:hash(initial)});
 plannerBudget.reserve('deepseek-flash',id);await save(join(output,'budget.json'),plannerBudget.snapshot());
 let receipt:CodexCallResult<unknown>|undefined,failure:unknown,workPlan:WorkPlan|undefined,compiled:ReturnType<typeof compileWorkPlan>|undefined;
 let termination='invalid-plan',infrastructureFailure=false,worker:Awaited<ReturnType<typeof runPacketRepository>>|undefined;
 const plannerStarted=performance.now();
 try{receipt=await caller({model:'deepseek-flash',prompt,schema,cwd:snapshot.root,timeoutMs:config.timeoutMs,maxTokens:config.maxTokensPerCall,thinking:'enabled',sessionId:'planner-'+randomUUID(),callId:id,outputDirectory:output});}catch(e){failure=e;}
 const plannerMs=performance.now()-plannerStarted,error=failure instanceof CodexWorkerError?failure:undefined;
 const metered=receipt??{requestedModel:'deepseek-flash',error:error?.code??'unknown',transcript:error?.transcript};
 const settlement=plannerBudget.settle(id,metered);await save(join(output,id+'.json'),metered);await save(join(output,'budget.json'),plannerBudget.snapshot());
 const errors:string[]=[];
 if(settlement.overrun){termination='reservation-overrun';infrastructureFailure=true;}
 else if(error&&error.code!=='malformed-output'){termination='transport-failure';infrastructureFailure=true;}
 else if(settlement.tokens===null||unknownUsageForRun(receipt?.transcript??error?.transcript,'opencode-go',true,error?.code)){termination='unknown-usage';infrastructureFailure=true;}
 else if(receipt&&(receipt.requestedModel!=='deepseek-flash'||receipt.transcript.effectiveModelEvidence!=='deepseek-flash')){termination='model-evidence';infrastructureFailure=true;}
 else if(receipt)try{compiled=compileWorkPlan(receipt.result,targets,plan.publicPaths,plan.graphEdges);workPlan=compiled.raw;}catch(e){errors.push(String(e));}
 if(workPlan) {
  await save(join(output,'work-plan.json'),workPlan);await save(join(output,'compiled-plan.json'),compiled);
  const current=await captureRepository(snapshot.root,task);
  const unchanged=current.head===snapshot.head&&current.entries.size===snapshot.entries.size&&[...snapshot.entries].every(([p,e])=>current.entries.get(p)?.mode===e.mode&&current.entries.get(p)!.bytes.equals(e.bytes));
  if(!unchanged){termination='source-drift';infrastructureFailure=true;}
  else if(config.maxCalls<=1||config.maxTokens-plannerBudget.snapshot().observedTokens<config.reserveTokensPerCall)termination='planner-exhausted-budget';
  else {
   worker=await runPacketRepository({...fixed,task,workPlan,outputDirectory:join(output,'workers'),maxCalls:config.maxCalls-1,maxTokens:config.maxTokens-plannerBudget.snapshot().observedTokens},caller);
   termination=worker.termination;infrastructureFailure=worker.infrastructureFailure;
   const {readFile}=await import('node:fs/promises');await writeFile(join(output,'artifacts.json'),await readFile(join(output,'workers','artifacts.json')));
  }
 }
 const elapsedMs=performance.now()-started,budget=plannedBudget(plannerBudget.snapshot(),worker?.budget),success=worker?.success===true&&!budget.locked;
 const report={format:1,method:'planned',success,qualityPass:worker?.qualityPass??false,applied:worker?.applied??false,termination,infrastructureFailure,errors,
  elapsedMs,completionMs:success?elapsedMs:null,plannerMs,plannerCalls:1,lowerCalls:budget.calls.length,upperCalls:0,budget,
  proposedPacketCount:compiled?.normalization.proposedPackets??null,executedPacketCount:worker?.plan.packets.length??null,
  plannedWritablePaths:workPlan?[...new Set(workPlan.packets.flatMap(p=>p.writablePaths))]:[],untouchedPaths:workPlan?.untouchedPaths??[],changedPaths:worker?.changedPaths??[],
  plannerChoseSingle:workPlan?.packets.length===1,normalizedToSingle:compiled?.packets.length===1,worker};
 await save(join(output,'budget.json'),budget);await save(join(output,'result.json'),report);return report;
}
