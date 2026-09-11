import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {buildSyntheticTask} from '../experiments/synthetic-corpus/index.ts';
import {materializeSyntheticTask,preflightSyntheticTask} from './synthetic-corpus.ts';
import {runSingleRepository} from '../experiments/repository-single.ts';
import {runRepository} from '../src/repo-run.ts';
import {runPacketRepository,prepareRepositoryPackets} from '../src/repo-packet-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
const digest=x=>createHash('sha256').update(x).digest('hex');
const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n');
async function sources(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?sources(join(dir,e.name)):[join(dir,e.name)]))).flat();}
export async function packetSmoke(outputDirectory) {
 const output=resolve(outputDirectory);await mkdir(output);
 const f=buildSyntheticTask('syn-apportion-v00');assert.equal(f.metadata.split,'dev');
 const lock=JSON.parse(await readFile('experiments/synthetic-corpus-v1-lock.json','utf8'));assert.deepEqual(f.hashes,lock.cases.find(c=>c.id===f.metadata.id).hashes);
 const preflight=await preflightSyntheticTask(f);await save(join(output,'preflight.json'),preflight);assert.ok(preflight.ok);
 const repository=join(output,'fixture');await materializeSyntheticTask(f,repository);
 for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Frozen packet smoke input']])execFileSync('git',args,{cwd:repository});
 const task=f.task,limits={maxCalls:16,maxTokens:2000000,reserveTokensPerCall:200000,maxTokensPerCall:64000,timeoutMs:600000};
 const base={repository,task,...limits,runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxMetaCalls:0,concurrency:4,maxRounds:256};
 const methods=['legacy-single','packet-all','packet-2','packet-1','legacy-sheep'];
 const runtimeHashes={};
 for(const p of [...await sources('src'),...await sources('experiments/synthetic-corpus'),'experiments/repository-single.ts','experiments/repository-patch.ts','scripts/packet-smoke.mjs','scripts/synthetic-corpus.ts','package.json','package-lock.json']) {
  const bytes=await readFile(p);runtimeHashes[p]=digest(bytes);const destination=join(output,'runtime',p);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);
 }
 const plans={};for(const size of ['all',2,1])plans[size]=(await prepareRepositoryPackets({...base,packetSize:size,outputDirectory:join(output,'unused')})).plan;
 const profile={format:1,purpose:'compatibility smoke, not a granularity performance study',case:f.metadata.id,hashes:f.hashes,model:'opencode-go/deepseek-flash',thinking:'enabled',limits,
  upperCalls:0,taskDeadlineMs:null,concurrencyCeiling:4,legacySheepWorkers:4,repeats:1,order:methods,plans,runtimeHashes};
 await save(join(output,'profile.json'),profile);
 const snapshot=await captureRepository(repository,task),rows=[];
 for(const method of methods) {
  for(const [p,h] of Object.entries(runtimeHashes))assert.equal(digest(await readFile(p)),h,'runtime changed during smoke');
  const directory=join(output,method);const begin=performance.now();
  await save(join(output,'state.json'),{inFlight:method,completed:rows.map(r=>r.method)});
  const r=method==='legacy-single'?await runSingleRepository({...limits,repository,task,outputDirectory:directory}):
   method==='legacy-sheep'?await runRepository({...base,workers:4,outputDirectory:directory}):
   await runPacketRepository({...base,packetSize:method==='packet-all'?'all':Number(method.split('-')[1]),outputDirectory:directory});
  const elapsedMs=performance.now()-begin;
  const artifacts=JSON.parse(await readFile(join(directory,'artifacts.json'),'utf8'));
  const audit=await runRepoChecks(snapshot,artifacts,[...task.files.flatMap(x=>x.checks),...task.checks],join(output,'audit'));
  const current=await captureRepository(repository,task);
  const sourceUnchanged=current.head===snapshot.head&&current.entries.size===snapshot.entries.size&&[...snapshot.entries].every(([p,e])=>current.entries.get(p)?.bytes.equals(e.bytes)&&current.entries.get(p)?.mode===e.mode);
  const b=r.budget,known=b.unknownUsageCalls===0&&b.activeReservations===0&&b.reservationOverruns===0;
  const row={method,success:r.success&&audit.ok&&sourceUnchanged&&known,runnerSuccess:r.success,auditPass:audit.ok,sourceUnchanged,
   elapsedMs,completionMs:r.success&&audit.ok&&sourceUnchanged&&known?elapsedMs:null,knownTokens:b.observedTokens,totalTokens:known?b.observedTokens:null,
   calls:r.lowerCalls??r.swarm?.lowerCalls??r.calls.length,upperCalls:r.upperCalls??r.swarm?.upperCalls??0,
   maxConcurrentModelCalls:r.maxConcurrentModelCalls??r.swarm?.maxActiveWorkers??1,
   termination:r.termination??(r.success?'accepted':'failed'),budget:b};
  rows.push(row);await save(join(output,'summary.json'),{profileHash:digest(JSON.stringify(profile)),complete:rows.length===methods.length,rows});
  process.stdout.write(JSON.stringify(row)+'\n');
  if(!known||b.locked||r.infrastructureFailure||!sourceUnchanged||audit.executionFailure||(r.errors??[]).some(e=>/infrastructure|unknown|usage/.test(e))) {
   await save(join(output,'state.json'),{inFlight:null,stopped:true,reason:'evidence-or-infrastructure',completed:rows.map(r=>r.method)});throw new Error('smoke stopped; retain evidence, do not restart');
  }
 }
 for(const [p,h] of Object.entries(runtimeHashes))assert.equal(digest(await readFile(p)),h);
 assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repository,encoding:'utf8'}),'');
 await save(join(output,'state.json'),{inFlight:null,stopped:false,complete:true,completed:rows.map(r=>r.method)});
 return rows;
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 if(process.argv.length!==3)throw new Error('Usage: node scripts/packet-smoke.mjs NEW_OUTPUT_DIRECTORY (five paid conditions)');
 await packetSmoke(process.argv[2]);
}
