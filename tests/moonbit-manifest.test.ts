import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMoonManifest} from '../src/moonbit-manifest.ts';

test('MoonBit manifest parses JSON and DSL without evaluating source',()=>{
 assert.deepEqual(parseMoonManifest('moon.mod.json','{"name":"user/demo","source":"src","version":"0.1.0"}'),{name:'user/demo',source:'src',imports:[]});
 assert.deepEqual(parseMoonManifest('moon.mod','// name = "fake"\nname = "user/demo"\nsource = "src"\nversion = "0.1.0"'),{name:'user/demo',source:'src',imports:[]});
 assert.deepEqual(parseMoonManifest('moon.pkg.json',JSON.stringify({import:['user/demo/a',{path:'user/demo/b',alias:'b'}],'test-import':['user/demo/t'],'wbtest-import':['moonbitlang/core/json'],'is-main':false})),{imports:['user/demo/a','user/demo/b','user/demo/t','moonbitlang/core/json']});
 assert.deepEqual(parseMoonManifest('moon.pkg','// import {"bad"}\nimport {"user/demo/a" @a, "user/demo/b",}\nimport {"user/demo/t"} for "test"\nimport {"moonbitlang/core/json"} for "wbtest"\noptions("is-main": false)'),{imports:['user/demo/a','user/demo/b','user/demo/t','moonbitlang/core/json']});
 assert.deepEqual(parseMoonManifest('moon.pkg',''),{imports:[]});
});
test('MoonBit manifest rejects ambiguity, unsupported resolution and malformed syntax',()=>{
 for(const [path,text] of [
 ['moon.pkg','import {"a" garbage}'],['moon.pkg','import {"a"} for "unknown"'],['moon.pkg','import {"a"'],['moon.pkg','x = "import { \\"hidden\\" }"'],['moon.pkg','dev_build(rule: "x")'],['moon.pkg','options(targets: {"a.mbt": ["js"]})'],['moon.pkg.json','{"import":[42]}'],['moon.pkg.json','{"pre-build":[]}'],['moon.pkg.json','[]'],['moon.pkg','import {"../escape"}'],['moon.pkg','import {"a//b"}'],['moon.pkg','import {"a"} /* comment */'],['moon.mod','name = "a"\nname = "b"'],['moon.mod.json','{"name":"a","deps":{"x":"1.0.0"}}'],['moon.mod','name = "a"\nimport {"b@1.0.0"}'],['moon.mod','name = "a"\nsource = "../x"'],['moon.mod.json','{}'],['moon.pkg','options("is-main": true) junk'],
 ] as const)assert.throws(()=>parseMoonManifest(path,text),`${path}: ${text}`);
});

test('MoonBit parser closes delegated boundary gaps',()=>{
 for(const [p,s] of [['moon.mod','name="a" deps={b:"1"}'],['moon.mod','name="a" source="x\\\\y"'],['moon.pkg','options("test-import-all": "yes")'],['moon.pkg','options("warn-list": false)'],['moon.pkg','options("is-main": false, "is-main": true)'],['moon.pkg','options("is-main": unknown)'],['moon.mod','name="a" source="x\\t"']] as const)assert.throws(()=>parseMoonManifest(p,s));
 assert.deepEqual(parseMoonManifest('moon.pkg','pkgtype(kind: "executable")'),{imports:[]});
 assert.deepEqual(parseMoonManifest('moon.mod','name = "u/\\u0061"'),{name:'u/a',imports:[]});
 assert.throws(()=>parseMoonManifest('moon.mod','name="a" keywords='+ '['.repeat(70)+'"a"'+']'.repeat(70)),/nesting/);
});
