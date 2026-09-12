import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  RepoCaller,
  RepoCommand,
  RepoRunOptions,
  RepoRunReport,
  RepoSnapshot,
  RepoVerification,
} from './repo-types.ts';
import { parseRepoTask } from './repo-manifest.ts';
import { captureRepository, applyRepository } from './repo-files.ts';
import {createHostRepoVerifier, assertVerificationReceipt, type HostRepoVerifier} from './repo-verifier.ts';
import {RepositoryDiscovery} from './repo-discovery.ts';
import { callerForRuntime, resolveRoleRuntimes } from './model-runtime.ts';
import { TokenBudget, type TokenBudgetSnapshot } from './token-budget.ts';
import {
  runSwarm,
  type SwarmReport,
  type SwarmTask,
  type SwarmOptions,
  type ModelCaller,
} from './swarm.ts';
import type { CodeFixture, FixtureContents, FixtureResult } from './fixture.ts';
import type { DockerAgentOptions } from './docker-agent-worker.ts';
import type { CodexCallResult } from './codex-worker.ts';

const DEFAULTS = {
  workers: 4,
  concurrency: 2,
  maxCalls: 16,
  maxMetaCalls: 2,
  maxRounds: 12,
  timeoutMs: 120000,
  maxTokensPerCall: 16000,
  maxTokens: 300000,
  reserveTokensPerCall: 30000,
} as const;

const GOAL_ARTIFACT = '.sheep-internal/goal.md';
const GUIDANCE_ARTIFACT = '.sheep-internal/guidance.md';

interface JsonResponse {
  content: string;
  note: string;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function hashContent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function originalContent(snapshot: RepoSnapshot, path: string): string {
  const entry = snapshot.entries.get(path);
  if (entry !== undefined) return entry.bytes.toString('utf8');
  return snapshot.initialTargets[path] ?? '';
}

function buildGoalArtifact(snapshot: RepoSnapshot): string {
  if(snapshot.task.version===2)return `# Fixed repository goal\n${snapshot.task.goal}\nHost owns acceptance commands and write capabilities. Only assigned targets may be changed.`;
  const manifest = JSON.stringify(snapshot.task, null, 2);
  return [
    '# Host-owned repository task (immutable)',
    '',
    `Repository goal: ${snapshot.task.goal}`,
    '',
    'Selected writable targets:',
    ...snapshot.task.files.map((file) => `- ${file.path}`),
    '',
    'Read-only context:',
    ...(snapshot.task.context.length ? snapshot.task.context.map((p) => `- ${p}`) : ['- (none)']),
    '',
    'Protected paths:',
    ...snapshot.task.protected.map((p) => `- ${p}`),
    '',
    'Final acceptance checks (operator-supplied, authoritative):',
    ...snapshot.task.checks.map((command) => `- ${JSON.stringify(command.argv)}`),
    '',
    'Normalized manifest:',
    '```json',
    manifest,
    '```',
    '',
    'This artifact is the fixed host oracle. Model output cannot alter it.',
  ].join('\n');
}

function buildGuidanceArtifact(snapshot: RepoSnapshot): string {
  if(snapshot.task.version===2)return 'Use your own immutable target instructions and delivered files. Shared guidance cannot replace the fixed host oracle.';
  return [
    `# Shared guidance for goal: ${snapshot.task.goal}`,
    '',
    'Per-target instructions:',
    ...snapshot.task.files.map((file) => `- ${file.path}: ${file.instructions}`),
    '',
    'This guidance is mutable shared context. It must remain nonempty and cannot replace the fixed goal/oracle artifact.',
  ].join('\n');
}

/** Route by the worker/meta role encoded in the swarm sessionId (not model-name equality). */
function roleOf(sessionId: string | undefined): 'worker' | 'meta' {
  if (typeof sessionId !== 'string') return 'worker';
  const parts = sessionId.split(':');
  return parts[1] === 'meta' ? 'meta' : 'worker';
}

function makeTask(
  snapshot: RepoSnapshot,
  goalArtifact: string,
  guidanceArtifact: string,
  checkDirectory: string,
  verifications: RepoVerification[],
  finalChecks: {value?: RepoVerification},
  verifier:HostRepoVerifier,
  discovery?:RepositoryDiscovery,
): SwarmTask {
  return {
    id: 'repository-task',
    ...(discovery?{control:discovery}:{}),
    createFixture: (): CodeFixture => {
      const selected = new Set<string>([
        ...snapshot.task.files.map((file) => file.path),
        ...snapshot.task.context,
      ]);
      const contents: Record<string, string> = Object.create(null);
      for (const selectedPath of selected) contents[selectedPath] = originalContent(snapshot, selectedPath);
      Object.assign(contents,discovery?.artifacts);
      contents[GOAL_ARTIFACT] = 'Repository task awaiting activation.';
      contents[GUIDANCE_ARTIFACT] = guidanceArtifact;

      const writableIds = snapshot.task.files.map((file) => file.path);
      const writableSet = new Set(writableIds);

      const dependencies: { consumer: string; provider: string }[] = [];
      const seenEdges = new Set<string>();
      const addEdge = (consumer: string, provider: string): void => {
        if (consumer === provider) return;
        const key = `${consumer}\u0000${provider}`;
        if (seenEdges.has(key)) return;
        seenEdges.add(key);
        dependencies.push({ consumer, provider });
      };

      for (const file of snapshot.task.files) {
        for (const dep of file.dependsOn) addEdge(file.path, dep);
        for (const ctx of snapshot.task.context) if (!writableSet.has(ctx)) addEdge(file.path, ctx);
        addEdge(file.path, GOAL_ARTIFACT);
        addEdge(file.path, GUIDANCE_ARTIFACT);
      }

      const verify = async (
        candidate: FixtureContents,
        scope?: readonly string[],
      ): Promise<FixtureResult> => {
        const errors: string[] = [];
        let executionFailure = false;
        let publicFailure: FixtureResult['publicFailure'];
        const scoped = scope !== undefined && scope.length > 0 ? scope : undefined;

        // Immutable artifacts must never be replaced by generated code.
        if (candidate[GOAL_ARTIFACT] !== goalArtifact) {
          errors.push('immutable goal artifact was modified');
        }
        if (candidate[GUIDANCE_ARTIFACT] !== undefined) {
          if (typeof candidate[GUIDANCE_ARTIFACT] !== 'string') {
            errors.push('guidance artifact must be a string');
          } else if (candidate[GUIDANCE_ARTIFACT].trim().length === 0) {
            errors.push('guidance artifact must remain nonempty');
          }
        }

        // Read-only context (unless also declared writable) must remain unchanged.
        for (const ctx of [...snapshot.task.context,...(snapshot.task.discovery?.readable??[]),...(discovery?.instructions.values()??[])]) {
          if (writableSet.has(ctx)) continue;
          if (candidate[ctx] !== undefined && candidate[ctx] !== (discovery?.artifacts[ctx]??originalContent(snapshot, ctx))) {
            errors.push(`context ${ctx} must remain unchanged`);
          }
        }

        const localChecks = new Map<string, readonly RepoCommand[]>();
        for (const file of snapshot.task.files) localChecks.set(file.path, file.checks);

        const targetOverlay = (): Record<string, string> => {
          const overlay: Record<string, string> = Object.create(null);
          for (const file of snapshot.task.files) {
            const value = candidate[file.path];
            if (typeof value === 'string') overlay[file.path] = value;
          }
          return overlay;
        };

        const runChecks = async (commands: readonly RepoCommand[]): Promise<void> => {
          if (executionFailure) return;
          const request={snapshot,overlay:targetOverlay(),commands,outputRoot:checkDirectory,phase:scoped===undefined?'final' as const:'local' as const};
          const verification=await verifier.verify(request);
          try {assertVerificationReceipt(request,verification,verifier.environmentId);}
          catch(error){executionFailure=true;errors.push(`verification receipt rejected: ${String(error)}`);return;}
          verifications.push(verification);
          if (scoped === undefined) finalChecks.value = verification;
          if (verification.executionFailure) executionFailure = true;
          if (!verification.ok) {
            errors.push(...verification.errors);
            // Local checks are operator-selected repair feedback. Keep full
            // bounded logs on disk and only a small diagnostic in the prompt;
            // final-only checks remain outside the worker repair loop.
            if (scoped !== undefined) {
              const failed = verification.checks.find(check => check.timedOut || check.signal !== null || check.exitCode !== 0);
              if (failed) {
                const diagnostic = [failed.stderr && `stderr:\n${failed.stderr}`, failed.stdout && `stdout:\n${failed.stdout}`]
                  .filter(Boolean).join('\n').slice(0, 8192);
                if (diagnostic) errors.push(`Local check diagnostics:\n${diagnostic}`);
                if (!verification.executionFailure && !failed.timedOut && failed.signal === null && failed.exitCode !== null
                  && verification.errors.length === 1
                  && verification.errors[0] === `command exited with code ${failed.exitCode}: ${failed.argv.join(' ')}`) {
                  publicFailure = {commands: [failed.argv], diagnostic};
                }
              }
            }
          }
        };

        const verdict = (): FixtureResult => ({ ok: errors.length === 0, errors,
          ...(executionFailure ? { executionFailure: true } : {}),
          ...(!executionFailure && publicFailure ? {publicFailure} : {}) });

        if (scoped === undefined) {
          // Final scope: run every final check against the combined candidate.
          await runChecks(snapshot.task.checks);
          return verdict();
        }

        // Local scope: structural immutable-source verdict plus each target's local checks.
        await runChecks([]);
        if (errors.length > 0) return verdict();
        for (const id of scoped) {
          if (id === GOAL_ARTIFACT || id === GUIDANCE_ARTIFACT) continue;
          const commands = localChecks.get(id) ?? [];
          if (commands.length > 0) await runChecks(commands);
        }
        return verdict();
      };

      const visibleTest = (): string => '';

      return {
        artifacts: contents,
        dependencies:discovery?.dependencies()??dependencies,
        changedSource: { id: GOAL_ARTIFACT, content: goalArtifact },
        sourceId: GOAL_ARTIFACT,
        specId: GUIDANCE_ARTIFACT,
        consumerIds: writableIds,
        reportIds: [],
        writableIds,
        visibleTest,
        verify,
      };
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function pathExists(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute);
    return true;
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function runRepository(
  options: RepoRunOptions,
  caller?: RepoCaller,
): Promise<RepoRunReport> {
  if(options.lazySwarm||options.lazyChildren!==undefined)throw new Error('use runLazyRepository for lazy mode');
  if(options.planWork||options.workPlan!==undefined)throw new Error('use runPlannedRepository or runPacketRepository for work plans');
  if (options.packetSize !== undefined) throw new Error('use runPacketRepository for packetSize');
  // ---- Preflight: manifest, runtime, limits, output path, capture (no model calls). ----
  const task = parseRepoTask(options.task);

  const resolved = resolveRoleRuntimes({
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    ...(options.metaRuntime === undefined ? {} : { metaRuntime: options.metaRuntime }),
    ...(options.workerModel === undefined ? {} : { workerModel: options.workerModel }),
    ...(options.metaModel === undefined ? {} : { metaModel: options.metaModel }),
  });

  if (resolved.runtime === 'docker-agent' || resolved.metaRuntime === 'docker-agent') {
    throw new Error('the repository runner rejects the docker-agent runtime (no false isolation claim)');
  }

  const workers = positiveInteger(options.workers, DEFAULTS.workers, 'workers');
  const concurrency = positiveInteger(options.concurrency, DEFAULTS.concurrency, 'concurrency');
  const maxCalls = positiveInteger(options.maxCalls, DEFAULTS.maxCalls, 'maxCalls');
  const maxMetaCalls = nonNegativeInteger(options.maxMetaCalls, DEFAULTS.maxMetaCalls, 'maxMetaCalls');
  const maxRounds = positiveInteger(options.maxRounds, DEFAULTS.maxRounds, 'maxRounds');
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs');
  const maxTokensPerCall = positiveInteger(options.maxTokensPerCall, DEFAULTS.maxTokensPerCall, 'maxTokensPerCall');
  const maxTokens = positiveInteger(options.maxTokens, DEFAULTS.maxTokens, 'maxTokens');
  const reserveTokensPerCall = positiveInteger(options.reserveTokensPerCall, DEFAULTS.reserveTokensPerCall, 'reserveTokensPerCall');

  if (concurrency > workers) throw new RangeError('concurrency must not exceed workers');

  if (typeof options.outputDirectory !== 'string' || options.outputDirectory.trim() === '') {
    throw new Error('outputDirectory is required');
  }
  const outputDirectory = resolve(options.outputDirectory);
  const swarmDirectory = join(outputDirectory, 'swarm');
  const checksDirectory = join(outputDirectory, 'checks');

  // Output root must be new: never overwrite prior evidence.
  if (await pathExists(outputDirectory)) {
    throw new Error(`outputDirectory already exists: ${outputDirectory}`);
  }

  if (options.goThinking !== undefined &&
    ((options.goThinking !== 'enabled' && options.goThinking !== 'disabled') || resolved.runtime !== 'opencode-go' || !resolved.workerModel.startsWith('deepseek-')))
    throw new RangeError('goThinking requires an OpenCode Go DeepSeek worker and enabled or disabled');
  const goThinking = options.goThinking ?? (resolved.runtime === 'opencode-go' && resolved.workerModel.startsWith('deepseek-') ? 'enabled' : undefined);
  const snapshot = await captureRepository(options.repository, task);
  for (const file of [...task.files.map(f=>f.path),...task.context,...task.protected,...(task.discovery?.readable??[])]) {
    const absolute=join(snapshot.root,file);
    if(absolute===outputDirectory || absolute.startsWith(outputDirectory+sep) || outputDirectory.startsWith(absolute+sep))
      throw new Error('outputDirectory overlaps a selected repository path');
  }
  const originalHashes: Record<string, string> = Object.create(null);
  for (const file of task.files) {
    originalHashes[file.path] = hashContent(originalContent(snapshot, file.path));
  }

  const verifier=createHostRepoVerifier();
  const verifications: RepoVerification[] = [];
  const discovery=task.version===2?await RepositoryDiscovery.create(snapshot,async(probe,contents)=>{
    // A newly created provider has no entry in the original snapshot; the overlay supplies it.
    const entries=new Map(probe.paths.filter(p=>snapshot.entries.has(p)).map(p=>[p,snapshot.entries.get(p)!]));
    const scoped:RepoSnapshot={...snapshot,entries,initialTargets:{[probe.provider]:snapshot.initialTargets[probe.provider]!},
      task:{version:1,goal:'Host-authored public counterexample',files:snapshot.task.files.filter(f=>f.path===probe.provider),
        context:probe.paths.filter(p=>p!==probe.provider),protected:probe.paths.filter(p=>p!==probe.provider),checks:[probe.check]}};
    const request={snapshot:scoped,overlay:{[probe.provider]:contents[probe.provider]!},commands:[probe.check],outputRoot:checksDirectory,phase:'local' as const};
    const receipt=await verifier.verify(request);
    assertVerificationReceipt(request,receipt,verifier.environmentId);
    verifications.push(receipt);return receipt;
  }):undefined;
  const goalArtifact = buildGoalArtifact(snapshot);
  const guidanceArtifact = buildGuidanceArtifact(snapshot);

  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory);
  await mkdir(checksDirectory, { recursive: true });
  await writeJson(join(outputDirectory, 'task.json'), task);

  const budget = new TokenBudget({ maxTokens, reserveTokensPerCall });
  let unknownUsage = false;
  let admissionLocked = false;

  await writeJson(join(outputDirectory, 'budget.json'), budget.snapshot());

  const workerFallback = callerForRuntime<JsonResponse>(resolved.runtime) as unknown as RepoCaller;
  const metaFallback = callerForRuntime<JsonResponse>(resolved.metaRuntime) as unknown as RepoCaller;

  // Only evidence writes must be ordered (to prevent stale receipts); the network
  // calls themselves remain concurrent. reserve() is synchronous and atomic.
  let writeLane: Promise<void> = Promise.resolve();
  const serializeWrite = async <T>(action: () => Promise<T>): Promise<T> => {
    const previous = writeLane;
    let release: () => void = () => {};
    writeLane = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  };

  const shouldLock = (): boolean => {
    const snap = budget.snapshot();
    return unknownUsage || snap.locked || snap.exceeded || snap.admissionDenied;
  };

  const wrapped: RepoCaller = async (
    callOptions: DockerAgentOptions,
  ): Promise<CodexCallResult<JsonResponse>> => {
    if (admissionLocked || shouldLock()) {
      throw new Error('token budget admission is locked; refusing new provider call');
    }
    const role = roleOf(callOptions.sessionId);
    const callId = callOptions.callId ?? `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    if (!budget.reserve(callOptions.model, callId)) {
      admissionLocked = true;
      await serializeWrite(() => writeJson(join(outputDirectory, 'budget.json'), budget.snapshot()));
      throw new Error(`token budget reserve denied for ${callId}`);
    }
    const active: RepoCaller = caller ?? (role === 'meta' ? metaFallback : workerFallback);
    let receipt: CodexCallResult<JsonResponse> | undefined;
    let failure: unknown;
    try {
      const providerOptions = {...callOptions,...(role === 'worker' && goThinking !== undefined ? {thinking:goThinking} : {})};
      receipt = await active(providerOptions);
    } catch (error) {
      failure = error;
    }
    const errorRecord = failure as
      | { code?: unknown; transcript?: unknown }
      | undefined;
    const settlement = budget.settle(
      callId,
      receipt ??
        (errorRecord !== undefined && errorRecord !== null
          ? {
              error: errorRecord.code,
              transcript: errorRecord.transcript,
              requestedModel: callOptions.model,
            }
          : {}),
    );
    if (settlement.tokens === null) unknownUsage = true;
    if (settlement.overrun) admissionLocked = true;
    if (shouldLock()) admissionLocked = true;
    await serializeWrite(() => writeJson(join(outputDirectory, 'budget.json'), budget.snapshot()));
    if (failure !== undefined) throw failure;
    return receipt!;
  };

  const finalChecks: {value?: RepoVerification} = {};
  const swarmTask = makeTask(snapshot, goalArtifact, guidanceArtifact, checksDirectory, verifications, finalChecks, verifier, discovery);

  const swarmOptions: SwarmOptions = {
    workers,
    concurrency,
    size: workers,
    outputDirectory: swarmDirectory,
    workerModel: resolved.workerModel,
    metaModel: resolved.metaModel,
    timeoutMs,
    maxCalls,
    maxMetaCalls,
    maxRounds,
    fault: 'none',
    runtime: resolved.runtime,
    metaRuntime: resolved.metaRuntime,
    workerTools: 'none',
    maxTokensPerCall,
  };

  await writeJson(join(outputDirectory,'profile.json'),{...swarmOptions,goThinking:goThinking??'provider-default',maxTokens,reserveTokensPerCall,apply:options.apply??false});
  let swarmReport: SwarmReport | undefined;
  let swarmFailure: unknown;
  try {
    swarmReport = await runSwarm(swarmOptions, wrapped as ModelCaller, undefined, swarmTask);
  } catch (error) {
    swarmFailure = error;
  }

  await discovery?.save(outputDirectory);
  const budgetSnapshot: TokenBudgetSnapshot = budget.snapshot();
  await writeJson(join(outputDirectory, 'budget.json'), budgetSnapshot);

  if (swarmReport === undefined) {
    throw swarmFailure instanceof Error ? swarmFailure : new Error(String(swarmFailure));
  }

  // Read accepted contents from the inner artifacts.json written by runSwarm.
  const accepted: Record<string, string> = Object.create(null);
  let innerArtifacts: Record<string, unknown> = {};
  try {
    innerArtifacts = JSON.parse(
      await readFile(join(swarmDirectory, 'artifacts.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    innerArtifacts = {};
  }
  for (const file of task.files) {
    const value = innerArtifacts[file.path];
    accepted[file.path] = typeof value === 'string' ? value : originalContent(snapshot, file.path);
  }

  // Export selected target contents to the outer artifacts.json.
  const outerArtifacts: Record<string, string> = Object.create(null);
  for (const file of task.files) outerArtifacts[file.path] = accepted[file.path]!;
  await writeJson(join(outputDirectory, 'artifacts.json'), outerArtifacts);

  const errors: string[] = [...swarmReport.finalErrors];
  // Reuse the fixed final verification; only collect a fallback when the kernel
  // stopped before reaching it. This avoids executing successful checks twice.
  let finalVerification = finalChecks.value;
  if (!finalVerification) {
    const request={snapshot,overlay:outerArtifacts,commands:task.checks,outputRoot:checksDirectory,phase:'final' as const};
    const receipt=await verifier.verify(request);
    assertVerificationReceipt(request,receipt,verifier.environmentId);
    finalVerification=receipt;
    verifications.push(finalVerification);
  }
  if (!finalVerification.ok) errors.push(...finalVerification.errors);

  const changedPaths: string[] = [];
  for (const file of task.files) {
    if (!snapshot.entries.has(file.path) || accepted[file.path] !== originalContent(snapshot, file.path)) changedPaths.push(file.path);
  }

  const changes = changedPaths.map((changedPath) => ({
    path: changedPath,
    before: snapshot.entries.has(changedPath) ? originalHashes[changedPath] : null,
    after: hashContent(accepted[changedPath]!),
  }));
  await writeJson(join(outputDirectory, 'changes.json'), changes);

  const settledKnown =
    budgetSnapshot.unknownUsageCalls === 0 &&
    budgetSnapshot.locked === false &&
    !budgetSnapshot.exceeded &&
    !budgetSnapshot.admissionDenied &&
    budgetSnapshot.reservationOverruns === 0 &&
    budgetSnapshot.activeReservations === 0;

  if (!settledKnown) errors.push('token-budget-incomplete-or-exceeded');
  let success =
    swarmReport.success &&
    finalVerification.ok &&
    settledKnown &&
    !unknownUsage &&
    errors.length === 0;

  let applied = false;
  if (success && options.apply === true) {
    try {
      const overlay: Record<string, string> = Object.create(null);
      for (const changedPath of changedPaths) overlay[changedPath] = accepted[changedPath]!;
      const written = await applyRepository(snapshot, overlay);
      applied = true;
      for (const writtenPath of written) if (!changedPaths.includes(writtenPath)) changedPaths.push(writtenPath);
    } catch (error) {
      applied = false;
      success = false;
      errors.push(`apply failed: ${String(error)}`);
    }
  }

  const report: RepoRunReport = {
    success,
    applied,
    repository: snapshot.root,
    head: snapshot.head,
    outputDirectory,
    changedPaths,
    budget: budgetSnapshot,
    swarm: swarmReport,
    verifications,
    ...(discovery?{discovery:discovery.metrics(swarmReport.calls)}:{}),
    errors,
  };

  await writeJson(join(outputDirectory, 'result.json'), report);
  return report;
}
