import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const SEMANTIC_METHODS=['single','fixed-all','planned'] as const;
export const semanticHash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
interface Case {id:string;family:string;split:string;targetCount:number;topology:string;dependencyDepth:number}
/** Public metadata only: three sizes per family, rotating the omitted size. */
export function semanticPilotCases<T extends Case>(cases:readonly T[]):T[] {
 const dev=cases.filter(c=>c.split==='dev'),families=[...new Set(dev.map(c=>c.family))].sort();assert.equal(families.length,8);
 return families.flatMap((family,i)=>[4,8,16,32].filter((_,j)=>j!==i%4).map(size=>{
  const choices=dev.filter(c=>c.family===family&&c.targetCount===size).sort((a,b)=>semanticHash('semantic-dev-v1:'+a.id).localeCompare(semanticHash('semantic-dev-v1:'+b.id)));
  assert.ok(choices.length);return choices[0]!;
 })).sort((a,b)=>semanticHash('semantic-order-v1:'+a.id).localeCompare(semanticHash('semantic-order-v1:'+b.id)));
}
export function semanticPilotOrder(cases:readonly Case[]) {
 const orders=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
 return cases.flatMap((c,i)=>orders[i%6]!.map(j=>({id:c.id,method:SEMANTIC_METHODS[j]!})));
}
export const median=(ns:readonly number[])=>{const s=[...ns].sort((a,b)=>a-b),n=s.length;return n?n%2?s[(n-1)/2]!:(s[n/2-1]!+s[n/2]!)/2:null;};
export interface SemanticRow {id:string;method:typeof SEMANTIC_METHODS[number];success:boolean;evidenceErrors:string[];elapsedMs:number;calls:number;knownTokens:number;tokens:number|null;
 proposedPacketCount:number|null;executedPacketCount:number|null;plannedWritableCount:number|null;changedTargetCount:number;plannerMs:number;plannerCalls:number;plannerChoseSingle:boolean;allTargetsOnePacket:boolean}
export function summarizeSemantic(cases:readonly Case[],rows:readonly SemanticRow[]) {
 const observations=new Map<string,SemanticRow>();for(const r of rows){assert.ok(cases.some(c=>c.id===r.id));assert.ok(SEMANTIC_METHODS.includes(r.method));assert.ok(r.elapsedMs>0);const k=r.id+':'+r.method;assert.ok(!observations.has(k));observations.set(k,r);}
 const group=(selected:readonly Case[])=>{
  const valid=(id:string,m:string)=>{const r=observations.get(id+':'+m);return r&&!r.evidenceErrors.length?r:undefined;};
  const methods=Object.fromEntries(SEMANTIC_METHODS.map(m=>{const rs=selected.flatMap(c=>{const r=valid(c.id,m);return r?[r]:[];});return [m,{observed:rs.length,successes:rs.filter(r=>r.success).length,medianCompletionMs:median(rs.filter(r=>r.success).map(r=>r.elapsedMs)),knownTokens:rs.reduce((n,r)=>n+r.knownTokens,0),tokens:rs.some(r=>r.tokens===null)?null:rs.reduce((n,r)=>n+r.tokens!,0),calls:rs.reduce((n,r)=>n+r.calls,0)}];}));
  const comparisons=Object.fromEntries(['single','fixed-all'].map(reference=>{
   const pairs=selected.flatMap(c=>{const a=valid(c.id,reference),b=valid(c.id,'planned');return a&&b?[[a,b] as const]:[];}),both=pairs.filter(([a,b])=>a.success&&b.success);
   return [reference,{pairs:pairs.length,bothSuccess:both.length,referenceOnly:pairs.filter(([a,b])=>a.success&&!b.success).length,plannedOnly:pairs.filter(([a,b])=>!a.success&&b.success).length,
    referenceFaster:both.filter(([a,b])=>a.elapsedMs<b.elapsedMs).length,plannedFaster:both.filter(([a,b])=>b.elapsedMs<a.elapsedMs).length,medianPlannedOverReference:median(both.map(([a,b])=>b.elapsedMs/a.elapsedMs))}];
  }));
  const plans=selected.flatMap(c=>{const r=valid(c.id,'planned');return r&&r.proposedPacketCount!==null?[r]:[];});
  return {methods,comparisons,planning:{validPlans:plans.length,onePacket:plans.filter(r=>r.plannerChoseSingle).length,allTargetsOnePacket:plans.filter(r=>r.allTargetsOnePacket).length,
   medianProposedPackets:median(plans.map(r=>r.proposedPacketCount!)),medianExecutedPackets:median(plans.flatMap(r=>r.executedPacketCount===null?[]:[r.executedPacketCount])),
   medianWritableTargets:median(plans.flatMap(r=>r.plannedWritableCount===null?[]:[r.plannedWritableCount])),medianChangedTargets:median(plans.map(r=>r.changedTargetCount)),medianPlannerMs:median(plans.map(r=>r.plannerMs))}};
 };
 return {overall:group(cases),topology:Object.fromEntries([...new Set(cases.map(c=>c.topology))].sort().map(v=>[v,group(cases.filter(c=>c.topology===v))])),dependencyDepth:Object.fromEntries([...new Set(cases.map(c=>c.dependencyDepth))].sort((a,b)=>a-b).map(v=>[v,group(cases.filter(c=>c.dependencyDepth===v))])),family:Object.fromEntries([...new Set(cases.map(c=>c.family))].map(f=>[f,group(cases.filter(c=>c.family===f))])),targetCount:Object.fromEntries([...new Set(cases.map(c=>c.targetCount))].sort((a,b)=>a-b).map(n=>[n,group(cases.filter(c=>c.targetCount===n))]))};
}
