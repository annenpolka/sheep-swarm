import {mkdir,writeFile,rename,realpath} from 'node:fs/promises';
import {dirname,basename,join,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SwarmKernel,KernelError,type Checkout} from './kernel.ts';
import {parseRepoTask} from './repo-manifest.ts';
import {captureRepository,applyRepository} from './repo-files.ts';
import {runRepoChecks} from './repo-checks.ts';
import {discoverRepoDependencies} from './repo-dependencies.ts';
import {TokenBudget} from './token-budget.ts';
import {unknownUsageForRun} from './model-runtime.ts';
import {callOpenCodeGo,type OpenCodeGoOptions} from './opencode-go-worker.ts';
import {CodexWorkerError,type CodexCallResult} from './codex-worker.ts';
import type {RepoRunOptions,RepoVerification} from './repo-types.ts';
import {planPackets} from './repo-packets.ts';
import {packetSchema,parsePacketResponse} from './repo-packet-response.ts';

export type PacketCaller=(options:OpenCodeGoOptions)=>Promise<CodexCallResult<unknown>>;
const BASELINE='.sheep-internal/packet-baseline';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save=async(path:string,value:unknown)=>{
 const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,path);
};
async function canonicalOutput(path:string):Promise<string> {
 const absolute=resolve(path),missing:string[]=[basename(absolute)];let parent=dirname(absolute);
 for(;;) {
  try{return join(await realpath(parent),...missing);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  missing.unshift(basename(parent));const next=dirname(parent);if(next===parent)throw new Error('no output ancestor');parent=next;
 }
}
function integer(value:number|undefined,fallback:number,name:string) {
 const n=value??fallback;if(!Number.isSafeInteger(n)||n<1)throw new Error(`invalid ${name}`);return n;
}
export function packetConfiguration(options:RepoRunOptions) {
 const task=parseRepoTask(options.task);
 if(options.workers!==undefined)throw new Error('packet worker count derives from the plan');
 if(options.packetSize===undefined)throw new Error('packetSize is required');
 if(options.packetSize!=='all'&&(!Number.isSafeInteger(options.packetSize)||options.packetSize<1))throw new Error('invalid packet size');
 if(options.runtime!=='opencode-go'||options.workerModel!=='deepseek-flash')throw new Error('packets require opencode-go/deepseek-flash');
 if(options.goThinking!==undefined&&options.goThinking!=='enabled')throw new Error('packets require thinking enabled');
 if((options.maxMetaCalls??0)!==0)throw new Error('packets do not support upper calls');
 if(task.activation||task.recovery||task.discovery?.mode==='static+reads')throw new Error('packets require all activation, static graph and no recovery policy');
 const concurrency=integer(options.concurrency,4,'concurrency');
 const config={packetSize:options.packetSize,concurrency,maxCalls:integer(options.maxCalls,128,'maxCalls'),
  maxRounds:integer(options.maxRounds,256,'maxRounds'),timeoutMs:integer(options.timeoutMs,600000,'timeoutMs'),
  maxTokens:integer(options.maxTokens,2000000,'maxTokens'),reserveTokensPerCall:integer(options.reserveTokensPerCall,200000,'reserveTokensPerCall'),
  maxTokensPerCall:integer(options.maxTokensPerCall,64000,'maxTokensPerCall')};
 if(config.reserveTokensPerCall>config.maxTokens)throw new Error('reservation exceeds total token budget');
 return {task,config};
}

/** Read-only planning uses exactly the same captured public graph as execution. */
export async function prepareRepositoryPackets(options:RepoRunOptions) {
 const {task,config}=packetConfiguration(options),snapshot=await captureRepository(options.repository,task);
 const targets=task.files.map(f=>f.path),publicPaths=[...new Set([...targets,...task.context,...(task.discovery?.readable??[])])].sort();
 const initial=Object.fromEntries(publicPaths.map(p=>[p,snapshot.initialTargets[p]??snapshot.entries.get(p)!.bytes.toString('utf8')]));
 const scan=task.version===2?await discoverRepoDependencies(initial,publicPaths,targets):{edges:[],issues:[]};
 if(scan.issues.length)throw new Error('packet graph contains unresolved static dependencies');
 const edges=[...task.files.flatMap(f=>f.dependsOn.map(provider=>({consumer:f.path,provider}))),...scan.edges];
 const graph=new Map(publicPaths.map(p=>[p,new Set<string>()]));
 for(const e of edges)graph.get(e.consumer)!.add(e.provider);
 const closure=(roots:readonly string[])=>{const seen=new Set(roots);for(const p of seen)for(const dep of graph.get(p)??[])seen.add(dep);return [...seen].sort();};
 const nodes=targets.map(path=>{
  const dependencies=new Set<string>(),queue=new Set(graph.get(path));
  for(const p of queue) {
   if(targets.includes(p)){if(p!==path)dependencies.add(p);}
   else for(const dep of graph.get(p)??[])queue.add(dep);
  }
  return {path,dependsOn:[...dependencies].sort()};
 });
 const partition=planPackets(nodes,config.packetSize);
 // The kernel records every delivered read for every written member. Grouping
 // a and b therefore couples their consumers even when a/b have no source edge.
 // Close over co-members before dispatch so transitive notifications always
 // have a current provider in the checkout. This adds reads, never authority.
 for(const packet of partition.packets)for(const consumer of packet.paths)for(const provider of packet.paths)
  if(consumer!==provider)graph.get(consumer)!.add(provider);
 const packets=partition.packets.map(p=>({...p,currentReadPaths:closure(p.paths).filter(path=>targets.includes(path))}));
 const plan={...partition,packets,publicPaths,contextPolicy:'immutable-public-baseline+upstream-packet-closure',
  initialPublicBytes:Object.values(initial).reduce((n,s)=>n+Buffer.byteLength(s),0),graphEdges:edges};
 if(task.discovery&&plan.initialPublicBytes>task.discovery.maxDeliveredBytes)throw new Error('packet public baseline exceeds maxDeliveredBytes');
 return {snapshot,initial,plan,config};
}

/** Shared executor for singleton, multi-target and all-target packets; no durable resume. */
export async function runPacketRepository(options:RepoRunOptions,caller:PacketCaller=callOpenCodeGo) {
 const started=performance.now();
 const {snapshot,initial,plan,config}=await prepareRepositoryPackets(options),task=snapshot.task;
 const output=await canonicalOutput(options.outputDirectory);
 for(const p of new Set([...snapshot.entries.keys(),...task.files.map(f=>f.path)])) {
  const absolute=join(snapshot.root,p);
  if(output===absolute||output.startsWith(absolute+sep)||absolute.startsWith(output+sep))throw new Error('output overlaps repository files');
 }
 await mkdir(dirname(output),{recursive:true});await mkdir(output);
 const baseline=JSON.stringify({goal:task.goal,instructions:task.files.map(f=>({path:f.path,instructions:f.instructions})),files:initial});
 const kernel=new SwarmKernel({artifacts:{...snapshot.initialTargets,[BASELINE]:baseline}});
 for(const p of plan.packets)for(const consumer of p.paths)for(const provider of p.currentReadPaths)if(consumer!==provider)kernel.addDependency(consumer,provider);
 kernel.closeInput();
 const budget=new TokenBudget(config),done=new Set<string>(),feedback=new Map<string,string>();
 const previousProposals=new Map<string,Record<string,string>>(),sessionPrefix=randomUUID();
 const attempts=new Map<string,number>();
 const calls:{id:string;packet:string;outcome:string;errors:string[];durationMs:number;promptBytes:number;readContext:string}[]=[];
 const verifications:RepoVerification[]=[];
 let termination='round-limit',infrastructureFailure=false,maxConcurrentModelCalls=0,active=0,qualityPass=false,applied=false;
 let stopped=false;
 const artifactContents=()=>Object.fromEntries(task.files.map(f=>[f.path,kernel.artifact(f.path).content]));
 const verify=async(contents:Readonly<Record<string,string>>,paths?:readonly string[])=>{
  const overlay=Object.fromEntries(task.files.map(f=>[f.path,contents[f.path]!]));
  const commands=paths?task.files.filter(f=>paths.includes(f.path)).flatMap(f=>f.checks):task.checks;
  const result=await runRepoChecks(snapshot,overlay,commands,join(output,'checks'));verifications.push(result);
  if(result.executionFailure){stopped=true;infrastructureFailure=true;termination='verification-infrastructure';}
  return result;
 };
 const fail=(reason:string)=>{stopped=true;infrastructureFailure=true;termination=reason;};
 await save(join(output,'profile.json'),{format:1,method:'packets',...config,model:'opencode-go/deepseek-flash',thinking:'enabled',upperCalls:0,taskDeadlineMs:null,plan,sourceHead:snapshot.head,sourceHash:hash(initial)});
 await save(join(output,'task.json'),task);await save(join(output,'budget.json'),budget.snapshot());
 const saveState=async()=>{await save(join(output,'kernel.json'),kernel.exportState());await save(join(output,'budget.json'),budget.snapshot());};
 type Packet=typeof plan.packets[number];
 type Pending={packet:Packet;context:Checkout;lease:ReturnType<SwarmKernel['grant']>;call:typeof calls[number];receipt?:CodexCallResult<unknown>;failure?:unknown};
 const pendingFor=(packet:Packet)=>kernel.pending().filter(o=>packet.paths.includes(o.consumer));
 // A post-commit no-op validates the current packet snapshot and discharges its
 // internal notification obligations, without purchasing an identical LLM call.
 const acknowledge=async(packet:Packet)=>{
  const obligations=pendingFor(packet);if(!obligations.length)return;
  const context=kernel.checkout(packet.id,[BASELINE,...packet.currentReadPaths]);
  const lease=kernel.grant(packet.id,packet.paths,Number.MAX_SAFE_INTEGER-Date.now());
  const candidate=kernel.prepare({id:randomUUID(),agent:packet.id,context:context.id,lease,writes:Object.fromEntries(packet.paths.map(p=>[p,context.contents[p]!])),obligations:obligations.map(o=>o.id)});
  const verdict=await kernel.validate(candidate.id,contents=>verify(contents,packet.paths));
  if(verdict.ok)kernel.commit(candidate.id);else done.delete(packet.id);
  kernel.revoke(lease.id);
 };
 try {
  for(let round=0;round<config.maxRounds&&!stopped;round++) {
   kernel.deliverAll();
   for(const packet of plan.packets)if(done.has(packet.id)&&pendingFor(packet).length)done.delete(packet.id);
   if(done.size===plan.packets.length){termination='ready-for-final';break;}
   const ready=plan.packets.filter(p=>!done.has(p.id)&&p.dependsOn.every(id=>done.has(id))).slice(0,config.concurrency);
   if(!ready.length){termination='blocked-packets';break;}
   const pending:Pending[]=[];
   // Reserve and persist the whole wave before dispatch. Settle all issued calls
   // before considering another wave, including failures and unknown usage.
   for(const packet of ready) {
    if(calls.length>=config.maxCalls){termination='call-limit';break;}
    const id=`call-${calls.length+1}`;
    if(!budget.reserve('deepseek-flash',id)){termination='token-budget';break;}
    const context=kernel.checkout(packet.id,[BASELINE,...packet.currentReadPaths]);
    const lease=kernel.grant(packet.id,packet.paths,Number.MAX_SAFE_INTEGER-Date.now());
    const call={id,packet:packet.id,outcome:'reserved',errors:[] as string[],durationMs:0,promptBytes:0,readContext:context.id};calls.push(call);
    pending.push({packet,context,lease,call});kernel.beginWork(id,packet.id);
   }
   await saveState();if(!pending.length)break;
   const settled=await Promise.allSettled(pending.map(async item=>{
    const {packet,context,call}=item;
    const prompt=[`Implement one work packet. Return exactly {files: {each assigned path: complete source string}, note: string}. No tools or upper consultation.`,
     `The following public baseline is immutable original task input, NOT current versions of other packets. Use the current dependency overlay below for evolving code.`,
     `Public baseline: ${context.contents[BASELINE]}`,`Assigned targets: ${JSON.stringify(packet.paths)}`,
     `Current packet/dependency files: ${JSON.stringify(Object.fromEntries(packet.currentReadPaths.map(p=>[p,context.contents[p]])))}`,
     `Previous rejected proposal: ${JSON.stringify(previousProposals.get(packet.id)??null)}`,
     `Previous public feedback: ${feedback.get(packet.id)??''}`].join('\n');
    call.promptBytes=Buffer.byteLength(prompt);attempts.set(packet.id,(attempts.get(packet.id)??0)+1);
    await save(join(output,`${call.id}.request.json`),{prompt,schema:packetSchema(packet.paths),reads:context.reads,packet:packet.id});
    const before=performance.now();active++;maxConcurrentModelCalls=Math.max(maxConcurrentModelCalls,active);
    try {item.receipt=await caller({model:'deepseek-flash',prompt,schema:packetSchema(packet.paths),cwd:snapshot.root,timeoutMs:config.timeoutMs,maxTokens:config.maxTokensPerCall,thinking:'enabled',sessionId:`packet-${sessionPrefix}-${packet.id}`,callId:call.id,outputDirectory:output});}
    catch(error){item.failure=error;}finally{active--;call.durationMs=performance.now()-before;}
    const error=item.failure instanceof CodexWorkerError?item.failure:undefined;
    const receipt=item.receipt??{requestedModel:'deepseek-flash',error:error?.code??'unknown',transcript:error?.transcript};
    const settlement=budget.settle(call.id,receipt);
    await save(join(output,`${call.id}.json`),receipt);
    if(unknownUsageForRun(item.receipt?.transcript??error?.transcript,'opencode-go',true,error?.code)||settlement.tokens===null||settlement.overrun)fail(settlement.overrun?'reservation-overrun':'unknown-usage');
    if(item.receipt&&(!item.receipt.transcript.effectiveModelEvidence||item.receipt.requestedModel!=='deepseek-flash'))fail('model-evidence');
    // Provider failures are not generated-code repair opportunities.
    if(error&&error.code!=='malformed-output')fail('transport-failure');
    return item;
   }));
   for(const result of settled)if(result.status==='rejected')fail('evidence-write-failure');
   for(const item of pending) {
    if(budget.snapshot().calls.find(c=>c.callId===item.call.id)?.status==='reserved')budget.settle(item.call.id,{requestedModel:'deepseek-flash',error:'unsettled-call'});
    kernel.endWork(item.call.id);
   }
   await saveState();
   for(const item of pending) {
    const {packet,context,lease,call}=item;
    if(stopped){call.outcome=termination;kernel.revoke(lease.id);continue;}
    let candidateId:string|undefined;
    try {
     if(item.failure!==undefined)throw new Error('invalid model response; return the required JSON schema');
     const writes=parsePacketResponse(item.receipt!.result,packet.paths);
     previousProposals.set(packet.id,writes);
     // The initial static graph is frozen for this experiment. Refuse changes
     // requiring new edges rather than silently running against an obsolete plan.
     if(task.version===2) {
      const scan=await discoverRepoDependencies({...initial,...artifactContents(),...writes},plan.publicPaths,task.files.map(f=>f.path));
      if(scan.issues.length||scan.edges.some(e=>!plan.graphEdges.some(old=>old.consumer===e.consumer&&old.provider===e.provider)))throw new Error('proposal changes frozen public dependency graph');
     }
     const candidate=kernel.prepare({id:call.id,agent:packet.id,context:context.id,lease,writes,obligations:pendingFor(packet).map(o=>o.id)});candidateId=candidate.id;
     const verdict=await kernel.validate(candidate.id,contents=>verify(contents,packet.paths));
     if(!verdict.ok) {
      const check=verifications.at(-1)!;
      throw new Error(JSON.stringify({errors:check.errors,checks:check.checks.filter(c=>c.exitCode!==0||c.timedOut||c.signal).map(c=>({argv:c.argv,stdout:c.stdout,stderr:c.stderr}))}).slice(0,8192));
     }
     kernel.commit(candidate.id);candidateId=undefined;call.outcome='committed';done.add(packet.id);feedback.delete(packet.id);previousProposals.delete(packet.id);
     kernel.deliverAll();await acknowledge(packet);
    } catch(error) {
     if(candidateId)kernel.discard(candidateId,'packet rejected');
     const message=error instanceof KernelError?error.code:String(error);
     call.errors.push(message);
     if(error instanceof KernelError) {
      // Host-owned scope, checkout and obligation errors cannot be repaired by
      // asking the model to rewrite the same source. Drain this wave and stop.
      fail('kernel-infrastructure');call.outcome=termination;
     } else {call.outcome='rejected';feedback.set(packet.id,message);}
    } finally {kernel.revoke(lease.id);}
   }
   await saveState();
  }
  kernel.deliverAll();
  if(!stopped&&done.size===plan.packets.length) {
   const final=await kernel.complete(contents=>verify(contents));qualityPass=final.ok;
   termination=qualityPass?'accepted':infrastructureFailure?'verification-infrastructure':'holdout-failed';
  }
 } catch {fail('runner-infrastructure');}
 const artifacts=artifactContents();
 let sourceUnchanged=false;
 try {
  const current=await captureRepository(snapshot.root,task);
  sourceUnchanged=current.head===snapshot.head&&current.entries.size===snapshot.entries.size&&[...snapshot.entries].every(([p,e])=>{const now=current.entries.get(p);return now?.mode===e.mode&&now.bytes.equals(e.bytes);});
 }catch {sourceUnchanged=false;}
 if(!sourceUnchanged)fail('source-drift');
 const successful=qualityPass&&!infrastructureFailure&&!budget.snapshot().locked;
 if(successful&&options.apply)try{await applyRepository(snapshot,artifacts);applied=true;}catch{fail('apply-failed');}
 const success=successful&&!infrastructureFailure;
 const elapsedMs=performance.now()-started;
 const report={format:1,method:'packets',success,qualityPass,applied,termination,infrastructureFailure,sourceUnchanged,elapsedMs,completionMs:success?elapsedMs:null,
  repository:snapshot.root,outputDirectory:output,plan,budget:budget.snapshot(),lowerCalls:calls.length,upperCalls:0,registeredWorkers:plan.packets.length,
  concurrency:config.concurrency,maxConcurrentModelCalls,calls,attempts:Object.fromEntries(attempts),verifications,completedPackets:[...done],
  changedPaths:task.files.map(f=>f.path).filter(p=>artifacts[p]!==snapshot.initialTargets[p])};
 await save(join(output,'artifacts.json'),artifacts);await saveState();await save(join(output,'result.json'),report);return report;
}
