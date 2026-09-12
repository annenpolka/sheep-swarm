// Recheck saved candidates and account for every issued receipt. Never calls a model.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {extractTokenUsage} from '../src/cost-estimate.ts';
import {captureRepository} from '../src/repo-files.ts';
import {parseRepoTask} from '../src/repo-manifest.ts';
import {runRepoChecks} from '../src/repo-checks.ts';
const root=resolve(process.argv[2]??'');const destination=process.argv[3];if(!process.argv[2]||!destination)throw new Error('usage: node scripts/report-lazy-smoke.mjs SERIES OUTPUT_JSON');
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const rows=await read(join(root,'summary.json')),profile=await read(join(root,'profile.json'));
const output={format:1,series:root,profile,rows:[],hashes:{},tokens:0,calls:0,unknownUsage:0,auditIssues:[]};
const audit=join(root,`independent-audit-${Date.now()}`);await mkdir(audit);
for(const row of rows){
 const directory=join(root,row.fixture==='forced-fork-protocol'?'forced-fork':`${row.fixture}-${row.method}`);
 const result=await read(join(directory,'result.json')),artifacts=await read(join(directory,'artifacts.json')),task=parseRepoTask(await read(join(directory,'task.json')));
 const snapshot=await captureRepository(result.repository,task);
 const check=await runRepoChecks(snapshot,artifacts,task.checks,audit);
 assert(!check.executionFailure);assert.equal(check.ok,result.qualityPass);
 let calls=0,tokens=0,unknown=0;const hashes={};
 for(const call of result.calls){
  const raw=await readFile(join(directory,`${call.id}.json`));const receipt=JSON.parse(raw);calls++;
  hashes[`${call.id}.json`]=createHash('sha256').update(raw).digest('hex');
  assert.equal(receipt.requestedModel,'deepseek-flash');
  const usage=extractTokenUsage(receipt);
  const metered=usage.inputTokens!==null&&usage.outputTokens!==null&&!usage.partial&&!usage.issues.some(x=>x.startsWith('Invalid '));
  if(metered){tokens+=usage.inputTokens+usage.outputTokens;assert.equal(receipt.transcript.effectiveModelEvidence,'deepseek-flash');}
  else unknown++;
  const req=await readFile(join(directory,`${call.id}.request.json`));hashes[`${call.id}.request.json`]=createHash('sha256').update(req).digest('hex');
  assert(!req.toString().includes(snapshot.entries.get('holdout.mjs').bytes.toString()));
 }
 assert.equal(calls,result.lowerCalls);assert.equal(unknown,result.budget.unknownUsageCalls);assert.equal(tokens,result.budget.observedTokens);
 assert.equal(result.budget.activeReservations,0);if(result.success)assert(result.sourceUnchanged&&!unknown&&check.ok);
 output.calls+=calls;output.tokens+=tokens;output.unknownUsage+=unknown;
 output.rows.push({...row,independentCheckPassed:check.ok,receiptCount:calls,receiptTokens:tokens});
 output.hashes[row.fixture+'/'+row.method]=hashes;
}
for(const name of ['sources-before.json','sources.json']){
 try{output[name]=await read(join(root,name));}catch{output.auditIssues.push(`missing ${name}`);}
}
if(output['sources-before.json']&&output['sources.json'])assert.deepEqual(output['sources-before.json'],output['sources.json']);
await writeFile(destination,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({rows:output.rows.length,calls:output.calls,tokens:output.tokens,unknownUsage:output.unknownUsage,auditIssues:output.auditIssues}));
