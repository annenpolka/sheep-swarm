// Small implementation smoke, not a performance benchmark. No evaluation corpus is used.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {runLazyRepository} from '../src/repo-lazy-run.ts';
import {runPacketRepository} from '../src/repo-packet-run.ts';
import {captureRepository} from '../src/repo-files.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
const output=resolve(process.argv[2]??'');if(!process.argv[2])throw new Error('usage: node scripts/lazy-swarm-smoke.mjs NEW_OUTPUT');
await mkdir(output);const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n');
const slug="export function slug(s){if(typeof s!=='string')throw new TypeError('text');return s.trim().toLowerCase().replace(/\\s+/g,'-');}\n";
const sum="export function sum(xs){if(!Array.isArray(xs)||!Array.from(xs).every(x=>Number.isSafeInteger(x)&&x>=0))throw new TypeError('values');const n=xs.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(n))throw new RangeError('overflow');return n;}\n";
const normalize="export function normalize(s){if(typeof s!=='string'||!s.trim())throw new TypeError('name');return s.trim().toLowerCase();}\n";
const render="import {normalize} from './a.mjs';export function render(s){return 'user:'+normalize(s);}\n";
const independentCheck="import assert from 'node:assert/strict';import {slug} from './a.mjs';import {sum} from './b.mjs';assert.equal(slug('  Hello   World '),'hello-world');assert.equal(slug(''),'');assert.throws(()=>slug(null),TypeError);assert.equal(sum([2,3,0]),5);assert.equal(sum([]),0);assert.throws(()=>sum([-1]),TypeError);assert.throws(()=>sum(Array(2)),TypeError);assert.throws(()=>sum([Number.MAX_SAFE_INTEGER,1]),RangeError);";
const cases=[
 {id:'local',goal:'Repair slug only; preserve the existing correct sum.',baseline:{'a.mjs':"export function slug(s){return s;}\n",'b.mjs':sum},reference:{'a.mjs':slug,'b.mjs':sum},instructions:['slug accepts strings only (else TypeError), trims, lowercases, and replaces each run of whitespace with a hyphen. Empty string stays empty.','sum accepts arrays whose every indexed position is a nonnegative safe integer; reject holes and invalid elements with TypeError. Empty sum is zero; unsafe sum throws RangeError.'],check:independentCheck},
 {id:'independent',goal:'Implement both independent utilities according to their contracts.',baseline:{'a.mjs':"export function slug(s){return s;}\n",'b.mjs':"export function sum(xs){return 0;}\n"},reference:{'a.mjs':slug,'b.mjs':sum},instructions:['slug accepts strings only (else TypeError), trims, lowercases, replaces each run of whitespace with a hyphen. Empty string stays empty.','sum accepts arrays whose every indexed position is a nonnegative safe integer; reject holes and invalid elements with TypeError. Empty sum is zero; unsafe sum throws RangeError.'],check:independentCheck},
 {id:'coupled',goal:'Update the common name contract and its consumer together. Consumers must use normalize, not copy it.',baseline:{'a.mjs':"export function normalize(s){return s;}\n",'b.mjs':"import {normalize} from './a.mjs';export function render(s){return normalize(s);}\n"},reference:{'a.mjs':normalize,'b.mjs':render},instructions:['normalize requires a nonblank string, throws TypeError otherwise, and returns trimmed lowercase.','render imports normalize from a.mjs and returns the exact concatenation of the literal "user:" (no space after colon) and normalize(input); propagate its errors.'],dependsOn:['a.mjs'],check:"import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {normalize} from './a.mjs';import {render} from './b.mjs';assert.equal(normalize(' ALICE '),'alice');assert.equal(render(' ALICE '),'user:alice');for(const x of [null,'  ',1]){assert.throws(()=>normalize(x),TypeError);assert.throws(()=>render(x),TypeError);}assert.match(readFileSync('b.mjs','utf8'),/import.*normalize.*from.*a\\.mjs/);"},
];
const options={runtime:'opencode-go',workerModel:'deepseek-flash',goThinking:'enabled',maxCalls:12,maxRounds:24,maxTokens:1000000,reserveTokensPerCall:100000,maxTokensPerCall:64000,timeoutMs:600000,concurrency:3,maxMetaCalls:0};
const sourcePaths=['src/repo-lazy-run.ts','src/opencode-go-worker.ts','src/opencode-go-conversation.ts','scripts/lazy-swarm-smoke.mjs'];
const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
await save(join(output,'sources-before.json'),sourceHashes);
const configs=[];
for(const fixture of cases){
 const repository=join(output,fixture.id);await mkdir(repository);
 for(const [p,s]of Object.entries({...fixture.baseline,'holdout.mjs':fixture.check}))await writeFile(join(repository,p),s);
 execFileSync('git',['init','-q'],{cwd:repository});execFileSync('git',['add','.'],{cwd:repository});execFileSync('git',['-c','user.name=Sheep Fixture','-c','user.email=fixture@invalid','commit','-qm','Frozen lazy smoke baseline'],{cwd:repository});
 const task=parseRepoTask({version:1,goal:fixture.goal,files:[{path:'a.mjs',instructions:fixture.instructions[0]},{path:'b.mjs',instructions:fixture.instructions[1],dependsOn:fixture.dependsOn??[]}],context:[],protected:['holdout.mjs'],checks:[{argv:[process.execPath,'holdout.mjs']}]});
 const snapshot=await captureRepository(repository,task);
 const baseline=await runRepoChecks(snapshot,fixture.baseline,task.checks,join(output,'preflight'));
 const reference=await runRepoChecks(snapshot,fixture.reference,task.checks,join(output,'preflight'));
 if(baseline.ok||baseline.executionFailure||!reference.ok)throw new Error('fixture preflight failed');
 configs.push({id:fixture.id,repository,task,hash:createHash('sha256').update(JSON.stringify({baseline:fixture.baseline,task,holdout:fixture.check})).digest('hex')});
}
const methods=['packet-all','root-only','lazy'];
await save(join(output,'profile.json'),{format:1,purpose:'implementation-smoke-not-performance-evaluation',options,fixtures:configs.map(({id,hash})=>({id,hash})),orders:configs.map((c,i)=>({id:c.id,methods:[...methods.slice(i),...methods.slice(0,i)]})),forcedFork:'Separate final plumbing condition explicitly requests fork; not autonomous decomposition evidence.'});
const reports=[];
for(let i=0;i<configs.length;i++)for(const method of [...methods.slice(i),...methods.slice(0,i)]){
 const c=configs[i],outputDirectory=join(output,`${c.id}-${method}`);
 const o={...options,repository:c.repository,task:c.task,outputDirectory};
 const r=method==='packet-all'?await runPacketRepository({...o,packetSize:'all'}):await runLazyRepository({...o,lazyChildren:method==='root-only'?0:2});
 const row={fixture:c.id,method,success:r.success,termination:r.termination,completionMs:r.completionMs,elapsedMs:r.elapsedMs,tokens:r.budget.observedTokens,unknownUsage:r.budget.unknownUsageCalls,calls:r.lowerCalls,children:r.children??[],metrics:r.metrics??null};reports.push(row);await save(join(output,'summary.json'),reports);console.log(JSON.stringify(row));
 if(r.budget.unknownUsageCalls)throw new Error('unknown usage: preserve this attempt; do not reset its budget by spawning another child');
}
const c=configs[1];
const forcedTask={...c.task,goal:c.task.goal+' This is a forced fork protocol smoke: first use fork to delegate b.mjs with no unrelated reads, keep a.mjs for yourself, then continue implementing a.mjs while the child works. This is not a test of whether you autonomously choose delegation.'};
const forced=await runLazyRepository({...options,repository:c.repository,task:forcedTask,outputDirectory:join(output,'forced-fork'),lazyChildren:2});
reports.push({fixture:'forced-fork-protocol',method:'lazy',success:forced.success,termination:forced.termination,completionMs:forced.completionMs,elapsedMs:forced.elapsedMs,tokens:forced.budget.observedTokens,unknownUsage:forced.budget.unknownUsageCalls,calls:forced.lowerCalls,children:forced.children,metrics:forced.metrics});
await save(join(output,'summary.json'),reports);console.log(JSON.stringify(reports.at(-1)));
// Preserve source provenance separately from any later edits.
await save(join(output,'sources.json'),Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')]))));
