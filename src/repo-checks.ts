import type {
  RepoCheckResult,
  RepoCommand,
  RepoSnapshot,
  RepoVerification,
} from './repo-types.ts';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { materializeRepository } from './repo-files.ts';

const MAX_STREAM_BYTES = 65536;
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 300000;

interface ExpectedEntry {
  readonly bytes: Buffer;
  readonly mode: number;
}

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  if (timeoutMs < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (timeoutMs > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return timeoutMs;
}

function boundedAppend(current: Buffer, chunk: Buffer): Buffer {
  if (current.length >= MAX_STREAM_BYTES) return current;
  const remaining = MAX_STREAM_BYTES - current.length;
  const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  return Buffer.concat([current, slice]);
}

interface SpawnCapture {
  readonly result: RepoCheckResult;
  readonly spawnError: Error | undefined;
}

function runCommand(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError: Error | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({
        result: {
          argv,
          exitCode,
          signal: signal === null ? null : String(signal),
          timedOut,
          stdout: new TextDecoder().decode(stdout, {stream:true}),
          stderr: new TextDecoder().decode(stderr, {stream:true}),
          durationMs: Date.now() - start,
        },
        spawnError,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(null, null, error as Error);
      return;
    }

    const killGroup = (signal: NodeJS.Signals): void => {
      if (process.platform === 'win32' || child.pid === undefined) {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk);
    });

    child.once('error', (error) => {
      finish(null, null, error);
    });

    killTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      forceTimer = setTimeout(() => {
        killGroup('SIGKILL');
      }, 200);
      forceTimer.unref?.();
    }, timeoutMs);
    killTimer.unref?.();

    child.once('close', (code, signal) => {
      if (timedOut) {
        killGroup('SIGKILL');
      }
      finish(code, signal ?? null, undefined);
    });
  });
}

async function buildChildEnvironment(scratch: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    HOME: scratch,
    TMPDIR: scratch,
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.platform === 'win32') {
    if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
    if (process.env.WINDIR !== undefined) env.WINDIR = process.env.WINDIR;
  }
  return env;
}

function uniqueWorkspace(outputRoot: string): string {
  const token = `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
  return path.join(outputRoot, `candidate-${token}`);
}

function computeExpected(
  snapshot: RepoSnapshot,
  contents: Readonly<Record<string, string>>,
): Map<string, ExpectedEntry | null> {
  const expected = new Map<string, ExpectedEntry | null>();
  for (const [relative, entry] of snapshot.entries) {
    expected.set(relative, { bytes: Buffer.from(entry.bytes), mode: entry.mode });
  }
  const targets = new Set(snapshot.task.files.map((file) => file.path));
  for (const target of targets) {
    if (Object.prototype.hasOwnProperty.call(contents, target)) {
      const mode = snapshot.entries.get(target)?.mode ?? 0o644;
      expected.set(target, { bytes: Buffer.from(contents[target]!, 'utf8'), mode });
    }
  }
  return expected;
}

async function verifyCandidate(
  workspace: string,
  expected: ReadonlyMap<string, ExpectedEntry | null>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [relative, entry] of expected) {
    const absolute = path.join(workspace, relative);
    let info;
    try {
      let parent=workspace;
      for(const part of relative.split('/').slice(0,-1)) {
        parent=path.join(parent,part);
        const state=await lstat(parent);
        if(state.isSymbolicLink() || !state.isDirectory()) throw new Error(`candidate replaced parent: ${relative}`);
      }
      info = await lstat(absolute);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        if (entry === null) continue;
        errors.push(`candidate deleted required file: ${relative}`);
        continue;
      }
      errors.push(`candidate file could not be inspected: ${relative}: ${err.message}`);
      continue;
    }
    if (entry === null) {
      errors.push(`candidate introduced unexpected file: ${relative}`);
      continue;
    }
    if (info.isSymbolicLink()) {
      errors.push(`candidate replaced file with symlink: ${relative}`);
      continue;
    }
    if (!info.isFile()) {
      errors.push(`candidate replaced file with non-regular entry: ${relative}`);
      continue;
    }
    if ((info.mode & 0o777) !== entry.mode) {
      errors.push(`candidate changed file mode: ${relative}`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      errors.push(`candidate file could not be read: ${relative}: ${(error as Error).message}`);
      continue;
    }
    if (!bytes.equals(entry.bytes)) {
      errors.push(`candidate mutated file contents: ${relative}`);
    }
  }
  return errors;
}

async function persistEvidence(
  workspace: string,
  checks: readonly RepoCheckResult[],
  errors: readonly string[],
  ok: boolean,
): Promise<void> {
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(
      `${workspace}.checks.json`,
      JSON.stringify({ ok, checks, errors }, null, 2),
      'utf8',
    );
  } catch {
    /* evidence retention is best effort */
  }
}

export async function runRepoChecks(
  snapshot: RepoSnapshot,
  contents: Readonly<Record<string, string>>,
  commands: readonly RepoCommand[],
  outputRoot: string,
): Promise<RepoVerification> {
  const workspace = uniqueWorkspace(outputRoot);
  const scratch = `${workspace}.scratch`;

  try {
    await materializeRepository(snapshot, workspace, contents);
  } catch (error) {
    const errors = [`failed to materialize candidate: ${(error as Error).message}`];
    await persistEvidence(workspace, [], errors, false);
    return { ok: false, workspace, checks: [], errors };
  }

  const expected = computeExpected(snapshot, contents);
  const env = await buildChildEnvironment(scratch);
  const checks: RepoCheckResult[] = [];
  const errors: string[] = [];
  let failed = false;

  for (const command of commands) {
    if (failed) break;
    const timeoutMs = clampTimeout(command.timeoutMs);
    const { result, spawnError } = await runCommand(command.argv, workspace, env, timeoutMs);
    checks.push(result);
    if (spawnError !== undefined) {
      failed = true;
      errors.push(`command failed to spawn (${command.argv.join(' ')}): ${spawnError.message}`);
      continue;
    }
    if (result.timedOut) {
      failed = true;
      errors.push(`command timed out after ${timeoutMs}ms: ${command.argv.join(' ')}`);
      continue;
    }
    if (result.signal !== null) {
      failed = true;
      errors.push(`command terminated by signal ${result.signal}: ${command.argv.join(' ')}`);
      continue;
    }
    if (result.exitCode !== 0) {
      failed = true;
      errors.push(`command exited with code ${result.exitCode ?? 'null'}: ${command.argv.join(' ')}`);
    }
  }

  const driftErrors = await verifyCandidate(workspace, expected);
  if (driftErrors.length > 0) {
    failed = true;
    errors.push(...driftErrors);
  }

  const ok = !failed && errors.length === 0;
  await persistEvidence(workspace, checks, errors, ok);
  return { ok, workspace, checks, errors };
}
