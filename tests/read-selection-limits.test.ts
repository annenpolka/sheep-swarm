import assert from 'node:assert/strict';
import test from 'node:test';
import {rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {runRepository} from '../src/repo-run.ts';
import {repository,manifest} from './repo-test-helpers.ts';
import type {RepoCaller} from '../src/repo-types.ts';
const task=(maxPathsPerRead?:unknown)=>({...manifest(),version:2,discovery:{mode:'static+reads',readable:['x.json','y.json'],...(maxPathsPerRead===undefined?{}:{maxPathsPerRead})}});
const response=(kind:string,paths:string[],content=''):RepoCaller=>async o=>({requestedModel:o.model,result:{kind,content,paths,observed:[],missing:[],hypothesis:'',note:'fixture'},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'test-only',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}});
const profile={runtime:'opencode-go' as const,workerModel:'deepseek-flash',workers:2,concurrency:1,maxCalls:4,maxMetaCalls:0,maxTokens:1000,reserveTokensPerCall:100};

test('read path cap defaults to legacy 32 and rejects zero, malformed and excessive limits',()=>{
  assert.equal(parseRepoTask(task()).discovery!.maxPathsPerRead,32);
  for(const n of [1,2,32])assert.equal(parseRepoTask(task(n)).discovery!.maxPathsPerRead,n);
  for(const n of [0,-1,33,1.5,NaN,'1',null])assert.throws(()=>parseRepoTask(task(n)));
  assert.throws(()=>parseRepoTask({...manifest(),discovery:{maxPathsPerRead:1}}));
});

test('over-cap requests stop unresolved without any partial delivery or write',async t=>{
  const root=await repository({'x.json':'X','y.json':'Y'});t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const r=await runRepository({...profile,repository:root,task:task(1),outputDirectory:join(root,'run'),apply:true},async o=>{
    calls++;assert.match(o.prompt,/at most 1 paths/);return response('read',['x.json','y.json'])(o);
  });assert.equal(calls,1);assert.equal(r.success,false);assert.equal(r.applied,false);
  const reads=JSON.parse(await readFile(join(root,'run','read-deliveries.json'),'utf8'));assert.equal(reads.requests[0].reason,'read-path-limit');assert.deepEqual(reads.deliveries,[]);
  assert.equal(await readFile(join(root,'a.mjs'),'utf8'),'export const value = 0;\n');
});

test('cap applies to new import read requests, while existing static closure is delivered intact',async t=>{
  const root=await repository({'x.mjs':"export {value} from './y.mjs';",'y.mjs':'export const value=42;'});t.after(()=>rm(root,{recursive:true,force:true}));
  const spec={...task(1),discovery:{...task(1).discovery,readable:['x.mjs','y.mjs']}};
  const blocked=await runRepository({...profile,repository:root,task:spec,outputDirectory:join(root,'new-import')},response('write',[],"export {value} from './x.mjs';"));
  assert.equal(blocked.success,false);assert.equal(blocked.swarm.lowerCalls,1);
  let reads=0;
  const requested=await runRepository({...profile,repository:root,task:spec,outputDirectory:join(root,'one-path-transitive')},async o=>{
    if(reads++===0)return response('read',['x.mjs'])(o);
    const local=JSON.parse(/Local files:\n([^\n]+)\n/.exec(o.prompt)![1]!);
    assert.ok(local['x.mjs']);assert.ok(local['y.mjs']);
    return response('write',[],"export {value} from './x.mjs';")(o);
  });assert.equal(requested.success,true,requested.errors.join('\n'));assert.equal(requested.swarm.lowerCalls,2);
  const {writeFile}=await import('node:fs/promises');await writeFile(join(root,'a.mjs'),"export {value} from './x.mjs';");
  const r=await runRepository({...profile,repository:root,task:spec,outputDirectory:join(root,'initial-import')},async o=>{
    const local=JSON.parse(/Local files:\n([^\n]+)\n/.exec(o.prompt)![1]!);assert.equal(local['x.mjs'],"export {value} from './y.mjs';");assert.equal(local['y.mjs'],'export const value=42;');return response('write',[],"export {value} from './x.mjs';")(o);
  });assert.equal(r.success,true,r.errors.join('\n'));assert.equal(r.swarm.lowerCalls,1);
});
