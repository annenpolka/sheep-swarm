import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {repository} from './repo-test-helpers.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {runRepository} from '../src/repo-run.ts';
import type {RepoCaller} from '../src/repo-types.ts';

const spec=(changedPaths:string[])=>({version:2,goal:'Propagate the new value through a and b; keep unrelated code unchanged.',files:[{path:'a.ts',instructions:'Export value=policy.value',checks:[]},{path:'b.ts',instructions:'Export value=a.value+1',checks:[]},{path:'unused.ts',instructions:'Preserve value=7',checks:[]}],context:[],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs']}],discovery:{mode:'static+reads',readable:['policy.ts'],maxPathsPerRead:1},activation:{changedPaths}});
const contents={
 'policy.ts':'export const value=42;',
 'a.ts':"import {value as p} from './policy.ts';export const value=0;",
 'b.ts':"import {value as a} from './a.ts';export const value=0;",
 'unused.ts':'export const value=7;',
 'check.mjs':"import assert from 'node:assert/strict';import {value as a} from './a.ts';import {value as b} from './b.ts';import {value as u} from './unused.ts';assert.equal(a,42);assert.equal(b,43);assert.equal(u,7);",
};
const reply=(content:string):RepoCaller=>async o=>({requestedModel:o.model,result:{kind:'write',content,paths:[],observed:[],missing:[],hypothesis:'',note:''},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'injected-test',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}});
const profile={runtime:'opencode-go' as const,workerModel:'deepseek-flash',workers:4,concurrency:2,maxCalls:8,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100};

test('activation is opt-in, public-scoped and unavailable on v1',()=>{
 const valid=parseRepoTask(spec(['policy.ts']));assert.deepEqual(valid.activation,{changedPaths:['policy.ts']});
 for(const activation of [null,{}, {changedPaths:['missing.ts']},{changedPaths:['policy.ts','policy.ts']},{changedPaths:['.env']},{changedPaths:[],confidence:1}])assert.throws(()=>parseRepoTask({...spec([]),activation}));
 assert.throws(()=>parseRepoTask({...spec([]),version:1}));
 const {activation:_,...all}=spec([]);assert.equal(parseRepoTask(all).activation,undefined);
});

test('changed provider activates only dependent targets and delivers the accepted provider version',async t=>{
 const root=await repository(contents);t.after(()=>rm(root,{recursive:true,force:true}));
 const seen:string[]=[];
 const run=await runRepository({...profile,repository:root,task:spec(['policy.ts']),outputDirectory:join(root,'run'),apply:true},async o=>{
   if(o.prompt.includes('Update only a.ts')){seen.push('a');return reply("import {value as p} from './policy.ts';export const value=p;")(o);}
   assert.match(o.prompt,/Update only b.ts/);seen.push('b');
   const local=JSON.parse(/Local files:\n([^\n]+)\n/.exec(o.prompt)![1]!);assert.match(local['a.ts'],/value=p/);
   return reply("import {value as a} from './a.ts';export const value=a+1;")(o);
 });
 assert.equal(run.success,true,run.errors.join('\n'));assert.deepEqual(seen,['a','b']);assert.equal(run.applied,true);
 assert.deepEqual(run.changedPaths,['a.ts','b.ts']);assert.equal(run.discovery!.initiallyActivatedTargets,2);assert.equal(run.discovery!.activatedTargets,2);
 assert.equal(await readFile(join(root,'unused.ts'),'utf8'),contents['unused.ts']);
 const activation=JSON.parse(await readFile(join(root,'run/activation.json'),'utf8'));assert.deepEqual(activation.unaffectedTargets,['unused.ts']);
 const noOp=await runRepository({...profile,repository:root,task:spec([]),outputDirectory:join(root,'noop')},async()=>{throw new Error('must not call');});
 assert.equal(noOp.success,true,noOp.errors.join('\n'));assert.equal(noOp.swarm.lowerCalls,0);
});

test('missed semantic dependencies fail the full oracle instead of reporting idle as completion',async t=>{
 const root=await repository(contents);t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'a.ts'),'export const value=0;');await writeFile(join(root,'b.ts'),'export const value=0;');
 const run=await runRepository({...profile,repository:root,task:spec(['policy.ts']),outputDirectory:join(root,'missed'),apply:true},async()=>{throw new Error('must not call');});
 assert.equal(run.swarm.lowerCalls,0);assert.equal(run.success,false);assert.equal(run.applied,false);assert.ok(run.errors.length);
});
