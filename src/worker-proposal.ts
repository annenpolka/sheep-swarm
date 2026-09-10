import { Buffer } from 'node:buffer';
import { safeRepoPath } from './repo-manifest.ts';

/** A worker's proposed next action against a repository snapshot. */
export type RepoWorkerProposal =
  | { readonly kind: 'write'; readonly content: string; readonly note: string }
  | { readonly kind: 'read'; readonly paths: readonly string[]; readonly note: string }
  | {
      readonly kind: 'uncertain';
      readonly observed: readonly string[];
      readonly missing: readonly string[];
      readonly hypothesis: string | null;
      readonly note: string;
    };

export const MAX_NOTE_CHARS = 8192;
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_READ_PATHS = 32;
export const MAX_UNCERTAIN_ITEMS = 32;
export const MAX_UNCERTAIN_ITEM_CHARS = 1024;

const KIND_KEYS: Readonly<Record<RepoWorkerProposal['kind'], readonly string[]>> = {
  write: ['kind', 'content', 'note'],
  read: ['kind', 'paths', 'note'],
  uncertain: ['kind', 'observed', 'missing', 'hypothesis', 'note'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where} has unknown key: ${key}`);
  }
  if (hasOwn(value, '__proto__')) throw new Error(`${where} has unknown key: __proto__`);
}

function requireNote(value: unknown): string {
  if (value === undefined) throw new Error('proposal.note is required');
  if (typeof value !== 'string') throw new Error('proposal.note must be a string');
  if (value.length > MAX_NOTE_CHARS) throw new Error('proposal.note exceeds maximum length');
  if (value.includes('\0')) throw new Error('proposal.note must not contain NUL');
  return value;
}

function requireValidUtf8(value: string, where: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) throw new Error(`${where} must be valid UTF-8 text`);
}

function requireBoundedString(value: unknown, where: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  if (value.length > max) throw new Error(`${where} exceeds maximum length`);
  if (value.includes('\0')) throw new Error(`${where} must not contain NUL`);
  requireValidUtf8(value, where);
  return value;
}

function parseWrite(value: Record<string, unknown>): RepoWorkerProposal {
  if (!hasOwn(value, 'content')) throw new Error('proposal.content is required');
  const content = value.content;
  if (typeof content !== 'string') throw new Error('proposal.content must be a string');
  if (content.includes('\0')) throw new Error('proposal.content must not contain NUL');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_CONTENT_BYTES) throw new Error('proposal.content exceeds maximum size');
  if (bytes.toString('utf8') !== content) throw new Error('proposal.content must be valid UTF-8');
  const note = requireNote(value.note);
  return { kind: 'write', content, note };
}

function parseRead(value: Record<string, unknown>): RepoWorkerProposal {
  if (!hasOwn(value, 'paths')) throw new Error('proposal.paths is required');
  const raw = value.paths;
  if (!Array.isArray(raw)) throw new Error('proposal.paths must be an array');
  if (raw.length === 0) throw new Error('proposal.paths must not be empty');
  if (raw.length > MAX_READ_PATHS) throw new Error('proposal.paths exceeds maximum of 32 entries');
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const path = safeRepoPath(raw[i]);
    if (seen.has(path)) throw new Error(`proposal.paths has duplicate path: ${path}`);
    seen.add(path);
    paths.push(path);
  }
  const note = requireNote(value.note);
  return { kind: 'read', paths, note };
}

function parseStringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  if (value.length > MAX_UNCERTAIN_ITEMS) {
    throw new Error(`${where} exceeds maximum of ${MAX_UNCERTAIN_ITEMS} entries`);
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = requireBoundedString(value[i], `${where}[${i}]`, MAX_UNCERTAIN_ITEM_CHARS);
    if (item.trim().length === 0) throw new Error(`${where}[${i}] must not be blank`);
    result.push(item);
  }
  return result;
}

function parseUncertain(value: Record<string, unknown>): RepoWorkerProposal {
  if (!hasOwn(value, 'observed')) throw new Error('proposal.observed is required');
  if (!hasOwn(value, 'missing')) throw new Error('proposal.missing is required');
  const observed = parseStringArray(value.observed, 'proposal.observed');
  const missing = parseStringArray(value.missing, 'proposal.missing');
  if (missing.length === 0) throw new Error('proposal.missing must contain at least one item');
  if (!hasOwn(value, 'hypothesis')) throw new Error('proposal.hypothesis is required');
  let hypothesis: string | null = null;
  if (hasOwn(value, 'hypothesis') && value.hypothesis !== undefined) {
    const h = value.hypothesis;
    if (h !== null) {
      if (typeof h !== 'string') throw new Error('proposal.hypothesis must be a string or null');
      if (h.length > MAX_NOTE_CHARS) throw new Error('proposal.hypothesis exceeds maximum length');
      if (h.includes('\0')) throw new Error('proposal.hypothesis must not contain NUL');
      requireValidUtf8(h, 'proposal.hypothesis');
      hypothesis = h;
    }
  }
  const note = requireNote(value.note);
  return { kind: 'uncertain', observed, missing, hypothesis, note };
}

export function parseWorkerProposal(value: unknown): RepoWorkerProposal {
  if (!isPlainObject(value)) throw new Error('proposal must be a plain object');
  if (!hasOwn(value, 'kind')) throw new Error('proposal.kind is required');
  const kind = value.kind;
  if (kind !== 'write' && kind !== 'read' && kind !== 'uncertain') {
    throw new Error('proposal.kind must be one of write, read, uncertain');
  }
  rejectUnknownKeys(value, KIND_KEYS[kind], `proposal(${kind})`);
  if (!hasOwn(value, 'note')) throw new Error('proposal.note is required');
  switch (kind) {
    case 'write':
      return parseWrite(value);
    case 'read':
      return parseRead(value);
    case 'uncertain':
      return parseUncertain(value);
  }
}

// Provider transport accepts only the schema subset supported by every adapter.
// Unused fields are explicit empty values; the host validates the disjoint action.
export const REPO_WORKER_SCHEMA = {type:'object',additionalProperties:false,
  properties:{kind:{type:'string'},content:{type:'string'},paths:{type:'array',items:{type:'string'}},
    observed:{type:'array',items:{type:'string'}},missing:{type:'array',items:{type:'string'}},hypothesis:{type:'string'},note:{type:'string'}},
  required:['kind','content','paths','observed','missing','hypothesis','note']} as const;
export function parseWorkerResponse(value:unknown): RepoWorkerProposal {
  if (!isPlainObject(value)) throw new Error('invalid worker envelope');
  const keys=REPO_WORKER_SCHEMA.required;
  if(Object.keys(value).length!==keys.length||keys.some(k=>!hasOwn(value,k)))throw new Error('invalid worker envelope fields');
  for(const k of ['content','hypothesis','note','kind'])if(typeof value[k]!=='string')throw new Error('invalid envelope string');
  for(const k of ['paths','observed','missing'])if(!Array.isArray(value[k]))throw new Error('invalid envelope array');
  const empty=(k:string)=>Array.isArray(value[k])?(value[k] as unknown[]).length===0:value[k]==='';
  if(value.kind==='write'){
    if(!['paths','observed','missing','hypothesis'].every(empty))throw new Error('mixed worker actions: write requires paths=[], observed=[], missing=[], hypothesis=empty string; put explanation only in note');
    return parseWorkerProposal({kind:'write',content:value.content,note:value.note});
  }
  if(value.kind==='read'){
    if(!['content','observed','missing','hypothesis'].every(empty))throw new Error('mixed worker actions: read requires content=empty string, observed=[], missing=[], hypothesis=empty string; put explanation only in note');
    return parseWorkerProposal({kind:'read',paths:value.paths,note:value.note});
  }
  if(value.kind==='uncertain'){
    if(!['content','paths'].every(empty))throw new Error('mixed worker actions: uncertain requires content=empty string, paths=[]');
    return parseWorkerProposal({kind:'uncertain',observed:value.observed,missing:value.missing,hypothesis:value.hypothesis||null,note:value.note});
  }
  throw new Error('invalid worker action');
}
