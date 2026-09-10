import assert from 'node:assert/strict';
import test from 'node:test';
import {parseImpactInput} from '../src/repo-impact-input.ts';
test('self-host input validation snapshots declared impact data and rejects malformed shapes',()=>{
 const a={targets:['a.ts'],changedPaths:[],edges:[{consumer:'a.ts',provider:'p.ts'}]};
 const result=parseImpactInput(a);assert.deepEqual(result,{...a,uncertainConsumers:[]});
 a.targets.push('b.ts');a.edges[0]!.provider='changed';assert.deepEqual(result.targets,['a.ts']);assert.equal(result.edges[0]!.provider,'p.ts');
 for(const value of [null,[],{}, {...a,targets:[]},{...a,targets:['a','a']},{...a,changedPaths:['x','x']},{...a,edges:[[]]},{...a,edges:[{consumer:'x',provider:''}]},{...a,uncertainConsumers:null},{...a,uncertainConsumers:[1]},Object.assign([],{targets:['a'],changedPaths:[],edges:[]})])assert.throws(()=>parseImpactInput(value));
 assert.deepEqual(parseImpactInput({...a,uncertainConsumers:['a.ts']}).uncertainConsumers,['a.ts']);
 assert.throws(()=>parseImpactInput({...a,edges:Array(1)}));
});
