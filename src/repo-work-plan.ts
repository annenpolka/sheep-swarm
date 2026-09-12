import {planPackets,type WorkPacket} from './repo-packets.ts';
export interface PlannedPacket {id:string;writablePaths:string[];relevantPaths:string[];objective:string;invariants:string[];dependsOn:string[]}
export interface WorkPlan {packets:PlannedPacket[];untouchedPaths:string[];rationale:string}
export interface CompiledWorkPacket extends WorkPacket {objective:string;invariants:string[];relevantPaths:string[];sourcePacketIds:string[]}
const keys=(value:unknown,names:string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('plan must contain plain objects');
 const descriptors=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(value).length!==names.length||names.some(k=>!Object.hasOwn(descriptors,k)||!Object.hasOwn(descriptors[k]!,'value')))throw new Error('unexpected or missing plan fields');
 return value as Record<string,unknown>;
};
const text=(s:unknown,max=4096)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw new Error('invalid plan text');return s;};
const array=(x:unknown,max:number)=>{if(!Array.isArray(x)||x.length>max||Array.from({length:x.length},(_,i)=>Object.getOwnPropertyDescriptor(x,String(i))).some(d=>!d||!Object.hasOwn(d,'value')))throw new Error('invalid plan array');return x as unknown[];};
const strings=(x:unknown,max:number)=>{const a=array(x,max).map(s=>text(s));if(new Set(a).size!==a.length)throw new Error('duplicate plan entry');return a;};
export function workPlanSchema(targets:readonly string[],publicPaths:readonly string[]) {
 const list=(values:readonly string[])=>({type:'array',items:{type:'string'},description:'Allowed paths: '+JSON.stringify(values)});
 return {type:'object',additionalProperties:false,required:['packets','untouchedPaths','rationale'],properties:{
  packets:{type:'array',items:{type:'object',additionalProperties:false,required:['id','writablePaths','relevantPaths','objective','invariants','dependsOn'],properties:{
   id:{type:'string'},writablePaths:list(targets),relevantPaths:list(publicPaths),objective:{type:'string'},invariants:{type:'array',items:{type:'string'}},dependsOn:{type:'array',items:{type:'string'}}}}},
  untouchedPaths:list(targets),rationale:{type:'string'}}};
}
/** Model text is a proposal. Only declared targets/public paths become capabilities. */
export function compileWorkPlan(raw:unknown,targets:readonly string[],publicPaths:readonly string[],edges:readonly {consumer:string;provider:string}[]) {
 const root=keys(raw,['packets','untouchedPaths','rationale']);
 const packets=array(root.packets,targets.length).map(value=>{
  const p=keys(value,['id','writablePaths','relevantPaths','objective','invariants','dependsOn']);
  const id=text(p.id,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id))throw new Error('invalid packet ID');
  return {id,writablePaths:strings(p.writablePaths,targets.length),relevantPaths:strings(p.relevantPaths,publicPaths.length),objective:text(p.objective),invariants:strings(p.invariants,32),dependsOn:strings(p.dependsOn,targets.length)};
 });
 const plan:WorkPlan={packets,untouchedPaths:strings(root.untouchedPaths,targets.length),rationale:text(root.rationale,8192)};
 if(!packets.length||new Set(packets.map(p=>p.id)).size!==packets.length)throw new Error('empty plan or duplicate packet ID');
 const targetSet=new Set(targets),readable=new Set(publicPaths),ids=new Map(packets.map((p,i)=>[p.id,i]));
 for(const p of packets) {
  if(!p.writablePaths.length||p.writablePaths.some(s=>!targetSet.has(s))||p.relevantPaths.some(s=>!readable.has(s)))throw new Error('plan path outside declared scope');
  if(p.dependsOn.some(id=>!ids.has(id)||id===p.id))throw new Error('unknown/self packet dependency');
 }
 const owned=new Set(packets.flatMap(p=>p.writablePaths));
 if(plan.untouchedPaths.some(p=>!targetSet.has(p)||owned.has(p))||targets.some(p=>!owned.has(p)&&!plan.untouchedPaths.includes(p)))throw new Error('plan must classify every target exactly as writable or untouched');
 const graph=new Map(publicPaths.map(p=>[p,new Set<string>()]));
 for(const e of edges){if(!graph.has(e.consumer)||!graph.has(e.provider))throw new Error('invalid public graph');graph.get(e.consumer)!.add(e.provider);}
 const closure=(roots:readonly string[])=>{const seen=new Set(roots);for(const p of seen)for(const dep of graph.get(p)??[])seen.add(dep);return [...seen].sort();};
 const parent=packets.map((_,i)=>i),find=(i:number):number=>parent[i]===i?i:find(parent[i]!);
 const merge=(a:number,b:number)=>{parent[find(b)]=find(a);};
 const owners=new Map<string,number>();
 for(const [i,p] of packets.entries())for(const path of p.writablePaths){if(owners.has(path))merge(owners.get(path)!,i);else owners.set(path,i);}
 const components=new Map<number,number[]>();for(let i=0;i<packets.length;i++){const k=find(i);if(!components.has(k))components.set(k,[]);components.get(k)!.push(i);}
 const groups=[...components.values()],groupOf=new Map(groups.flatMap((g,i)=>g.map(j=>[j,i] as const)));
 const deps=groups.map((indices,i)=>{
  const set=new Set<number>();
  for(const j of indices){const p=packets[j]!;
   for(const path of closure([...p.writablePaths,...p.relevantPaths]))if(owners.has(path))set.add(groupOf.get(owners.get(path)!)!);
   for(const id of p.dependsOn)set.add(groupOf.get(ids.get(id)!)!);
  }set.delete(i);return set;
 });
 // Capacity one merges only SCCs; it never invents a file-count partition.
 const partition=planPackets(groups.map((_,i)=>({path:String(i),dependsOn:[...deps[i]!].map(String)})),1);
 const compiled:CompiledWorkPacket[]=partition.packets.map(p=>{
  const original=p.paths.flatMap(i=>groups[Number(i)]!).map(i=>packets[i]!);
  return {id:p.id,paths:[...new Set(original.flatMap(x=>x.writablePaths))].sort(),dependsOn:p.dependsOn,
   oversizeReasons:[],sourcePacketIds:original.map(x=>x.id).sort(),objective:original.map(x=>`${x.id}: ${x.objective}`).join('\n'),
   invariants:[...new Set(original.flatMap(x=>x.invariants))],relevantPaths:[...new Set(original.flatMap(x=>x.relevantPaths))].sort()};
 });
 return {raw:plan,packets:compiled,boundaryEdges:partition.boundaryEdges,untouchedPaths:plan.untouchedPaths.slice().sort(),
  normalization:{proposedPackets:packets.length,executedPackets:compiled.length,mergedGroups:compiled.filter(p=>p.sourcePacketIds.length>1).map(p=>p.sourcePacketIds)}};
}
