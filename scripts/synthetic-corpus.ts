import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs, promisify} from 'node:util';
import {parseRepoTask, safeRepoPath} from '../src/repo-manifest.ts';
import type {RepoCommand} from '../src/repo-types.ts';
import type {Built} from '../experiments/synthetic-corpus/common.ts';

const execute = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nodeEnv = {PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`};

interface Check {
  ok: boolean;
  assertionFailure: boolean;
  exitCode: number | null;
  diagnostic: string;
}
interface Scenario {
  syntax: boolean;
  publicPass: boolean;
  finalPass: boolean;
  finalAssertionFailure: boolean;
  diagnostic: string;
}
export interface PreflightRow {
  id: string;
  family: string;
  split: string;
  targetCount: number;
  hashes: Built['hashes'] | null;
  ok: boolean;
  errors: string[];
  baseline?: Scenario;
  reference?: Scenario;
  mutants: {id: string; predictedPublicPass: boolean; result: Scenario}[];
  elapsedMs: number;
}

/** Validate host fixture data before creating any repository or running checks. */
export function validateSyntheticTask(fixture: Built): void {
  const task = parseRepoTask(fixture.task);
  const targets = new Set(task.files.map(f => f.path));
  if (targets.size !== fixture.metadata.targetCount) throw new Error('target count mismatch');
  for (const [path, value] of Object.entries(fixture.files)) {
    safeRepoPath(path);
    if (typeof value !== 'string') throw new Error(`non-string file: ${path}`);
    if (path === 'task.json') throw new Error('task.json is reserved for the materialized manifest');
  }
  for (const path of [...targets, ...task.context, ...task.protected, ...(task.discovery?.readable ?? [])]) {
    if (!Object.hasOwn(fixture.files, path)) throw new Error(`missing file: ${path}`);
  }
  for (const path of task.protected) {
    if (task.context.includes(path) || task.discovery?.readable.includes(path)) throw new Error(`private file is readable: ${path}`);
  }
  const patch = (contents: Record<string, string>) => {
    if (!Object.keys(contents).length) throw new Error('empty target patch');
    for (const [path, value] of Object.entries(contents)) {
      if (!targets.has(path) || typeof value !== 'string') throw new Error(`invalid target patch: ${path}`);
    }
  };
  patch(fixture.reference);
  if (Object.keys(fixture.reference).length !== targets.size) throw new Error('reference does not cover all targets');
  if (!Object.entries(fixture.reference).some(([p, v]) => v !== fixture.files[p])) throw new Error('baseline equals reference');
  if (fixture.mutants.length < 2) throw new Error('at least two mutants are required');
  const ids = new Set<string>();
  const patches = new Set<string>();
  for (const mutant of fixture.mutants) {
    patch(mutant.patch);
    if (ids.has(mutant.id)) throw new Error(`duplicate mutant ID: ${mutant.id}`);
    ids.add(mutant.id);
    if (!Object.entries(mutant.patch).some(([p, v]) => v !== fixture.reference[p])) throw new Error(`no-op mutant: ${mutant.id}`);
    const hash = digest(JSON.stringify(Object.entries(mutant.patch).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    if (patches.has(hash)) throw new Error(`duplicate mutant patch: ${mutant.id}`);
    patches.add(hash);
  }
}

async function writeFiles(root: string, files: Record<string, string>, exclusive = false): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), text, {flag: exclusive ? 'wx' : 'w'});
  }
}

/** Only the baseline and task manifest are exported; solutions stay host-side. */
export async function materializeSyntheticTask(fixture: Built, directory: string): Promise<string> {
  validateSyntheticTask(fixture);
  const root = resolve(directory);
  await mkdir(dirname(root), {recursive: true});
  await mkdir(root); // An existing directory, including an empty one, is never overwritten.
  try {
    await writeFiles(root, {...fixture.files, 'task.json': JSON.stringify(fixture.task, null, 2) + '\n'}, true);
  } catch (error) {
    await rm(root, {recursive: true, force: true});
    throw error;
  }
  return root;
}

async function check(root: string, command: RepoCommand): Promise<Check> {
  if (command.argv[0] !== 'node' && command.argv[0] !== process.execPath) {
    return {ok: false, assertionFailure: false, exitCode: null, diagnostic: 'synthetic preflight supports Node checks only'};
  }
  try {
    await execute(process.execPath, [...command.argv.slice(1)], {cwd: root, env: nodeEnv, timeout: command.timeoutMs, maxBuffer: 1024 * 1024});
    return {ok: true, assertionFailure: false, exitCode: 0, diagnostic: ''};
  } catch (error) {
    const e = error as Error & {code?: number | string; signal?: string; killed?: boolean; stderr?: string};
    const diagnostic = e.stderr || e.message;
    return {
      ok: false,
      assertionFailure: typeof e.code === 'number' && !e.signal && !e.killed && diagnostic.includes('AssertionError'),
      exitCode: typeof e.code === 'number' ? e.code : null,
      diagnostic: diagnostic.slice(0, 3000),
    };
  }
}

/** Model-free execution. A crash, missing executable, or syntax error never counts as an oracle kill. */
export async function preflightSyntheticTask(fixture: Built): Promise<PreflightRow> {
  const start = performance.now();
  const row: PreflightRow = {...fixture.metadata, hashes: fixture.hashes, ok: false, errors: [], mutants: [], elapsedMs: 0};
  validateSyntheticTask(fixture);
  const root = await mkdtemp(join(tmpdir(), 'sheep-synthetic-preflight-'));
  const syntaxCache = new Map<string, Check>();
  try {
    const scenario = async (overlay: Record<string, string>): Promise<Scenario> => {
      const files = {...fixture.files, ...overlay};
      await writeFiles(root, files);
      for (const [path, text] of Object.entries(files)) {
        if (!path.endsWith('.mjs')) continue;
        const key = digest(text);
        let result = syntaxCache.get(key);
        if (!result) {
          result = await check(root, {argv: ['node', '--check', path], timeoutMs: 15000});
          syntaxCache.set(key, result);
        }
        if (!result.ok) return {syntax: false, publicPass: false, finalPass: false, finalAssertionFailure: false, diagnostic: result.diagnostic};
      }
      const publicChecks = fixture.task.files.flatMap(f => f.checks);
      const publicResults: Check[] = [];
      for (const command of publicChecks) publicResults.push(await check(root, command));
      const finalResults: Check[] = [];
      for (const command of fixture.task.checks) finalResults.push(await check(root, command));
      for (const [path, text] of Object.entries(files)) {
        if (await readFile(join(root, path), 'utf8') !== text) throw new Error(`check changed fixture file: ${path}`);
      }
      const firstFailure = [...publicResults, ...finalResults].find(r => !r.ok);
      return {
        syntax: true,
        publicPass: publicResults.every(r => r.ok),
        finalPass: finalResults.length > 0 && finalResults.every(r => r.ok),
        finalAssertionFailure: finalResults.some(r => r.assertionFailure) && finalResults.every(r => r.ok || r.assertionFailure),
        diagnostic: firstFailure?.diagnostic ?? '',
      };
    };
    row.baseline = await scenario({});
    row.reference = await scenario(fixture.reference);
    if (!row.baseline.syntax || !row.baseline.finalAssertionFailure) row.errors.push('baseline must fail the final oracle by assertion with valid syntax');
    if (!row.reference.syntax || !row.reference.publicPass || !row.reference.finalPass) row.errors.push('reference must pass all public and final checks');
    for (const mutant of fixture.mutants) {
      const result = await scenario({...fixture.reference, ...mutant.patch});
      row.mutants.push({id: mutant.id, predictedPublicPass: mutant.predictedPublicPass, result});
      if (!result.syntax || !result.finalAssertionFailure) row.errors.push(`${mutant.id}: mutant must fail final oracle by assertion with valid syntax`);
      // Generator hints cover local cases; only the executed all-target outcome is authoritative.
    }
    row.ok = row.errors.length === 0;
  } finally {
    await rm(root, {recursive: true, force: true});
    row.elapsedMs = performance.now() - start;
  }
  return row;
}

export async function main(args: string[]): Promise<number> {
  const {positionals, values} = parseArgs({args, allowPositionals: true, strict: true, options: {
    all: {type: 'boolean'}, id: {type: 'string'}, family: {type: 'string'}, split: {type: 'string'},
    output: {type: 'string'}, concurrency: {type: 'string'}, help: {type: 'boolean'},
  }});
  if (values.help || !positionals.length) {
    console.log('Usage:\n  node scripts/synthetic-corpus.ts list [--family NAME] [--split dev|evaluation]\n  node scripts/synthetic-corpus.ts materialize ID NEW_DIRECTORY\n  node scripts/synthetic-corpus.ts preflight (--all | --id ID) [--concurrency 4] [--output report.json]');
    return 0;
  }
  // Loaded only for corpus operations, so --help remains usable during generation.
  const {listSyntheticTasks, buildSyntheticTask} = await import('../experiments/synthetic-corpus/index.ts');
  const [command, id, directory, ...extra] = positionals;
  if (command === 'materialize') {
    if (!id || !directory || extra.length || Object.keys(values).length) throw new Error('materialize requires exactly ID and NEW_DIRECTORY');
    console.log(await materializeSyntheticTask(buildSyntheticTask(id), directory));
    return 0;
  }
  if (id || directory || extra.length) throw new Error('unexpected positional argument');
  if (values.split && !['dev', 'evaluation'].includes(values.split)) throw new Error('split must be dev or evaluation');
  let specs = listSyntheticTasks().filter(s => (!values.family || s.family === values.family) && (!values.split || s.split === values.split));
  if (!specs.length) throw new Error('no matching tasks');
  if (command === 'list') {
    if (values.all || values.id || values.output || values.concurrency) throw new Error('unsupported list option');
    console.log(JSON.stringify(specs, null, 2));
    return 0;
  }
  if (command !== 'preflight') throw new Error(`unknown command: ${command}`);
  if (Boolean(values.all) === Boolean(values.id)) throw new Error('preflight requires exactly --all or --id ID');
  if (values.id) specs = specs.filter(s => s.id === values.id);
  if (!specs.length) throw new Error('unknown task ID or conflicting filters');
  const concurrency = Number(values.concurrency ?? '4');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('concurrency must be an integer from 1 to 8');
  const rows: PreflightRow[] = new Array(specs.length);
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({length: Math.min(concurrency, specs.length)}, async () => {
    while (next < specs.length) {
      const index = next++;
      const spec = specs[index]!;
      const taskStarted = performance.now();
      try { rows[index] = await preflightSyntheticTask(buildSyntheticTask(spec.id)); }
      catch (error) { rows[index] = {...spec, hashes: null, ok: false, errors: [String(error)], mutants: [], elapsedMs: performance.now() - taskStarted}; }
      console.error(`${index + 1}/${specs.length} ${spec.id}: ${rows[index]!.ok ? 'ok' : 'FAILED'}`);
    }
  }));
  const report = {version: 1, tasks: rows.length, passed: rows.filter(r => r.ok).length, families: new Set(rows.map(r => r.family)).size,
    publicPassingMutants: rows.flatMap(r => r.mutants).filter(m => m.result.publicPass && m.result.finalAssertionFailure).length,
    corpusHash: digest(JSON.stringify(rows.map(r => ({id: r.id, hashes: r.hashes})))),
    elapsedMs: performance.now() - started, modelCalls: 0, rows};
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.output) { await mkdir(dirname(resolve(values.output)), {recursive: true}); await writeFile(values.output, json); }
  else process.stdout.write(json);
  return rows.every(r => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => {process.exitCode = code;}, error => {console.error((error as Error).message); process.exitCode = 1;});
}
