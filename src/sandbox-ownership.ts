import { hostname } from "node:os";
import { mkdir, open, readFile, readdir, rename, lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, type Capture } from "./sandbox-process.ts";

export const OWNERS_DIRECTORY = fileURLToPath(new URL("../.sheep/sandbox-owners/", import.meta.url));
const NAME = /^sheep-(?:(?:accept|verify|recovery)-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface Owner {
  format: 1; name: string; image: string; host: string; pid: number;
  createdAt: string; released: boolean;
}
export interface RecoveryEntry { name: string; action: "active" | "absent" | "reaped" | "foreign-host" | "refused"; detail?: string }
export interface RecoveryIO {
  alive: (pid: number) => boolean;
  run: (args: string[]) => Promise<Capture>;
}
const defaultIO: RecoveryIO = {
  alive: pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } },
  run: args => capture("sbx", args, { timeoutMs: 60_000 }),
};
function checked(result: Capture): string {
  if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.tooLarge) throw new Error("Sandbox recovery command failed");
  return result.stdout;
}
function valid(value: unknown): value is Owner {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<Owner>;
  return row.format === 1 && typeof row.name === "string" && NAME.test(row.name)
    && typeof row.image === "string" && /^docker\/sandbox-templates:docker-agent@sha256:[0-9a-f]{64}$/.test(row.image)
    && typeof row.host === "string" && Number.isSafeInteger(row.pid) && row.pid! > 0
    && typeof row.released === "boolean" && typeof row.createdAt === "string";
}

/** Durable intent is written before sbx create. No token or workspace content is recorded. */
export async function ownSandbox(name: string, image: string, directory = OWNERS_DIRECTORY) {
  const owner: Owner = { format: 1, name, image, host: hostname(), pid: process.pid, createdAt: new Date().toISOString(), released: false };
  if (!valid(owner)) throw new Error("Invalid sandbox ownership identity");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.json`);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(owner) + "\n"); await file.sync(); } finally { await file.close(); }
  return { release: async () => {
    const temporary = `${path}.${process.pid}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ ...owner, released: true }) + "\n"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } };
}

/** Reap only journaled UUID names whose owner is definitely dead on this host. */
export async function recoverOwnedSandboxes(directory = OWNERS_DIRECTORY, io: RecoveryIO = defaultIO): Promise<RecoveryEntry[]> {
  let entries: string[];
  try { entries = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: RecoveryEntry[] = [];
  let listed: Set<string> | undefined;
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const path = join(directory, entry);
    if (!(await lstat(path)).isFile()) { result.push({ name: entry, action: "refused", detail: "nonregular owner record" }); continue; }
    let owner: unknown;
    try { owner = JSON.parse(await readFile(path, "utf8")); } catch { result.push({ name: entry, action: "refused", detail: "invalid owner JSON" }); continue; }
    if (!valid(owner) || entry !== `${owner.name}.json`) { result.push({ name: entry, action: "refused", detail: "invalid owner identity" }); continue; }
    if (owner.released) continue;
    if (owner.host !== hostname()) { result.push({ name: owner.name, action: "foreign-host" }); continue; }
    if (io.alive(owner.pid)) { result.push({ name: owner.name, action: "active" }); continue; }
    if (!listed) {
      const value = JSON.parse(checked(await io.run(["ls", "--json"])));
      if (!Array.isArray(value.sandboxes) || value.sandboxes.some((row: { name?: unknown }) => typeof row?.name !== "string")) throw new Error("Invalid sandbox listing");
      listed = new Set(value.sandboxes.map((row: { name: string }) => row.name));
    }
    // Keep absent entries: a killed client may still have a create in flight.
    if (!listed.has(owner.name)) { result.push({ name: owner.name, action: "absent" }); continue; }
    const inspection = await io.run(["inspect", owner.name, "--json"]);
    if (inspection.exitCode !== 0) {
      const after = JSON.parse(checked(await io.run(["ls", "--json"])));
      if (Array.isArray(after.sandboxes) && !after.sandboxes.some((row: { name?: string }) => row.name === owner.name)) {
        result.push({ name: owner.name, action: "absent" }); continue;
      }
    }
    const inspected = JSON.parse(checked(inspection));
    if (inspected.name !== owner.name || inspected.agent !== "docker-agent" || inspected.image !== owner.image
      || inspected.workspace || inspected.workspaces?.length || inspected.kits?.length) {
      result.push({ name: owner.name, action: "refused", detail: "VM identity or mounts differ" }); continue;
    }
    // An active PID, including conservative PID reuse, always wins over reclamation.
    if (io.alive(owner.pid)) { result.push({ name: owner.name, action: "active" }); continue; }
    const removed = await io.run(["rm", "--force", owner.name]);
    const after = JSON.parse(checked(await io.run(["ls", "--json"])));
    if (!Array.isArray(after.sandboxes) || after.sandboxes.some((row: { name?: string }) => row.name === owner.name)) {
      checked(removed); throw new Error(`Sandbox removal not confirmed: ${owner.name}`);
    }
    result.push({ name: owner.name, action: "reaped" });
    // Retain the intent even after reaping: inspect it again on future starts.
  }
  return result;
}

let startup: Promise<void> | undefined;
/** One sweep per host process; no background daemon and no model/run resumption. */
export function recoverBeforeSandboxStart(): Promise<void> {
  return startup ??= recoverOwnedSandboxes().then(entries => {
    if (entries.some(entry => entry.action === "refused")) throw new Error("Sandbox recovery refused an ownership record; inspect sandbox:reap output");
  });
}
