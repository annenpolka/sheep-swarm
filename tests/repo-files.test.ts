import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { readFile, writeFile, rm, symlink, chmod, stat, mkdir } from "node:fs/promises";
import { parseRepoTask } from "../src/repo-manifest.ts";
import { captureRepository, materializeRepository, applyRepository } from "../src/repo-files.ts";
import { repository, manifest, execute } from "./repo-test-helpers.ts";

test("capture includes selected untracked targets and rejects symlink parents before reading", async t => {
  const root=await repository({"dir/item.txt":"tracked"});t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,"new.txt"),"untracked \ufffd text");
  const task=parseRepoTask({...manifest(),files:[{path:"new.txt",instructions:"edit"}]});
  const s=await captureRepository(root,task);
  assert.equal(s.initialTargets["new.txt"],"untracked \ufffd text");
  await mkdir(join(root,"other"));await writeFile(join(root,"other/item.txt"),"tracked");
  await rm(join(root,"dir"),{recursive:true});await symlink("other",join(root,"dir"));
  await assert.rejects(captureRepository(root,task),/symlink/);
  await assert.rejects(applyRepository(s,{"new.txt":"replace"}),/symlink/);
});

test("apply checks the captured tracked set and all target parents before any write",async t=>{
  const root=await repository({"gone.txt":"remove"});t.after(()=>rm(root,{recursive:true,force:true}));
  await rm(join(root,"gone.txt"));
  const task=parseRepoTask({...manifest(),files:[...manifest().files,{path:"new/item.txt",instructions:"create"}]});
  const s=await captureRepository(root,task);
  await execute("git",["-C",root,"rm","--cached","gone.txt"]);
  await assert.rejects(applyRepository(s,{"a.mjs":"changed"}),/tracked|index/);
  await execute("git",["-C",root,"reset","--quiet","HEAD","--","gone.txt"]);
  await writeFile(join(root,"new"),"parent is a file");
  await assert.rejects(applyRepository(s,{"a.mjs":"changed","new/item.txt":"new"}));
  assert.equal(await readFile(join(root,"a.mjs"),"utf8"),s.initialTargets["a.mjs"]);
});

test("repository snapshots preserve dirty tracked bytes, executable modes and selected new targets", async t => {
  const root = await repository({ "blob.bin": Buffer.from([0, 255, 1]), "gone.txt": "delete", ".env": "secret" }); t.after(() => rm(root, {recursive:true,force:true}));
  await writeFile(join(root, "a.mjs"), "dirty\n"); await chmod(join(root, "a.mjs"), 0o755);
  await rm(join(root, "gone.txt")); await writeFile(join(root, "untracked.txt"), "preserve");
  const task = parseRepoTask({ ...manifest(), files: [...manifest().files, {path:"new/n.py",instructions:"new"}] });
  const s = await captureRepository(root, task);
  assert.equal(s.initialTargets["a.mjs"], "dirty\n"); assert.equal(s.initialTargets["new/n.py"], "");
  assert.equal(s.entries.has("gone.txt"), false); assert.equal(s.entries.has(".env"), false); assert.equal(s.entries.has("untracked.txt"), false);
  const dir = join(root, "candidate"); await materializeRepository(s, dir, {"a.mjs":"new\n","new/n.py":"x=1\n"});
  assert.deepEqual(await readFile(join(dir,"blob.bin")), Buffer.from([0,255,1]));
  assert.equal((await stat(join(dir,"a.mjs"))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(root,"a.mjs"),"utf8"), "dirty\n");
  assert.equal(s.entries.get("a.mjs")!.bytes.toString(), "dirty\n");
  await assert.rejects(materializeRepository(s,dir,{}));
  await assert.rejects(materializeRepository(s,join(root,"bad"),{"check.mjs":"bypass"}));
});
test("repository capture rejects symlinks, missing protected data and invalid target text", async t => {
  const root = await repository(); t.after(() => rm(root,{recursive:true,force:true}));
  await symlink("a.mjs",join(root,"alias"));
  await assert.rejects(captureRepository(root,parseRepoTask({...manifest(),context:["alias"]})));
  await assert.rejects(captureRepository(root,parseRepoTask({...manifest(),protected:["missing"]})));
  await writeFile(join(root,"a.mjs"),Buffer.from([255]));
  await assert.rejects(captureRepository(root,parseRepoTask(manifest())));
});
test("repository apply detects drift before writing and preserves unrelated untracked work", async t => {
  const root = await repository(); t.after(() => rm(root,{recursive:true,force:true}));
  const task=parseRepoTask({...manifest(),files:[...manifest().files,{path:"new.mjs",instructions:"new"}]});
  const s=await captureRepository(root,task);
  await writeFile(join(root,"check.mjs"),"changed");
  await assert.rejects(applyRepository(s,{"a.mjs":"replacement","new.mjs":"new"}));
  assert.equal(await readFile(join(root,"a.mjs"),"utf8"),s.initialTargets["a.mjs"]);
  await writeFile(join(root,"check.mjs"),s.entries.get("check.mjs")!.bytes);
  await writeFile(join(root,"notes.txt"),"user work");
  const changed=await applyRepository(s,{"a.mjs":"replacement","new.mjs":"new"});
  assert.deepEqual(changed.sort(),["a.mjs","new.mjs"]);
  assert.equal(await readFile(join(root,"notes.txt"),"utf8"),"user work");
});
test("repository apply refuses new-file collision, tracked deletion drift and symlink parents", async t => {
  const root=await repository({"old.txt":"old"}); t.after(()=>rm(root,{recursive:true,force:true}));
  await rm(join(root,"old.txt"));
  const task=parseRepoTask({...manifest(),files:[{path:"dir/new.mjs",instructions:"new"}]});
  const s=await captureRepository(root,task);
  await writeFile(join(root,"old.txt"),"restored"); await assert.rejects(applyRepository(s,{"dir/new.mjs":"new"}));
  await rm(join(root,"old.txt")); await mkdir(join(root,"elsewhere")); await symlink("elsewhere",join(root,"dir"));
  await assert.rejects(applyRepository(s,{"dir/new.mjs":"new"}));
  await rm(join(root,"dir")); await mkdir(join(root,"dir")); await writeFile(join(root,"dir/new.mjs"),"user new file");
  await assert.rejects(applyRepository(s,{"dir/new.mjs":"new"}));
  await execute("git",["-C",root,"add","dir/new.mjs"]);
  await assert.rejects(applyRepository(s,{"dir/new.mjs":"new"}));
});
