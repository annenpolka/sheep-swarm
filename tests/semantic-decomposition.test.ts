import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticPilotCases,semanticPilotOrder,summarizeSemantic,type SemanticRow} from '../experiments/semantic-decomposition.ts';
import {readFile} from 'node:fs/promises';
test('semantic pilot selects dev only, balances sizes and all six orders without outcome metadata',async()=>{
 const corpus=JSON.parse(await readFile('experiments/synthetic-corpus-v1-lock.json','utf8'));
 const selected=semanticPilotCases(corpus.cases);assert.equal(selected.length,24);assert.equal(new Set(selected.map(c=>c.id)).size,24);
 assert.ok(selected.every(c=>c.split==='dev'));for(const n of [4,8,16,32])assert.equal(selected.filter(c=>c.targetCount===n).length,6);
 for(const f of new Set(selected.map(c=>c.family)))assert.equal(selected.filter(c=>c.family===f).length,3);
 assert.deepEqual(semanticPilotCases([...corpus.cases].reverse()).map(c=>c.id),selected.map(c=>c.id));
 const order=semanticPilotOrder(selected);assert.equal(order.length,72);const permutations=new Map<string,number>();
 for(let i=0;i<72;i+=3){const group=order.slice(i,i+3);assert.equal(new Set(group.map(g=>g.method)).size,3);const k=group.map(g=>g.method).join();permutations.set(k,(permutations.get(k)??0)+1);}
 assert.equal(permutations.size,6);assert.ok([...permutations.values()].every(n=>n===4));
});
test('semantic summary keeps failed time out of completion, and unknown usage unknown',()=>{
 const cases=[{id:'a',family:'f',split:'dev',targetCount:4,topology:'independent',dependencyDepth:0},{id:'b',family:'f',split:'dev',targetCount:4,topology:'independent',dependencyDepth:0}];
 const row=(id:string,method:SemanticRow['method'],extra:Partial<SemanticRow>={}):SemanticRow=>({id,method,success:true,evidenceErrors:[],elapsedMs:20,calls:2,knownTokens:50,tokens:50,proposedPacketCount:1,executedPacketCount:1,plannedWritableCount:1,changedTargetCount:1,plannerMs:5,plannerCalls:1,plannerChoseSingle:true,allTargetsOnePacket:false,...extra});
 const r=summarizeSemantic(cases,[row('a','single'),row('a','planned',{tokens:null,elapsedMs:30}),row('b','single'),row('b','planned',{success:false,elapsedMs:100})]).overall;
 assert.equal(r.methods.planned!.medianCompletionMs,30);assert.equal(r.methods.planned!.tokens,null);assert.equal(r.comparisons.single!.bothSuccess,1);assert.equal(r.comparisons.single!.referenceOnly,1);assert.equal(r.comparisons.single!.medianPlannedOverReference,1.5);assert.equal(r.planning.onePacket,2);assert.equal(r.planning.allTargetsOnePacket,0);
});
