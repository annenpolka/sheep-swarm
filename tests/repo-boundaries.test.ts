import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { chmod, lstat, readFile, rm, symlink } from "node:fs/promises";
import { captureRepository, materializeRepository, applyRepository } from "../src/repo-files.ts";
import { parseRepoTask } from "../src/repo-manifest.ts";
import { runRepoChecks } from "../src/repo-checks.ts";
import { runRepository } from "../src/repo-run.ts";
import type { RepoCaller } from "../src/repo-types.ts";
import { repository, manifest, execute } from "./repo-test-helpers.ts";

test("repository apply rejects permission and HEAD drift without touching candidate targets",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const s=await captureRepository(root,parseRepoTask(manifest()));
  await chmod(join(root,"check.mjs"),0o755);
  await assert.rejects(applyRepository(s,{"a.mjs":"changed"}));
  await chmod(join(root,"check.mjs"),s.entries.get("check.mjs")!.mode & 0o777);
  await execute("git",["-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","new head"]);
  await assert.rejects(applyRepository(s,{"a.mjs":"changed"}));
  assert.equal(await readFile(join(root,"a.mjs"),"utf8"),s.initialTargets["a.mjs"]);
});
test("repository materialization rejects dangerous overlays and never replaces source symlinks",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const s=await captureRepository(root,parseRepoTask(manifest()));
  for(const bad of [{"../escape":"bad"},{"a.mjs":"\u0000"},{"a.mjs":"\ud800"},{"a.mjs":"x".repeat(2*1024*1024+1)}])
    await assert.rejects(materializeRepository(s,join(root,"candidate-"+Math.random()),bad));
  await rm(join(root,"a.mjs"));await symlink("check.mjs",join(root,"a.mjs"));
  await assert.rejects(applyRepository(s,{"a.mjs":"changed"}));assert.equal((await lstat(join(root,"a.mjs"))).isSymbolicLink(),true);
});
test("repository check mutations and environment do not escape through successful exit status",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const s=await captureRepository(root,parseRepoTask(manifest()));
  const r=await runRepoChecks(s,{},[{argv:[process.execPath,"-e","const fs=require('node:fs');fs.unlinkSync('check.mjs');fs.symlinkSync('a.mjs','check.mjs')"],timeoutMs:1000}],join(root,"checks"));
  assert.equal(r.ok,false);assert.equal((await lstat(join(root,"check.mjs"))).isFile(),true);
});
test("repository tasks keep hidden checks and unrelated files out of worker prompts",async t=>{
  const root=await repository({"private-not-context.txt":"DO_NOT_SEND_THIS_SENTINEL"});t.after(()=>rm(root,{recursive:true,force:true}));
  let count=0;
  const model:RepoCaller=async o=>{
    count++;assert.equal(o.prompt.includes("DO_NOT_SEND_THIS_SENTINEL"),false);
    assert.equal(o.prompt.includes("assert.equal(value, 42)"),false);
    return {requestedModel:o.model,result:{content:"export const value=42;\n",note:"fixed"},usage:[{event:{},inputTokens:12,outputTokens:8}],
      transcript:{requestedModel:o.model,effectiveModelEvidence:"deepseek-flash",events:[],usage:[{event:{},inputTokens:12,outputTokens:8}],stdout:"",stderr:"",exitCode:0,signal:null,timedOut:false,cancelled:false,durationMs:1}};
  };
  const r=await runRepository({repository:root,task:manifest(),outputDirectory:join(root,"out"),maxMetaCalls:0},model);
  assert.equal(count,1);assert.equal(r.success,true,r.errors.join("\n"));
});
