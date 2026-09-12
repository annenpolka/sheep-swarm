import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,METHODS} from '../experiments/lazy-benchmark.ts';
import {median} from '../experiments/synthetic-paired.ts';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
/** Publish accounting and evidence identities only, never raw model reasoning or private fixtures. */
export async function publish(root,destination){
 const report=await load(join(root,'audit.json')),state=await load(join(root,'state.json'));
 assert(report.complete&&report.completedRuns===54,'completed independent audit required');
 assert.equal(state.profileHash,report.profileHash);assert.equal(hash(await readFile(join(root,'profile.json'))),report.profileHash);
 const attempts=state.groups.flatMap(g=>g.attempts);
 const metrics=Object.fromEntries(['all','local','independent','coupled'].map(group=>[group,Object.fromEntries(METHODS.map(method=>{
  const rows=report.rows.filter(r=>(group==='all'||r.group===group)&&r.method===method),as=attempts.filter(a=>(group==='all'||a.group===group)&&a.method===method);
  const sum=k=>as.reduce((n,a)=>n+(a.metrics?.[k]??0),0);
  return [method,{inputTokens:as.reduce((n,a)=>n+(a.inputTokens??0),0),outputTokens:as.reduce((n,a)=>n+(a.outputTokens??0),0),retries:as.length-rows.length,changedTargetMedian:median(rows.filter(r=>r.success).map(r=>r.changedTargetCount)),rejectedToolCalls:sum('rejectedToolCalls'),rootContinuationCalls:sum('rootContinuationCalls'),rootCallsAfterJoin:sum('rootCallsAfterJoin'),joinWaitMs:sum('joinWaitMs'),discardedChildTokens:as.some(a=>a.metrics?.discardedChildTokens===null)?null:sum('discardedChildTokens'),firstForkMedianMs:median(as.flatMap(a=>a.metrics?.firstForkMs==null?[]:[a.metrics.firstForkMs]))}];
 }))]));
 const adoption=Object.fromEntries(['local','independent','coupled'].map(group=>{
  const s=report.summary[group],threshold=report.profile.adoption.medianLazyOverEachReference[group];
  return [group,Object.fromEntries(['packet-all','root-only'].map(ref=>{
   const p=s.comparisons[ref],available=p.pairs===6,quality=available&&s.methods.lazy.successes>=s.methods[ref].successes;
   const speed=available&&p.medianLazyOverReference!==null&&p.medianLazyOverReference<=threshold;
   return [ref,{available,quality,speed,threshold,observedRatio:p.medianLazyOverReference,pass:available&&quality&&speed}];
  }))];
 }));
 const rootAgainstPacket=Object.fromEntries(['all','local','independent','coupled'].map(group=>{
  const rows=report.rows.filter(r=>(group==='all'||r.group===group)&&!r.evidenceErrors.length);
  const pairs=rows.filter(r=>r.method==='root-only').flatMap(root=>{const packet=rows.find(r=>r.id===root.id&&r.method==='packet-all');return packet?[[root,packet]]:[];}),both=pairs.filter(([a,b])=>a.success&&b.success);
  return [group,{pairs:pairs.length,bothSuccess:both.length,rootFaster:both.filter(([a,b])=>a.elapsedMs<b.elapsedMs).length,packetFaster:both.filter(([a,b])=>b.elapsedMs<a.elapsedMs).length,medianRootOverPacket:median(both.map(([a,b])=>a.elapsedMs/b.elapsedMs))}];
 }));
 const preflight=[];for(const c of report.profile.cases){const p=await load(join(root,'preflight',c.id+'.json'));assert(p.ok);preflight.push({id:c.id,hashes:p.hashes,baselineAssertionFailure:p.baseline.finalAssertionFailure,referencePass:p.reference.publicPass&&p.reference.finalPass,mutants:p.mutants.length,detected:p.mutants.filter(m=>m.result.finalAssertionFailure).length,hiddenOnly:p.mutants.filter(m=>m.result.publicPass&&m.result.finalAssertionFailure).length,requiredImplementations:p.mutants.filter(m=>m.id.startsWith('missing-body-')).length});}
 const evidenceFiles={};for(const a of attempts){for(const name of await readdir(a.directory)){if(!/^(call-\d+(\.request)?|row|result|artifacts|independent-check|messages|kernel|budget)\.json$/.test(name))continue;const p=join(a.directory,name);evidenceFiles[relative(root,p)]=hash(await readFile(p));}}
 const result={format:1,series:'lazy-benchmark-dev-v2',generatedAt:new Date().toISOString(),profileHash:report.profileHash,complete:report.complete,completedRuns:report.completedRuns,plannedRuns:report.plannedRuns,profile:report.profile,summary:report.summary,accounting:report.accounting,metrics,rootAgainstPacket,adoption,adoptionNecessaryCriteriaPass:Object.values(adoption).every(g=>Object.values(g).every(x=>x.pass)),preflight,rows:report.rows.map(({directory,attemptDirectories,...row})=>({...row,directory:relative(root,directory),attemptDirectories:attemptDirectories.map(p=>relative(root,p))})),attempts:attempts.map(({budget,directory,...a})=>({...a,directory:relative(root,directory),unknownUsageCalls:budget.unknownUsageCalls})),evidenceFiles,rawEvidenceRoot:root};
 await writeFile(destination,JSON.stringify(result,null,2)+'\n');return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){const [root,destination]=process.argv.slice(2);if(!root||!destination)throw new Error('Usage: node scripts/report-lazy-benchmark.mjs DIRECTORY OUTPUT.json');const r=await publish(resolve(root),resolve(destination));console.log(JSON.stringify({complete:r.complete,runs:r.completedRuns,adoptionNecessaryCriteriaPass:r.adoptionNecessaryCriteriaPass,accounting:r.accounting}));}
