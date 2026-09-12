import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {buildLazyCases,structure,lazyOrder,summarizeLazy,type LazyRow} from '../experiments/lazy-benchmark.ts';
import {repository} from './repo-test-helpers.ts';
import {runLazyRepository} from '../src/repo-lazy-run.ts';
import {callOpenCodeGoTurn} from '../src/opencode-go-worker.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {captureRepository} from '../src/repo-files.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
const {auditLazyAttempt}=await import('../scripts/'+'lazy-benchmark-audit.mjs');
const {scaffoldSources}=await import('../scripts/'+'scaffold-lazy-fixture.mjs');
test('lazy benchmark chooses dev by public structure, keeps old hashes and balances all six orders per stratum',async()=>{
 const cases=buildLazyCases(),lock=JSON.parse(await readFile('experiments/synthetic-corpus-v1-lock.json','utf8'));
 assert.equal(cases.length,18);
 for(const c of cases){assert.equal(c.fixture.metadata.split,'dev');if(c.group==='local')assert.deepEqual(c.fixture.hashes,lock.cases.find((x:{id:string})=>x.id===c.id).hashes);
  if(c.group==='independent'){assert.equal(c.fixture.task.files.length,12);assert.equal(structure(c.fixture.task).components,3);}
  if(c.group==='coupled'){assert.equal(c.fixture.task.files.length,16);assert.equal(structure(c.fixture.task).components,1);}
  if(c.group!=='local')assert(c.fixture.metadata.defectedPaths.length>=3);
  for(const p of c.fixture.task.protected)assert(!c.fixture.task.context.includes(p));
 }
 const plan=lazyOrder(cases);assert.equal(plan.length,54);assert.equal(new Set(plan.map(x=>x.id+':'+x.method)).size,54);
 for(const group of ['local','independent','coupled']){
  const selected=cases.filter(c=>c.group===group);assert.equal(new Set(selected.map(c=>plan.filter(p=>p.id===c.id).map(p=>p.method).join(','))).size,6);
 }
});
test('scaffolding preserves signatures and imports without evaluating code or leaving hidden implementation bodies',()=>{
 const input="import {x} from './x.mjs'; export const fixed=2; export function f(s){const secret='PRIVATE_BODY';return `${s}${secret}`;} function helper(){throw Error('no evaluation');}";
 const r=scaffoldSources({'a.mjs':input})['a.mjs'];assert.match(r,/import/);assert.match(r,/fixed=2/);assert.match(r,/function f\(s\)/);assert(!r.includes('PRIVATE_BODY'));assert(!r.includes('no evaluation'));assert.equal((r.match(/return undefined/g)??[]).length,2);
});
test('paired lazy summaries keep quality failures out of time ratios but in success counts and total spend',()=>{
 const row=(method:LazyRow['method'],success:boolean,elapsedMs:number):LazyRow=>({id:'a',group:'local',method,success,elapsedMs,tokens:30,knownTokens:30,calls:1,children:0,forkRequests:0,overlapMs:0,evidenceErrors:[]});
 const rs=[row('packet-all',true,10),row('root-only',true,8),row('lazy',false,20)];const s=summarizeLazy(rs);
 assert.equal(s.local!.comparisons['packet-all']!.referenceOnly,1);assert.equal(s.local!.comparisons['packet-all']!.medianLazyOverReference,null);assert.equal(s.local!.methods.lazy!.knownTokens,30);
 assert.throws(()=>summarizeLazy([...rs,rs[0]!]));
});
test('lazy receipt audit binds raw assistant, public current snapshots, usage and final artifacts',async t=>{
 const root=await repository({'check.mjs':"import assert from 'node:assert/strict';import {value} from './a.mjs';assert.equal(value,42,'PRIVATE');"});t.after(()=>rm(root,{recursive:true,force:true}));
 const task=parseRepoTask({version:1,goal:'value=42',files:[{path:'a.mjs',instructions:'value=42'}],context:[],protected:['check.mjs'],checks:[{argv:[process.execPath,'check.mjs']}]});
 const options={repository:root,task,outputDirectory:join(root,'out'),runtime:'opencode-go' as const,workerModel:'deepseek-flash',maxCalls:2,maxTokens:10000,reserveTokensPerCall:1000,maxTokensPerCall:500,timeoutMs:1000};
 const run=await runLazyRepository({...options,lazyChildren:0},o=>callOpenCodeGoTurn({...o,apiKey:'fake-lazy-audit-credential',fetch:async()=>new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{role:'assistant',reasoning_content:'test',content:JSON.stringify({files:{'a.mjs':'export const value=42;'},note:''})}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}))}));
 const snapshot=await captureRepository(root,task),artifacts=JSON.parse(await readFile(join(root,'out','artifacts.json'),'utf8'));
 const independent=await runRepoChecks(snapshot,artifacts,task.checks,join(root,'audit'));
 assert.deepEqual((await auditLazyAttempt(options.outputDirectory,'root-only',run,options,independent)).evidenceErrors,[]);
 const receiptPath=join(root,'out','call-1.json'),receipt=JSON.parse(await readFile(receiptPath,'utf8'));receipt.transcript.rawUsage.prompt_tokens=21;await writeFile(receiptPath,JSON.stringify(receipt));
 await assert.rejects(()=>auditLazyAttempt(options.outputDirectory,'root-only',run,options,independent));
});
