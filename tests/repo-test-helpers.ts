import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
export const execute = promisify(execFile);
export async function repository(files: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(join(tmpdir(), "sheep-repo-test-"));
  const values = { "a.mjs": "export const value = 0;\n", "check.mjs": "import assert from 'node:assert/strict'; import {value} from './a.mjs'; assert.equal(value, 42);\n", ...files };
  for (const [p, value] of Object.entries(values)) { await mkdir(dirname(join(root, p)), { recursive: true }); await writeFile(join(root, p), value); }
  await execute("git", ["init", "-q", root]);
  await execute("git", ["-C", root, "add", "."]);
  await execute("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  return root;
}
export function manifest() { return { version: 1, goal: "Return forty-two", files: [{ path: "a.mjs", instructions: "Export value=42" }],
  protected: ["check.mjs"], checks: [{ argv: [process.execPath, "check.mjs"] }] }; }
