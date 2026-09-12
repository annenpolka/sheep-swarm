// CLI configuration resolution. This module resolves command-line values
// into a fully-specified runner configuration without performing side effects
// other than reading explicitly supplied task/rate files.
//
// It intentionally does NOT import the command entry points (cli.ts,
// repo-cli.ts, ...); it mirrors their defaults and validation so that every
// command can be refused before effects happen.

import { parseRateCard } from "./cost-estimate.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { numberOption, type CliValues, type CommandName } from "./cli-options.ts";
import { resolveRoleRuntimes, type ModelRuntime, type ResolvedRoleRuntimes } from "./model-runtime.ts";
import type { RepoTask } from "./repo-types.ts";
import { parseRepoTask } from "./repo-manifest.ts";
import type { SwarmOptions } from "./swarm.ts";
import type { RepoRunOptions } from "./repo-types.ts";
import type { ComparisonOptions, ComparisonMethod } from "./comparison.ts";
import type { DurableOptions } from "./durable-run.ts";
import type { MechanismOptions, MechanismMethod } from "./mechanism-run.ts";

export type { CommandName, CliValues };

/** Shared resolved limits across every command. */
export interface ResolvedLimits {
  readonly workerCalls: number | null;
  readonly totalCalls: number | null;
  readonly metaCalls: number;
}

/** Resolved budget for a command. */
export interface ResolvedBudget {
  readonly unit: "none" | "tokens" | "credits";
  readonly maxTokens?: number;
  readonly reserveTokens?: number;
  readonly maxCredits?: number;
  readonly lunaReservation?: number;
  readonly astraReservation?: number;
}

/** Resolved capabilities for a command. */
export interface ResolvedCapabilities {
  readonly resume: boolean;
  readonly apply: boolean;
  readonly verification: string;
}

/** Resolved registered pool and configured concurrency; observed activity is in the run report. */
export interface ResolvedConfiguration {
  readonly workers: number | null;
  readonly concurrency: number;
  readonly runtime: ModelRuntime;
  readonly metaRuntime: ModelRuntime;
  readonly workerModel: string;
  readonly metaModel: string;
  readonly maxTokensPerCall: number;
  readonly timeoutMs: number;
  readonly maxRounds?: number;
  readonly maxAttempts?: number;
}

/** Exact runner arguments for each command, discriminated by `command`. */
export type CliRunnerOptions =
  | { readonly command: "swarm"; readonly options: SwarmOptions }
  | { readonly command: "repo"; readonly options: RepoRunOptions }
  | { readonly command: "compare"; readonly options: ComparisonOptions }
  | { readonly command: "durable"; readonly options: DurableOptions }
  | { readonly command: "mechanism"; readonly options: MechanismOptions };

/** Fully resolved command profile. */
export interface ResolvedCliProfile {
  readonly planning?: {state:'requires-model-call';publicPaths:string[]};
  readonly packetPlan?: Awaited<ReturnType<typeof import('./repo-packet-run.ts').prepareRepositoryPackets>>['plan'];
  readonly command: CommandName;
  readonly options: SwarmOptions | RepoRunOptions | ComparisonOptions | DurableOptions | MechanismOptions;
  readonly configuration: ResolvedConfiguration;
  readonly outputDirectory: string;
  readonly limits: ResolvedLimits;
  readonly budget: ResolvedBudget;
  readonly capabilities: ResolvedCapabilities;
  readonly resumeState?:{generation:number;usageLocked:boolean};
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MODEL_RUNTIMES = ["codex", "docker-agent", "deepseek", "opencode-go"] as const;

function readRuntime(values: CliValues, key: string): ModelRuntime | undefined {
  const raw = values[key];
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") throw new Error(`--${key} must be a runtime name`);
  if (!(MODEL_RUNTIMES as readonly string[]).includes(raw)) throw new Error(`unknown ${key}`);
  return raw as ModelRuntime;
}

function readString(values: CliValues, key: string): string | undefined {
  const raw = values[key];
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") throw new Error(`--${key} must be a string`);
  if(raw.trim().length===0)throw new Error(`--${key} must not be empty`);
  return raw;
}

function readBoolean(values: CliValues, key: string): boolean | undefined {
  const raw = values[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new Error(`--${key} must be a boolean flag`);
  return raw;
}

function positiveInt(values: CliValues, key: string, fallback: number, min = 1): number {
  return numberOption(values, key, fallback, min);
}

function nonNegativeInt(values: CliValues, key: string, fallback: number): number {
  return numberOption(values, key, fallback, 0);
}

function positiveFraction(values: CliValues, key: string, fallback: number, allowZero=false): number {
  const raw = readString(values, key);
  if (raw === undefined) return fallback;
  const text = raw.trim();
  if (text.length === 0) throw new Error(`--${key} must be a number`);
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || (allowZero?parsed<0:parsed<=0)) throw new Error(`--${key} must be a finite positive number`);
  return parsed;
}

function freshOutputPath(cwd: string, name: string): string {
  return resolve(cwd, `.sheep/${name}-${new Date().toISOString().replaceAll(":", "-")}`);
}

function validateConcurrency(workers: number, concurrency: number): void {
  if (concurrency > workers) throw new Error("concurrency must not exceed workers");
}

function resolveRuntimes(values: CliValues): ResolvedRoleRuntimes {
  const maxTokensPerCallRaw = readString(values, "max-tokens-per-call");
  let maxTokensPerCall: number | undefined;
  if (maxTokensPerCallRaw !== undefined) {
    maxTokensPerCall = numberOption(values, "max-tokens-per-call", 1, 1);
  }
  return resolveRoleRuntimes({
    ...(readRuntime(values, "runtime") === undefined ? {} : { runtime: readRuntime(values, "runtime")! }),
    ...(readRuntime(values, "meta-runtime") === undefined ? {} : { metaRuntime: readRuntime(values, "meta-runtime")! }),
    ...(readString(values, "worker-model") === undefined ? {} : { workerModel: readString(values, "worker-model")! }),
    ...(readString(values, "meta-model") === undefined ? {} : { metaModel: readString(values, "meta-model")! }),
    ...(readString(values, "worker-tools") === undefined ? {} : { workerTools: readString(values, "worker-tools")! }),
    ...(maxTokensPerCall === undefined ? {} : { maxTokensPerCall }),
  });
}

function configurationFor(runtimes: ResolvedRoleRuntimes, workers: number, concurrency: number, timeoutMs: number,
  extras: { maxRounds?: number; maxAttempts?: number } = {}): ResolvedConfiguration {
  return { workers, concurrency, runtime: runtimes.runtime, metaRuntime: runtimes.metaRuntime,
    workerModel: runtimes.workerModel, metaModel: runtimes.metaModel,
    maxTokensPerCall: runtimes.maxTokensPerCall, timeoutMs, ...extras };
}

// ---------------------------------------------------------------------------
// Command-specific resolution
// ---------------------------------------------------------------------------

function resolveSwarm(values: CliValues, cwd: string, runtimes: ResolvedRoleRuntimes): ResolvedCliProfile {
  const workers = positiveInt(values, "workers", 4);
  const concurrency = positiveInt(values, "concurrency", 4);
  validateConcurrency(workers, concurrency);
  const size = positiveInt(values, "size", 4);
  if(size<2||size>256)throw new RangeError("fixture size must be from 2 to 256");
  const maxMetaCalls = nonNegativeInt(values, "max-meta-calls", 2);
  const maxRounds = nonNegativeInt(values, "max-rounds", 20);
  const timeoutMs = nonNegativeInt(values, "timeout-ms", 120_000);
  const maxCalls = values["max-calls"] === undefined
    ? size * 5
    : nonNegativeInt(values, "max-calls", size * 5);
  const faultRaw = readString(values, "fault");
  if (faultRaw !== undefined && faultRaw !== "none" && faultRaw !== "rounded-guidance") throw new Error("unknown fault");
  const outputDirectory = readString(values, "output") === undefined
    ? freshOutputPath(cwd, "run")
    : resolve(cwd, readString(values, "output")!);
  const options: SwarmOptions = {
    workers, concurrency, size, outputDirectory,
    ...(readString(values, "worker-model") === undefined ? {} : { workerModel: readString(values, "worker-model")! }),
    ...(readString(values, "meta-model") === undefined ? {} : { metaModel: readString(values, "meta-model")! }),
    timeoutMs, maxCalls, maxMetaCalls, maxRounds,
    ...(faultRaw === undefined ? {} : { fault: faultRaw }),
    runtime: runtimes.runtime, metaRuntime: runtimes.metaRuntime,
    workerTools: runtimes.workerTools,
    maxTokensPerCall: runtimes.maxTokensPerCall,
  };
  return {
    command: "swarm",
    options,
    configuration: configurationFor(runtimes, workers, concurrency, timeoutMs, { maxRounds }),
    outputDirectory,
    limits: { workerCalls: maxCalls, totalCalls: null, metaCalls: maxMetaCalls },
    budget: { unit: "none" },
    capabilities: { resume: false, apply: false, verification: "fixture" },
  };
}

async function resolveRepo(values: CliValues, cwd: string, runtimes: ResolvedRoleRuntimes): Promise<ResolvedCliProfile> {
  const repo = readString(values, "repo");
  const taskPath = readString(values, "task");
  if (repo === undefined || taskPath === undefined)
    throw new Error("--repo and --task are required; use --help for the task schema");
  const repository = resolve(cwd, repo);
  const taskFile = resolve(cwd, taskPath);
  const raw = JSON.parse(await readFile(taskFile, "utf8"));
  const task: RepoTask = parseRepoTask(raw);

  const packetRaw = readString(values, 'packet-size');
  const planWork=readBoolean(values,'plan-work')??false;
  const lazySwarm=readBoolean(values,'lazy-swarm')??false;
  if(!lazySwarm&&values['lazy-children']!==undefined)throw new Error('--lazy-children requires --lazy-swarm');
  if(lazySwarm&&(planWork||packetRaw!==undefined))throw new Error('--lazy-swarm excludes planner and packet flags');
  if(planWork&&packetRaw!==undefined)throw new Error('--plan-work and --packet-size are mutually exclusive');
  if (packetRaw !== undefined || planWork || lazySwarm) {
    if (values['workers'] !== undefined || values['max-rounds'] !== undefined) throw new Error('packet workers derive from the plan; use concurrency and max-calls');
    const packetSize = lazySwarm||planWork||packetRaw === 'all' ? 'all' : numberOption(values, 'packet-size', 1, 1);
    const options: RepoRunOptions = {
      repository, task, outputDirectory: resolve(cwd, readString(values,'output') ?? `.sheep/packets-${Date.now()}`),
      packetSize, runtime:runtimes.runtime, workerModel:runtimes.workerModel,
      concurrency:positiveInt(values,'concurrency',4),maxCalls:positiveInt(values,'max-calls',128),
      maxMetaCalls:nonNegativeInt(values,'max-meta-calls',0),timeoutMs:positiveInt(values,'timeout-ms',600000),
      maxTokens:positiveInt(values,'max-tokens',2000000),reserveTokensPerCall:positiveInt(values,'reserve-tokens',200000),
      maxTokensPerCall:positiveInt(values,'max-tokens-per-call',64000),apply:readBoolean(values,'apply')??false,
      goThinking:(readString(values,'go-thinking')??'enabled') as 'enabled',
    };
    const {prepareRepositoryPackets}=await import('./repo-packet-run.ts');
    const {plan,config}=await prepareRepositoryPackets(options);
    const {packetSize:_packetSize,...plannerOptions}=options;
    if(lazySwarm){
      const lazyOptions={...plannerOptions,lazySwarm:true,lazyChildren:nonNegativeInt(values,'lazy-children',2)};
      const {prepareLazyRepository}=await import('./repo-lazy-run.ts');await prepareLazyRepository(lazyOptions);
      return {command:'repo',options:lazyOptions,outputDirectory:options.outputDirectory,
        configuration:configurationFor({...runtimes,maxTokensPerCall:config.maxTokensPerCall},1,config.concurrency,config.timeoutMs),
        limits:{workerCalls:config.maxCalls,totalCalls:config.maxCalls,metaCalls:0},budget:{unit:'tokens',maxTokens:config.maxTokens,reserveTokens:config.reserveTokensPerCall},
        capabilities:{resume:false,apply:true,verification:'host-lazy-checks'}};
    }
    if(planWork)return {command:'repo',options:{...plannerOptions,planWork:true},planning:{state:'requires-model-call',publicPaths:plan.publicPaths},outputDirectory:options.outputDirectory,
      configuration:{...configurationFor({...runtimes,maxTokensPerCall:config.maxTokensPerCall},0,config.concurrency,config.timeoutMs),workers:null},
      limits:{workerCalls:config.maxCalls-1,totalCalls:config.maxCalls,metaCalls:0},budget:{unit:'tokens',maxTokens:config.maxTokens,reserveTokens:config.reserveTokensPerCall},
      capabilities:{resume:false,apply:true,verification:'host-planned-packet-checks'}};
    return {command:'repo',options,packetPlan:plan,outputDirectory:options.outputDirectory,
      configuration:configurationFor({...runtimes,maxTokensPerCall:config.maxTokensPerCall},plan.packets.length,config.concurrency,config.timeoutMs),
      limits:{workerCalls:config.maxCalls,totalCalls:config.maxCalls,metaCalls:0},
      budget:{unit:'tokens',maxTokens:config.maxTokens,reserveTokens:config.reserveTokensPerCall},
      capabilities:{resume:false,apply:true,verification:'host-packet-checks'}};
  }

  if (runtimes.runtime === "docker-agent" || runtimes.metaRuntime === "docker-agent")
    throw new Error("the repository runner does not support the Docker Agent runtime");

  const goThinkingRaw = readString(values, "go-thinking");
  if (goThinkingRaw !== undefined && goThinkingRaw !== "enabled" && goThinkingRaw !== "disabled") throw new Error("unknown go-thinking mode");

  if(goThinkingRaw!==undefined&&(runtimes.runtime!=="opencode-go"||!runtimes.workerModel.startsWith("deepseek-")))throw new Error("go-thinking requires an OpenCode Go DeepSeek worker");
  const workers = positiveInt(values, "workers", 4);
  const concurrency = positiveInt(values, "concurrency", 2);
  validateConcurrency(workers, concurrency);
  const maxCalls = positiveInt(values, "max-calls", 16);
  const maxMetaCalls = nonNegativeInt(values, "max-meta-calls", 2);
  const maxRounds = positiveInt(values, "max-rounds", 12);
  const timeoutMs = positiveInt(values, "timeout-ms", 120_000);
  const maxTokensPerCall = values["max-tokens-per-call"] === undefined
    ? 16_000
    : numberOption(values, "max-tokens-per-call", 16_000, 1);

  const maxTokensRaw = readString(values, "max-tokens");
  const reserveTokensRaw = readString(values, "reserve-tokens");
  let maxTokens = 300_000;
  let reserveTokensPerCall = 30_000;
  if (maxTokensRaw !== undefined) {
    maxTokens = numberOption(values, "max-tokens", 300_000, 1);
  }
  if (reserveTokensRaw !== undefined) {
    reserveTokensPerCall = numberOption(values, "reserve-tokens", 30_000, 1);
  }
  if (reserveTokensPerCall > maxTokens) throw new RangeError("reservation exceeds total token budget");

  const apply = readBoolean(values, "apply") ?? false;
  const outputDirectory = readString(values, "output") === undefined
    ? resolve(cwd, `.sheep/repository-${Date.now()}`)
    : resolve(cwd, readString(values, "output")!);

  const options: RepoRunOptions = {
    repository, task, outputDirectory, apply,
    workers, concurrency, maxCalls, maxMetaCalls, maxRounds, timeoutMs,
    maxTokensPerCall, maxTokens, reserveTokensPerCall,
    runtime: runtimes.runtime, metaRuntime: runtimes.metaRuntime, workerModel: runtimes.workerModel, metaModel: runtimes.metaModel,
    ...(goThinkingRaw === undefined ? (runtimes.runtime === "opencode-go" && runtimes.workerModel.startsWith("deepseek-") ? { goThinking: "enabled" as const } : {}) : { goThinking: goThinkingRaw as "enabled" | "disabled" }),
  };
  return {
    command: "repo",
    options,
    configuration: configurationFor({...runtimes,maxTokensPerCall}, workers, concurrency, timeoutMs, { maxRounds }),
    outputDirectory,
    limits: { workerCalls: maxCalls, totalCalls: null, metaCalls: maxMetaCalls },
    budget: { unit: "tokens", maxTokens, reserveTokens: reserveTokensPerCall },
    capabilities: { resume: false, apply:true, verification: "host-checks" },
  };
}

const COMPARISON_METHODS = ["single-luna", "single-worker", "single-upper", "manager-local", "sheep-fixed", "sheep-full"] as const;

function resolveCompare(values: CliValues, cwd: string, runtimes: ResolvedRoleRuntimes): ResolvedCliProfile {
  const methodRaw = readString(values, "method") ?? "sheep-fixed";
  if (!(COMPARISON_METHODS as readonly string[]).includes(methodRaw)) throw new Error(`method must be one of ${COMPARISON_METHODS.join(", ")}`);
  const method = methodRaw as ComparisonMethod;
  const faultRaw = readString(values, "fault");
  if (faultRaw !== undefined && faultRaw !== "none" && faultRaw !== "rounded-guidance") throw new Error("unknown comparison fault");

  const isSingleLane = method === "single-luna" || method === "single-worker";
  const size = positiveInt(values, "size", 8);
  if(size<2||size>64)throw new RangeError("heldout size must be from 2 to 64");
  const requestedWorkers=positiveInt(values,"workers",4),requestedConcurrency=positiveInt(values,"concurrency",4);
  const workers = isSingleLane ? 1 : requestedWorkers;
  const concurrency = isSingleLane ? 1 : requestedConcurrency;
  validateConcurrency(workers, concurrency);
  const maxCalls = positiveInt(values, "max-calls", 48);
  const maxTokens = positiveInt(values, "max-tokens", 120_000);
  const maxUpperCalls = values["max-upper-calls"] === undefined
    ? maxCalls
    : numberOption(values, "max-upper-calls", maxCalls, 0);
  const reserveTokensPerCall = positiveInt(values, "reserve-tokens", 12_000);
  if (reserveTokensPerCall > maxTokens) throw new RangeError("reservation exceeds total token budget");
  const timeoutMs = positiveInt(values, "timeout-ms", 120_000);
  const maxRounds = positiveInt(values, "max-rounds", 24);
  const maxAttempts = positiveInt(values, "max-attempts", 3);

  const outputDirectory = readString(values, "output") === undefined
    ? resolve(cwd, `.sheep/comparison-${method}-${Date.now()}`)
    : resolve(cwd, readString(values, "output")!);

  const options: ComparisonOptions = {
    method, outputDirectory, size, workers, concurrency, maxCalls, maxTokens, maxUpperCalls,
    reserveTokensPerCall, timeoutMs, maxRounds, maxAttempts,
    ...(faultRaw === undefined ? {} : { fault: faultRaw }),
    runtime: runtimes.runtime, metaRuntime: runtimes.metaRuntime,
    workerModel: runtimes.workerModel, metaModel: runtimes.metaModel,
    workerTools: runtimes.workerTools, maxTokensPerCall: runtimes.maxTokensPerCall,
  };
  return {
    command: "compare",
    options,
    configuration: configurationFor(runtimes, workers, concurrency, timeoutMs, { maxRounds, maxAttempts }),
    outputDirectory,
    limits: { workerCalls: null, totalCalls: maxCalls, metaCalls: maxUpperCalls },
    budget: { unit: "tokens", maxTokens, reserveTokens: reserveTokensPerCall },
    capabilities: { resume: false, apply: false, verification: "held-out-fixture" },
  };
}

function resolveDurable(values: CliValues, cwd: string, runtimes: ResolvedRoleRuntimes): ResolvedCliProfile {
  const directoryRaw = readString(values, "directory");
  if (directoryRaw === undefined) throw new Error("--directory is required; pass --resume to continue its durable state");
  const directory = resolve(cwd, directoryRaw);
  const resume = readBoolean(values, "resume") ?? false;
  if (runtimes.runtime === "docker-agent" || runtimes.metaRuntime === "docker-agent")
    throw new Error("durable runs do not support the Docker Agent runtime");
  if (resume) throw new Error("durable resume profile requires persisted state inspection");

  const faultRaw = readString(values, "fault");
  if (faultRaw !== undefined && faultRaw !== "none" && faultRaw !== "rounded-guidance") throw new Error("unknown fault");

  const size = positiveInt(values, "size", 4);
  if(size<2||size>256)throw new RangeError("fixture size must be from 2 to 256");
  const workers = positiveInt(values, "workers", 4);
  const concurrency = 1;
  validateConcurrency(workers, concurrency);
  const maxCalls = values["max-calls"] === undefined
    ? size * 6
    : positiveInt(values, "max-calls", size * 6);
  const maxMetaCalls = nonNegativeInt(values, "max-meta-calls", 2);
  const timeoutMs = positiveInt(values, "timeout-ms", 120_000);

  const options: DurableOptions = {
    directory, resume, size, workers, maxCalls, maxMetaCalls, timeoutMs,
    ...(faultRaw === undefined ? {} : { fault: faultRaw }),
    runtime: runtimes.runtime, metaRuntime: runtimes.metaRuntime,
    workerModel: runtimes.workerModel, metaModel: runtimes.metaModel,
    maxTokensPerCall: runtimes.maxTokensPerCall,
  };
  return {
    command: "durable",
    options,
    configuration: configurationFor(runtimes, workers, concurrency, timeoutMs),
    outputDirectory: directory,
    limits: { workerCalls: maxCalls, totalCalls: null, metaCalls: maxMetaCalls },
    budget: { unit: "none" },
    capabilities: { resume: true, apply: false, verification: "durable-fixture" },
  };
}

const MECHANISM_METHODS = ["sheep", "single-luna", "single-worker", "single-astra", "no-memory", "no-upper"] as const;
const MECHANISM_FAMILIES = ["static", "semantic", "staged"] as const;

async function resolveMechanism(values: CliValues, cwd: string, runtimes: ResolvedRoleRuntimes): Promise<ResolvedCliProfile> {
  const methodRaw = readString(values, "method") ?? "sheep";
  if (!(MECHANISM_METHODS as readonly string[]).includes(methodRaw)) throw new Error("unknown method");
  const familyRaw = readString(values, "family") ?? "static";
  if (!(MECHANISM_FAMILIES as readonly string[]).includes(familyRaw)) throw new Error("unknown family");
  const budgetModeRaw = readString(values, "budget-mode") ?? "credits";
  if (budgetModeRaw !== "credits" && budgetModeRaw !== "tokens") throw new Error("unknown budget mode");

  const maxTokensRaw = readString(values, "max-tokens");
  const reserveTokensRaw = readString(values, "reserve-tokens");
  const maxCreditsRaw = readString(values, "max-credits");
  const lunaReservationRaw = readString(values, "luna-reservation");
  const astraReservationRaw = readString(values, "astra-reservation");
  const ratesRaw = readString(values, "rates");
  const tokenOptionsSupplied = maxTokensRaw !== undefined || reserveTokensRaw !== undefined;
  const creditOptionsSupplied = maxCreditsRaw !== undefined || lunaReservationRaw !== undefined
    || astraReservationRaw !== undefined || ratesRaw !== undefined;

  if (budgetModeRaw === "tokens") {
    if (creditOptionsSupplied) throw new Error("credit budget options cannot be combined with the token budget mode");
    if (maxTokensRaw === undefined || reserveTokensRaw === undefined)
      throw new Error("token budget mode requires --max-tokens and --reserve-tokens");
  } else {
    if (tokenOptionsSupplied) throw new Error("token budget options cannot be combined with the credit budget mode");
  }

  const budgetMode = budgetModeRaw;
  const maxTokens = maxTokensRaw === undefined ? 0 : numberOption(values, "max-tokens", 0, 0);
  const reserveTokensPerCall = reserveTokensRaw === undefined ? 1 : numberOption(values, "reserve-tokens", 1, 1);
  const maxCredits = positiveFraction(values, "max-credits", 30,true);
  const lunaReservation = positiveFraction(values, "luna-reservation", 0.25);
  const astraReservation = positiveFraction(values, "astra-reservation", 15);

  const single = methodRaw === "single-luna" || methodRaw === "single-worker" || methodRaw === "single-astra";
  const groups = positiveInt(values, "groups", 8);
  if(groups>16)throw new RangeError("mechanism groups must be from 1 to 16");
  const requestedWorkers=positiveInt(values,"workers",16),requestedConcurrency=positiveInt(values,"concurrency",8);
  const workers = single ? 1 : requestedWorkers;
  const concurrency = single ? 1 : requestedConcurrency;
  validateConcurrency(workers, concurrency);
  const maxCalls = positiveInt(values, "max-calls", 400);
  const timeoutMs = positiveInt(values, "timeout-ms", 90_000);
  const maxAttempts = positiveInt(values, "max-attempts", 3);
  const maxReadCalls = nonNegativeInt(values, "max-read-calls", 2);
  const maxMetaCalls = nonNegativeInt(values, "max-meta-calls", 3);
  const maxTokensPerCall = values["max-tokens-per-call"] === undefined
    ? 60_000
    : numberOption(values, "max-tokens-per-call", 60_000, 1);

  if (budgetMode === "credits" && (runtimes.runtime === "deepseek" || runtimes.metaRuntime === "deepseek"
    || runtimes.runtime === "opencode-go" || runtimes.metaRuntime === "opencode-go"))
    throw new Error("the mechanism credit budget does not support API runtimes; use --budget-mode tokens");

  const outputDirectory = readString(values, "output") === undefined
    ? resolve(cwd, `.sheep/mechanism-${methodRaw}-${familyRaw}-${Date.now()}`)
    : resolve(cwd, readString(values, "output")!);

  const options: MechanismOptions = {
    method: methodRaw as MechanismMethod, family: familyRaw as typeof MECHANISM_FAMILIES[number], outputDirectory,
    runtime: runtimes.runtime, metaRuntime: runtimes.metaRuntime,
    workerModel: runtimes.workerModel, metaModel: runtimes.metaModel,
    workerTools: runtimes.workerTools, maxTokensPerCall,
    budgetMode,
    groups, workers, concurrency,
    maxCalls, timeoutMs, maxAttempts, maxReadCalls, maxMetaCalls,
    ...(budgetMode === "tokens" ? { maxTokens, reserveTokensPerCall } : {}),
    ...(budgetMode === "credits" ? { maxCredits, lunaReservation, astraReservation } : {}),
  };

  if (ratesRaw !== undefined) {
    const parsed = JSON.parse(await readFile(resolve(cwd, ratesRaw), "utf8"));
    (options as { rateCard?: unknown }).rateCard = parseRateCard(parsed);
  }

  const budget: ResolvedBudget = budgetMode === "tokens"
    ? { unit: "tokens", maxTokens, reserveTokens: reserveTokensPerCall }
    : { unit: "credits", maxCredits, lunaReservation, astraReservation };
  return {
    command: "mechanism",
    options,
    configuration: configurationFor({...runtimes,maxTokensPerCall}, workers, concurrency, timeoutMs, { maxAttempts }),
    outputDirectory,
    limits: { workerCalls: null, totalCalls: maxCalls, metaCalls: maxMetaCalls },
    budget,
    capabilities: { resume: false, apply: false, verification: "mechanism-fixture" },
  };
}

export function resolveCliProfile<C extends CommandName>(command:C,values:CliValues,cwd?:string):Promise<ResolvedCliProfile & Extract<CliRunnerOptions,{command:C}>>;
export async function resolveCliProfile(
  command: CommandName,
  values: CliValues,
  cwd: string = process.cwd(),
): Promise<ResolvedCliProfile> {
  if(command==='durable' && values.resume===true){
    const directory=readString(values,'directory');if(!directory)throw new Error('--directory is required');
    const {inspectDurableRun}=await import('./durable-run.ts');
    const inspected=await inspectDurableRun(resolve(cwd,directory));
    const config=inspected.configuration;
    const keys:Record<string,string>={'max-calls':'maxCalls','max-meta-calls':'maxMetaCalls','timeout-ms':'timeoutMs','meta-runtime':'metaRuntime','worker-model':'workerModel','meta-model':'metaModel','max-tokens-per-call':'maxTokensPerCall'};
    for(const [flag,value] of Object.entries(values)){
      if(['directory','resume','dry-run','format','help'].includes(flag))continue;
      const key=keys[flag]??flag;const saved=config[key as keyof typeof config];
      const requested=typeof saved==='number'?numberOption(values,flag,0,key==='maxMetaCalls'?0:1):value;
      if(requested!==saved)throw new Error(`resume configuration mismatch: ${key}`);
    }
    return {command:'durable',options:{directory:resolve(cwd,directory),resume:true,...config},configuration:config,
      outputDirectory:resolve(cwd,directory),limits:{workerCalls:config.maxCalls,totalCalls:null,metaCalls:config.maxMetaCalls},
      resumeState:{generation:inspected.generation,usageLocked:inspected.usageLocked},
      budget:{unit:'none'},capabilities:{resume:true,apply:false,verification:'durable-fixture'}};
  }
  const runtimes = resolveRuntimes(values);
  switch (command) {
    case "swarm": return resolveSwarm(values, cwd, runtimes);
    case "repo": return resolveRepo(values, cwd, runtimes);
    case "compare": return resolveCompare(values, cwd, runtimes);
    case "durable": return resolveDurable(values, cwd, runtimes);
    case "mechanism": return resolveMechanism(values, cwd, runtimes);
    default: throw new Error(`unsupported command: ${String(command)}`);
  }
}
