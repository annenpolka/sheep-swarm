import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { safeRepoPath } from './repo-manifest.ts';

export interface RepoDependencyScan {
  edges: { consumer: string; provider: string; specifier: string; sourceHash: string }[];
  issues: { consumer: string; specifier: string; reason: string }[];
  cycles: string[][];
  filesRead: number;
  bytesRead: number;
  durationMs: number;
  limitations: string[];
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10000;

const LIMITATIONS = ['dynamic-imports-not-covered', 'semantic-dependencies-not-covered', 'only-mjs-ts-mts-scanned', 'no-tsconfig-path-or-package-resolution'];

const RESERVED_COMPONENTS = new Set(['.git', '.sheep', 'node_modules', '.sheep-internal']);
const ENV_BASENAME = /^\.env(\..*)?$/;

interface RawRequestEntry {
  readonly path: string;
  readonly text: string;
}

interface RawChildIssue {
  readonly consumer: string;
  readonly specifier: string;
  readonly reason: string;
}

interface RawChildEdge {
  readonly consumer: string;
  readonly specifier: string;
}

// The child parses .mjs with SourceTextModule and .ts/.mts with a virtual TS
// program. Neither path links or evaluates the supplied source text.
const CHILD_SOURCE = [
  "'use strict';",
  "const vm = require('node:vm');",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', async () => {",
  "  let payload;",
  "  try {",
  "    payload = JSON.parse(input);",
  "  } catch (error) {",
  "    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid input json' }));",
  "    return;",
  "  }",
  "  const edges = [];",
  "  const issues = [];",
  "  const entries = Array.isArray(payload.entries) ? payload.entries : [];",
  "  const tsEntries = entries.filter(e => !e.path.endsWith('.mjs'));",
  "  if(tsEntries.length) {",
  "    try { const {parseTypeScriptEntries} = await import(payload.tsParser); const parsed = parseTypeScriptEntries(tsEntries); edges.push(...parsed.edges); issues.push(...parsed.issues); }",
  "    catch { process.stdout.write(JSON.stringify({ok:false,error:'TypeScript parser unavailable or failed'})); return; }",
  "  }",
  "  for (const entry of entries) {",
  "    if(!entry.path.endsWith('.mjs')) continue;",
  "    const consumer = entry.path;",
  "    let mod;",
  "    try {",
  "      mod = new vm.SourceTextModule(entry.text, { identifier: consumer });",
  "    } catch (error) {",
  "      issues.push({ consumer: consumer, specifier: '', reason: 'syntax-error: ' + String((error && error.message) || error) });",
  "      continue;",
  "    }",
  "    let requests = [];",
  "    try {",
  "      if (!Array.isArray(mod.moduleRequests)) throw new Error('moduleRequests unavailable');",
  "      requests = mod.moduleRequests;",
  "    } catch (error) {",
  "      issues.push({ consumer: consumer, specifier: '', reason: 'parse-error: ' + String((error && error.message) || error) });",
  "      continue;",
  "    }",
  "    for (const request of requests) {",
  "      const specifier = typeof request.specifier === 'string' ? request.specifier : null;",
  "      if (specifier === null) continue;",
  "      edges.push({ consumer: consumer, specifier: specifier });",
  "    }",
  "  }",
  "  process.stdout.write(JSON.stringify({ ok: true, edges: edges, issues: issues }));",
  "});",
].join('\n');

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function safeReadablePath(value: unknown): string {
  if (typeof value !== 'string') throw new Error('readable path must be a string');
  if (value.startsWith('/')) throw new Error(`readable path must be repository-relative: ${value}`);
  if (value.includes('\\')) throw new Error(`readable path must not contain backslashes: ${value}`);
  if (hasControlChars(value)) throw new Error(`readable path must not contain control characters: ${value}`);
  const components = value.split('/');
  for (const component of components) {
    if (component === '') throw new Error(`readable path has empty component: ${value}`);
    if (component === '.' || component === '..') throw new Error(`readable path has dot component: ${value}`);
    if (RESERVED_COMPONENTS.has(component.toLowerCase())) throw new Error(`readable path uses reserved component: ${value}`);
    if (ENV_BASENAME.test(component.toLowerCase())) throw new Error(`readable path uses reserved env basename: ${value}`);
  }
  return value;
}

function posixNormalize(base: string, specifier: string): string | null {
  const stack = base === '' ? [] : base.split('/');
  const parts = specifier.split('/');
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (stack.length === 0) return null;
  return stack.join('/');
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

function escapesRoot(provider: string): boolean {
  if (provider.startsWith('/')) return true;
  const components = provider.split('/');
  return components.includes('..');
}

function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return false;
  if (isRelativeSpecifier(specifier) || specifier.startsWith('/')) return false;
  if (specifier.startsWith('#')) return false;
  return true;
}

function hasExplicitExtension(provider: string): boolean {
  const lastSegment = provider.slice(provider.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

function resolveProvider(consumer: string, specifier: string): { provider: string } | { issue: string } {
  if (specifier.startsWith('node:')) return { provider: specifier };
  if (specifier.startsWith('#')) return { issue: `import-map-specifier: ${specifier}` };
  if (specifier.startsWith('/')) return { issue: `absolute-import: ${specifier}` };
  if (isBareSpecifier(specifier)) return { issue: `bare-package: ${specifier}` };
  const dir = consumer.includes('/') ? consumer.slice(0, consumer.lastIndexOf('/')) : '';
  const resolved = posixNormalize(dir, specifier);
  if (resolved === null) return { issue: `unresolvable-relative: ${specifier}` };
  if (escapesRoot(resolved)) return { issue: `escapes-root: ${specifier}` };
  if (!hasExplicitExtension(resolved)) return { issue: `missing-explicit-extension: ${specifier}` };
  return { provider: resolved };
}

function runChild(entries: readonly RawRequestEntry[]): Promise<{ edges: RawChildEdge[]; issues: RawChildIssue[] }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        ['--experimental-vm-modules', '--input-type=commonjs', '-e', CHILD_SOURCE],
        {
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error as Error);
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (
      error: Error | undefined,
      value?: { edges: RawChildEdge[]; issues: RawChildIssue[] },
    ): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      // Native TypeScript parser belongs to this child group, including on timeout.
      if(process.platform !== 'win32' && child.pid) {
        try {process.kill(-child.pid,'SIGKILL');} catch { /* already collected */ }
      }
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(value!);
    };

    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        kill();
        finish(new Error('dependency scan child output exceeded limit'));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        kill();
        finish(new Error('dependency scan child stderr exceeded limit'));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.once('error', (error) => {
      finish(error);
    });

    timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(new Error('dependency scan child timed out'));
    }, MAX_TIMEOUT_MS);
    timer.unref?.();

    child.once('close', (code) => {
      if (settled) return;
      if (timedOut) {
        finish(new Error('dependency scan child timed out'));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        finish(new Error(`dependency scan child exited with code ${code}: ${stderr.slice(0, 512)}`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        finish(new Error(`dependency scan child produced invalid JSON: ${(error as Error).message}`));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish(new Error('dependency scan child produced invalid result shape'));
        return;
      }
      const result = parsed as Record<string, unknown>;
      if (result.ok !== true) {
        finish(new Error(`dependency scan child reported error: ${String(result.error)}`));
        return;
      }
      const edgesRaw = Array.isArray(result.edges) ? result.edges : [];
      const issuesRaw = Array.isArray(result.issues) ? result.issues : [];
      finish(undefined, {
        edges: edgesRaw as RawChildEdge[],
        issues: issuesRaw as RawChildIssue[],
      });
    });

    try {
      child.stdin?.write(JSON.stringify({ entries,tsParser:new URL('../scripts/parse-typescript-dependencies.mjs',import.meta.url).href }));
      child.stdin?.end();
    } catch (error) {
      finish(error as Error);
    }
  });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function computeCycles(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  const strongConnect = (v: string): void => {
    const seenNeighbors = adjacency.get(v) ?? [];
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of seenNeighbors) {
      if (!index.has(w)) {
        strongConnect(w);
        const lw = low.get(w)!;
        if (lw < low.get(v)!) low.set(v, lw);
      } else if (onStack.has(w)) {
        const iw = index.get(w)!;
        if (iw < low.get(v)!) low.set(v, iw);
      }
    }

    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let popped: string | undefined;
      do {
        popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== v);
      if (component.length > 1) {
        result.push(component);
      } else {
        const only = component[0];
        if (only !== undefined && seenNeighbors.includes(only)) result.push(component);
      }
    }
  };

  for (const node of nodes) {
    if (!index.has(node)) strongConnect(node);
  }
  return result;
}

export async function discoverRepoDependencies(
  contents: Readonly<Record<string, string>>,
  readable: readonly string[],
): Promise<RepoDependencyScan> {
  const started = Date.now();

  const readableSet = new Set<string>();
  for (const entry of readable) {
    readableSet.add(safeReadablePath(entry));
  }

  const providerSet = new Set<string>();
  for (const key of Object.keys(contents)) {
    providerSet.add(safeRepoPath(key));
  }

  const parsedEntries: RawRequestEntry[] = [];
  let filesRead = 0;
  let bytesRead = 0;

  const sortedReadable = [...readableSet].sort();
  for (const candidate of sortedReadable) {
    if (!/\.(?:mjs|ts|mts)$/.test(candidate)) continue;
    if (!Object.prototype.hasOwnProperty.call(contents, candidate)) continue;
    const text = contents[candidate]!;
    parsedEntries.push({ path: candidate, text });
    filesRead += 1;
    bytesRead += Buffer.byteLength(text, 'utf8');
  }

  const raw = await runChild(parsedEntries);

  const edgeMap = new Map<
    string,
    { consumer: string; provider: string; specifier: string; sourceHash: string }
  >();
  const issueMap = new Map<string, { consumer: string; specifier: string; reason: string }>();
  const adjacency = new Map<string, Set<string>>();

  const addEdge = (consumer: string, provider: string, specifier: string): void => {
    const key = `${consumer}\u0000${provider}\u0000${specifier}`;
    if (edgeMap.has(key)) return;
    const sourceHash = sha256(contents[consumer]!);
    edgeMap.set(key, { consumer, provider, specifier, sourceHash });
    let set = adjacency.get(consumer);
    if (set === undefined) {
      set = new Set<string>();
      adjacency.set(consumer, set);
    }
    set.add(provider);
  };

  const addIssue = (consumer: string, specifier: string, reason: string): void => {
    const key = `${consumer}\u0000${specifier}\u0000${reason}`;
    if (issueMap.has(key)) return;
    issueMap.set(key, { consumer, specifier, reason });
  };

  for (const issue of raw.issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const consumer = (issue as RawChildIssue).consumer;
    if (typeof consumer !== 'string') continue;
    const specifier =
      typeof (issue as RawChildIssue).specifier === 'string'
        ? (issue as RawChildIssue).specifier
        : '';
    const reason =
      typeof (issue as RawChildIssue).reason === 'string'
        ? (issue as RawChildIssue).reason
        : 'syntax-error';
    addIssue(consumer, specifier, reason);
  }

  for (const edge of raw.edges) {
    if (typeof edge !== 'object' || edge === null) continue;
    const consumer = (edge as RawChildEdge).consumer;
    const specifier = (edge as RawChildEdge).specifier;
    if (typeof consumer !== 'string' || typeof specifier !== 'string') continue;

    if (specifier.startsWith('node:')) continue;

    const resolution = resolveProvider(consumer, specifier);
    if ('issue' in resolution) {
      addIssue(consumer, specifier, resolution.issue);
      continue;
    }
    const provider = resolution.provider;
    if (!providerSet.has(provider) || !readableSet.has(provider)) {
      addIssue(consumer, specifier, `missing-provider: ${provider}`);
      continue;
    }
    addEdge(consumer, provider, specifier);
  }

  const edges = [...edgeMap.values()].sort((a, b) => {
    if (a.consumer !== b.consumer) return a.consumer < b.consumer ? -1 : 1;
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.specifier !== b.specifier) return a.specifier < b.specifier ? -1 : 1;
    return 0;
  });

  const issues = [...issueMap.values()].sort((a, b) => {
    if (a.consumer !== b.consumer) return a.consumer < b.consumer ? -1 : 1;
    if (a.specifier !== b.specifier) return a.specifier < b.specifier ? -1 : 1;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return 0;
  });

  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.consumer);
    nodes.add(edge.provider);
  }
  const adjacencyView = new Map<string, readonly string[]>();
  for (const [node, set] of adjacency) {
    adjacencyView.set(node, [...set].sort());
  }
  const cycles = computeCycles([...nodes].sort(), adjacencyView).map((component) => [
    ...component,
  ].sort());
  cycles.sort((a, b) => {
    const aKey = a.join('\u0000');
    const bKey = b.join('\u0000');
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  return {
    edges,
    issues,
    cycles,
    filesRead,
    bytesRead,
    durationMs: Date.now() - started,
    limitations: [...LIMITATIONS],
  };
}
