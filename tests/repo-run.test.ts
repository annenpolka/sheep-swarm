import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { runRepository } from "../src/repo-run.ts";
import type { RepoCaller } from "../src/repo-types.ts";
import { repository, manifest } from "./repo-test-helpers.ts";

function caller(content:string,unknown=false):RepoCaller{return async o=>({requestedModel:o.model,result:{content,note:"fixture"},usage:unknown?[]:[{event:{},inputTokens:10,outputTokens:5}],
  transcript:{requestedModel:o.model,effectiveModelEvidence:"deepseek-flash",events:[],usage:unknown?[]:[{event:{},inputTokens:10,outputTokens:5}],stdout:"",stderr:"",exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1,
    usageCompleteness:unknown?"partial-or-unknown":"complete"}});}
const profile={runtime:"opencode-go" as const,workerModel:"deepseek-flash",workers:2,concurrency:1,maxCalls:3,maxMetaCalls:0,maxTokens:10000,reserveTokensPerCall:1000};
test("repository swarm generates accepted code without changing the source by default",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const report=await runRepository({...profile,repository:root,task:manifest(),outputDirectory:join(root,"run")},caller("export const value=42;\n"));
  assert.equal(report.success,true,report.errors.join("\n"));assert.equal(report.applied,false);assert.deepEqual(report.changedPaths,["a.mjs"]);
  assert.equal(report.swarm.lowerCalls,1);assert.equal(report.budget.observedTokens,15);
  assert.equal(await readFile(join(root,"a.mjs"),"utf8"),"export const value = 0;\n");
  const saved=JSON.parse(await readFile(join(root,"run","artifacts.json"),"utf8"));assert.equal(saved["a.mjs"],"export const value=42;\n");
});
test("repository swarm only applies after final acceptance and rejects source drift",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const bad=await runRepository({...profile,repository:root,task:manifest(),outputDirectory:join(root,"bad"),apply:true},caller("export const value=9;\n"));
  assert.equal(bad.success,false);assert.equal(bad.applied,false);
  const drift=await runRepository({...profile,repository:root,task:manifest(),outputDirectory:join(root,"drift"),apply:true},async o=>{
    await writeFile(join(root,"a.mjs"),"user edit");return caller("export const value=42;\n")(o);
  });assert.equal(drift.success,false);assert.equal(await readFile(join(root,"a.mjs"),"utf8"),"user edit");
  const good=await runRepository({...profile,repository:root,task:manifest(),outputDirectory:join(root,"good"),apply:true},caller("export const value=42;\n"));
  assert.equal(good.success,true,good.errors.join("\n"));assert.equal(good.applied,true);assert.equal(await readFile(join(root,"a.mjs"),"utf8"),"export const value=42;\n");
});
test("repository unknown usage halts provider admissions and prevents apply",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const r=await runRepository({...profile,repository:root,task:manifest(),outputDirectory:join(root,"run"),apply:true},async o=>{calls++;return caller("export const value=42;\n",true)(o);});
  assert.equal(calls,1);assert.equal(r.success,false);assert.equal(r.applied,false);assert.equal(r.budget.unknownUsageCalls,1);
});
test("repository preflight rejects invalid config before invoking a provider",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  for(const extra of [{task:{}},{concurrency:3},{runtime:"docker-agent" as const},{maxTokens:-1},{maxCalls:-1},{goThinking:"bad" as "disabled"}]){
    let calls=0;await assert.rejects(runRepository({...profile,repository:root,task:manifest(),outputDirectory:join(root,"invalid"),...extra},async o=>{calls++;return caller("")(o);}));assert.equal(calls,0);
  }
});

test("repository calls overlap, target context creates no implicit cycle, and final checks run once",async t=>{
  const root=await repository({"b.mjs":"export const value=0;\n"});t.after(()=>rm(root,{recursive:true,force:true}));
  let active=0,peak=0;
  const task={...manifest(),context:["a.mjs","b.mjs"],files:[...manifest().files,{path:"b.mjs",instructions:"export value 42"}]};
  const r=await runRepository({...profile,concurrency:2,goThinking:"disabled",repository:root,task,outputDirectory:join(root,"parallel")},async o=>{
    assert.equal((o as typeof o & {thinking?:string}).thinking,"disabled");
    peak=Math.max(peak,++active);await new Promise<void>(resolve=>setTimeout(resolve,20));active--;
    return caller("export const value=42;\n")(o);
  });
  assert.equal(r.success,true,r.errors.join("\n"));assert.equal(peak,2);assert.equal(r.swarm.completedArtifacts,2);
  assert.equal(r.verifications.filter(v=>v.checks.some(c=>c.argv.includes("check.mjs"))).length,1);
});

test("repository dependencies supply accepted provider contents before consumer execution",async t=>{
  const root=await repository({"b.mjs":"export const value=0;\n"});t.after(()=>rm(root,{recursive:true,force:true}));
  const seen:string[]=[];
  const task={...manifest(),files:[{path:"a.mjs",instructions:"import provider",dependsOn:["b.mjs"]},{path:"b.mjs",instructions:"export value 42"}]};
  const r=await runRepository({...profile,concurrency:2,repository:root,task,outputDirectory:join(root,"deps")},async o=>{
    const target=/Update only (\S+) to satisfy/.exec(o.prompt)![1]!;seen.push(target);
    if(target==="a.mjs") {
      const files=JSON.parse(/Local files:\n([^\n]+)\n/.exec(o.prompt)![1]!);
      assert.equal(files["b.mjs"],"export const value=42;\n");
      return caller("export {value} from './b.mjs';\n")(o);
    }
    return caller("export const value=42;\n")(o);
  });
  assert.equal(r.success,true,r.errors.join("\n"));assert.deepEqual(seen,["b.mjs","a.mjs"]);
});

test("repository concurrent token reservation denial prevents a second paid call",async t=>{
  const root=await repository({"b.mjs":"export const value=0;\n"});t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const r=await runRepository({...profile,concurrency:2,maxTokens:1500,repository:root,task:{...manifest(),files:[...manifest().files,{path:"b.mjs",instructions:"export value 42"}]},outputDirectory:join(root,"budget"),apply:true},async o=>{
    calls++;await new Promise<void>(resolve=>setTimeout(resolve,20));return caller("export const value=42;\n")(o);
  });
  assert.equal(calls,1);assert.equal(r.success,false);assert.equal(r.applied,false);
  assert.equal(r.budget.admissionDenied,true);assert.equal(r.budget.activeReservations,0);
  assert.ok(r.errors.includes("token-budget-incomplete-or-exceeded"));
});
