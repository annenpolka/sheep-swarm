import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const STRATEGIES=['legacy-single','packet-all','packet-8','packet-4','packet-2','packet-1'] as const;
export type Strategy=typeof STRATEGIES[number];
export const digest=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
export interface SweepCase {id:string;family:string;split:string;targetCount:number;topology:string;dependencyDepth:number;conditions:{method:Strategy;signature:string;packetSize:'all'|number|null}[]}
export function sweepPlan(cases:readonly SweepCase[]) {
 assert.ok(cases.length>0&&cases.every(c=>c.split==='dev'));assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
 const ranks=new Map<string,number>();
 return [...cases].sort((a,b)=>digest('packet-dev-v1:'+a.id).localeCompare(digest('packet-dev-v1:'+b.id))).flatMap(c=>{
  assert.deepEqual(c.conditions.map(x=>x.method),STRATEGIES);
  const groups=new Map<string,{id:string;method:Strategy;packetSize:'all'|number|null;aliases:Strategy[]}>();
  for(const condition of c.conditions){
   assert.ok(condition.signature.length>0);
   const key=condition.method==='legacy-single'?'legacy-single':condition.signature;
   const group=groups.get(key);if(group)group.aliases.push(condition.method);
   else groups.set(key,{id:c.id,method:condition.method,packetSize:condition.packetSize,aliases:[condition.method]});
  }
  const ordered=[...groups.values()];const bucket=c.family+':'+ordered.map(g=>g.aliases.join(',')).join('/');
  const rank=ranks.get(bucket)??0;ranks.set(bucket,rank+1);
  if(Math.floor(rank/ordered.length)%2)ordered.reverse();
  const offset=rank%ordered.length;return [...ordered.slice(offset),...ordered.slice(0,offset)];
 });
}
export interface SweepRow {id:string;method:Strategy;aliases:Strategy[];success:boolean;elapsedMs:number;tokens:number|null;knownTokens?:number;calls:number;evidenceErrors:string[]}
const median=(xs:number[])=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]!:(s[i-1]!+s[i]!)/2;};
export function summarizeSweep(cases:readonly Pick<SweepCase,'id'|'family'|'targetCount'|'topology'|'dependencyDepth'>[],rows:readonly SweepRow[]) {
 const data=new Map(cases.map(c=>[c.id,new Map<Strategy,SweepRow>()]));
 for(const r of rows){assert.ok(data.has(r.id));assert.ok(r.elapsedMs>0&&Number.isFinite(r.elapsedMs));
  for(const alias of r.aliases){assert.ok(STRATEGIES.includes(alias));assert.ok(!data.get(r.id)!.has(alias),'duplicate observation');data.get(r.id)!.set(alias,r);}
 }
 function group(selected:typeof cases) {
  const valid=(id:string,m:Strategy)=>{const r=data.get(id)?.get(m);return r&&!r.evidenceErrors.length?r:undefined;};
  const methods=Object.fromEntries(STRATEGIES.map(method=>{const rs=selected.flatMap(c=>{const r=valid(c.id,method);return r?[r]:[];});return [method,{cases:rs.length,successes:rs.filter(r=>r.success).length,medianCompletionMs:median(rs.filter(r=>r.success).map(r=>r.elapsedMs)),knownTokens:rs.reduce((n,r)=>n+(r.knownTokens??r.tokens??0),0),totalTokens:rs.some(r=>r.tokens===null)?null:rs.reduce((n,r)=>n+r.tokens!,0)}];}));
  const pairs=Object.fromEntries((['packet-all','legacy-single'] as const).map(reference=>[reference,Object.fromEntries(STRATEGIES.filter(m=>m!==reference).map(method=>{
   let complete=0,equivalent=0,both=0,referenceOnly=0,methodOnly=0,neither=0,referenceFaster=0,methodFaster=0;const ratios:number[]=[];
   for(const c of selected){const a=valid(c.id,reference),b=valid(c.id,method);if(!a||!b)continue;if(a===b){equivalent++;continue;}complete++;
    if(a.success&&b.success){both++;ratios.push(a.elapsedMs/b.elapsedMs);if(a.elapsedMs<b.elapsedMs)referenceFaster++;else if(a.elapsedMs>b.elapsedMs)methodFaster++;}
    else if(a.success)referenceOnly++;else if(b.success)methodOnly++;else neither++;
   }
   return [method,{completePairs:complete,equivalentCases:equivalent,bothSuccess:both,referenceOnly,methodOnly,neither,referenceFaster,methodFaster,medianReferenceOverMethod:median(ratios)}];
  }))]));return {plannedCases:selected.length,methods,pairs};
 }
 const strata=(key:'family'|'targetCount'|'topology'|'dependencyDepth')=>Object.fromEntries([...new Set(cases.map(c=>String(c[key])))].sort().map(value=>[value,group(cases.filter(c=>String(c[key])===value))]));
 return {overall:group(cases),family:strata('family'),targetCount:strata('targetCount'),topology:strata('topology'),dependencyDepth:strata('dependencyDepth')};
}
