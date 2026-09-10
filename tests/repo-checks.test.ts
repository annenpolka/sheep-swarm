import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { repository, manifest } from "./repo-test-helpers.ts";
import { parseRepoTask } from "../src/repo-manifest.ts";
import { captureRepository } from "../src/repo-files.ts";
import { runRepoChecks } from "../src/repo-checks.ts";

test("repository acceptance executes actual language commands on isolated candidates",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const s=await captureRepository(root,parseRepoTask(manifest()));
  const bad=await runRepoChecks(s,{},s.task.checks,join(root,"checks")); assert.equal(bad.ok,false);
  const good=await runRepoChecks(s,{"a.mjs":"export const value=42;\n"},s.task.checks,join(root,"checks"));
  assert.equal(good.ok,true,good.errors.join("\n")); assert.notEqual(bad.workspace,good.workspace);
  assert.equal(await readFile(join(root,"a.mjs"),"utf8"),s.initialTargets["a.mjs"]);
});
test("repository acceptance rejects exit-zero mutations, timeouts and spawn errors",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const s=await captureRepository(root,parseRepoTask(manifest()));
  for(const path of ["check.mjs","a.mjs"]){
    const r=await runRepoChecks(s,{},[{argv:[process.execPath,"-e",`require('node:fs').writeFileSync('${path}','cheat')`],timeoutMs:1000}],join(root,"checks"));
    assert.equal(r.ok,false,"mutation should fail: "+path);
  }
  const timed=await runRepoChecks(s,{},[{argv:[process.execPath,"-e","setInterval(()=>{},100)"],timeoutMs:100}],join(root,"checks"));
  assert.equal(timed.ok,false);assert.equal(timed.checks[0]!.timedOut,true);
  const missing=await runRepoChecks(s,{},[{argv:["/definitely/not/a/command"],timeoutMs:100}],join(root,"checks")); assert.equal(missing.ok,false);
});
test("repository checks bound logs and omit provider credentials from child environments",async t=>{
  const root=await repository();t.after(()=>rm(root,{recursive:true,force:true}));
  const old=process.env.OPENCODE_GO_API_KEY;process.env.OPENCODE_GO_API_KEY="test-secret-no-forward";
  t.after(()=>{if(old===undefined)delete process.env.OPENCODE_GO_API_KEY;else process.env.OPENCODE_GO_API_KEY=old;});
  const s=await captureRepository(root,parseRepoTask(manifest()));
  const r=await runRepoChecks(s,{},[{argv:[process.execPath,"-e","if(process.env.OPENCODE_GO_API_KEY)process.exit(9);console.log('x'.repeat(100000))"],timeoutMs:1000}],join(root,"checks"));
  assert.equal(r.ok,true,r.errors.join("\n")); assert.ok(Buffer.byteLength(r.checks[0]!.stdout)<=65536);
});
