import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import type { RepoSnapshot } from '../src/repo-types.ts';

test('proposal: strict disjoint actions, safe paths and bounded information', async () => {
  const {parseWorkerProposal} = await import('../src/worker-proposal.ts');
  assert.deepEqual(parseWorkerProposal({kind:'write',content:'',note:'ok'}),{kind:'write',content:'',note:'ok'});
  assert.deepEqual(parseWorkerProposal({kind:'read',paths:['docs/a.json'],note:''}),{kind:'read',paths:['docs/a.json'],note:''});
  assert.equal(parseWorkerProposal({kind:'uncertain',observed:['registry missing'],missing:['policy'],hypothesis:null,note:''}).kind,'uncertain');
  for (const bad of [null,[],{kind:'write',content:'x',note:'',paths:[]},{kind:'read',paths:[],note:''},
    {kind:'read',paths:['../secret'],note:''},{kind:'read',paths:['.env'],note:''},
    {kind:'read',paths:['a','a'],note:''},{kind:'read',paths:['a'],note:4},
    {kind:'uncertain',observed:[],missing:[],hypothesis:null,note:''},
    {kind:'write',content:'x',note:'x'.repeat(8193)}]) assert.throws(()=>parseWorkerProposal(bad));
});

test('options: aliases preserve meanings and unsupported flags fail before execution', async () => {
  const {parseCommandArgs,numberOption,cliHelp} = await import('../src/cli-options.ts');
  assert.equal(parseCommandArgs('repo',['--max-worker-calls','12']).values['max-calls'],'12');
  assert.equal(parseCommandArgs('compare',['--max-meta-calls','0']).values['max-upper-calls'],'0');
  assert.equal(parseCommandArgs('durable',['--output','somewhere']).values.directory,'somewhere');
  for(const [command,args] of [ ['repo',['--max-total-calls','3']],['compare',['--max-worker-calls','3']],
    ['swarm',['--max-tokens','10']],['repo',['--resume']],['durable',['--concurrency','2']],
    ['repo',['--max-calls','2','--max-worker-calls','2']],['repo',['--workers','2','--workers','3']]] as const)
    assert.throws(()=>parseCommandArgs(command,[...args]));
  for(const name of ['repo','swarm','compare','durable','mechanism'] as const){
    assert.equal(parseCommandArgs(name,['-h']).help,true);
    assert.match(cliHelp(name),/--dry-run/);
  }
  assert.equal(numberOption({'n':'0'},'n',2,0),0);
  for(const value of ['NaN','Infinity','-1','1.5','9007199254740992','']) assert.throws(()=>numberOption({n:value},'n',1));
});

test('dependencies: parse actual static imports and reexports without evaluating code', async () => {
  const {discoverRepoDependencies} = await import('../src/repo-dependencies.ts');
  const scan=await discoverRepoDependencies({
    'src/a.mjs':`// import {x} from '../secret.mjs';\nimport fs from 'node:fs';\nimport './side.mjs';\nexport {v} from './b.mjs';\nthrow new Error('MUST NOT EVALUATE');`,
    'src/b.mjs':'export const v=2;', 'src/side.mjs':'export {};', 'secret.mjs':'export const x=0;',
  },['src/a.mjs','src/b.mjs','src/side.mjs']);
  assert.deepEqual(scan.edges.map(e=>[e.consumer,e.provider]).sort(),[['src/a.mjs','src/b.mjs'],['src/a.mjs','src/side.mjs']]);
  assert.equal(scan.issues.length,0); assert.equal(scan.filesRead,3); assert.ok(scan.bytesRead>0);
  assert.ok(scan.edges.every(e=>/^[a-f0-9]{64}$/.test(e.sourceHash)));
  const bad=await discoverRepoDependencies({'a.mjs':`import './missing.mjs'; import './protected.mjs'; import 'package';`,'protected.mjs':'export {};'},['a.mjs']);
  assert.equal(bad.edges.length,0);assert.equal(bad.issues.length,3);
  const cyclic=await discoverRepoDependencies({'a.mjs':`import './b.mjs';`,'b.mjs':`import './a.mjs';`},['a.mjs','b.mjs']);
  assert.equal(cyclic.cycles.length,1); assert.deepEqual([...cyclic.cycles[0]!].sort(),['a.mjs','b.mjs']);
  assert.ok(cyclic.limitations.includes('dynamic-imports-not-covered'));
  await assert.rejects(discoverRepoDependencies({'../bad.mjs':''},['../bad.mjs']));
});

test('verifier: bind immutable candidates, commands, phases and environments', async () => {
  const {createHostRepoVerifier,verificationIdentity,assertVerificationReceipt}=await import('../src/repo-verifier.ts');
  const snapshot:RepoSnapshot={root:'/unused',head:'head',task:{version:1,goal:'test',files:[{path:'a.mjs',instructions:'test',dependsOn:[],checks:[]}],context:[],protected:['test.mjs'],checks:[]},entries:new Map([['a.mjs',{bytes:Buffer.from('old'),mode:0o644}]]),initialTargets:{'a.mjs':'old'}};
  const request={snapshot,overlay:{'a.mjs':'new'},commands:[],phase:'local' as const,outputRoot:'/unused-output'};
  let calls=0;
  const verifier=createHostRepoVerifier('test-env',async()=>{calls++;return {ok:true,workspace:'/candidate',checks:[],errors:[]};});
  const receipt=await verifier.verify(request);assert.equal(calls,1);assert.equal(receipt.status,'pass');
  assertVerificationReceipt(request,receipt,'test-env');
  assert.throws(()=>assertVerificationReceipt({...request,overlay:{'a.mjs':'other'}},receipt,'test-env'));
  assert.throws(()=>assertVerificationReceipt({...request,phase:'final'},receipt,'test-env'));
  assert.throws(()=>assertVerificationReceipt(request,receipt,'other-env'));
  assert.notEqual(verificationIdentity({...request,commands:[{argv:['node','x'],timeoutMs:1}]},'test-env').checksDigest,receipt.checksDigest);
  const failed=await createHostRepoVerifier('test-env',async()=>{throw new Error('disk unavailable');}).verify(request);
  assert.equal(failed.status,'infrastructure-error');assert.equal(failed.ok,false);
});

test('verifier refuses forged pass results and detects request mutation',async()=>{
  const {createHostRepoVerifier,assertVerificationReceipt,verificationIdentity}=await import('../src/repo-verifier.ts');
  const snapshot:RepoSnapshot={root:'/unused',head:'head',task:{version:1,goal:'test',files:[],context:[],protected:[],checks:[]},entries:new Map(),initialTargets:{}};
  const request={snapshot,overlay:{a:'one'},commands:[{argv:['node','check.mjs'],timeoutMs:100}],phase:'final' as const,outputRoot:'/unused'};
  const receipt={...verificationIdentity(request,'env'),ok:true,workspace:'/candidate',errors:[],status:'pass' as const,cleanup:'process-group-attempted' as const,
    checks:[{argv:['node','check.mjs'],exitCode:0,signal:null,timedOut:false,stdout:'',stderr:'',durationMs:1}]};
  assertVerificationReceipt(request,receipt,'env');
  for(const bad of [{...receipt,checks:[]},{...receipt,checks:[{...receipt.checks[0]!,exitCode:1}]},
    {...receipt,checks:[{...receipt.checks[0]!,argv:['true']}]},{...receipt,checks:[{...receipt.checks[0]!,timedOut:true}]}])assert.throws(()=>assertVerificationReceipt(request,bad,'env'));
  const v=createHostRepoVerifier('env',async()=>{request.overlay.a='two';return {ok:true,workspace:'/candidate',checks:[],errors:[]};});
  assert.equal((await v.verify(request)).status,'infrastructure-error');
  const a=verificationIdentity({...request,overlay:{a:'x\0b\0y'}},'env');
  const b=verificationIdentity({...request,overlay:{a:'x',b:'y'}},'env');assert.notEqual(a.candidateDigest,b.candidateDigest);
});
