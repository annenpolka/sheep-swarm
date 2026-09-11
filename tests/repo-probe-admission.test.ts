import test from 'node:test';
import assert from 'node:assert/strict';
import {admitPublicProbe,type ProbeAdmission} from '../src/repo-probe-admission.ts';
const stamp={version:1,evidenceEpoch:0};
const base:ProbeAdmission={target:'consumer',provider:'provider',upstream:['provider'],eligible:['provider'],required:['provider','check'],reads:{consumer:stamp,provider:stamp,check:stamp},current:{consumer:stamp,provider:stamp,check:stamp},key:'k',seen:[],requests:0,maxRequests:2};
test('probe admission rejects stale, undelivered, unrelated, unavailable, repeated and over-budget claims',()=>{
 assert.equal(admitPublicProbe(base),null);
 for(const [patch,reason] of [
  [{provider:'consumer'},'not-upstream'],[{upstream:[]},'not-upstream'],[{eligible:[]},'provider-unavailable'],
  [{required:['unread']},'undelivered-probe-input'],[{current:{...base.current,provider:{version:2,evidenceEpoch:0}}},'stale-observation'],
  [{current:{...base.current,consumer:{version:1,evidenceEpoch:1}}},'stale-observation'],[{current:{}},'stale-observation'],
  [{seen:['k']},'duplicate-probe'],[{requests:2},'probe-request-limit'],[{maxRequests:0},'probe-request-limit']
 ] as const)assert.equal(admitPublicProbe({...base,...patch}),reason);
 assert.deepEqual(base.reads,{consumer:stamp,provider:stamp,check:stamp});
});
test('probe limits require nonnegative safe integers and precedence is deterministic',()=>{
 for(const key of ['requests','maxRequests'] as const)for(const value of [-1,NaN,Infinity,0.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>admitPublicProbe({...base,[key]:value}));
 assert.equal(admitPublicProbe({...base,requests:2,seen:['k'],upstream:[]}), 'probe-request-limit');
});
