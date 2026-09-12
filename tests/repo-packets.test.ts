import assert from 'node:assert/strict';
import test from 'node:test';
import {planPackets} from '../src/repo-packets.ts';
import {packetSchema,parsePacketResponse} from '../src/repo-packet-response.ts';
import {SwarmKernel} from '../src/kernel.ts';

test('packet partitions cover every node once, preserve cycles and have an acyclic quotient for all three-node graphs',()=>{
 const paths=['a','b','c'];const possible=paths.flatMap(a=>paths.filter(b=>a!==b).map(b=>[a,b] as const));
 for(let mask=0;mask<64;mask++)for(const size of [1,2,3,'all'] as const) {
  const nodes=paths.map(path=>({path,dependsOn:possible.filter(([a],i)=>a===path&&(mask&(1<<i))).map(([,b])=>b)}));
  const original=structuredClone(nodes),result=planPackets(nodes,size);
  assert.deepEqual(nodes,original);assert.deepEqual(result,planPackets([...nodes].reverse().map(n=>({...n,dependsOn:[...n.dependsOn].reverse()})),size));
  assert.deepEqual(result.packets.flatMap(p=>p.paths).sort(),paths);
  const owner=new Map(result.packets.flatMap((p,i)=>p.paths.map(path=>[path,i] as const)));
  for(const n of nodes)for(const dep of n.dependsOn)assert.ok(owner.get(dep)!<=owner.get(n.path)!);
  const count=nodes.flatMap(n=>n.dependsOn.filter(d=>owner.get(d)!==owner.get(n.path))).length;assert.equal(result.boundaryEdges,count);
  for(const p of result.packets)if(size!=='all'&&p.paths.length>size) {
   assert.deepEqual(p.oversizeReasons,['strongly-connected-component']);
   for(const a of p.paths)for(const b of p.paths){const seen=new Set([a]);for(const x of seen)for(const d of nodes.find(n=>n.path===x)!.dependsOn)seen.add(d);assert.ok(seen.has(b));}
  }
 }
});
test('packet planner rejects malformed graphs and response validator fences the exact packet',()=>{
 const nodes=[{path:'a',dependsOn:[]}];
 for(const size of [0,NaN,-2,1.5,'2'])assert.throws(()=>planPackets(nodes,size as number));
 for(const graph of [[],new Array(2),[nodes[0],nodes[0]],[{path:'a',dependsOn:['x']}]])assert.throws(()=>planPackets(graph as typeof nodes,1));
 const files=Object.fromEntries(['__proto__','constructor'].map(k=>[k,'source']));
 const result=parsePacketResponse({files,note:''},Object.keys(files));assert.equal(Object.getPrototypeOf(result),null);assert.equal(result['__proto__'],'source');
 assert.deepEqual((packetSchema(['a'])['properties'] as {files:{required:string[]}}).files.required,['a']);
 for(const value of [{files:{a:'x',b:'x'},note:''},{files:{},note:''},{files:{a:4},note:''},{files:{a:'x'},note:4},{files:{a:'x'},note:'',extra:true},{files:{a:'あ'.repeat(800000)},note:''}])assert.throws(()=>parsePacketResponse(value,['a']));
});
test('kernel fences a whole packet for stale reads, revoked authority and candidate replacement',async()=>{
 for(const action of ['read','revoke','candidate'] as const) {
  const kernel=new SwarmKernel({artifacts:{a:'0',b:'0',dep:'0'},now:()=>0});
  const lease=kernel.grant('packet',['a','b']);const context=kernel.checkout('packet',['a','b','dep']);
  const candidate=kernel.prepare({id:'update',agent:'packet',context:context.id,lease,writes:{a:'1',b:'1'}});
  candidate.contents['a']='ATTACK';await kernel.validate(candidate.id,c=>({ok:c['a']==='1'&&c['b']==='1',errors:[]}));
  if(action==='read')kernel.change('dep','new');if(action==='revoke')kernel.revoke(lease.id);
  if(action==='candidate'){kernel.commit(candidate.id);assert.deepEqual(kernel.contents(),{a:'1',b:'1',dep:'0'});}
  else{assert.throws(()=>kernel.commit(candidate.id));assert.equal(kernel.artifact('a').content,'0');assert.equal(kernel.artifact('b').content,'0');}
 }
});
