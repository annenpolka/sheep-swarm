import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverRepoDependencies} from '../src/repo-dependencies.ts';
import {validateMoonBitCatalog} from '../src/repo-moonbit.ts';
const files={
 'moon.mod.json':'{"name":"u/m","source":"src"}',
 'src/a/moon.pkg':'import {"u/m/b" @b}',
 'src/a/main.mbt':'pub fn value() -> Int { @b.value() }',
 'src/a/helper.mbt':'fn extra() -> Int { 2 }',
 'src/b/moon.pkg.json':'{}',
 'src/b/lib.mbt':'pub fn value() -> Int { 42 }',
};
const scan=(contents:Record<string,string>=files,targets=['src/a/main.mbt'])=>discoverRepoDependencies(contents,Object.keys(contents),targets);
test('MoonBit package imports, source roots and companions form acyclic dependency edges',async()=>{
 const result=await scan();assert.deepEqual(result.issues,[]);assert.deepEqual(result.cycles,[]);
 const deps=result.edges.filter(e=>e.consumer==='src/a/main.mbt').map(e=>e.provider);
 assert.deepEqual(deps,['moon.mod.json','src/a/helper.mbt','src/a/moon.pkg','src/b/lib.mbt','src/b/moon.pkg.json']);
 assert.equal(result.filesRead,6);assert.ok(result.bytesRead>0);
 assert.ok(result.edges.every(e=>e.sourceHash.length===64));
});
test('MoonBit rejects incomplete catalogs, external packages and package cycles',async()=>{
 assert.throws(()=>validateMoonBitCatalog(Object.keys(files),Object.keys(files).filter(p=>!p.endsWith('helper.mbt'))),/explicit public/);
 assert.throws(()=>validateMoonBitCatalog([...Object.keys(files),'moon.mod'],Object.keys(files)),/moon.mod/);
 assert.throws(()=>validateMoonBitCatalog([...Object.keys(files),'moon.work'],Object.keys(files)),/workspace/);
 assert.throws(()=>validateMoonBitCatalog([...Object.keys(files),'src/a/example.mbt.md'],Object.keys(files)),/literate/);
 assert.match((await scan({...files,'src/a/moon.pkg':'import {"external/pkg"}'})).issues[0]!.reason,/external/);
 assert.match((await scan({...files,'src/a/moon.pkg':'import {"u/m/missing"}'})).issues[0]!.reason,/missing public/);
 assert.match((await scan(files,['src/a/main.mbt','src/a/helper.mbt'])).issues[0]!.reason,/one writable/);
 const cycle=await scan({...files,'src/b/moon.pkg.json':'{"import":["u/m/a"]}'});assert.ok(cycle.cycles.length>0);
});
test('MoonBit ignores private text, honors new metadata and rejects unsupported build inputs',async()=>{
 const privateContent={...files,'src/a/moon.pkg':'import {"u/m/b"}','secret.mbt':'secret'};
 const result=await discoverRepoDependencies(privateContent,Object.keys(files),['src/a/main.mbt']);assert.equal(result.filesRead,6);assert.deepEqual(result.issues,[]);
 const modern=await scan({...files,'moon.mod':'name="u/m" source="src"','moon.mod.json':'invalid old json'});assert.deepEqual(modern.issues,[]);
 for(const source of ['options("pre-build":[])','options(targets:{})','dev_build(rule:"x")'])assert.match((await scan({...files,'src/a/moon.pkg':source})).issues[0]!.reason,/moonbit/);
 const missing={...files};delete (missing as Record<string,string>)['moon.mod.json'];assert.match((await scan(missing)).issues[0]!.reason,/missing public moon.mod/);
});
