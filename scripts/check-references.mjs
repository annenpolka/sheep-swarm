import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const base = new URL("../docs/references/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", base), "utf8"));
assert.ok(Array.isArray(manifest.files) && manifest.files.length === 2);
for (const entry of manifest.files) {
  assert.match(entry.file, /^raw--[a-z0-9-]+\.md$/);
  const content = await readFile(new URL(entry.file, base));
  assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256,
    `Reference changed: ${entry.file}. Add a new dated source instead of editing the snapshot.`);
}
console.log(`Verified ${manifest.files.length} reference snapshots.`);
