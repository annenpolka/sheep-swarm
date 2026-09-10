import assert from 'node:assert/strict';
import {quote} from './pricing.mjs';
import {label} from './label.mjs';
import {summary} from './summary.mjs';
for (const [units,total] of [[0,21],[1,21],[3,21],[4,28],[8,56],[9,56],[100,56]]) {
  assert.equal(quote(units),total);
  assert.equal(label(units),units===1?'item':'items');
  assert.deepEqual(summary(units),{units,total,label:units===1?'item':'items'});
}
for (const units of [-1,1.5,NaN,Infinity,'4',null]) {
  assert.equal(quote(units),null);
  assert.equal(summary(units),null);
}
