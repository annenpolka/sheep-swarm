import type { RepoCommand, RepoFileTask, RepoTask } from './repo-types.ts';

const MAX_TARGETS = 64;
const MAX_PATHS = 256;
const MAX_COMMANDS = 32;
const MAX_GOAL_INSTRUCTIONS = 32000;
const MAX_PATH = 1024;
const MAX_ARGV = 4096;
const MAX_ARGS = 128;
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 300000;
const DEFAULT_TIMEOUT = 30000;

const RESERVED_COMPONENTS = new Set(['.git', '.sheep', 'node_modules', '.sheep-internal']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} has unknown key: ${key}`);
  }
  // `__proto__` own key is not enumerated by Object.keys when set via literal
  // but is when defined via Object.defineProperty / JSON.parse; check explicitly.
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) {
    throw new Error(`${where} has unknown key: __proto__`);
  }
}

function requireString(value: unknown, where: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  if (value.trim().length === 0) throw new Error(`${where} must not be blank`);
  if (value.length > max) throw new Error(`${where} exceeds maximum length`);
  return value;
}

function requireArray(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function requireBoundedArray(value: unknown, where: string, max: number): readonly unknown[] {
  const arr = requireArray(value, where);
  if (arr.length > max) throw new Error(`${where} exceeds maximum of ${max} entries`);
  return arr;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const ENV_BASENAME = /^\.env(\..*)?$/;

export function safeRepoPath(value: unknown): string {
  const path = requireString(value, 'path', MAX_PATH);
  if (Buffer.from(path,'utf8').toString('utf8') !== path) throw new Error('path must be valid Unicode');
  if (path.startsWith('/')) throw new Error(`path must be repository-relative: ${path}`);
  if (path.includes('\\')) throw new Error(`path must not contain backslashes: ${path}`);
  if (hasControlChars(path)) throw new Error(`path must not contain control characters: ${path}`);
  const components = path.split('/');
  for (const component of components) {
    if (component === '') throw new Error(`path has empty component: ${path}`);
    if (component === '.' || component === '..') throw new Error(`path has dot component: ${path}`);
    if (RESERVED_COMPONENTS.has(component.toLowerCase())) throw new Error(`path uses reserved component: ${path}`);
    if (ENV_BASENAME.test(component.toLowerCase())) throw new Error(`path uses reserved env basename: ${path}`);
  }
  return path;
}

function parseCommand(value: unknown, where: string): RepoCommand {
  if (!isPlainObject(value)) throw new Error(`${where} must be an object`);
  rejectUnknownKeys(value, ['argv', 'timeoutMs'], where);
  if (!Object.prototype.hasOwnProperty.call(value, 'argv')) throw new Error(`${where}.argv is required`);
  const argvRaw = requireBoundedArray(value.argv, `${where}.argv`, MAX_ARGS);
  if (argvRaw.length === 0) throw new Error(`${where}.argv must not be empty`);
  const argv: string[] = [];
  for (let i = 0; i < argvRaw.length; i++) {
    const item = argvRaw[i];
    if (typeof item !== 'string') throw new Error(`${where}.argv[${i}] must be a string`);
    if (item.includes('\0')) throw new Error(`${where}.argv[${i}] contains NUL`);
    if (item.length > MAX_ARGV) throw new Error(`${where}.argv[${i}] exceeds maximum length`);
    if (i === 0 && item.trim().length === 0) throw new Error(`${where}.argv[0] must not be blank`);
    argv.push(item);
  }
  let timeoutMs = DEFAULT_TIMEOUT;
  if (Object.prototype.hasOwnProperty.call(value, 'timeoutMs') && value.timeoutMs !== undefined) {
    const t = value.timeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t)) throw new Error(`${where}.timeoutMs must be an integer`);
    if (t < MIN_TIMEOUT || t > MAX_TIMEOUT) throw new Error(`${where}.timeoutMs out of range`);
    timeoutMs = t;
  }
  return { argv, timeoutMs };
}

function parseCommandList(value: unknown, where: string): readonly RepoCommand[] {
  const arr = requireBoundedArray(value, where, MAX_COMMANDS);
  return arr.map((entry, i) => parseCommand(entry, `${where}[${i}]`));
}

function parsePathList(value: unknown, where: string): readonly string[] {
  const arr = requireBoundedArray(value, where, MAX_PATHS);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const path = safeRepoPath(arr[i]);
    if (seen.has(path)) throw new Error(`${where} has duplicate path: ${path}`);
    seen.add(path);
    result.push(path);
  }
  return result;
}

function parseFileTask(value: unknown, where: string): RepoFileTask {
  if (!isPlainObject(value)) throw new Error(`${where} must be an object`);
  rejectUnknownKeys(value, ['path', 'instructions', 'dependsOn', 'checks'], where);
  if (!Object.prototype.hasOwnProperty.call(value, 'path')) throw new Error(`${where}.path is required`);
  if (!Object.prototype.hasOwnProperty.call(value, 'instructions')) throw new Error(`${where}.instructions is required`);
  const path = safeRepoPath(value.path);
  const instructions = requireString(value.instructions, `${where}.instructions`, MAX_GOAL_INSTRUCTIONS);
  let dependsOn: readonly string[] = [];
  if (Object.prototype.hasOwnProperty.call(value, 'dependsOn') && value.dependsOn !== undefined) {
    const raw = requireArray(value.dependsOn, `${where}.dependsOn`);
    const seen = new Set<string>();
    const list: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const dep = safeRepoPath(raw[i]);
      if (seen.has(dep)) throw new Error(`${where}.dependsOn has duplicate path: ${dep}`);
      seen.add(dep);
      list.push(dep);
    }
    dependsOn = list;
  }
  let checks: readonly RepoCommand[] = [];
  if (Object.prototype.hasOwnProperty.call(value, 'checks') && value.checks !== undefined) {
    checks = parseCommandList(value.checks, `${where}.checks`);
  }
  return { path, instructions, dependsOn, checks };
}

export function parseRepoTask(value: unknown): RepoTask {
  if (!isPlainObject(value)) throw new Error('repository task must be an object');
  rejectUnknownKeys(value, ['version', 'goal', 'files', 'context', 'protected', 'checks', ...(value.version === 2 ? ['discovery'] : [])], 'repository task');
  if (!Object.prototype.hasOwnProperty.call(value, 'version')) throw new Error('repository task.version is required');
  if (value.version !== 1 && value.version !== 2) throw new Error('repository task.version must be 1 or 2');
  if (!Object.prototype.hasOwnProperty.call(value, 'goal')) throw new Error('repository task.goal is required');
  const goal = requireString(value.goal, 'repository task.goal', MAX_GOAL_INSTRUCTIONS);
  if (!Object.prototype.hasOwnProperty.call(value, 'files')) throw new Error('repository task.files is required');
  const filesRaw = requireBoundedArray(value.files, 'repository task.files', MAX_TARGETS);
  if (filesRaw.length === 0) throw new Error('repository task.files must not be empty');
  const files: RepoFileTask[] = [];
  const targetPaths = new Set<string>();
  for (let i = 0; i < filesRaw.length; i++) {
    const file = parseFileTask(filesRaw[i], `repository task.files[${i}]`);
    if (targetPaths.has(file.path)) throw new Error(`duplicate target path: ${file.path}`);
    targetPaths.add(file.path);
    files.push(file);
  }
  for (const file of files) {
    if (files.some(other=>other.path !== file.path && other.path.startsWith(file.path+'/')))
      throw new Error(`target paths overlap as file and directory: ${file.path}`);
    for (const dep of file.dependsOn) {
      if (!targetPaths.has(dep)) throw new Error(`unknown dependency target: ${dep}`);
      if (dep === file.path) throw new Error(`self dependency: ${dep}`);
    }
  }
  // cycle detection
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const path of targetPaths) color.set(path, WHITE);
  const adj = new Map<string, readonly string[]>();
  for (const file of files) adj.set(file.path, file.dependsOn);
  const visit = (node: string): void => {
    color.set(node, GRAY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) throw new Error(`dependency cycle detected at: ${next}`);
      if (c === WHITE) visit(next);
    }
    color.set(node, BLACK);
  };
  for (const path of targetPaths) {
    if (color.get(path) === WHITE) visit(path);
  }
  let context: readonly string[] = [];
  if (Object.prototype.hasOwnProperty.call(value, 'context') && value.context !== undefined) {
    context = parsePathList(value.context, 'repository task.context');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'protected')) throw new Error('repository task.protected is required');
  const protectedPaths = parsePathList(value.protected, 'repository task.protected');
  if (protectedPaths.length === 0) throw new Error('repository task.protected must not be empty');
  if (!Object.prototype.hasOwnProperty.call(value, 'checks')) throw new Error('repository task.checks is required');
  const checks = parseCommandList(value.checks, 'repository task.checks');
  if (checks.length === 0) throw new Error('repository task.checks must not be empty');
  for (const path of targetPaths) {
    if (protectedPaths.includes(path)) throw new Error(`target overlaps protected path: ${path}`);
  }
  const base = {goal, files, context, protected: protectedPaths, checks};
  if (value.version === 1) return {version:1,...base};
  const d=value.discovery;
  if (!isPlainObject(d)) throw new Error('version 2 requires discovery');
  rejectUnknownKeys(d,['mode','readable','maxReadCalls','maxDeliveredBytes'],'discovery');
  if (d.mode !== 'static' && d.mode !== 'static+reads') throw new Error('invalid discovery mode');
  const readable=parsePathList(d.readable,'discovery.readable');
  for (const path of readable) if (protectedPaths.includes(path) && !context.includes(path))
    throw new Error(`discovery cannot publish protected file: ${path}`);
  const bounded=(v:unknown,fallback:number,max:number):number=>{
    if(v===undefined)return fallback;
    if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)throw new Error('invalid discovery limit');
    return v;
  };
  return {version:2,...base,discovery:{mode:d.mode,readable,
    maxReadCalls:bounded(d.maxReadCalls,2,32),maxDeliveredBytes:bounded(d.maxDeliveredBytes,65536,2*1024*1024)}};
}
