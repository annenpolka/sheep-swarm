import {readFile} from 'node:fs/promises';
import {parseRepoTask} from '../src/repo-manifest.ts';
import type {RepoTask} from '../src/repo-types.ts';
// @ts-expect-error host fixture
import {buildQualitySpeedFixture} from '../scripts/quality-speed-fixture.mjs';
// @ts-expect-error host-only independent reference
import {referenceContents} from '../scripts/quality-speed-reference.mjs';
export interface TrialFixture {files:Record<string,string>;task:RepoTask;reference:Record<string,string>;mutant:Record<string,string>;changedPaths:readonly string[]}
export async function qualityFixture(kind:'multiple'|'healthy'|'branching'):Promise<TrialFixture>{
 const f=buildQualitySpeedFixture('propagation',1),reference=referenceContents('propagation') as Record<string,string>;
 const seed=JSON.parse(await readFile(new URL('./upstream-recovery-seed.json',import.meta.url),'utf8'));
 const files:Record<string,string>={...f.files,...(kind==='healthy'?{...reference,'invoice.mjs':f.files['invoice.mjs']}:seed)};
 const task={...f.task,activation:{changedPaths:['invoice.mjs']}};
 if(kind==='branching'){
  files['invoice-b.mjs']=files['invoice.mjs']!;reference['invoice-b.mjs']=reference['invoice.mjs']!;
  files['public-b.mjs']=files['public-check.mjs']!.replaceAll('invoice.mjs','invoice-b.mjs');
  files['holdout-b.mjs']=files['holdout.mjs']!.replaceAll('invoice.mjs','invoice-b.mjs');
  task.files=[...task.files,{...task.files.find((f:{path:string})=>f.path==='invoice.mjs'),path:'invoice-b.mjs',checks:[{argv:[process.execPath,'public-b.mjs','invoice-b.mjs']}]}];
  task.context=[...task.context,'public-b.mjs'];task.protected=[...task.protected,'holdout-b.mjs'];task.checks=[...task.checks,{argv:[process.execPath,'holdout-b.mjs']}];task.activation.changedPaths.push('invoice-b.mjs');
 }
 const mutant={...reference,'amount.mjs':reference['amount.mjs']!.replace('const digits=parts[0]',"if(value.startsWith('00'))return null;const digits=parts[0]")};
 return {files,task:parseRepoTask(task),reference,mutant,changedPaths:task.activation.changedPaths};
}
export function freshFixture(family:'independent'|'propagation'):TrialFixture{
 const f=buildQualitySpeedFixture(family,0),reference=referenceContents(family) as Record<string,string>;
 return {files:f.files,task:parseRepoTask(f.task),reference,mutant:{...reference,'amount.mjs':f.files['amount.mjs']},changedPaths:[]};
}
/** Eight independent two-stage branches. Only two configurations changed. */
export function parallelFixture():TrialFixture{
 const files:Record<string,string>={},reference:Record<string,string>={},tasks=[];
 const contexts=[],changedPaths=['config-0.mjs','config-1.mjs'];
 for(let i=0;i<8;i++){
  const factor=i+2,shift=i+1;
  files[`config-${i}.mjs`]=`export const factor=${factor};export const shift=${shift};\n`;contexts.push(`config-${i}.mjs`);
  const a=`compute-${i}.mjs`,b=`report-${i}.mjs`;
  reference[a]=`import {factor} from './config-${i}.mjs';\nexport function compute(value){return Number.isInteger(value)&&value>=-1000000&&value<=1000000?value*factor:null;}\n`;
  reference[b]=`import {compute} from './compute-${i}.mjs';\nimport {shift} from './config-${i}.mjs';\nexport function report(values){if(!Array.isArray(values))return null;const out=[];for(const value of values){const n=compute(value);if(n===null)return null;out.push(n+shift);}return out;}\n`;
  files[a]=i<2?reference[a]!.replace('value*factor','value*(factor-1)'):reference[a]!;
  files[b]=i<2?reference[b]!.replace('n+shift','n+shift-1'):reference[b]!;
  tasks.push({path:a,instructions:'Export compute(value). Accept an integer in [-1000000,1000000], returning value*factor imported from the matching config file; otherwise null. Use the current factor exactly, never subtract an old offset.',checks:[{argv:[process.execPath,'public-check.mjs',a]}]},
   {path:b,instructions:'Export report(values). Accept an array. Use compute from the matching compute file for each value; return null for any invalid element. Return a new array of each result plus the current shift from matching config. Preserve input. Empty array returns [].',checks:[{argv:[process.execPath,'public-check.mjs',b]}]});
 }
 files['public-check.mjs']=`import assert from 'node:assert/strict';const path=process.argv[2];const i=Number(/-(\\d+)/.exec(path)[1]);const {factor,shift}=await import('./config-'+i+'.mjs');const module=await import('./'+path);if(path.startsWith('compute')){assert.equal(module.compute(2),2*factor);assert.equal(module.compute('2'),null);}else{assert.deepEqual(module.report([2,0]),[2*factor+shift,shift]);assert.equal(module.report(null),null);}\n`;
 contexts.push('public-check.mjs');
 files['holdout.mjs']=`import assert from 'node:assert/strict';for(let i=0;i<8;i++){const f=i+2,s=i+1;const {compute}=await import('./compute-'+i+'.mjs');const {report}=await import('./report-'+i+'.mjs');for(const x of [-1000001,-1000000,-3,0,11,1000000,1000001,1.5,'2',null,NaN,Infinity]){const valid=typeof x==='number'&&Number.isInteger(x)&&x>=-1000000&&x<=1000000;assert.equal(compute(x),valid?x*f:null);assert.deepEqual(report([x]),valid?[x*f+s]:null);}assert.deepEqual(report([]),[]);const xs=[1,-2,3],before=[...xs];assert.deepEqual(report(xs),xs.map(x=>x*f+s));assert.deepEqual(xs,before);assert.equal(report({}),null);}console.log('accepted');\n`;
 const task=parseRepoTask({version:2,goal:'Propagate the current configuration through every declared compute and report function. Preserve interfaces and all validity requirements.',files:tasks,context:['public-check.mjs'],protected:['holdout.mjs'],checks:[{argv:[process.execPath,'holdout.mjs']}],discovery:{mode:'static',readable:contexts.filter(p=>p!=='public-check.mjs'),maxReadCalls:0,maxPathsPerRead:8,maxDeliveredBytes:1048576}});
 // Public check text is shared evidence; configuration files stay branch-local
 // through static imports rather than making every target depend on every config.
 return {files,task,reference,mutant:{...reference,'compute-7.mjs':reference['compute-7.mjs']!.replace('value*factor','value*(factor-1)')},changedPaths};
}
