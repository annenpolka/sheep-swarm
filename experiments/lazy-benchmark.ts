import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const {scaffoldSources}=await import('../scripts/'+'scaffold-lazy-fixture.mjs');
import {buildSyntheticTask,listSyntheticTasks} from './synthetic-corpus/index.ts';
import type {Built} from './synthetic-corpus/common.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {dependencyDepth,median} from './synthetic-paired.ts';
export const METHODS=['packet-all','root-only','lazy'] as const;
export const FAMILIES=['units','baseconv','window','stats','intervals','apportion'] as const;
export const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
export function structure(task:Built['task']){
 const graph=new Map(task.files.map(f=>[f.path,new Set(f.dependsOn)]));
 for(const [p,deps]of graph)for(const d of deps)graph.get(d)?.add(p);
 const seen=new Set<string>();let components=0;
 for(const p of graph.keys())if(!seen.has(p)){components++;const todo=[p];while(todo.length){const next=todo.pop()!;if(seen.has(next))continue;seen.add(next);todo.push(...graph.get(next)!);}}
 return {components,dependencyDepth:dependencyDepth(task)};
}
function expanded(original:Built,id:string,group:string):Built{
 const files={...original.files},changed:string[]=[];
 const scaffolds=scaffoldSources(original.reference);
 for(const [path,source]of Object.entries(original.reference)){files[path]=scaffolds[path];if(files[path]!==source)changed.push(path);}
 assert(changed.length>=3,'expanded task needs several actual implementation targets');
 const task=parseRepoTask({...original.task,goal:`Implement the scaffolded functions according to the existing public contracts. Preserve declared imports and exports. ${original.task.goal}`});
 const mutants=[...original.mutants,...changed.map((p,i)=>({id:`missing-body-${i}`,description:'One required implementation remains a scaffold',patch:{[p]:files[p]!},predictedPublicPass:false}))];
 const metadata={...original.metadata,id,family:group,defect:'Required function implementations are scaffolded',defectedPaths:changed,mutants:mutants.map(({id,description,predictedPublicPass})=>({id,description,predictedPublicPass}))};
 const publicPaths=new Set([...task.files.map(f=>f.path),...task.context,...(task.discovery?.readable??[])]);
 return {files,task,reference:original.reference,mutants,metadata,hashes:{public:hash(JSON.stringify({task,files:Object.fromEntries(Object.entries(files).filter(([p])=>publicPaths.has(p)))})),private:hash(JSON.stringify({reference:original.reference,mutants,protected:Object.fromEntries(task.protected.map(p=>[p,files[p]]))}))}};
}
function independent(index:number):Built{
 const parts=[0,1,2].map(offset=>buildSyntheticTask(`syn-${FAMILIES[(index+offset)%FAMILIES.length]}-v00`));
 const files:Record<string,string>={},reference:Record<string,string>={},mutants:Built['mutants'][number][]=[],targets:unknown[]=[],context:string[]=[],protectedPaths:string[]=[];
 for(const [i,part]of parts.entries()){
  const prefix=`component-${i+1}/`,path=(p:string)=>prefix+p;
  for(const [p,s]of Object.entries(part.files))files[path(p)]=s;
  for(const [p,s]of Object.entries(part.reference))reference[path(p)]=s;
  for(const m of part.mutants)mutants.push({...m,id:prefix+m.id,patch:Object.fromEntries(Object.entries(m.patch).map(([p,s])=>[path(p),s]))});
  targets.push(...part.task.files.map(f=>({...f,path:path(f.path),instructions:`This belongs to ${prefix}; relative paths in its contract refer to that component. ${f.instructions}`,dependsOn:f.dependsOn.map(path),checks:f.checks.map(c=>({...c,argv:[c.argv[0]!,path(c.argv[1]!),...c.argv.slice(2)]}))})));
  context.push(...part.task.context.map(path));protectedPaths.push(...part.task.protected.map(path));
 }
 files['holdout.mjs']=parts.map((_,i)=>`await import('./component-${i+1}/holdout.mjs');`).join('\n');protectedPaths.push('holdout.mjs');
 const task=parseRepoTask({version:2,goal:'Implement the three separate component libraries. Each component has its own contract and tests; there are no cross-component imports. '+parts.map((p,i)=>`component-${i+1}: ${p.task.goal}`).join('\n'),files:targets,context,protected:protectedPaths,checks:[{argv:['node','holdout.mjs'],timeoutMs:60000}],discovery:{mode:'static',readable:[],maxPathsPerRead:8,maxReadCalls:0,maxDeliveredBytes:1048576}});
 const original={files,reference,mutants,task,metadata:{...parts[0]!.metadata,targetCount:targets.length,topology:'independent' as const},hashes:{public:'',private:''}};
 const built=expanded(original,`lazy-independent-${index}`,'independent');assert(structure(task).components>=3);return built;
}
export function buildLazyCases(){
 const registry=listSyntheticTasks();
 const local=FAMILIES.map(family=>buildSyntheticTask(`syn-${family}-v00`));
 assert(local.every(f=>f.metadata.split==='dev'));
 const coupled=FAMILIES.map((family,i)=>{
  const candidates=registry.filter(c=>c.split==='dev'&&c.family===family&&c.targetCount===16).map(c=>buildSyntheticTask(c.id)).filter(f=>structure(f.task).components===1).sort((a,b)=>structure(b.task).dependencyDepth-structure(a.task).dependencyDepth||a.metadata.id.localeCompare(b.metadata.id));
  assert(candidates.length,`no connected candidate for ${family}`);
  return expanded(candidates[0]!,`lazy-coupled-${i}`,'coupled');
 });
 return [...local.map(f=>({id:f.metadata.id,group:'local',fixture:f})),...FAMILIES.map((_,i)=>({id:`lazy-independent-${i}`,group:'independent',fixture:independent(i)})),...coupled.map(f=>({id:f.metadata.id,group:'coupled',fixture:f}))];
}
export function lazyOrder(cases:readonly {id:string;group:string}[]){
 const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
 // Interleave groups. Each group uses each of the six method permutations once.
 const groups=['local','independent','coupled'];
 return Array.from({length:6},(_,i)=>groups.flatMap((group,g)=>{const c=cases.filter(c=>c.group===group)[i]!;return permutations[(i+g*2)%6]!.map(j=>({id:c.id,group,method:METHODS[j]!}));})).flat();
}
export interface LazyRow {id:string;group:string;method:typeof METHODS[number];success:boolean;evidenceErrors:string[];elapsedMs:number;tokens:number|null;knownTokens:number;calls:number;children:number;forkRequests:number;overlapMs:number}
export function summarizeLazy(rows:readonly LazyRow[]){
 const keys=new Set<string>();for(const r of rows){const key=r.id+':'+r.method;assert(!keys.has(key),'duplicate observation');keys.add(key);}
 return Object.fromEntries(['all','local','independent','coupled'].map(group=>{
  const selected=rows.filter(r=>group==='all'||r.group===group),valid=selected.filter(r=>!r.evidenceErrors.length);
  const methods=Object.fromEntries(METHODS.map(method=>{const rs=valid.filter(r=>r.method===method);return [method,{observed:rs.length,successes:rs.filter(r=>r.success).length,medianCompletionMs:median(rs.filter(r=>r.success).map(r=>r.elapsedMs)),knownTokens:rs.reduce((n,r)=>n+r.knownTokens,0),tokens:rs.some(r=>r.tokens===null)?null:rs.reduce((n,r)=>n+r.tokens!,0),calls:rs.reduce((n,r)=>n+r.calls,0),forkRequests:rs.reduce((n,r)=>n+r.forkRequests,0),forkedTasks:rs.filter(r=>r.children>0).length,children:rs.reduce((n,r)=>n+r.children,0),overlapMs:rs.reduce((n,r)=>n+r.overlapMs,0)}];}));
  const comparisons=Object.fromEntries(['packet-all','root-only'].map(reference=>{
   const pairs=valid.filter(r=>r.method==='lazy').flatMap(lazy=>{const ref=valid.find(r=>r.id===lazy.id&&r.method===reference);return ref?[[ref,lazy] as const]:[];}),both=pairs.filter(([a,b])=>a.success&&b.success);
   return [reference,{pairs:pairs.length,bothSuccess:both.length,referenceOnly:pairs.filter(([a,b])=>a.success&&!b.success).length,lazyOnly:pairs.filter(([a,b])=>!a.success&&b.success).length,lazyFaster:both.filter(([a,b])=>b.elapsedMs<a.elapsedMs).length,referenceFaster:both.filter(([a,b])=>a.elapsedMs<b.elapsedMs).length,medianLazyOverReference:median(both.map(([a,b])=>b.elapsedMs/a.elapsedMs))}];
  }));return [group,{methods,comparisons}];
 }));
}
