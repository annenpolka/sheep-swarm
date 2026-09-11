import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseCommandArgs} from '../src/cli-options.ts';

test('profiles preserve CLI defaults and count the correct roles',async t=>{
  const {resolveCliProfile}=await import('../src/cli-profile.ts');
  const cwd=await mkdtemp(join(tmpdir(),'sheep-profile-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const s=await resolveCliProfile('swarm',{},cwd);assert.equal(s.options.maxCalls,20);assert.equal(s.options.maxRounds,20);
  assert.equal(s.limits.workerCalls,20);assert.equal(s.limits.totalCalls,null);assert.equal(s.budget.unit,'none');
  const c=await resolveCliProfile('compare',{},cwd);assert.equal(c.limits.totalCalls,48);assert.equal(c.limits.metaCalls,48);assert.equal(c.budget.unit,'tokens');
  const m=await resolveCliProfile('mechanism',{},cwd);assert.equal(m.options.maxTokensPerCall,60000);assert.equal(m.limits.totalCalls,400);assert.equal(m.budget.unit,'credits');
  const d=await resolveCliProfile('durable',{directory:'run'},cwd);assert.equal(d.options.maxCalls,24);assert.equal(d.configuration.concurrency,1);
  assert.deepEqual(await readdir(cwd),[]);
});
test('profiles reject incompatible runtime, budget and values before execution',async()=>{
  const {resolveCliProfile}=await import('../src/cli-profile.ts');
  for(const [cmd,args] of [ ['swarm',['--workers','1','--concurrency','2']],['swarm',['--workers','NaN']],['swarm',['--size','1']],['compare',['--size','65']],['mechanism',['--groups','17']],
    ['swarm',['--runtime','opencode-go']],['swarm',['--runtime','opencode-go','--worker-model','deepseek-flash','--worker-tools','local']],
    ['mechanism',['--runtime','opencode-go','--worker-model','deepseek-flash']],
    ['mechanism',['--budget-mode','credits','--max-tokens','100']],
    ['mechanism',['--budget-mode','tokens','--max-tokens','1000','--reserve-tokens','10','--max-credits','5']],
    ['mechanism',['--budget-mode','tokens']],['compare',['--reserve-tokens','999999']],['durable',['--directory','x','--runtime','docker-agent']],
  ] as const)await assert.rejects(resolveCliProfile(cmd,parseCommandArgs(cmd,[...args]).values));
});
test('repository dry profile reads the manifest but never executes checks or creates output',async t=>{
  const {resolveCliProfile}=await import('../src/cli-profile.ts');
  const cwd=await mkdtemp(join(tmpdir(),'sheep-repo-profile-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'task.json'),JSON.stringify({version:1,goal:'test',files:[{path:'a.mjs',instructions:'test'}],protected:['check.mjs'],checks:[{argv:['deliberately-missing-command']}]}));
  const p=await resolveCliProfile('repo',{repo:'.',task:'task.json',output:'run',runtime:'opencode-go','worker-model':'deepseek-flash','go-thinking':'disabled','max-calls':'12'},cwd);
  assert.equal(p.options.workerModel,'deepseek-flash');assert.equal(p.options.goThinking,'disabled');assert.equal(p.options.apply,false);
  assert.equal(p.limits.workerCalls,12);assert.equal(p.limits.metaCalls,2);assert.equal(p.outputDirectory,join(cwd,'run'));
  const defaults=await resolveCliProfile('repo',{repo:'.',task:'task.json',runtime:'opencode-go','worker-model':'deepseek-flash'},cwd);
  assert.equal(defaults.options.goThinking,'enabled');
  assert.deepEqual(await readdir(cwd),['task.json']);
  await assert.rejects(resolveCliProfile('repo',{repo:'.',task:'task.json',runtime:'docker-agent'},cwd));
});
