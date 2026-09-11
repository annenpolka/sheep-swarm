import assert from 'node:assert/strict';
import test from 'node:test';
import {selectUpstreamRechecks as select, type RecoverySelection} from '../src/repo-recovery-selection.ts';
const base:RecoverySelection={target:'invoice',targets:['invoice','cart','amount','other'],edges:[{consumer:'invoice',provider:'cart'},{consumer:'cart',provider:'amount'},{consumer:'other',provider:'amount'}],delivered:['cart','amount','other'],eligible:['cart','amount','other'],rechecked:[],limit:8};
test('select upstream only, in provider-first order, independently of edge order',()=>{
 assert.deepEqual(select(base),['amount','cart']);assert.deepEqual(select({...base,edges:[...base.edges].reverse()}),['amount','cart']);assert.deepEqual(select({...base,limit:1}),['amount']);
});
test('delivered, writable, eligible and unused are all required; traverse excluded intermediates',()=>{
 for(const key of ['delivered','targets','eligible'] as const)assert.deepEqual(select({...base,[key]:['cart']}),['cart']);
 assert.deepEqual(select({...base,rechecked:['cart']}),['amount']);assert.deepEqual(select({...base,rechecked:['amount','cart']}),[]);
 assert.deepEqual(select({...base,edges:[...base.edges,{consumer:'invoice',provider:'public'},{consumer:'public',provider:'other'}]}),['amount','cart','other']);
 assert.deepEqual(select({...base,delivered:[]}),[]);assert.deepEqual(select({...base,limit:0}),[]);
});
test('duplicates and cycles terminate, exclude self, sort sibling paths, and never mutate inputs',()=>{
 const o={...base,edges:[{consumer:'invoice',provider:'cart'},{consumer:'cart',provider:'invoice'},{consumer:'invoice',provider:'amount'},{consumer:'invoice',provider:'cart'}]};const before=JSON.stringify(o);
 assert.deepEqual(select(o),['amount','cart']);assert.equal(JSON.stringify(o),before);
 for(const limit of [-1,1.5,NaN,Infinity])assert.throws(()=>select({...base,limit}),RangeError);
});
