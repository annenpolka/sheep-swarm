// Production TypeScript ESM verifier wrapper around the host runner checks.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type {
  RepoCommand,
  RepoSnapshot,
  RepoVerification,
} from './repo-types.ts';
import { runRepoChecks } from './repo-checks.ts';

export interface RepoVerificationRequest {
  readonly snapshot: RepoSnapshot;
  readonly overlay: Readonly<Record<string, string>>;
  readonly commands: readonly RepoCommand[];
  readonly phase: 'local' | 'final';
  readonly outputRoot: string;
}

export interface RepoVerificationReceipt extends RepoVerification {
  readonly candidateDigest: string;
  readonly checksDigest: string;
  readonly environmentId: string;
  readonly phase: 'local' | 'final';
  readonly status: 'pass' | 'reject' | 'infrastructure-error';
  readonly cleanup: 'process-group-attempted' | 'unavailable';
}

export interface VerificationIdentity {
  readonly candidateDigest: string;
  readonly checksDigest: string;
  readonly environmentId: string;
  readonly phase: 'local' | 'final';
}

function sha256(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function sortedKeys(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort();
}

function overlayDigest(overlay: Readonly<Record<string,string>>): string {
  return sha256([JSON.stringify(sortedKeys(overlay).map(path => [path,overlay[path]]))]);
}
function snapshotDigest(snapshot: RepoSnapshot): string {
  return sha256([JSON.stringify({head:snapshot.head,task:snapshot.task,initialTargets:snapshot.initialTargets,
    entries:[...snapshot.entries].sort(([a],[b])=>a.localeCompare(b)).map(([path,e])=>[path,Buffer.from(e.bytes).toString('base64'),e.mode])})]);
}
function commandsDigest(commands: readonly RepoCommand[]): string {
  return sha256([JSON.stringify(commands.map(c=>[c.argv,c.timeoutMs]))]);
}

function candidateDigest(request: RepoVerificationRequest): string {
  return sha256([snapshotDigest(request.snapshot), Buffer.from([0]), overlayDigest(request.overlay)]);
}

function checksDigest(request: RepoVerificationRequest, environmentId: string): string {
  const hash = createHash('sha256');
  hash.update(environmentId);
  hash.update(Buffer.from([0]));
  hash.update(request.phase);
  hash.update(Buffer.from([0]));
  hash.update(commandsDigest(request.commands));
  return hash.digest('hex');
}

export function verificationIdentity(
  request: RepoVerificationRequest,
  environmentId: string,
): VerificationIdentity {
  if (typeof environmentId !== 'string' || environmentId.length === 0) {
    throw new Error('environmentId must be a non-empty string');
  }
  if (request.phase !== 'local' && request.phase !== 'final') {
    throw new Error(`invalid verification phase: ${String(request.phase)}`);
  }
  return {
    candidateDigest: candidateDigest(request),
    checksDigest: checksDigest(request, environmentId),
    environmentId,
    phase: request.phase,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isRepoCommand(value: unknown): value is RepoCommand {
  if (!isPlainObject(value)) return false;
  const argv = value.argv;
  if (!Array.isArray(argv)) return false;
  for (const arg of argv) if (typeof arg !== 'string') return false;
  return typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs);
}

function validateRequestShape(request: unknown): RepoVerificationRequest {
  if (!isPlainObject(request)) throw new Error('verification request must be an object');
  const snapshot = request.snapshot;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('verification request.snapshot must be an object');
  }
  const overlay = request.overlay;
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new Error('verification request.overlay must be an object');
  }
  for (const value of Object.values(overlay)) {
    if (typeof value !== 'string') throw new Error('verification request.overlay values must be strings');
  }
  const commands = request.commands;
  if (!Array.isArray(commands)) throw new Error('verification request.commands must be an array');
  for (const command of commands) {
    if (!isRepoCommand(command)) throw new Error('verification request.commands has an invalid command');
  }
  const phase = request.phase;
  if (phase !== 'local' && phase !== 'final') throw new Error('verification request.phase is invalid');
  if (typeof request.outputRoot !== 'string' || request.outputRoot.length === 0) {
    throw new Error('verification request.outputRoot must be a non-empty string');
  }
  return request as unknown as RepoVerificationRequest;
}

function determineStatus(result: RepoVerification): 'pass' | 'reject' | 'infrastructure-error' {
  if (result.executionFailure === true) return 'infrastructure-error';
  return result.ok ? 'pass' : 'reject';
}

function runChecksSafely(
  runner: typeof runRepoChecks,
  request: RepoVerificationRequest,
  environmentId: string,
  before: VerificationIdentity,
): Promise<RepoVerificationReceipt> {
  return (async (): Promise<RepoVerificationReceipt> => {
    let result: RepoVerification;
    try {
      result = await runner(request.snapshot, request.overlay, request.commands, request.outputRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        executionFailure: true,
        workspace: '',
        checks: [],
        errors: [`host runner threw: ${message}`],
        candidateDigest: before.candidateDigest,
        checksDigest: before.checksDigest,
        environmentId,
        phase: request.phase,
        status: 'infrastructure-error',
        cleanup: 'unavailable',
      };
    }

    let after: VerificationIdentity;
    try {
      after = verificationIdentity(request, environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        executionFailure: true,
        workspace: result.workspace,
        checks: result.checks,
        errors: [...result.errors, `identity recomputation failed: ${message}`],
        candidateDigest: before.candidateDigest,
        checksDigest: before.checksDigest,
        environmentId,
        phase: request.phase,
        status: 'infrastructure-error',
        cleanup: 'process-group-attempted',
      };
    }

    if (
      after.candidateDigest !== before.candidateDigest ||
      after.checksDigest !== before.checksDigest ||
      after.environmentId !== before.environmentId ||
      after.phase !== before.phase
    ) {
      return {
        ok: false,
        executionFailure: true,
        workspace: result.workspace,
        checks: result.checks,
        errors: [...result.errors, 'verification input changed during execution'],
        candidateDigest: before.candidateDigest,
        checksDigest: before.checksDigest,
        environmentId,
        phase: request.phase,
        status: 'infrastructure-error',
        cleanup: 'process-group-attempted',
      };
    }

    const status = determineStatus(result);
    const receipt: RepoVerificationReceipt = {
      ok: result.ok,
      ...(result.executionFailure === true ? { executionFailure: true as const } : {}),
      workspace: result.workspace,
      checks: result.checks,
      errors: result.errors,
      candidateDigest: before.candidateDigest,
      checksDigest: before.checksDigest,
      environmentId,
      phase: request.phase,
      status,
      cleanup: 'process-group-attempted',
    };
    return receipt;
  })();
}

export interface HostRepoVerifier {
  readonly environmentId: string;
  verify(request: RepoVerificationRequest): Promise<RepoVerificationReceipt>;
}

export function createHostRepoVerifier(
  environmentId?: string,
  runChecks?: typeof runRepoChecks,
): HostRepoVerifier {
  const resolvedEnvironmentId =
    environmentId === undefined || environmentId.length === 0
      ? `host-process-group-v1/node-${process.versions.node}/${process.platform}-${process.arch}`
      : environmentId;
  const runner: typeof runRepoChecks = runChecks ?? runRepoChecks;
  return {
    environmentId: resolvedEnvironmentId,
    async verify(request: RepoVerificationRequest): Promise<RepoVerificationReceipt> {
      const validated = validateRequestShape(request);
      const before = verificationIdentity(validated, resolvedEnvironmentId);
      const receipt = await runChecksSafely(runner, validated, resolvedEnvironmentId, before);
      // Sanity: ensure the produced receipt still matches the captured identity.
      if (
        receipt.candidateDigest !== before.candidateDigest ||
        receipt.checksDigest !== before.checksDigest ||
        receipt.environmentId !== before.environmentId ||
        receipt.phase !== before.phase
      ) {
        return {
          ok: false,
          executionFailure: true,
          workspace: receipt.workspace,
          checks: receipt.checks,
          errors: [...receipt.errors, 'receipt identity does not match captured identity'],
          candidateDigest: before.candidateDigest,
          checksDigest: before.checksDigest,
          environmentId: before.environmentId,
          phase: before.phase,
          status: 'infrastructure-error',
          cleanup: 'process-group-attempted',
        };
      }
      return receipt;
    },
  };
}

export function assertVerificationReceipt(
  request: RepoVerificationRequest,
  receipt: RepoVerificationReceipt,
  environmentId: string,
): void {
  const validated = validateRequestShape(request);
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('verification receipt must be an object');
  }
  if (typeof environmentId !== 'string' || environmentId.length === 0) {
    throw new Error('environmentId must be a non-empty string');
  }
  const expected = verificationIdentity(validated, environmentId);
  if (receipt.environmentId !== expected.environmentId) {
    throw new Error('verification receipt environment mismatch');
  }
  if (receipt.phase !== expected.phase) {
    throw new Error('verification receipt phase mismatch');
  }
  if (receipt.candidateDigest !== expected.candidateDigest) {
    throw new Error('verification receipt candidate digest mismatch');
  }
  if (receipt.checksDigest !== expected.checksDigest) {
    throw new Error('verification receipt checks digest mismatch');
  }
  if (receipt.status !== 'pass' && receipt.status !== 'reject' && receipt.status !== 'infrastructure-error') {
    throw new Error('verification receipt status is invalid');
  }
  if (receipt.cleanup !== 'process-group-attempted' && receipt.cleanup !== 'unavailable') {
    throw new Error('verification receipt cleanup is invalid');
  }
  if (typeof receipt.ok !== 'boolean') {
    throw new Error('verification receipt ok must be boolean');
  }
  if (typeof receipt.workspace !== 'string') {
    throw new Error('verification receipt workspace must be a string');
  }
  if (!Array.isArray(receipt.checks)) {
    throw new Error('verification receipt checks must be an array');
  }
  for (const check of receipt.checks) {
    if (check === null || typeof check !== 'object') {
      throw new Error('verification receipt contains an invalid check result');
    }
    if (!Array.isArray(check.argv) || check.argv.some((arg: unknown) => typeof arg !== 'string')) {
      throw new Error('verification receipt contains an invalid check argv');
    }
    if (typeof check.stdout !== 'string' || typeof check.stderr !== 'string') {
      throw new Error('verification receipt check output must be strings');
    }
    if (typeof check.timedOut !== 'boolean') {
      throw new Error('verification receipt check timedOut must be boolean');
    }
    if (typeof check.durationMs !== 'number' || !Number.isFinite(check.durationMs)) {
      throw new Error('verification receipt check durationMs must be a finite number');
    }
    if (check.exitCode !== null && typeof check.exitCode !== 'number') {
      throw new Error('verification receipt check exitCode is invalid');
    }
    if (check.signal !== null && typeof check.signal !== 'string') {
      throw new Error('verification receipt check signal is invalid');
    }
  }
  if (!Array.isArray(receipt.errors) || receipt.errors.some((entry) => typeof entry !== 'string')) {
    throw new Error('verification receipt errors must be a string array');
  }
  if (receipt.status === 'pass') {
    if (receipt.errors.length || receipt.cleanup !== 'process-group-attempted' || receipt.checks.length !== request.commands.length) throw new Error('incomplete passing receipt');
    if (receipt.checks.some((c,i)=>JSON.stringify(c.argv)!==JSON.stringify(request.commands[i]!.argv)||c.timedOut||c.signal!==null||c.exitCode!==0)) throw new Error('passing receipt has failed or mismatched checks');
    if (receipt.ok !== true) throw new Error('passing receipt reports failure');
    if (receipt.executionFailure === true) throw new Error('passing receipt reports execution failure');
  } else if (receipt.status === 'reject') {
    if (receipt.ok !== false) throw new Error('rejected receipt reports success');
    if (receipt.executionFailure === true) throw new Error('rejected receipt reports execution failure');
  } else {
    // infrastructure-error
    if (receipt.ok !== false) throw new Error('infrastructure receipt must not report success');
    if (receipt.executionFailure !== true) {
      throw new Error('infrastructure receipt must set executionFailure');
    }
  }
}
