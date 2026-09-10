import type { RepoEntry, RepoSnapshot, RepoTask } from './repo-types.ts';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const MAX_CAPTURE_FILES = 10000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const trackedSnapshots = new WeakMap<RepoSnapshot, string>();

interface GitEntry {
  readonly path: string;
  readonly mode: number;
}

function isExcludedComponent(component: string): boolean {
  component = component.toLowerCase();
  return (
    component === '.git' ||
    component === '.sheep' ||
    component === '.sheep-internal' ||
    component === 'node_modules' ||
    component === '.env' ||
    component.startsWith('.env.')
  );
}

/** Validate a repository-relative path and reject structural hazards. */
function assertPathShape(value: string, where: string): string {
  if (value.length === 0) throw new Error(`${where} is empty`);
  if (value.startsWith('/')) throw new Error(`${where} is absolute: ${value}`);
  if (value.includes('\\')) throw new Error(`${where} contains backslash: ${value}`);
  const components = value.split('/');
  for (const component of components) {
    if (component === '' || component === '.' || component === '..') {
      throw new Error(`${where} has invalid component: ${value}`);
    }
    for (let i = 0; i < component.length; i++) {
      const code = component.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) throw new Error(`${where} has control character: ${value}`);
    }
  }
  return value;
}

/**
 * Validate a path obtained from git. Excluded paths are simply skipped by the
 * caller, not treated as a fatal error, because a real worktree may legally
 * track `.env`/`.env.*` entries that the contract requires us to omit.
 */
function isExcludedPath(value: string): boolean {
  for (const component of value.split('/')) {
    if (isExcludedComponent(component)) return true;
  }
  return false;
}

/** Validate an explicitly named task path: excluded components are rejected. */
function assertTaskPath(value: string, where: string): void {
  assertPathShape(value, where);
  for (const component of value.split('/')) {
    if (isExcludedComponent(component)) {
      throw new Error(`${where} uses excluded component: ${value}`);
    }
  }
}

function runGit(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function runGitBytes(args: readonly string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'buffer', maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr.toString('utf8') || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function resolveRepositoryRoot(repository: string): Promise<string> {
  const real = await realpath(repository).catch(() => {
    throw new Error(`repository path does not exist: ${repository}`);
  });
  const info = await stat(real);
  if (!info.isDirectory()) throw new Error(`repository path is not a directory: ${repository}`);
  const toplevel = (await runGit(['rev-parse', '--show-toplevel'], real)).replace(/\n$/, '');
  if (toplevel.length === 0) throw new Error(`not inside a git worktree: ${repository}`);
  return await realpath(toplevel);
}

async function getHead(root: string): Promise<string> {
  const head = (await runGit(['rev-parse', 'HEAD'], root)).trim();
  if (head.length === 0) throw new Error('unable to resolve HEAD');
  return head;
}

function splitNullDelimited(buf: Buffer): string[] {
  const value = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(buf);
  const parts = value.split('\u0000');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

async function listTrackedFiles(root: string): Promise<GitEntry[]> {
  const output = await runGitBytes(['ls-files', '-z', '--stage'], root);
  const records = splitNullDelimited(output);
  const byPath = new Map<string, GitEntry>();
  const modes = new Map<string, string>();
  for (const record of records) {
    // record: "<mode> <sha> <stage>\t<path>"
    const tabIndex = record.indexOf('\t');
    if (tabIndex < 0) throw new Error('unexpected git ls-files record');
    const meta = record.slice(0, tabIndex);
    const filePath = record.slice(tabIndex + 1);
    const [modeText, , stage] = meta.split(' ');
    if (stage !== '0') throw new Error(`unmerged index entry: ${filePath}`);
    if (modeText === undefined) throw new Error('unexpected git ls-files mode');
    const existing = modes.get(filePath);
    if (existing !== undefined) {
      if (existing !== modeText) throw new Error(`tracked path has conflicting index entries: ${filePath}`);
      continue;
    }
    modes.set(filePath, modeText);
    if (modeText === '160000') throw new Error(`tracked path is a submodule: ${filePath}`);
    if (modeText !== '100644' && modeText !== '100755') {
      throw new Error(`tracked path has unsupported mode: ${filePath}`);
    }
    // Excluded tracked files (e.g. a committed `.env`) are omitted, not fatal.
    if (isExcludedPath(filePath)) continue;
    assertPathShape(filePath, 'tracked path');
    byPath.set(filePath, { path: filePath, mode: modeText === '100755' ? 0o755 : 0o644 });
  }
  return [...byPath.values()];
}

interface CapturedEntry {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

function decodeStrictUtf8(bytes: Buffer, where: string): string {
  if (bytes.includes(0)) throw new Error(`${where} contains a NUL byte`);
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`${where} exceeds maximum text size`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${where} is not valid UTF-8`);
  return text;
}

/**
 * Reject symlinks in any path component. `allowMissingTail` permits the final
 * components to be absent (used for targets that may not exist yet), but any
 * existing prefix must consist solely of real directories.
 */
async function assertNoSymlinkComponents(
  root: string,
  relative: string,
  where: string,
  allowMissingTail: boolean,
): Promise<void> {
  const components = relative.split('/');
  let current = root;
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        if (allowMissingTail) return;
        throw new Error(`${where} has a missing component: ${relative}`);
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`${where} is a symlink: ${relative}`);
    const isFinal = i === components.length - 1;
    if (!isFinal && !info.isDirectory()) {
      throw new Error(`${where} has a non-directory parent: ${relative}`);
    }
    if (isFinal && !info.isFile()) {
      throw new Error(`${where} is not a regular file: ${relative}`);
    }
  }
}

async function readStrictFile(root: string, relative: string, where: string): Promise<CapturedEntry> {
  assertTaskPath(relative, where);
  await assertNoSymlinkComponents(root, relative, where, false);
  const absolute = path.join(root, relative);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`${where} is not a regular file: ${relative}`);
  if (info.size > MAX_CAPTURE_BYTES) throw new Error(`${where} exceeds snapshot size limit`);
  return { path: relative, bytes: await readFile(absolute), mode: info.mode & 0o777 };
}

export async function captureRepository(repository: string, task: RepoTask): Promise<RepoSnapshot> {
  const root = await resolveRepositoryRoot(repository);
  const head = await getHead(root);

  const targetPaths = task.files.map((file) => file.path);
  const targetSet = new Set(targetPaths);
  const explicitPaths = new Set<string>([...task.context, ...task.protected]);

  const tracked = await listTrackedFiles(root);
  const captured = new Map<string, CapturedEntry>();
  let totalBytes = 0;

  const addEntry = (entry: CapturedEntry): void => {
    if (captured.has(entry.path)) return;
    if (captured.size >= MAX_CAPTURE_FILES) throw new Error('repository snapshot exceeds maximum file count');
    totalBytes += entry.bytes.length;
    if (totalBytes > MAX_CAPTURE_BYTES) throw new Error('repository snapshot exceeds maximum total size');
    captured.set(entry.path, entry);
  };

  for (const entry of tracked) {
    const absolute = path.join(root, entry.path);
    await assertNoSymlinkComponents(root, entry.path, 'tracked path', true);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue; // tracked deletion preserved
      throw error;
    }
    await assertNoSymlinkComponents(root, entry.path, 'tracked path', false);
    if (info.isSymbolicLink()) throw new Error(`tracked path is a symlink: ${entry.path}`);
    if (!info.isFile()) throw new Error(`tracked path is not a regular file: ${entry.path}`);
    if (info.size + totalBytes > MAX_CAPTURE_BYTES) throw new Error('repository snapshot exceeds maximum total size');
    addEntry({ path: entry.path, bytes: await readFile(absolute), mode: info.mode & 0o777 });
  }

  for (const relative of explicitPaths) {
    if (captured.has(relative)) continue;
    addEntry(await readStrictFile(root, relative, 'explicit path'));
  }

  if (captured.size > MAX_CAPTURE_FILES) throw new Error('repository snapshot exceeds maximum file count');

  // Targets must be validated even when they are not currently captured.
  for (const target of targetSet) {
    assertTaskPath(target, `target ${target}`);
    await assertNoSymlinkComponents(root, target, 'target', true);
    if (captured.has(target)) continue;
    if (await pathExists(path.join(root,target))) addEntry(await readStrictFile(root,target,'target'));
  }
  if (captured.size > MAX_CAPTURE_FILES) throw new Error('repository snapshot exceeds maximum file count');

  const initialTargets: Record<string, string> = Object.create(null);
  for (const target of targetPaths) {
    const existing = captured.get(target);
    if (existing !== undefined) {
      initialTargets[target] = decodeStrictUtf8(existing.bytes, `target ${target}`);
    } else {
      initialTargets[target] = '';
    }
  }

  for (const relative of task.context) {
    const entry = captured.get(relative);
    if (entry === undefined) throw new Error(`context path is missing: ${relative}`);
    decodeStrictUtf8(entry.bytes, `context ${relative}`);
  }
  for (const relative of task.protected) {
    const entry = captured.get(relative);
    if (entry === undefined) throw new Error(`protected path is missing: ${relative}`);
  }

  const snapshotEntries = new Map<string, RepoEntry>();
  for (const [key, value] of captured) {
    snapshotEntries.set(key, { bytes: Buffer.from(value.bytes), mode: value.mode });
  }

  const snapshot = { root, head, task, entries: snapshotEntries, initialTargets };
  trackedSnapshots.set(snapshot, JSON.stringify(tracked));
  return snapshot;
}

function assertOverlayPathSafe(relative: string): void {
  assertTaskPath(relative, 'overlay path');
}

function decodeOverlayContent(value: unknown, relative: string): Buffer {
  if (typeof value !== 'string') throw new Error(`overlay content for ${relative} must be a string`);
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.includes(0)) throw new Error(`overlay content for ${relative} contains a NUL byte`);
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`overlay content for ${relative} exceeds maximum size`);
  if (bytes.toString('utf8') !== value) {
    throw new Error(`overlay content for ${relative} is not valid UTF-8`);
  }
  return bytes;
}

function declaredTargets(snapshot: RepoSnapshot): ReadonlySet<string> {
  return new Set(snapshot.task.files.map((file) => file.path));
}

function validateOverlay(
  snapshot: RepoSnapshot,
  contents: Readonly<Record<string, string>>,
): Map<string, Buffer> {
  const targets = declaredTargets(snapshot);
  const overlay = new Map<string, Buffer>();
  for (const key of Object.keys(contents)) {
    if (!targets.has(key)) throw new Error(`overlay references undeclared path: ${key}`);
    assertOverlayPathSafe(key);
    overlay.set(key, decodeOverlayContent(contents[key], key));
  }
  return overlay;
}

async function pathExists(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureParentDirectory(root: string, relative: string): Promise<void> {
  const components = relative.split('/');
  components.pop();
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        await mkdir(current, { mode: 0o755 });
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`refusing to traverse symlink parent: ${current}`);
    if (!info.isDirectory()) throw new Error(`parent path is not a directory: ${current}`);
  }
}

async function copySnapshotEntries(snapshot: RepoSnapshot, destination: string): Promise<void> {
  for (const [relative, entry] of snapshot.entries) {
    assertOverlayPathSafe(relative);
    const absolute = path.join(destination, relative);
    await ensureParentDirectory(destination, relative);
    await writeFile(absolute, entry.bytes, { mode: entry.mode });
    await chmod(absolute, entry.mode);
  }
}

export async function materializeRepository(
  snapshot: RepoSnapshot,
  directory: string,
  contents: Readonly<Record<string, string>>,
): Promise<void> {
  const overlay = validateOverlay(snapshot, contents);
  const target = path.resolve(directory);
  if (await pathExists(target)) throw new Error(`materialize destination already exists: ${directory}`);
  await mkdir(target, { recursive: true, mode: 0o755 });
  await copySnapshotEntries(snapshot, target);
  for (const [relative, bytes] of overlay) {
    const absolute = path.join(target, relative);
    await ensureParentDirectory(target, relative);
    const existing = snapshot.entries.get(relative);
    const mode = existing?.mode ?? 0o644;
    await writeFile(absolute, bytes, { mode });
    await chmod(absolute, mode);
  }
}

interface ApplyPlan {
  readonly rel: string;
  readonly bytes: Buffer;
  readonly mode: number;
}

interface RollbackItem {
  readonly rel: string;
  readonly existed: boolean;
  readonly original?: Buffer;
  readonly originalMode?: number;
}

async function verifyEntryUnchanged(snapshot: RepoSnapshot, absolute: string, relative: string): Promise<void> {
  await assertNoSymlinkComponents(snapshot.root,relative,'captured path',false);
  const expected = snapshot.entries.get(relative);
  if (expected === undefined) throw new Error(`captured path is unknown: ${relative}`);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') throw new Error(`captured path disappeared: ${relative}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`captured path is now a symlink: ${relative}`);
  if (!info.isFile()) throw new Error(`captured path is no longer a regular file: ${relative}`);
  if ((info.mode & 0o777) !== expected.mode) throw new Error(`captured path mode has drifted: ${relative}`);
  const current = await readFile(absolute);
  if (!current.equals(expected.bytes)) throw new Error(`captured path has drifted: ${relative}`);
}

async function verifyCapturedSet(snapshot: RepoSnapshot, root: string): Promise<void> {
  for (const relative of snapshot.entries.keys()) {
    await verifyEntryUnchanged(snapshot, path.join(root, relative), relative);
  }
  // Tracked paths recorded as deleted at capture must still be absent.
  const tracked = await listTrackedFiles(root);
  if (JSON.stringify(tracked) !== trackedSnapshots.get(snapshot)) throw new Error('tracked index path set has changed since capture');
  for (const entry of tracked) {
    if (snapshot.entries.has(entry.path)) continue;
    if (await pathExists(path.join(root, entry.path))) {
      throw new Error(`tracked path reappeared since capture: ${entry.path}`);
    }
  }
}

async function recomputeHead(snapshot: RepoSnapshot): Promise<void> {
  const current = await getHead(snapshot.root);
  if (current !== snapshot.head) throw new Error('repository HEAD has changed since capture');
}

async function checkAbsentTargets(snapshot: RepoSnapshot): Promise<void> {
  for (const file of snapshot.task.files) {
    await assertNoSymlinkComponents(snapshot.root,file.path,'target',true);
    if (snapshot.entries.has(file.path)) continue;
    if (await pathExists(path.join(snapshot.root, file.path))) {
      throw new Error(`originally absent target now exists: ${file.path}`);
    }
  }
}

async function rollback(applied: readonly RollbackItem[]): Promise<void> {
  const failures: string[] = [];
  for (const item of applied) {
    try {
      if (item.existed) {
        await writeFile(item.rel, item.original ?? Buffer.alloc(0));
        if (item.originalMode !== undefined) await chmod(item.rel, item.originalMode);
      } else {
        await rm(item.rel, { force: true });
      }
    } catch (error) {
      failures.push(`${item.rel}: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) throw new Error(`rollback failed for: ${failures.join(', ')}`);
}

export async function applyRepository(
  snapshot: RepoSnapshot,
  contents: Readonly<Record<string, string>>,
): Promise<string[]> {
  const overlay = validateOverlay(snapshot, contents);
  const root = snapshot.root;

  await recomputeHead(snapshot);
  await verifyCapturedSet(snapshot, root);
  await checkAbsentTargets(snapshot);

  const plan: ApplyPlan[] = [];
  for (const [relative, bytes] of overlay) {
    assertOverlayPathSafe(relative);
    const existing = snapshot.entries.get(relative);
    if (existing !== undefined) {
      if (existing.bytes.equals(bytes)) continue;
      plan.push({ rel: relative, bytes, mode: existing.mode });
      continue;
    }
    if (await pathExists(path.join(root, relative))) {
      throw new Error(`new target collides with existing path: ${relative}`);
    }
    plan.push({ rel: relative, bytes, mode: 0o644 });
  }

  const applied: RollbackItem[] = [];
  if (!plan.length) return [];
  // A uniquely owned staging directory cannot collide with unrelated user files.
  const stageDir = await mkdtemp(path.join(root, '.sheep-stage-'));
  try {
    // Prepare every replacement before changing any target.
    for (const [index, item] of plan.entries()) {
      const staged = path.join(stageDir, String(index));
      await writeFile(staged, item.bytes, {flag:'wx',mode:item.mode});
      await chmod(staged,item.mode);
    }
    for (const [index,item] of plan.entries()) {
      const absolute=path.join(root,item.rel);
      await ensureParentDirectory(root,item.rel);
      await assertNoSymlinkComponents(root,item.rel,'target',true);
      const current=snapshot.entries.get(item.rel);
      if (!current && await pathExists(absolute)) throw new Error(`new target collision: ${item.rel}`);
      applied.push(current ? {rel:absolute,existed:true,original:current.bytes,originalMode:current.mode}
        : {rel:absolute,existed:false});
      await rename(path.join(stageDir,String(index)),absolute);
    }
  } catch(error) {
    try { await rollback(applied.reverse()); }
    catch(rollbackError) { throw new AggregateError([error,rollbackError],'repository apply and rollback failed'); }
    throw error;
  } finally {
    await rm(stageDir,{recursive:true,force:true});
  }
  return plan.map(item=>item.rel).sort();
}
