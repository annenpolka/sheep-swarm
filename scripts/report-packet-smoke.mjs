import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {receiptAudit} from './synthetic-paired-benchmark.mjs';
const load=async p=>JSON.parse(await readFile(p,'utf8'));
const [root,destination]=process.argv.slice(2);if(!root||!destination)throw new Error('Usage: node scripts/report-packet-smoke.mjs RUN_DIRECTORY OUTPUT.json');
const profile=await load(join(root,'profile.json')),summary=await load(join(root,'summary.json')),state=await load(join(root,'state.json'));
assert.equal(createHash('sha256').update(JSON.stringify(profile)).digest('hex'),summary.profileHash);
assert.equal(state.complete,true);assert.equal(state.inFlight,null);assert.equal(summary.complete,true);
assert.deepEqual(summary.rows.map(r=>r.method),profile.order);
for(const [p,h] of Object.entries(profile.runtimeHashes))assert.equal(createHash('sha256').update(await readFile(join(root,'runtime',p))).digest('hex'),h);
const task=await load(join(root,'fixture/task.json'));
const publicPaths=[...new Set([...task.files.map(f=>f.path),...task.context,...(task.discovery?.readable??[])])].sort();
const rows=[];
for(const row of summary.rows) {
 const dir=join(root,row.method),run=await load(join(dir,'result.json'));
 let usage;
 if(row.method.startsWith('legacy'))usage=await receiptAudit(dir,row.method==='legacy-single'?'single':'sheep',run,task);
 else {
  const kernel=await load(join(dir,'kernel.json'));usage={inputTokens:0,outputTokens:0,tokens:0};
  for(const call of run.calls) {
   const receipt=await load(join(dir,call.id+'.json')),request=await load(join(dir,call.id+'.request.json')),tr=receipt.transcript,u=tr.rawUsage;
   assert.equal(tr.requestedModel,'deepseek-flash');assert.equal(tr.effectiveModelEvidence,'deepseek-flash');assert.equal(tr.thinking,'enabled');assert.equal(tr.httpStatus,200);
   assert.equal(tr.usageCompleteness,'complete');assert.equal(tr.timedOut,false);assert.equal(tr.cancelled,false);
   for(const n of [u.prompt_tokens,u.completion_tokens,u.total_tokens])assert.ok(Number.isSafeInteger(n)&&n>=0);
   assert.equal(u.prompt_tokens+u.completion_tokens,u.total_tokens);
   assert.equal(u.total_tokens,run.budget.calls.find(c=>c.callId===call.id).tokens);
   usage.inputTokens+=u.prompt_tokens;usage.outputTokens+=u.completion_tokens;usage.tokens+=u.total_tokens;
   const baselineLine=request.prompt.split('\n').find(s=>s.startsWith('Public baseline: '));assert.ok(baselineLine);
   const baseline=JSON.parse(baselineLine.slice('Public baseline: '.length));assert.deepEqual(Object.keys(baseline.files).sort(),publicPaths);
   for(const p of task.protected)assert.ok(!Object.hasOwn(baseline.files,p));
   const packet=run.plan.packets.find(p=>p.id===call.packet);assert.deepEqual(request.reads,kernel.contexts.find(c=>c.id===call.readContext).reads);
   const overlayLine=request.prompt.split('\n').find(s=>s.startsWith('Current packet/dependency files: '));
   assert.deepEqual(Object.keys(JSON.parse(overlayLine.slice('Current packet/dependency files: '.length))).sort(),packet.currentReadPaths);
   assert.deepEqual(Object.keys(receipt.result.files).sort(),[...packet.paths].sort());
  }
 }
 assert.equal(usage.tokens,row.totalTokens);assert.equal(run.success,true);assert.equal(row.auditPass,true);assert.equal(row.sourceUnchanged,true);
 rows.push({...row,usage});
}
await writeFile(destination,JSON.stringify({format:1,kind:'compatibility-smoke',profileHash:summary.profileHash,profile,rows,complete:true,
 totalCalls:rows.reduce((n,r)=>n+r.calls,0),upperCalls:0,totalTokens:rows.reduce((n,r)=>n+r.totalTokens,0),actualCost:null,
 limitation:'one dev task, one trial per method; not a causal granularity comparison; frozen solver runtime precedes a later output-overlap guard'},null,2)+'\n');
process.stdout.write('All five conditions: raw usage, model/thinking, public context and frozen runtime copies verified.\n');
