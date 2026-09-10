import assert from 'node:assert/strict';
import test from 'node:test';
import {parseRepositoryPatch} from '../experiments/repository-patch.ts';
test('single repository patch permits a complete atomic update of all declared targets',()=>{
 const raw={files:[{path:'a.mjs',content:'a'},{path:'b.mjs',content:'b'}],note:'done'};
 const out=parseRepositoryPatch(raw,['a.mjs','b.mjs']);assert.deepEqual({...out},{'a.mjs':'a','b.mjs':'b'});
 raw.files[0]!.content='changed';assert.equal(out['a.mjs'],'a');
});
test('single repository patch rejects missing, duplicate, extra, nontext and oversized writes',()=>{
 for(const raw of [null,[],{}, {files:[],note:''},{files:[{path:'a.mjs',content:'a'},{path:'a.mjs',content:'b'}],note:''},{files:[{path:'a.mjs',content:'a'},{path:'secret',content:'b'}],note:''},{files:[{path:'a.mjs',content:1},{path:'b.mjs',content:'b'}],note:''},{files:[{path:'a.mjs',content:'a'},{path:'b.mjs',content:'b',extra:1}],note:''},{files:[{path:'a.mjs',content:'a'},{path:'b.mjs',content:'b'}],note:'',extra:1},{files:[{path:'a.mjs',content:'あ'.repeat(800000)},{path:'b.mjs',content:'b'}],note:''}])assert.throws(()=>parseRepositoryPatch(raw,['a.mjs','b.mjs']));
 assert.throws(()=>parseRepositoryPatch({files:new Array(2),note:''},['a.mjs','b.mjs']));
 assert.throws(()=>parseRepositoryPatch({files:[],note:''},[]));
 assert.throws(()=>parseRepositoryPatch({files:[],note:''},['a','a']));
});
