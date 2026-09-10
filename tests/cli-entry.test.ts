import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveCliProfile} from '../src/cli-profile.ts';
import {runDurableSwarm} from '../src/durable-run.ts';
import {createFixture} from '../src/fixture.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const run=(entry:string,args:string[],cwd:string)=>spawnSync(process.execPath,[join(root,'src',entry),...args],{cwd,encoding:'utf8',timeout:10000});
const entries={repo:'repo-cli.ts',swarm:'cli.ts',compare:'compare-cli.ts',durable:'durable-cli.ts',mechanism:'mechanism-cli.ts'} as const;

test('root and every old/new command help exit successfully without run side effects',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'sheep-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  for(const [command,entry] of Object.entries(entries))for(const [file,args] of [[entry,['--help']],['sheep-cli.ts',[command,'--help']]] as const){
    const r=run(file,[...args],cwd);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/--dry-run/);assert.match(r.stdout,/Defaults:/);
  }
  assert.equal(run('sheep-cli.ts',['--help'],cwd).status,0);assert.deepEqual(await readdir(cwd),[]);
});

test('new and old dry-run resolve identical options, aliases and zero-budget compatibility',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'sheep-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(join(cwd,'task.json'),JSON.stringify({version:1,goal:'g',files:[{path:'a.mjs',instructions:'i'}],protected:['check.mjs'],checks:[{argv:['MUST_NOT_EXECUTE']}]}));
  for(const command of Object.keys(entries) as (keyof typeof entries)[]){
    const args=command==='repo'?['--repo','.', '--task','task.json']:command==='durable'?['--directory','out']:['--output','out'];
    const legacy=run(entries[command],[...args,'--dry-run'],cwd);const current=run('sheep-cli.ts',[command,...args,'--dry-run'],cwd);
    assert.equal(legacy.status,0,legacy.stderr);assert.equal(current.status,0,current.stderr);
    const a=JSON.parse(legacy.stdout),b=JSON.parse(current.stdout);
    if(command==='repo'){a.outputDirectory=b.outputDirectory; a.options.outputDirectory=b.options.outputDirectory;}
    assert.deepEqual(a,b);assert.equal(b.status,'planned');
    assert.equal(b.configuration.maxTokensPerCall,b.options.maxTokensPerCall);
  }
  const zero=await resolveCliProfile('swarm',{'max-calls':'0','max-rounds':'0'});assert.equal(zero.options.maxCalls,0);
  assert.equal((await resolveCliProfile('mechanism',{'max-credits':'0'})).budget.maxCredits,0);
  assert.deepEqual(await readdir(cwd),['task.json']);
});

test('invalid entry arguments exit with the intended legacy/new code before creating output',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'sheep-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  for(const [command,args] of [['repo',['--resume']],['durable',['--directory','out','--concurrency','2']],['swarm',['--workers','NaN']],
    ['compare',['--max-calls','3','--max-total-calls','3']],['mechanism',['--budget-mode','tokens']],['swarm',['--runtime','opencode-go']]] as const){
    for(const [entry,prefix,status] of [[entries[command],[],1],['sheep-cli.ts',[command],2]] as const){
      const r=run(entry,[...prefix,...args],cwd);assert.equal(r.status,status,r.stderr);assert.equal(r.stdout,'');
    }
  }
  assert.equal(run('sheep-cli.ts',['unknown'],cwd).status,2);assert.deepEqual(await readdir(cwd),[]);
});

test('real dispatch preserves legacy summary while new output reports effective configuration',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'sheep-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  for(const legacy of [true,false]){
    const r=run(legacy?'cli.ts':'sheep-cli.ts',[...(legacy?[]:['swarm']),'--max-worker-calls','0','--output',legacy?'old':'new'],cwd);
    assert.equal(r.status,1,r.stderr);const out=JSON.parse(r.stdout);
    if(legacy){assert.deepEqual(Object.keys(out).sort(),['durationMs','finalErrors','interventions','lowerCalls','maxActiveWorkers','outputDirectory','success','upperCalls'].sort());assert.equal(out.lowerCalls,0);}
    else{assert.equal(out.format,1);assert.equal(out.command,'swarm');assert.equal(out.limits.workerCalls,0);assert.equal(out.result.lowerCalls,0);}
  }
});

test('durable dry-run reads authoritative state without touching DB files and rejects changed resume settings',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'sheep-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const directory=join(cwd,'saved');
  const fixture=createFixture({size:2,variant:'migrated'});
  const first=await runDurableSwarm({directory,size:2,workers:2,maxCalls:6,maxMetaCalls:0},async o=>({requestedModel:o.model,
    result:{content:fixture.artifacts[JSON.parse(o.prompt).target]!,note:'fixture'},usage:[{event:{},inputTokens:1,outputTokens:1}],
    transcript:{events:[],usage:[],requestedModel:o.model,effectiveModelEvidence:null,stdout:'',stderr:'',exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}}));
  assert.equal(first.success,true);
  // A stale result file must never override the transactional source of truth.
  await writeFile(join(directory,'result.json'),'{}');
  const names=await readdir(directory),dbNames=names.filter(n=>n.startsWith('state.sqlite')),before=await Promise.all(dbNames.map(n=>readFile(join(directory,n))));
  const dry=run('sheep-cli.ts',['durable','--output',directory,'--resume','--dry-run'],cwd);assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).configuration.workers,2);assert.equal(JSON.parse(dry.stdout).limits.workerCalls,6);
  const bad=run('sheep-cli.ts',['durable','--output',directory,'--resume','--workers','4','--dry-run'],cwd);assert.equal(bad.status,2);assert.match(bad.stderr,/resume configuration mismatch/);
  assert.deepEqual(await readdir(directory),names);assert.deepEqual(await Promise.all(dbNames.map(n=>readFile(join(directory,n)))),before);
  const resumed=run('durable-cli.ts',['--directory',directory,'--resume'],cwd);assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).lowerCalls,first.lowerCalls);
});
