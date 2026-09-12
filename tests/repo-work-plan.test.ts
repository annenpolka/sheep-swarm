import {assertSupportedSchema} from '../src/codex-worker.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {compileWorkPlan,workPlanSchema,type PlannedPacket} from '../src/repo-work-plan.ts';
const p=(id:string,writablePaths:string[],extra:Partial<PlannedPacket>={}):PlannedPacket=>({id,writablePaths,relevantPaths:[],objective:'Repair assigned responsibility',invariants:['Preserve valid inputs'],dependsOn:[],...extra});
const raw=(packets:PlannedPacket[],untouchedPaths:string[]=[])=>({packets,untouchedPaths,rationale:'Small repair'});
const targets=['a','b','c'],publicPaths=[...targets,'policy'];
test('one packet is valid, untouched targets stay outside write authority, and overlaps merge',()=>{
 const all=compileWorkPlan(raw([p('one',targets)]),targets,publicPaths,[]);assert.equal(all.packets.length,1);assert.deepEqual(all.packets[0]!.paths,targets);
 const selected=compileWorkPlan(raw([p('one',['a'])],['b','c']),targets,publicPaths,[]);assert.deepEqual(selected.packets[0]!.paths,['a']);assert.deepEqual(selected.untouchedPaths,['b','c']);
 const merged=compileWorkPlan(raw([p('first',['a','b']),p('second',['b','c'])]),targets,publicPaths,[]);assert.equal(merged.packets.length,1);assert.deepEqual(merged.packets[0]!.paths,targets);assert.deepEqual(merged.normalization.mergedGroups,[['first','second']]);
});
test('host supplements public read dependencies and merges cycles without broadening writes',()=>{
 const plan=compileWorkPlan(raw([p('a',['a'],{relevantPaths:['policy']}),p('b',['b'])],['c']),targets,publicPaths,[{consumer:'policy',provider:'b'}]);
 const a=plan.packets.find(p=>p.paths.includes('a'))!,b=plan.packets.find(p=>p.paths.includes('b'))!;assert.deepEqual(a.dependsOn,[b.id]);
 const cyclic=compileWorkPlan(raw([p('a',['a'],{dependsOn:['b']}),p('b',['b'])],['c']),targets,publicPaths,[{consumer:'b',provider:'a'}]);assert.equal(cyclic.packets.length,1);assert.deepEqual(cyclic.packets[0]!.paths,['a','b']);
});
test('coverage, private/unknown paths, invalid dependencies and malformed shapes are rejected',()=>{
 for(const bad of [raw([]),raw([p('a',['a'])]),raw([p('a',['protected'])],targets),raw([p('a',['a'],{relevantPaths:['protected']})],['b','c']),
  raw([p('a',['a'],{dependsOn:['missing']})],['b','c']),raw([p('a',['a'],{dependsOn:['a']})],['b','c']),raw([p('a',['a']),p('a',['b'])],['c']),
  raw([p('a',['a'])],['a','b','c']),raw([p('a',['a'])],['b','b','c']),{...raw([p('a',targets)]),code:'forbidden'},
  {...raw([p('a',targets)]),packets:Array(1)},raw([p('a',['a'],{invariants:['']})],['b','c'])])assert.throws(()=>compileWorkPlan(bad,targets,publicPaths,[]));
 let invoked=false;const getter={...raw([p('a',targets)]),get rationale(){invoked=true;return 'x';}};assert.throws(()=>compileWorkPlan(getter,targets,publicPaths,[]));assert.equal(invoked,false);
});

test('planner schema uses the supported runtime dialect',()=>assertSupportedSchema(workPlanSchema(['a'],['a','context'])));
