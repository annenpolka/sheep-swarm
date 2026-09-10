const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) {
    return false;
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
  }
  return true;
}

export function parseRepositoryPatch(value: unknown, targets: readonly string[]): Record<string, string> {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('targets must be a nonempty array');
  }
  const targetSet = new Set<string>();
  for (const target of targets) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error('targets must be nonempty strings');
    }
    if (targetSet.has(target)) {
      throw new Error('targets must be unique');
    }
    targetSet.add(target);
  }

  if (!isPlainObject(value)) {
    throw new Error('value must be a plain object');
  }
  if (!hasExactOwnKeys(value, ['files', 'note'])) {
    throw new Error('value must have exactly files and note keys');
  }
  if (typeof value['note'] !== 'string') {
    throw new Error('note must be a string');
  }

  const files = value['files'];
  if (!Array.isArray(files) || files.length !== targets.length) {
    throw new Error('files must be a dense array with one entry per target');
  }
  for (let i = 0; i < files.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(files, i)) {
      throw new Error('files must be dense');
    }
  }

  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();

  for (const entry of files) {
    if (!isPlainObject(entry)) {
      throw new Error('file entries must be plain objects');
    }
    if (!hasExactOwnKeys(entry, ['path', 'content'])) {
      throw new Error('file entries must have exactly path and content keys');
    }
    const path = entry['path'];
    const content = entry['content'];
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new Error('path and content must be strings');
    }
    if (!targetSet.has(path)) {
      throw new Error('unknown path');
    }
    if (seen.has(path)) {
      throw new Error('duplicate path');
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error('content too large');
    }
    seen.add(path);
    result[path] = content;
  }

  for (const target of targets) {
    if (!seen.has(target)) {
      throw new Error('missing path');
    }
  }

  return result;
}
