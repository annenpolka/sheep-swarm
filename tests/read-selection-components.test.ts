import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

test('opaque fixture keeps filenames and all policy contents fixed across registry worlds',async()=>{
  const {buildReadSelectionFixture}=await import(pathToFileURL(resolve('scripts/read-selection-fixture.mjs')).href);
  const a=buildReadSelectionFixture({seed:'contract-seed',world:0,documents:24});
  const b=buildReadSelectionFixture({seed:'contract-seed',world:1,documents:24});
  assert.deepEqual(a,buildReadSelectionFixture({seed:'contract-seed',world:0,documents:24}));
  assert.deepEqual(Object.keys(a.files).sort(),Object.keys(b.files).sort());
  assert.deepEqual(a.catalog,b.catalog);assert.equal(a.catalog.length,25);
  assert.equal(a.targets.length,2);assert.deepEqual(a.targets,b.targets);
  const changed=Object.keys(a.files).filter(p=>a.files[p]!==b.files[p]);assert.deepEqual(changed,['registry.json']);
  for(const path of a.catalog.filter((p:string)=>p!=='registry.json')){
    assert.match(path,/^docs\/[0-9a-f]{16}\.json$/);const p=JSON.parse(a.files[path]);
    assert.ok(Number.isSafeInteger(p.rate)&&p.rate>0);assert.ok(Number.isSafeInteger(p.minimum)&&p.minimum>=0);assert.ok(Number.isSafeInteger(p.cap)&&p.cap>=p.minimum);
  }
  for(const f of [a,b]){
    const registry=JSON.parse(f.files['registry.json']);
    assert.equal(f.expectations.length,2);assert.equal(new Set(f.expectations.map((e:{policyPath:string})=>e.policyPath)).size,2);
    for(const e of f.expectations){assert.equal(registry[e.target],e.policyPath);assert.deepEqual(e.policy,JSON.parse(f.files[e.policyPath]));assert.equal(e.registryPath,'registry.json');}
  }
  assert.ok(a.expectations.every((e:{policyPath:string},i:number)=>e.policyPath!==b.expectations[i].policyPath));
  // Every document can become relevant; the first two are not privileged.
  const selected=new Set();
  for(let world=0;world<24;world++)selected.add(buildReadSelectionFixture({seed:'contract-seed',world}).expectations[0].policyPath);
  assert.equal(selected.size,24);
  for(const opts of [{seed:'',world:0,documents:24},{seed:'s',world:-1,documents:24},{seed:'s',world:0,documents:2},{seed:'s',world:0,documents:257},{seed:'s',world:0.5,documents:24}])assert.throws(()=>buildReadSelectionFixture(opts));
});

test('audit uses target-local delivery and call order, not claim text or lexical IDs',async()=>{
  const {auditReadSelection}=await import('../src/read-selection-audit.ts');
  const expectations=[{target:'a.mjs',registryPath:'registry.json',policyPath:'docs/p.json'}];
  const calls=[{id:'call-9',role:'worker',target:'a.mjs',outcome:'deferred'},{id:'call-10',role:'worker',target:'a.mjs',outcome:'deferred'},{id:'call-11',role:'worker',target:'a.mjs',outcome:'committed'}];
  const requests=[{callId:'call-9',target:'a.mjs',paths:['registry.json'],accepted:true},{callId:'call-10',target:'a.mjs',paths:['docs/p.json'],accepted:true}];
  const deliveries=[{callId:'call-10',target:'a.mjs',path:'registry.json'},{callId:'call-11',target:'a.mjs',path:'docs/p.json'}];
  const good=auditReadSelection({expectations,calls,requests,deliveries});assert.equal(good.valid,true);assert.equal(good.targets[0]!.sequentialRead,true);assert.equal(good.targets[0]!.policyDeliveredBeforeCommit,true);
  const batch=auditReadSelection({expectations,calls,requests:[{...requests[0],paths:['registry.json','docs/p.json']}],deliveries});assert.equal(batch.valid,true);assert.equal(batch.targets[0]!.sequentialRead,false);
  const broad=auditReadSelection({expectations,calls:[calls[2]],requests:[],deliveries:deliveries.map(d=>({...d,callId:'call-11'}))});assert.equal(broad.valid,true);assert.equal(broad.targets[0]!.sequentialRead,false);assert.equal(broad.targets[0]!.policyDeliveredBeforeCommit,true);
  for(const corrupt of [
    {expectations,calls,requests,deliveries:[...deliveries,{...deliveries[0],callId:'missing'}]},
    {expectations,calls:[...calls,calls[0]],requests,deliveries},
    {expectations,calls,requests,deliveries:[{...deliveries[0],target:'other.mjs'}]},
    {expectations,calls,requests:[{...requests[0],accepted:'yes'}],deliveries},
  ])assert.equal(auditReadSelection(corrupt).valid,false);
  assert.equal(auditReadSelection({expectations,calls,requests,deliveries:[]}).targets[0]!.policyDeliveredBeforeCommit,false);
  assert.equal(auditReadSelection({expectations:[],calls:[],requests:[],deliveries:[]}).valid,false);
  assert.equal(auditReadSelection({expectations,calls,requests:[{...requests[0],paths:[]}],deliveries}).valid,false);
  assert.equal(auditReadSelection({expectations,calls,requests:requests.map(r=>({...r,accepted:false})),deliveries}).targets[0]!.sequentialRead,false);
  const late={id:'later',role:'worker',target:'a.mjs',outcome:'committed'};
  assert.equal(auditReadSelection({expectations,calls:[...calls,late],requests,deliveries:[deliveries[0],{...deliveries[1],callId:'later'}]}).targets[0]!.sequentialRead,false);
  assert.equal(auditReadSelection({expectations,calls:calls.map(c=>({...c,outcome:'deferred'})),requests,deliveries}).targets[0]!.policyDeliveredBeforeCommit,false);
});
