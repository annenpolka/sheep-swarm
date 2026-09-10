import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execute} from './repo-test-helpers.ts';
import {runRepository} from '../src/repo-run.ts';
import type {RepoCaller} from '../src/repo-types.ts';

const prepare=resolve('scripts/prepare-read-selection-pilot.mjs');
const audit=resolve('scripts/audit-read-selection.mjs');
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const solution=(p:{rate:number;minimum:number;cap:number})=>`export function quote(n){return Number.isSafeInteger(n)&&n>=0?Math.min(${p.cap},Math.max(${p.minimum},n))*${p.rate}:null;}`;

test('prepared oracle rejects baseline and wrong-world guesses; accepts both fixed reference worlds',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sheep-read-oracle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let first: {target:string;policy:{rate:number;minimum:number;cap:number}}[]=[];
  for(const world of [0,1]){
    const dir=join(root,String(world)),repo=join(dir,'repo');
    await execute(process.execPath,[prepare,'--output',dir,'--seed','oracle-contract','--world',String(world)]);
    const f=await json(join(dir,'fixture.json'));
    await assert.rejects(execute(process.execPath,['check.mjs'],{cwd:repo}));
    if(world===0)first=f.expectations;
    else{
      for(const e of first)await writeFile(join(repo,e.target),solution(e.policy));
      await assert.rejects(execute(process.execPath,['check.mjs'],{cwd:repo}));
    }
    for(const e of f.expectations)await writeFile(join(repo,e.target),solution(e.policy));
    await execute(process.execPath,['check.mjs'],{cwd:repo});
    await writeFile(join(repo,'a.mjs'),solution(f.expectations[0].policy).replace('Number.isSafeInteger(n)','Number.isFinite(n)'));
    await assert.rejects(execute(process.execPath,['check.mjs'],{cwd:repo}));
    const local=await json(join(dir,'local.json')),broad=await json(join(dir,'broad.json'));
    assert.deepEqual({...local,context:broad.context},broad);assert.deepEqual(local.context,[]);
    assert.deepEqual(broad.context,f.catalog);assert.equal(local.discovery.maxPathsPerRead,1);
  }
});

test('local and broad runs have equal quality with distinct read evidence; audit rejects damaged evidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sheep-read-pair-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=join(root,'fixture'),repo=join(dir,'repo');
  await execute(process.execPath,[prepare,'--output',dir,'--seed','paired-contract']);
  const f=await json(join(dir,'fixture.json'));
  const reports=[];
  for(const condition of ['local','broad']){
    const run=join(root,condition);
    const caller:RepoCaller=async o=>{
      const local=JSON.parse(/Local files:\n([^\n]+)\n/.exec(o.prompt)![1]!);
      assert.equal(local['check.mjs'],undefined);assert.equal(local['fixture.json'],undefined);
      const target=f.targets.find((p:string)=>Object.hasOwn(local,p));assert.ok(target);
      let kind='read',paths=['registry.json'],content='';
      if(local['registry.json']){
        const policyPath=JSON.parse(local['registry.json'])[target];
        paths=[policyPath];
        if(local[policyPath]){kind='write';paths=[];content=solution(JSON.parse(local[policyPath]));}
      }
      return {requestedModel:o.model,result:{kind,paths,content,observed:[],missing:[],hypothesis:'',note:''},usage:[{event:{},inputTokens:10,outputTokens:5}],transcript:{events:[],usage:[{event:{},inputTokens:10,outputTokens:5}],usageCompleteness:'complete',requestedModel:o.model,effectiveModelEvidence:'injected-test',stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
    };
    const report=await runRepository({repository:repo,task:await json(join(dir,condition+'.json')),outputDirectory:run,runtime:'opencode-go',workerModel:'deepseek-flash',workers:4,concurrency:2,maxCalls:12,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:100},caller);
    assert.equal(report.success,true,report.errors.join('\n'));assert.equal(report.applied,false);
    assert.equal(report.swarm.lowerCalls,condition==='local'?6:2);
    const output=join(root,condition+'-audit');
    await execute(process.execPath,[audit,'--run',run,'--fixture',join(dir,'fixture.json'),'--output',output]);
    const summary=await json(join(output,'summary.json'));reports.push(summary);
    assert.equal(summary.qualityPass,true);assert.equal(summary.N,4);assert.equal(summary.C,2);
    assert.equal(summary.audit.valid,true);assert.equal(summary.audit.targets.length,2);
    assert.ok(summary.audit.targets.every((e:{sequentialRead:boolean;policyDeliveredBeforeCommit:boolean})=>e.sequentialRead===(condition==='local')&&e.policyDeliveredBeforeCommit));
    if(condition==='local'){
      const ledger=await json(join(run,'read-deliveries.json')),original=JSON.stringify(ledger);
      ledger.deliveries[0].sha256='bad';await writeFile(join(run,'read-deliveries.json'),JSON.stringify(ledger));
      await assert.rejects(execute(process.execPath,[audit,'--run',run,'--fixture',join(dir,'fixture.json'),'--output',join(root,'bad-hash')]),/delivery does not match/);
      await writeFile(join(run,'read-deliveries.json'),original);
      const reportFile=join(run,'result.json'),saved=await readFile(reportFile,'utf8'),damaged=JSON.parse(saved);
      damaged.budget.unknownUsageCalls=1;await writeFile(reportFile,JSON.stringify(damaged));
      await assert.rejects(execute(process.execPath,[audit,'--run',run,'--fixture',join(dir,'fixture.json'),'--output',join(root,'bad-usage')]),/usage incomplete/);
      await writeFile(reportFile,saved);
    }
  }
  assert.equal(reports[0].tokens,90);assert.equal(reports[1].tokens,30);
  assert.equal((await execute('git',['status','--porcelain'],{cwd:repo})).stdout,'');
});
