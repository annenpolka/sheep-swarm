// Production CLI option parsing shared by repository/swarm/compare/durable/mechanism entry points.
import { parseArgs } from 'node:util';

export type CommandName = 'repo' | 'swarm' | 'compare' | 'durable' | 'mechanism';
export type CliValues = Record<string, string | boolean | undefined>;
export interface ParsedCommandArgs {
  readonly values: CliValues;
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly format: 'json' | 'text';
}

interface OptionSpec {
  readonly key: string;
  readonly type: 'string' | 'boolean';
  readonly short?: string;
  readonly aliases?: readonly string[];
}

/**
 * Command-specific flag surfaces. `key` is the canonical legacy flag name
 * each CLI currently consumes; `aliases` are additional spellings that map
 * onto the same key.
 */
const COMMAND_OPTIONS: Record<CommandName, readonly OptionSpec[]> = {
  repo: [
    { key: 'packet-size', type: 'string' },
    { key: 'plan-work', type: 'boolean' },
    { key: 'repo', type: 'string' },
    { key: 'task', type: 'string' },
    { key: 'output', type: 'string' },
    { key: 'apply', type: 'boolean' },
    { key: 'go-thinking', type: 'string' },
    { key: 'runtime', type: 'string' },
    { key: 'meta-runtime', type: 'string' },
    { key: 'worker-model', type: 'string' },
    { key: 'meta-model', type: 'string' },
    { key: 'workers', type: 'string' },
    { key: 'concurrency', type: 'string' },
    { key: 'max-calls', type: 'string', aliases: ['max-worker-calls'] },
    { key: 'max-meta-calls', type: 'string' },
    { key: 'max-rounds', type: 'string' },
    { key: 'timeout-ms', type: 'string' },
    { key: 'max-tokens-per-call', type: 'string' },
    { key: 'max-tokens', type: 'string' },
    { key: 'reserve-tokens', type: 'string' },
  ],
  swarm: [
    { key: 'workers', type: 'string' },
    { key: 'concurrency', type: 'string' },
    { key: 'size', type: 'string' },
    { key: 'output', type: 'string' },
    { key: 'worker-model', type: 'string' },
    { key: 'meta-model', type: 'string' },
    { key: 'max-calls', type: 'string', aliases: ['max-worker-calls'] },
    { key: 'max-meta-calls', type: 'string' },
    { key: 'max-rounds', type: 'string' },
    { key: 'timeout-ms', type: 'string' },
    { key: 'max-tokens-per-call', type: 'string' },
    { key: 'fault', type: 'string' },
    { key: 'runtime', type: 'string' },
    { key: 'meta-runtime', type: 'string' },
    { key: 'worker-tools', type: 'string' },
  ],
  compare: [
    { key: 'method', type: 'string' },
    { key: 'output', type: 'string' },
    { key: 'size', type: 'string' },
    { key: 'workers', type: 'string' },
    { key: 'concurrency', type: 'string' },
    { key: 'max-calls', type: 'string', aliases: ['max-total-calls'] },
    { key: 'max-tokens', type: 'string' },
    { key: 'max-upper-calls', type: 'string', aliases: ['max-meta-calls'] },
    { key: 'reserve-tokens', type: 'string' },
    { key: 'timeout-ms', type: 'string' },
    { key: 'max-rounds', type: 'string' },
    { key: 'max-attempts', type: 'string' },
    { key: 'fault', type: 'string' },
    { key: 'runtime', type: 'string' },
    { key: 'meta-runtime', type: 'string' },
    { key: 'worker-tools', type: 'string' },
    { key: 'worker-model', type: 'string' },
    { key: 'meta-model', type: 'string' },
    { key: 'max-tokens-per-call', type: 'string' },
  ],
  durable: [
    { key: 'directory', type: 'string', aliases: ['output'] },
    { key: 'resume', type: 'boolean' },
    { key: 'size', type: 'string' },
    { key: 'workers', type: 'string' },
    { key: 'max-calls', type: 'string', aliases: ['max-worker-calls'] },
    { key: 'max-meta-calls', type: 'string' },
    { key: 'timeout-ms', type: 'string' },
    { key: 'fault', type: 'string' },
    { key: 'runtime', type: 'string' },
    { key: 'meta-runtime', type: 'string' },
    { key: 'worker-model', type: 'string' },
    { key: 'meta-model', type: 'string' },
    { key: 'max-tokens-per-call', type: 'string' },
  ],
  mechanism: [
    { key: 'runtime', type: 'string' },
    { key: 'meta-runtime', type: 'string' },
    { key: 'worker-model', type: 'string' },
    { key: 'meta-model', type: 'string' },
    { key: 'worker-tools', type: 'string' },
    { key: 'budget-mode', type: 'string' },
    { key: 'max-tokens', type: 'string' },
    { key: 'reserve-tokens', type: 'string' },
    { key: 'max-tokens-per-call', type: 'string' },
    { key: 'method', type: 'string' },
    { key: 'family', type: 'string' },
    { key: 'output', type: 'string' },
    { key: 'rates', type: 'string' },
    { key: 'groups', type: 'string' },
    { key: 'workers', type: 'string' },
    { key: 'concurrency', type: 'string' },
    { key: 'max-credits', type: 'string' },
    { key: 'luna-reservation', type: 'string' },
    { key: 'astra-reservation', type: 'string' },
    { key: 'max-calls', type: 'string', aliases: ['max-total-calls'] },
    { key: 'timeout-ms', type: 'string' },
    { key: 'max-attempts', type: 'string' },
    { key: 'max-read-calls', type: 'string' },
    { key: 'max-meta-calls', type: 'string' },
  ],
};

// Common flags accepted by every command.
const COMMON_OPTIONS: readonly OptionSpec[] = [
  { key: 'help', type: 'boolean', short: 'h' },
  { key: 'dry-run', type: 'boolean' },
  { key: 'format', type: 'string' },
];

interface ParsedRaw {
  readonly values: Record<string, string | boolean>;
  readonly tokens: readonly string[];
}

function collectSpecs(command: CommandName): readonly OptionSpec[] {
  return [...COMMON_OPTIONS, ...COMMAND_OPTIONS[command]];
}

function parse(command: CommandName, args: readonly string[]): ParsedRaw {
  const specs = collectSpecs(command);
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
  for (const spec of specs) {
    if (options[spec.key] !== undefined) throw new Error(`duplicate option definition: ${spec.key}`);
    const entry: { type: 'string' | 'boolean'; short?: string; multiple?: boolean } = { type: spec.type };
    if (spec.short !== undefined) entry.short = spec.short;
    // `multiple: true` lets parseArgs retain repeated occurrences so we can
    // detect duplicate same-key flags ourselves and reject them.
    entry.multiple = true;
    options[spec.key] = entry;
    for (const alias of spec.aliases ?? []) {
      if (options[alias] !== undefined) throw new Error(`duplicate option definition: ${alias}`);
      const aliasEntry: { type: 'string' | 'boolean'; short?: string; multiple?: boolean } = { type: spec.type };
      aliasEntry.multiple = true;
      options[alias] = aliasEntry;
    }
  }
  let result;
  try {
    result = parseArgs({ args: [...args], options, allowPositionals: false, strict: true });
  } catch (error) {
    throw new Error(`invalid arguments: ${(error as Error).message}`);
  }
  const rawValues = result.values as Record<string, string | boolean | (string | boolean)[]>;
  const values: Record<string, string | boolean> = {};
  for (const [name, raw] of Object.entries(rawValues)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      if (raw.length > 1) throw new Error(`duplicate option: --${name}`);
      const single = raw[0];
      if (single === undefined) continue;
      values[name] = single;
    } else {
      values[name] = raw;
    }
  }
  return { values, tokens: result.positionals };
}

function canonicalKey(command: CommandName, name: string): string {
  for (const spec of collectSpecs(command)) {
    if (spec.key === name) return spec.key;
    if ((spec.aliases ?? []).includes(name)) return spec.key;
  }
  return name;
}

function optionType(command: CommandName, name: string): 'string' | 'boolean' {
  for (const spec of collectSpecs(command)) {
    if (spec.key === name || (spec.aliases ?? []).includes(name)) return spec.type;
  }
  return 'string';
}

export function parseCommandArgs(command: CommandName, args: readonly string[]): ParsedCommandArgs {
  const specTable = COMMAND_OPTIONS[command];
  if (specTable === undefined) throw new Error(`unsupported command: ${command}`);
  const raw = parse(command, args);
  if (raw.tokens.length > 0) throw new Error(`unexpected positional argument: ${raw.tokens[0]}`);

  const values: CliValues = {};
  const claimed = new Map<string, string>();
  for (const [name, value] of Object.entries(raw.values)) {
    const canonical = canonicalKey(command, name);
    const existing = claimed.get(canonical);
    if (existing !== undefined) {
      throw new Error(`duplicate option: --${name} conflicts with --${existing}`);
    }
    claimed.set(canonical, name);
    values[canonical] = value;
  }

  const help = values.help === true;
  const dryRun = values['dry-run'] === true;

  let format: 'json' | 'text' = 'json';
  const formatValue = values.format;
  if (formatValue !== undefined) {
    if (formatValue !== 'json' && formatValue !== 'text') {
      throw new Error(`invalid --format: ${String(formatValue)} (expected json or text)`);
    }
    format = formatValue;
  }

  return { values, help, dryRun, format };
}

export function numberOption(values: CliValues, key: string, fallback: number, min = 1): number {
  const raw = values[key];
  if (raw === undefined) return fallback;
  if (typeof raw === 'boolean') throw new Error(`--${key} must be a number`);
  const text = raw.trim();
  if (text.length === 0) throw new Error(`--${key} must be a number`);
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a finite number`);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${key} must be a safe integer`);
  if (parsed < min) throw new Error(`--${key} must be at least ${min}`);
  return parsed;
}

function renderOptions(specs: readonly OptionSpec[]): string {
  return specs
    .map((spec) => {
      const head = spec.short !== undefined ? `-${spec.short}, --${spec.key}` : `    --${spec.key}`;
      const alias = (spec.aliases ?? []).map((a) => `--${a}`).join(', ');
      const suffix = spec.type === 'string' ? ' <value>' : '';
      return alias.length > 0 ? `  ${head}${suffix}  (alias: ${alias})` : `  ${head}${suffix}`;
    })
    .join('\n');
}

const COMMAND_BLURB: Record<CommandName, string> = {
  repo: 'Snapshot a Git worktree, run declared file tasks, then host checks.',
  swarm: 'Run the in-memory swarm pipeline and write a run report.',
  compare: 'Run a comparison between swarm strategies and report quality.',
  durable: 'Run or resume a checkpointed swarm with durable state.',
  mechanism: 'Run the mechanism harness under credits or tokens budgeting.',
};

const NOTES:Record<CommandName,string>={
  repo:`Required: --repo PATH --task TASK.json. Manifest v1 or opt-in v2 discovery.
Defaults: N=4, C=2, worker calls=16, meta calls=2, rounds=12, timeout=120000 ms;
  output tokens/call=16000, total tokens=300000, reservation/call=30000.
--max-worker-calls (legacy --max-calls) excludes meta calls.
Host commands run in candidate workspaces; they are not a security sandbox.
--apply writes accepted targets after final checks and source drift checks.
Repository resume and Docker Agent are unsupported.
--go-thinking enabled|disabled requires an OpenCode Go DeepSeek worker (default: enabled).
--plan-work asks DeepSeek Flash to choose scopes before execution; planner time/tokens count. Dry-run makes no model calls.
--packet-size all|N opts into the shared packet executor (Go deepseek-flash, thinking enabled, upper 0).
Packet mode derives worker count from the public graph; --concurrency is a ceiling (default 4).
Packet --dry-run includes assignments, current read paths, dependencies and SCC size exceptions.`,
  swarm:`Defaults: N=4, C=4, size=4, worker calls=size*5, meta calls=2, rounds=20.
--max-worker-calls (legacy --max-calls) excludes meta calls.
No total token or credit admission budget; --max-tokens-per-call limits output.
No resume or source apply. Verification uses the built-in fixture.`,
  compare:`Defaults: method=sheep-fixed, size=8, N=4, C=4, total calls=48, meta calls=48;
  tokens=120000, reservation/call=12000, rounds=24, attempts=3.
--max-total-calls (legacy --max-calls) includes every role.
--max-meta-calls (legacy --max-upper-calls) is a sub-limit, default total calls.
Single-luna / single-worker resolve to N=1, C=1. No resume or source apply.
Verification uses the held-out fixture.`,
  durable:`Required: --output DIRECTORY (legacy --directory). Fixed C=1.
Defaults: N=4, size=4, worker calls=size*6, meta calls=2, timeout=120000 ms.
--max-worker-calls (legacy --max-calls) excludes meta calls.
--resume reads saved configuration; incompatible overrides are rejected.
No aggregate token/credit admission budget. API unknown usage locks admissions.
Docker Agent and source apply are unsupported.`,
  mechanism:`Defaults: method=sheep, family=static, groups=8, N=16, C=8;
  total calls=400, meta calls=3, reads/target=2, attempts=3, timeout=90000 ms;
  output tokens/call=60000. Single methods resolve to N=1, C=1.
--max-total-calls (legacy --max-calls) includes every role.
--budget-mode credits (default): conditional rate-card estimate, not provider quota;
  max=30, lower reservation=0.25, upper reservation=15.
--budget-mode tokens requires --max-tokens and --reserve-tokens; do not mix units.
API runtimes require tokens mode. No resume or source apply.`};
function commandHelp(command:CommandName):string {
  return `Usage: npm run sheep -- ${command} [options]
Legacy entry: npm run ${command} -- [options]

${COMMAND_BLURB[command]}

${NOTES[command]}

Runtime: codex (default), docker-agent, deepseek, opencode-go, subject to command capabilities.
Default models: gpt-5.6-luna / gpt-6-astra for Codex. API worker model must be explicit;
API meta runtime defaults to Codex. --worker-model / --meta-model accept raw model IDs.
Default output limit: 30000 tokens/call unless specified above; timeout: 120000 ms.
--dry-run resolves configuration without model calls, checks, apply or run-directory writes.
Durable resume inspects a temporary copy of its database and removes the copy.
--format json (default) or text. New entry exits: 0 success, 2 invalid input, 1 run failure.
Legacy entries retain exit 1 for failures and their existing JSON summaries.

Common options:
${renderOptions(COMMON_OPTIONS)}

${command} options:
${renderOptions(COMMAND_OPTIONS[command])}
`;
}
function rootHelp():string {
  return `Usage: npm run sheep -- <command> [options]

${(['repo','swarm','compare','durable','mechanism'] as const).map(n=>`  ${n.padEnd(10)} ${COMMAND_BLURB[n]}`).join('\n')}

Use <command> --help for defaults, budgets, effects and supported flags.
N (--workers) is the registered pool; C (--concurrency) is the concurrent limit.
--max-worker-calls: repo/swarm/durable. --max-total-calls: compare/mechanism.
--max-meta-calls limits upper calls; legacy aliases retain their original meanings.
--dry-run resolves the configuration without spending model budget or running checks.
--format json|text controls output. Only repo supports --apply; only durable supports --resume.

Auxiliary npm scripts remain separate:
  npm run mechanism:experiment -- ...
  npm run sandbox:probe -- ... (other sandbox:* scripts in package.json)
  npm run estimate:cost -- ...
`;
}

export function cliHelp(command?: CommandName): string {
  if (command === undefined) return rootHelp();
  if (COMMAND_OPTIONS[command] === undefined) throw new Error(`unsupported command: ${command}`);
  return commandHelp(command);
}

export function optionTypeOf(command: CommandName, name: string): 'string' | 'boolean' {
  return optionType(command, name);
}
