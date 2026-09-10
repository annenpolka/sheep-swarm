import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverRepoDependencies} from '../src/repo-dependencies.ts';

test('TypeScript static and type-only dependencies are parsed without evaluation',async()=>{
 const contents={
  'src/a.ts':`import type {A} from './types.ts'; import {type B, value} from './b.mts'; export type {C} from './c.d.ts'; type D=import('./d.ts').D; import 'node:fs'; // import './fake.ts';\nconst x="import './also-fake.ts'"; throw new Error('MUST NOT EVALUATE');`,
  'src/types.ts':'export interface A {x:number}', 'src/b.mts':'export const value=2;export interface B {}',
  'src/c.d.ts':'export interface C {}', 'src/d.ts':'export type D=number;',
 };
 const r=await discoverRepoDependencies(contents,Object.keys(contents));
 assert.deepEqual(r.edges.map(e=>e.provider),['src/b.mts','src/c.d.ts','src/d.ts','src/types.ts']);assert.deepEqual(r.issues,[]);assert.equal(r.filesRead,5);
 assert.ok(r.edges.every(e=>e.sourceHash.length===64));
 const bad=await discoverRepoDependencies({'a.ts':`import type {X} from './private.ts'; import x from 'pkg';`,'private.ts':'export type X=number;'},['a.ts']);
 assert.equal(bad.edges.length,0);assert.equal(bad.issues.length,2);
 const syntax=await discoverRepoDependencies({'bad.ts':'const x: = ;'},['bad.ts']);assert.match(syntax.issues[0]!.reason,/syntax-error/);
 const dynamic=await discoverRepoDependencies({'a.ts':`const x=import('./b.ts'); import y = require('./c.ts');`},['a.ts']);assert.equal(dynamic.issues.length,2);
 const cyclic=await discoverRepoDependencies({'a.ts':`import type {B} from './b.ts'; export type A=number;`,'b.ts':`import type {A} from './a.ts';export type B=number;`},['a.ts','b.ts']);assert.deepEqual(cyclic.cycles,[['a.ts','b.ts']]);
});
