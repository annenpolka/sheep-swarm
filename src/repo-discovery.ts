import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Checkout, SwarmKernel} from './kernel.ts';
import type {RepoSnapshot} from './repo-types.ts';
import type {PublicCheckFailure} from './fixture.ts';
import {selectUpstreamRechecks} from './repo-recovery-selection.ts';
import type {SwarmTaskControl} from './swarm.ts';
import {discoverRepoDependencies, type RepoDependencyScan} from './repo-dependencies.ts';
import {REPO_WORKER_SCHEMA, parseWorkerResponse} from './worker-proposal.ts';
import {selectImpactedTargets} from './repo-impact.ts';
import {validateMoonBitCatalog} from './repo-moonbit.ts';

export const REPO_GOAL='.sheep-internal/goal.md';
export const REPO_GUIDANCE='.sheep-internal/guidance.md';
const RECOVERY_PREFIX='.sheep-internal/recovery/';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
type Stamp={version:number;evidenceEpoch:number};
interface Evidence {consumer:string;provider:string;source:'static-import'|'delivered-read';evidenceId:string;consumerStamp:Stamp;providerStamp:Stamp|null;sourceHash:string}
interface Delivery {callId:string;target:string;path:string;stamp:Stamp;sha256:string;bytes:number}
interface Uncertainty {callId:string;target:string;reads:Checkout['reads'];source:'model-claim'|'host-observation';observed:readonly string[];missing:readonly string[];hypothesis:string|null;open:boolean;resolution:string|null}

/** An explicit public catalog and delivery ledger; never a capability issuer. */
export class RepositoryDiscovery implements SwarmTaskControl {
  readonly schema=REPO_WORKER_SCHEMA;
  readonly maxAttempts:number;
  readonly artifacts:Record<string,string>={};
  readonly instructions=new Map<string,string>();
  readonly scans:RepoDependencyScan[]=[];
  readonly activation:{mode:'all'|'changed';changedPaths:readonly string[];activeTargets:string[];unaffectedTargets:string[]};
  readonly #snapshot:RepoSnapshot;
  readonly #public:Set<string>;
  readonly #targets:Set<string>;
  readonly #selected=new Map<string,Set<string>>();
  readonly #edges=new Map<string,{consumer:string;provider:string}>();
  readonly #deliveredBytes=new Map<string,number>();
  readonly #requested=new Map<string,number>();
  readonly #evidence:Evidence[]=[];
  readonly #deliveries:Delivery[]=[];
  readonly #requests:{callId:string;target:string;paths:readonly string[];accepted:boolean;reason:string|null}[]=[];
  readonly #uncertainties:Uncertainty[]=[];
  readonly #pendingScans=new Map<string,RepoDependencyScan>();
  readonly #recoveryArtifacts=new Map<string,string>();
  readonly #feedbackReads=new Map<string,Set<string>>();
  readonly #rechecked=new Set<string>();
  readonly #recoveries:{callId:string;target:string;context:string;selected:string[];reason:string;validations:string[]}[]=[];
  #scan:RepoDependencyScan;

  private constructor(snapshot:RepoSnapshot,scan:RepoDependencyScan) {
    this.#snapshot=snapshot;this.#scan=scan;this.scans.push(scan);
    const options=snapshot.task.discovery!;
    this.maxAttempts=3+options.maxReadCalls;
    this.#targets=new Set(snapshot.task.files.map(f=>f.path));
    this.#public=new Set([...this.#targets,...snapshot.task.context,...options.readable]);
    const changed=snapshot.task.activation?.changedPaths;
    const impactEdges=[...scan.edges,...snapshot.task.files.flatMap(f=>[...f.dependsOn,...snapshot.task.context].filter(p=>p!==f.path).map(provider=>({consumer:f.path,provider})))];
    const selectedImpact=changed===undefined?{activeTargets:[...this.#targets],unaffectedTargets:[]}:
      selectImpactedTargets({targets:[...this.#targets],changedPaths:changed,edges:impactEdges,
        uncertainConsumers:[...this.#targets].filter(p=>! /\.(?:mjs|ts|mts|mbt)$/.test(p))});
    this.activation={mode:changed===undefined?'all':'changed',changedPaths:changed??[],...selectedImpact};
    const active=new Set(this.activation.activeTargets);
    for(const path of this.#public)this.artifacts[path]=snapshot.initialTargets[path]??snapshot.entries.get(path)!.bytes.toString('utf8');
    snapshot.task.files.forEach((file,i)=>{
      const instruction=`.sheep-internal/instructions/${i}.md`;
      if(snapshot.task.recovery){
        const feedback=`${RECOVERY_PREFIX}${i}.json`;
        this.#recoveryArtifacts.set(file.path,feedback);
        this.artifacts[feedback]='No upstream recheck requested.';
        this.#feedbackReads.set(file.path,new Set([feedback]));
        this.edge(file.path,feedback);
      }
      this.instructions.set(file.path,instruction);this.artifacts[instruction]=file.instructions;
      const selected=this.closure([file.path,...snapshot.task.context,...file.dependsOn]);selected.delete(file.path);
      this.#selected.set(file.path,selected);
      for(const provider of selected)this.edge(file.path,provider);
      // Only selected work receives the initial goal-change obligation. All declared
      // targets retain their normal dependency edges and may wake on later commits.
      for(const provider of [REPO_GUIDANCE,instruction,...(active.has(file.path)?[REPO_GOAL]:[])])this.edge(file.path,provider);
    });
  }

  static async create(snapshot:RepoSnapshot):Promise<RepositoryDiscovery> {
    if(!snapshot.task.discovery)throw new Error('repository discovery requires task v2');
    const paths=[...new Set([...snapshot.task.files.map(f=>f.path),...snapshot.task.context,...snapshot.task.discovery.readable])];
    validateMoonBitCatalog([...snapshot.entries.keys()],paths);
    const contents=Object.fromEntries(paths.map(p=>[p,snapshot.initialTargets[p]??snapshot.entries.get(p)!.bytes.toString('utf8')]));
    const scan=await discoverRepoDependencies(contents,paths,snapshot.task.files.map(f=>f.path));
    return new RepositoryDiscovery(snapshot,scan);
  }

  private edge(consumer:string,provider:string):void {
    if(consumer!==provider)this.#edges.set(`${consumer}\0${provider}`,{consumer,provider});
  }
  private closure(paths:readonly string[],scan=this.#scan):Set<string> {
    const ids=new Set(paths);
    for(const id of ids) {
      if(!this.#public.has(id))throw new Error(`read outside public catalog: ${id}`);
      const issue=scan.issues.find(i=>i.consumer===id);
      if(issue)throw new Error(`unresolved dependency in ${id}: ${issue.reason}`);
      if(scan.cycles.some(c=>c.includes(id)))throw new Error(`unsupported-cycle: ${id}`);
      for(const edge of scan.edges)if(edge.consumer===id)ids.add(edge.provider);
    }
    return ids;
  }
  dependencies():readonly {consumer:string;provider:string}[]{return [...this.#edges.values()];}
  contextIds(kernel:SwarmKernel,target:string):readonly string[] {
    if(this.#targets.has(target)){
      const selected=this.closure([target,...(this.#selected.get(target)??[])]);selected.delete(target);this.#selected.set(target,selected);
    }
    for(const work of kernel.pending())if(work.consumer===target && work.provider.startsWith(RECOVERY_PREFIX))
      this.#feedbackReads.get(target)?.add(work.provider);
    return [...new Set([target,REPO_GOAL,REPO_GUIDANCE,...(this.#feedbackReads.get(target)??[]),...(this.instructions.has(target)?[this.instructions.get(target)!]:[]),...(this.#selected.get(target)??[])])];
  }
  instruction(_target:string):string {
    return `Choose one action: kind="write" to replace your assigned file, kind="read" to request public paths in a separate call, or kind="uncertain" to record missing information. Return all fields {kind,content,paths,observed,missing,hypothesis,note}; unused strings must be "" and unused arrays []. A read request changes no files; requested contents arrive in the NEXT separately metered call. Exact wire shapes by action:
WRITE: {"kind":"write","content":"<complete replacement>","paths":[],"observed":[],"missing":[],"hypothesis":"","note":"<summary>"}
READ: {"kind":"read","content":"","paths":["<requested public path>"],"observed":[],"missing":[],"hypothesis":"","note":"<reason>"}
UNCERTAIN: {"kind":"uncertain","content":"","paths":[],"observed":["<observation>"],"missing":["<unresolved information>"],"hypothesis":"<optional unverified hypothesis, or empty string>","note":"<summary>"}
A write MUST NOT put its target in paths. On write/read, observed and missing MUST be [] and hypothesis MUST be "". Put explanatory prose only in note. Current Local files are already delivered. A read request may name at most ${this.#snapshot.task.discovery!.maxPathsPerRead} paths; do not request the whole catalog when it exceeds that limit. Never claim a requested file was read before delivery. Public catalog (names only): ${JSON.stringify([...this.#public])}. No tools or upper consultation. ${this.#snapshot.task.discovery!.mode==='static'?'Additional model read requests are disabled in static mode.':''}`;
  }
  private additionalBytes(target:string,context:Checkout):number {
    return [...(this.#selected.get(target)??[]),...(this.#feedbackReads.get(target)??[])].filter(p=>!this.#snapshot.task.context.includes(p)).reduce((n,p)=>n+Buffer.byteLength(context.contents[p]!),0);
  }
  beforeCall(target:string,context:Checkout):void {
    if((this.#deliveredBytes.get(target)??0)+this.additionalBytes(target,context)>this.#snapshot.task.discovery!.maxDeliveredBytes){
      this.defer(target,context,context.id,'read-byte-limit: cumulative additional context exceeds delivery limit',true);
      throw new Error('read-byte-limit: cumulative additional context exceeds delivery limit');
    }
  }
  delivered(kernel:SwarmKernel,target:string,context:Checkout,callId:string):void {
    if(!this.#targets.has(target))return;
    this.#deliveredBytes.set(target,(this.#deliveredBytes.get(target)??0)+this.additionalBytes(target,context));
    for(const path of [...(this.#selected.get(target)??[]),...(this.#feedbackReads.get(target)??[])]) {
      const stamp=context.reads[path]!;
      this.#deliveries.push({callId,target,path,stamp,sha256:hash(context.contents[path]!),bytes:Buffer.byteLength(context.contents[path]!)});
      this.#evidence.push({consumer:target,provider:path,source:'delivered-read',evidenceId:callId,consumerStamp:context.reads[target]!,providerStamp:stamp,sourceHash:hash(context.contents[path]!)});
      this.edge(target,path);
      kernel.addDependency(target,path,stamp.version,stamp.evidenceEpoch);
    }
  }
  private defer(target:string,context:Checkout,callId:string,reason:string,blocked:boolean) {
    this.#uncertainties.push({callId,target,reads:context.reads,source:'host-observation',observed:[],missing:[reason],hypothesis:null,open:true,resolution:null});
    return {deferred:reason,blocked};
  }
  private request(target:string,context:Checkout,callId:string,paths:readonly string[],scan=this.#scan,staticRequest=false) {
    let reason:string|null=null;
    const count=(this.#requested.get(target)??0)+1;
    this.#requested.set(target,count);
    if(!staticRequest&&this.#snapshot.task.discovery!.mode!=='static+reads')reason='additional-read-disabled';
    if(count>this.#snapshot.task.discovery!.maxReadCalls)reason='read-call-limit';
    if(paths.length>this.#snapshot.task.discovery!.maxPathsPerRead){
      this.#requests.push({callId,target,paths,accepted:false,reason:'read-path-limit'});
      return this.defer(target,context,callId,'read-path-limit: too many paths in one request',true);
    }
    let selected=new Set(this.#selected.get(target));
    try {
      for(const path of this.closure(paths,scan))if(path!==target)selected.add(path);
      const bytes=[...selected].filter(p=>!this.#snapshot.task.context.includes(p)).reduce((n,p)=>n+Buffer.byteLength(context.contents[p]??this.artifacts[p]!),0);
      if((this.#deliveredBytes.get(target)??0)+bytes>this.#snapshot.task.discovery!.maxDeliveredBytes)reason='read-byte-limit';
    }catch(error){reason=String(error);}
    this.#requests.push({callId,target,paths,accepted:reason===null,reason});
    if(reason)return this.defer(target,context,callId,reason,true);
    // No edge or read stamp is registered before the next actual delivery.
    this.#selected.set(target,selected);
    return this.defer(target,context,callId,`Read requested; await next call: ${paths.join(', ')}`,false);
  }
  async propose(kernel:SwarmKernel,target:string,context:Checkout,callId:string,value:unknown) {
    const action=parseWorkerResponse(value);
    if(action.kind==='uncertain') {
      this.#uncertainties.push({callId,target,reads:context.reads,source:'model-claim',observed:action.observed,missing:action.missing,hypothesis:action.hypothesis,open:true,resolution:null});
      return {deferred:`Uncertain: ${action.missing.join('; ')}`,blocked:false};
    }
    if(action.kind==='read')return this.request(target,context,callId,action.paths);
    const contents=Object.fromEntries([...this.#public].map(p=>[p,p===target?action.content:(context.contents[p]??kernel.artifact(p).content)]));
    const scan=await discoverRepoDependencies(contents,[...this.#public],[...this.#targets]);this.scans.push(scan);
    let required:Set<string>;
    try{required=this.closure([target],scan);}catch(error){return this.defer(target,context,callId,String(error),false);}
    required.delete(target);
    const missing=[...required].filter(p=>!Object.hasOwn(context.reads,p));
    if(missing.length)return this.request(target,context,callId,missing,scan,true);
    for(const edge of scan.edges.filter(e=>e.consumer===target))this.#evidence.push({consumer:target,provider:edge.provider,source:'static-import',evidenceId:callId,consumerStamp:context.reads[target]!,providerStamp:context.reads[edge.provider]??null,sourceHash:edge.sourceHash});
    // Retain conservative observed dependencies even when a later proposal fails.
    for(const provider of required){this.#selected.get(target)!.add(provider);this.edge(target,provider);kernel.addDependency(target,provider,context.reads[provider]!.version,context.reads[provider]!.evidenceEpoch);}
    this.#pendingScans.set(target,scan);
    return {writes:{[target]:action.content}};
  }
  committed(target:string,context:Checkout,validation:string):void {
    const accepted=this.#pendingScans.get(target);if(accepted)this.#scan=accepted;
    this.#pendingScans.delete(target);
    for(const uncertainty of this.#uncertainties)if(uncertainty.target===target&&uncertainty.open){
      uncertainty.open=false;uncertainty.resolution=validation;
    }
    // Future reads of accepted target contents still come from the kernel.
    for(const path of this.#selected.get(target)??[])if(context.contents[path]!==undefined)this.artifacts[path]=context.contents[path]!;
  }
  /** A failed public consumer check is suspicion, never proof that its providers are wrong. */
  async rejected(kernel:SwarmKernel,target:string,context:Checkout,callId:string,
    failure:PublicCheckFailure,eligible:readonly string[]):Promise<void> {
    const limit=this.#snapshot.task.recovery?.maxUpstreamRechecks;
    if(limit===undefined)return;
    this.#pendingScans.delete(target);
    const entry={callId,target,context:context.id,selected:[] as string[],reason:'no-eligible-upstream',validations:[] as string[]};
    this.#recoveries.push(entry);
    // The failed candidate was evaluated against these delivered versions. An
    // obsolete observation must not invalidate newer provider work.
    if(Object.entries(context.reads).some(([id,stamp])=>{
      const current=kernel.artifact(id);
      return current.version!==stamp.version||current.evidenceEpoch!==stamp.evidenceEpoch;
    })){entry.reason='stale-observation';return;}
    const selected=selectUpstreamRechecks({target,targets:[...this.#targets],edges:this.dependencies(),
      delivered:Object.keys(context.reads),eligible,rechecked:[...this.#rechecked],limit:limit-this.#rechecked.size});
    if(!selected.length)return;
    entry.selected=selected;entry.reason='public-local-check-failure';
    // All observations are checked before the first mutation; this method runs
    // in the scheduler's serialized commit lane. Frozen observations are JSON,
    // not reverse dependencies from providers to the failed consumer.
    for(const provider of selected){
      const id=this.#recoveryArtifacts.get(provider)!;
      const content=JSON.stringify({source:'public-local-check-failure',target,provider,callId,context:context.id,
        reads:context.reads,commands:failure.commands,diagnostic:failure.diagnostic.slice(0,8192),
        instruction:this.#snapshot.task.recovery?.review==='contract'
          ? 'A downstream PUBLIC local check failed. Recheck your assigned provider against EVERY requirement in its original public contract, not only the reported example. Before returning the complete file, work through the contract one requirement at a time and check that the proposed implementation satisfies each one. Reconsider existing code as well as your edits; earlier acceptance is not proof of the whole contract. The fault may be in the consumer or another provider. Fix only your assigned file if needed, otherwise return its unchanged contents. Do this within this call; do not request a reviewer or additional tools. Preserve acceptance requirements. This is an immutable historical observation, not a current dependency on the consumer.'
          : 'A downstream PUBLIC local check failed. Recheck your assigned provider against its original contract using this observation. The fault may be in the consumer or another provider. Fix only your assigned file if needed, otherwise return its unchanged contents. Preserve acceptance requirements. This is an immutable historical observation, not a current dependency on the consumer.'});
      const agent='host-upstream-recovery';
      const checkout=kernel.checkout(agent,[id]);
      const lease=kernel.grant(agent,[id],60000,'meta');
      const candidate=kernel.prepare({id:`upstream-${callId}-${provider}`,agent,context:checkout.id,lease,
        writes:{[id]:content},kind:'intervention',reason:`Public local check from ${target}, ${callId}`});
      const verdict=await kernel.validate(candidate.id,contents=>({ok:contents[id]===content,errors:[]}));
      if(!verdict.ok)throw new Error('host recovery artifact validation failed');
      entry.validations.push(kernel.commit(candidate.id).validation);
      this.#rechecked.add(provider);
    }
    kernel.deliverAll();
  }
  observations():unknown {
    return this.#uncertainties.filter(u=>u.open).slice(-6).map(u=>({...u,observed:u.observed.slice(0,3),missing:u.missing.slice(0,3)}));
  }
  metrics(calls:readonly {role:string;target:string;contextBytes:number}[]) {
    const workers=calls.filter(c=>c.role==='worker');const sizes=workers.map(c=>c.contextBytes).sort((a,b)=>a-b);
    return {selectedTargets:this.#targets.size,activatedTargets:new Set(workers.map(c=>c.target)).size,initiallyActivatedTargets:this.activation.activeTargets.length,
      upstreamRechecks:this.#rechecked.size,recoveryObservations:this.#recoveries.length,
      scanCount:this.scans.length,scannedFiles:this.scans.reduce((n,s)=>n+s.filesRead,0),scannedBytes:this.scans.reduce((n,s)=>n+s.bytesRead,0),scanDurationMs:this.scans.reduce((n,s)=>n+s.durationMs,0),
      contextBytes:{total:sizes.reduce((n,b)=>n+b,0),p95:sizes[Math.max(0,Math.ceil(sizes.length*0.95)-1)]??0,max:sizes.at(-1)??0},
      uniqueDeliveredDependencies:new Set(this.#deliveries.map(d=>d.path)).size,readRequests:this.#requests.length,
      acceptedReadRequests:this.#requests.filter(r=>r.accepted).length,openUncertainties:this.#uncertainties.filter(c=>c.open).length,
      additionalDeliveredBytes:[...this.#deliveredBytes.values()].reduce((n,b)=>n+b,0)};
  }
  async save(directory:string):Promise<void> {
    await writeFile(join(directory,'upstream-recovery.json'),JSON.stringify({format:1,enabled:!!this.#snapshot.task.recovery,maxUpstreamRechecks:this.#snapshot.task.recovery?.maxUpstreamRechecks??0,review:this.#snapshot.task.recovery?.review??'focused',rechecked:[...this.#rechecked],observations:this.#recoveries},null,2)+'\n');
    await writeFile(join(directory,'activation.json'),JSON.stringify({format:1,...this.activation,limitations:['static-and-declared-context-impact-only','changed-paths-are-host-declared','final-oracle-still-covers-all-targets']},null,2)+'\n');
    await writeFile(join(directory,'dependency-evidence.json'),JSON.stringify({format:1,edges:this.dependencies(),evidence:this.#evidence,scans:this.scans},null,2)+'\n');
    await writeFile(join(directory,'read-deliveries.json'),JSON.stringify({format:1,requests:this.#requests,deliveries:this.#deliveries,additionalBytesByTarget:Object.fromEntries(this.#deliveredBytes)},null,2)+'\n');
    await writeFile(join(directory,'uncertainties.json'),JSON.stringify({format:1,claims:this.#uncertainties},null,2)+'\n');
  }
}
