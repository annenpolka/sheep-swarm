import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SwarmKernel,KernelError,type Checkout} from './kernel.ts';
import {TokenBudget} from './token-budget.ts';
import {CodexWorkerError} from './codex-worker.ts';
import {callOpenCodeGoTurn,type OpenCodeGoTurnOptions,type OpenCodeGoResult} from './opencode-go-worker.ts';
import {validateGoConversation,type GoAssistant,type GoMessage,type GoTool} from './opencode-go-conversation.ts';
import {prepareRepositoryPackets,preparePacketOutput} from './repo-packet-run.ts';
import {captureRepository,applyRepository} from './repo-files.ts';
import {runRepoChecks} from './repo-checks.ts';
import type {RepoRunOptions,RepoVerification} from './repo-types.ts';

export type LazyCaller=(options:OpenCodeGoTurnOptions)=>Promise<OpenCodeGoResult<GoAssistant>>;
export interface LazyOptions extends RepoRunOptions {readonly lazyChildren?:number}
const save=async(path:string,value:unknown)=>{const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n');await rename(tmp,path);};
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text={type:'string'},texts={type:'array',items:text};
export const lazyTools:readonly GoTool[]=[
 {type:'function',function:{name:'fork',description:'Delegate one independent implementation while you continue concrete remaining work. No recursive children. Optionally checkpoint your own files before spawning.',parameters:{type:'object',additionalProperties:false,required:['paths','relevantPaths','objective','invariants','parentWork','checkpoint'],properties:{paths:{...texts,description:'Nonempty child WRITE paths, a strict subset of current writablePaths. Keep at least one implementation path for yourself.'},relevantPaths:{...texts,description:'Additional current READ paths needed by the child, not write permission.'},objective:text,invariants:texts,parentWork:{...text,description:'The concrete implementation you will do while this child works.'},checkpoint:{type:'object',additionalProperties:true,description:'Parent source edits to commit BEFORE spawning; path to full source. Must exclude child paths. Use {} if none.'}}}}},
 {type:'function',function:{name:'join',description:'Wait for the specified child jobs when their results are needed. Host checks candidates and returns current files and public feedback.',parameters:{type:'object',additionalProperties:false,required:['jobs'],properties:{jobs:{...texts,description:'Nonempty list of actual job IDs returned by successful fork (for example child-1), never file paths. If no job exists, submit your files directly.'}}}}},
];
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
 if(!obj(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error(`expected exactly ${keys.join(',')}`);
}
function paths(value:unknown,allowed:readonly string[],empty=false):string[]{
 if(!Array.isArray(value)||(!empty&&!value.length)||value.some(p=>typeof p!=='string'||!allowed.includes(p))||new Set(value).size!==value.length)throw new Error('invalid or unauthorized paths/IDs');
 return value;
}
function patch(value:unknown,allowed:readonly string[]):Record<string,string>{
 if(!obj(value))throw new Error('files must be an object');
 const result:Record<string,string>=Object.create(null);
 for(const [path,content]of Object.entries(value)){
  if(!allowed.includes(path)||typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)throw new Error('invalid or unauthorized file write');
  result[path]=content;
 }
 return result;
}
function submission(content:string|null,allowed:readonly string[]){
 const value:unknown=JSON.parse(content??'');exact(value,['files','note']);
 if(typeof value.note!=='string')throw new Error('note must be a string');
 return patch(value.files,allowed);
}

export async function prepareLazyRepository(options:LazyOptions){
 if(options.packetSize!==undefined||options.planWork||options.workPlan!==undefined)throw new Error('lazy mode cannot use packet/planner options');
 const limit=options.lazyChildren??2;
 if(!Number.isSafeInteger(limit)||limit<0||limit>2)throw new Error('lazyChildren must be 0, 1 or 2');
 validateGoConversation({messages:[{role:'user',content:'preflight'}],tools:limit?lazyTools:[]});
 const prepared=await prepareRepositoryPackets({...options,packetSize:'all'});
 return {...prepared,childLimit:limit};
}

/** Parent continuation and bounded fork/join. Model completions never mutate the shared repository. */
export async function runLazyRepository(options:LazyOptions,caller:LazyCaller=callOpenCodeGoTurn){
 const started=performance.now(),{snapshot,initial,plan,config,childLimit}=await prepareLazyRepository(options);
 const output=await preparePacketOutput(snapshot,options.outputDirectory),task=snapshot.task;
 const targets=task.files.map(f=>f.path),kernel=new SwarmKernel({artifacts:initial}),budget=new TokenBudget(config);
 kernel.closeInput();
 const session=randomUUID(),tools=childLimit?lazyTools:[];
 const messages:GoMessage[]=[{role:'system',content:[
  'You are the implementer. Repair the task directly. Return JSON {files:{path:complete source},note:string} when done; files may contain only changed writable paths.',
  'Use at most one tool call per turn. If no delegation is needed, submit files directly without calling fork or join. Do not use markdown fences. No completion-only call is needed. The host checks candidates. Public feedback is evidence; your own claims are not verified facts.',
  childLimit?'Delegate only independent implementation whose assumptions are fixed and while you have specific work to continue. Prefer direct submission for a small task. At most two children in the entire run; never delegate merely to fill slots. A fork checkpoint commits your current files before the child snapshot. While a job is unresolved its paths are not writable by you. Join only when you need its result; your final submission also joins remaining jobs.':'Implement the task yourself. Child creation is disabled.',
  'Original public baseline is historical reference. Use the host current files for current versions. Only declared target paths may change.',
 ].join('\n')},{role:'user',content:JSON.stringify({goal:task.goal,instructions:task.files.map(f=>({path:f.path,instructions:f.instructions})),originalPublicBaseline:initial})}];
 const calls:{id:string;agent:string;startedMs:number;endedMs:number|null;outcome:string}[]=[],events:{type:string;atMs:number;[key:string]:unknown}[]=[];
 const verifications:RepoVerification[]=[];
 let fatal:string|null=null,active=0,modelActive=0,maxConcurrentModelCalls=0,termination='round-limit',qualityPass=false,applied=false;
 const waiters:(()=>void)[]=[];
 const now=()=>performance.now()-started;
 const event=(type:string,data:Record<string,unknown>={})=>events.push({type,atMs:now(),...data});
 const current=()=>Object.fromEntries(targets.map(p=>[p,kernel.artifact(p).content]));
 const halt=(reason:string)=>{fatal??=reason;};
 const acquire=async()=>{if(active>=config.concurrency)await new Promise<void>(resolve=>waiters.push(resolve));else active++;};
 const release=()=>{const next=waiters.shift();if(next)next();else active--;};
 const invoke=async(agent:string,history:readonly GoMessage[],available:readonly GoTool[]):Promise<GoAssistant>=>{
  try{validateGoConversation({messages:history,tools:available});}catch{halt('invalid-conversation');throw new Error('invalid conversation before dispatch');}
  await acquire();
  let id:string|undefined;
  try{
   if(fatal)throw new Error(fatal);
   if(calls.length>=config.maxCalls)throw new Error('call-limit');
   id=`call-${calls.length+1}`;
   if(!budget.reserve('deepseek-flash',id))throw new Error('token-budget');
   const row={id,agent,startedMs:now(),endedMs:null as number|null,outcome:'reserved'};calls.push(row);
   await save(join(output,`${id}.request.json`),{messages:history,tools:available,model:'deepseek-flash',thinking:'enabled',sessionId:`${session}-${agent}`,maxTokens:config.maxTokensPerCall,timeoutMs:config.timeoutMs,budget:budget.snapshot()});
   kernel.beginWork(id,agent);row.startedMs=now();event('model-start',{id,agent});modelActive++;maxConcurrentModelCalls=Math.max(maxConcurrentModelCalls,modelActive);
   let receipt:OpenCodeGoResult<GoAssistant>|undefined,error:unknown;
   try{receipt=await caller({messages:history,tools:available,model:'deepseek-flash',thinking:'enabled',sessionId:`${session}-${agent}`,maxTokens:config.maxTokensPerCall,timeoutMs:config.timeoutMs,cwd:snapshot.root,callId:id,outputDirectory:output});}
   catch(e){error=e;}
   finally{modelActive--;kernel.endWork(id);row.endedMs=now();event('model-end',{id,agent});}
   const failure=error instanceof CodexWorkerError?error:undefined;
   const evidence=receipt??{requestedModel:'deepseek-flash',error:failure?.code??'unknown',transcript:failure?.transcript};
   const settlement=budget.settle(id,evidence);
   try{await save(join(output,`${id}.json`),evidence);}catch{halt('evidence-failure');throw new Error('receipt persistence failed');}
   if(settlement.tokens===null||settlement.overrun)halt(settlement.overrun?'reservation-overrun':'unknown-usage');
   if(receipt&&(receipt.requestedModel!=='deepseek-flash'||receipt.transcript.effectiveModelEvidence!=='deepseek-flash'||receipt.transcript.usageCompleteness!=='complete'))halt('model-or-usage-evidence');
   if(error){row.outcome='failed';if(!failure||failure.code!=='malformed-output')halt('transport-failure');throw new Error(failure?.code??'caller-failed');}
   row.outcome='returned';if(fatal)throw new Error(fatal);return receipt!.result;
  }catch(e){
   if(id&&budget.snapshot().calls.find(c=>c.callId===id)?.status==='reserved'){
    budget.settle(id,{requestedModel:'deepseek-flash',error:'dispatch-or-evidence-failure'});halt('evidence-failure');
   }
   throw e;
  }finally{release();}
 };
 type Job={id:string;scope:string[];context:Checkout;lease:ReturnType<SwarmKernel['grant']>;promise:Promise<void>;writes?:Record<string,string>;error?:string;joined:boolean;status:string};
 const jobs:Job[]=[];
 const writable=()=>targets.filter(p=>!jobs.some(j=>!j.joined&&j.scope.includes(p)));
 const checkout=(agent:string,reads:readonly string[])=>kernel.checkout(agent,reads);
 let rootContext=checkout('root',plan.publicPaths);
 const hostState=()=>{rootContext=checkout('root',plan.publicPaths);return {currentFiles:rootContext.contents,readStamps:rootContext.reads,writablePaths:writable(),jobs:jobs.map(j=>({id:j.id,scope:j.scope,status:j.status,joined:j.joined}))};};
 const verify=async(contents:Readonly<Record<string,string>>,scope?:readonly string[])=>{
  const commands=scope?task.files.filter(f=>scope.includes(f.path)).flatMap(f=>f.checks):task.checks;
  const result=await runRepoChecks(snapshot,Object.fromEntries(targets.map(p=>[p,contents[p]!])),commands,join(output,'checks'));
  verifications.push(result);if(result.executionFailure)halt('verification-infrastructure');return result;
 };
 const feedback=(result:RepoVerification)=>JSON.stringify({errors:result.errors,checks:result.checks.filter(c=>c.exitCode!==0||c.signal||c.timedOut).map(c=>({argv:c.argv,stdout:c.stdout,stderr:c.stderr}))}).slice(0,8192);
 const commit=async(agent:string,context:Checkout,writes:Record<string,string>,lease?:ReturnType<SwarmKernel['grant']>)=>{
  if(!Object.keys(writes).length)return;
  const authority=lease??kernel.grant(agent,Object.keys(writes),Number.MAX_SAFE_INTEGER-Date.now());
  let candidate:string|undefined;
  try{
   const prepared=kernel.prepare({id:randomUUID(),agent,context:context.id,lease:authority,writes});candidate=prepared.id;
   const verdict=await kernel.validate(candidate,contents=>verify(contents,Object.keys(writes)));
   if(!verdict.ok)throw new Error(feedback(verifications.at(-1)!));
   if(fatal)throw new Error(fatal);
   kernel.commit(candidate);candidate=undefined;kernel.deliverAll();event('commit',{agent,paths:Object.keys(writes)});
  }finally{if(candidate)kernel.discard(candidate,'lazy candidate rejected');if(!lease)kernel.revoke(authority.id);}
 };
 const joinJobs=async(ids:string[])=>{
  const result:unknown[]=[];const before=now();event('join-start',{jobs:ids});
  for(const id of ids){
   const job=jobs.find(j=>j.id===id)!;if(job.joined){result.push({id,status:job.status});continue;}
   const waitStart=now();await job.promise;event('join-wait',{id,elapsedMs:now()-waitStart});
   try{
    if(fatal)throw new Error(fatal);
    if(job.error||!job.writes)throw new Error(job.error??'missing child candidate');
    // Check every delivered current read even for an empty/no-op child patch.
    for(const [path,stamp]of Object.entries(job.context.reads)){
     const state=kernel.artifact(path);if(state.version!==stamp.version||state.evidenceEpoch!==stamp.evidenceEpoch)throw new KernelError('stale-read');
    }
    await commit(id,job.context,job.writes,job.lease);job.status='accepted';result.push({id,status:job.status,files:job.writes});
   }catch(e){job.status='returned-to-parent';result.push({id,status:job.status,publicFeedback:e instanceof KernelError?e.code:String(e),candidate:job.writes??null});event('child-discard',{id,reason:e instanceof KernelError?e.code:String(e)});}
   finally{job.joined=true;kernel.revoke(job.lease.id);}
  }
  event('join-end',{jobs:ids,elapsedMs:now()-before});return result;
 };
 const fork=async(value:unknown)=>{
  exact(value,['paths','relevantPaths','objective','invariants','parentWork','checkpoint']);
  if(jobs.length>=childLimit)throw new Error('run child limit reached');
  const scope=paths(value.paths,writable());
  if(scope.length===writable().length)throw new Error('fork must leave implementation work for the parent');
  const relevant=paths(value.relevantPaths,plan.publicPaths,true);
  if(typeof value.objective!=='string'||!value.objective.trim()||typeof value.parentWork!=='string'||!value.parentWork.trim()||!Array.isArray(value.invariants)||value.invariants.some(v=>typeof v!=='string'))throw new Error('fork requires objective, fixed invariants and concrete parent work');
  const checkpoint=patch(value.checkpoint,writable().filter(p=>!scope.includes(p)));
  await commit('root',rootContext,checkpoint);
  const reads=new Set([...scope,...relevant]);for(const p of reads)for(const edge of plan.graphEdges)if(edge.consumer===p)reads.add(edge.provider);
  const id=`child-${jobs.length+1}`,context=checkout(id,[...reads]),lease=kernel.grant(id,scope,Number.MAX_SAFE_INTEGER-Date.now());
  const job:Job={id,scope,context,lease,joined:false,status:'running',promise:Promise.resolve()};jobs.push(job);event('fork',{id,paths:scope,parentWork:value.parentWork});
  const childMessages:GoMessage[]=[{role:'system',content:'Implement the assigned scoped task. No tools, no child delegation. Return JSON {files:{path:complete source},note:string}. Include only changed writable paths. The host validates your candidate; do not claim your note is a passed check.'},{role:'user',content:JSON.stringify({goal:task.goal,objective:value.objective,invariants:value.invariants,assumptionSource:'unverified parent instructions',instructions:task.files.filter(f=>scope.includes(f.path)).map(f=>({path:f.path,instructions:f.instructions})),writablePaths:scope,currentFiles:context.contents,readStamps:context.reads})}];
  job.promise=(async()=>{try{const answer=await invoke(id,childMessages,[]);job.writes=submission(answer.content,scope);job.status='candidate';}catch(e){job.error=String(e);job.status='failed';}})();
  return {jobId:id,status:'started',...hostState()};
 };
 await save(join(output,'profile.json'),{format:1,method:'lazy',...config,childLimit,model:'opencode-go/deepseek-flash',thinking:'enabled',upperCalls:0,taskDeadlineMs:null,sourceHead:snapshot.head});
 await save(join(output,'task.json'),task);
 messages.push({role:'user',content:JSON.stringify(hostState())});
 try{
  for(let round=0;round<config.maxRounds&&!fatal;round++){
   let answer:GoAssistant;
   try{answer=await invoke('root',messages,tools);}catch(e){termination=String(e);if(fatal||calls.length>=config.maxCalls||!budget.canReserve('deepseek-flash'))break;messages.push({role:'user',content:'Previous response was invalid. Return the requested JSON or a valid tool call.'});continue;}
   messages.push(answer);
   if(answer.tool_calls?.length){
    if(answer.tool_calls.length>1){
     for(const call of answer.tool_calls)messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify({error:'Use one tool per turn; this batch performed no operations.'})});
     continue;
    }
    for(const call of answer.tool_calls){
     let response:unknown;
     try{
      if(fatal)throw new Error(fatal);
      const value:unknown=JSON.parse(call.function.arguments);
      if(call.function.name==='fork')response=await fork(value);
      else if(call.function.name==='join'){exact(value,['jobs']);const ids=paths(value.jobs,jobs.map(j=>j.id));response={results:await joinJobs(ids),...hostState()};}
      else throw new Error('unsupported tool');
     }catch(e){response={error:e instanceof KernelError?e.code:String(e),...hostState()};}
     messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(response)});
    }
    continue;
   }
   try{
    await commit('root',rootContext,submission(answer.content,writable()));
    const joined=await joinJobs(jobs.filter(j=>!j.joined).map(j=>j.id));
    if(fatal)break;
    if(joined.some(r=>(r as {status:string}).status==='returned-to-parent')){
     messages.push({role:'user',content:JSON.stringify({results:joined,...hostState(),instruction:'Take over rejected child tasks and submit the complete repair.'})});continue;
    }
    // Public integrated validation also discharges notifications with current evidence.
    const context=checkout('root',plan.publicPaths),lease=kernel.grant('root',targets,Number.MAX_SAFE_INTEGER-Date.now());
    let candidate:string|undefined;
    try{
     const proposal=kernel.prepare({id:randomUUID(),agent:'root',context:context.id,lease,writes:{},obligations:kernel.pending().map(o=>o.id)});candidate=proposal.id;
     const verdict=await kernel.validate(candidate,contents=>verify(contents,targets));
     if(!verdict.ok)throw new Error(feedback(verifications.at(-1)!));
     if(fatal)break;
     kernel.commit(candidate);candidate=undefined;kernel.deliverAll();
    }finally{if(candidate)kernel.discard(candidate,'integration rejected');kernel.revoke(lease.id);}
    if(jobs.some(j=>!j.joined))throw new Error('unresolved children');
    const final=await kernel.complete(contents=>verify(contents));qualityPass=final.ok;termination=qualityPass?'accepted':'holdout-failed';break;
   }catch(e){
    if(fatal)break;
    messages.push({role:'user',content:JSON.stringify({publicFeedback:e instanceof KernelError?e.code:String(e),...hostState()})});
   }
  }
 }catch{halt('runner-infrastructure');}
 await Promise.all(jobs.map(j=>j.promise));
 for(const j of jobs)if(!j.joined)kernel.revoke(j.lease.id);
 let sourceUnchanged=false;
 try{const latest=await captureRepository(snapshot.root,task);sourceUnchanged=latest.head===snapshot.head&&latest.entries.size===snapshot.entries.size&&[...snapshot.entries].every(([p,e])=>{const v=latest.entries.get(p);return v?.mode===e.mode&&v.bytes.equals(e.bytes);});}catch{}
 if(!sourceUnchanged)halt('source-drift');
 const artifacts=current();
 let success=qualityPass&&!fatal&&!budget.snapshot().locked&&!budget.snapshot().activeReservations&&jobs.every(j=>j.joined);
 if(success&&options.apply)try{await applyRepository(snapshot,artifacts);applied=true;}catch{halt('apply-failed');success=false;}
 const elapsedMs=now();
 const timeline=calls.filter(c=>c.endedMs!==null).flatMap(c=>[{at:c.startedMs,agent:c.agent,delta:1},{at:c.endedMs!,agent:c.agent,delta:-1}]).sort((a,b)=>a.at-b.at);
 let roots=0,childrenActive=0,last=0,rootChildOverlapMs=0;
 for(const point of timeline){if(roots&&childrenActive)rootChildOverlapMs+=point.at-last;last=point.at;if(point.agent==='root')roots+=point.delta;else childrenActive+=point.delta;}
 const firstJoin=events.find(e=>e.type==='join-end'&&(e.jobs as string[]).length);
 const discardedIds=new Set(jobs.filter(j=>j.status==='returned-to-parent').map(j=>j.id));
 const discardedCalls=budget.snapshot().calls.filter(c=>calls.some(row=>row.id===c.callId&&discardedIds.has(row.agent)));
 const metrics={forkRequests:messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls??[]).filter(c=>c.function.name==='fork').length,
  rejectedToolCalls:messages.filter(m=>m.role==='tool').filter(m=>Boolean(JSON.parse(m.content).error)).length,firstForkMs:events.find(e=>e.type==='fork')?.atMs??null,rootChildOverlapMs,
  joinWaitMs:events.filter(e=>e.type==='join-wait').reduce((n,e)=>n+(e.elapsedMs as number),0),
  rootContinuationCalls:Math.max(0,calls.filter(c=>c.agent==='root').length-1),
  rootCallsAfterJoin:firstJoin?calls.filter(c=>c.agent==='root'&&c.startedMs>firstJoin.atMs).length:0,
  discardedChildTokens:discardedCalls.some(c=>c.tokens===null)?null:discardedCalls.reduce((n,c)=>n+c.tokens!,0)};
 const report={format:1,method:'lazy',success,qualityPass,applied,termination:fatal??termination,elapsedMs,completionMs:success?elapsedMs:null,sourceUnchanged,
  repository:snapshot.root,outputDirectory:output,childLimit,children:jobs.map(({id,scope,status,joined})=>({id,scope,status,joined})),budget:budget.snapshot(),
  lowerCalls:calls.length,upperCalls:0,concurrency:config.concurrency,maxConcurrentModelCalls,metrics,calls,events,verifications,changedPaths:targets.filter(p=>artifacts[p]!==snapshot.initialTargets[p])};
 await save(join(output,'messages.json'),messages);await save(join(output,'kernel.json'),kernel.exportState());await save(join(output,'artifacts.json'),artifacts);
 await save(join(output,'budget.json'),budget.snapshot());await save(join(output,'result.json'),report);return report;
}
