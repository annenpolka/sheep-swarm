import { readFile, writeFile, readdir, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseRateCard, extractTokenUsage, estimateCallCost, estimatePlannedUsage, sumCostIntervals } from "../src/cost-estimate.ts";

const HELP = `Offline conditional token costs, without provider calls.
  node scripts/estimate-costs.mjs --rates pricing/openai-2026-09-10.json --root .sheep --output cost-estimate.json [--markdown cost-estimate.md]
  node scripts/estimate-costs.mjs --rates pricing/openai-2026-09-10.json --run .sheep/my-next-run --output my-next-cost.json
  node scripts/estimate-costs.mjs --rates pricing/openai-2026-09-10.json --scenario planned-usage.json --output forecast.json
Scenario JSON: {"rows":[{"model":"gpt-5.6-luna","calls":40,"inputTokensPerCall":20000,"cachedInputTokensPerCall":15000,"cacheWriteInputTokensPerCall":0,"outputTokensPerCall":250}]}
Use null for unknown usage or rates. Missing cached usage is bounded, never silently zero.
--usd-per-credit NUMBER applies an explicitly assumed purchased-credit USD conversion.
Estimates assume Standard speed and ordinary per-request context. Actual service tier and billed debit are not inferred from turn totals.
`;
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === "--help") { process.stdout.write(HELP); process.exit(0); }
  if (!["--rates", "--root", "--run", "--output", "--markdown", "--scenario", "--usd-per-credit"].includes(flag) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--") || Object.hasOwn(args, flag.slice(2))) {
    throw new Error(`Unknown, missing, or duplicate argument: ${flag}\n${HELP}`);
  }
  args[flag.slice(2)] = process.argv[++i];
}
if (!args.rates || !args.output) throw new Error(HELP);
if ([args.scenario, args.root, args.run].filter(Boolean).length > 1) throw new Error("Choose exactly one of --scenario, --root, or --run");
const rateBytes = await readFile(resolve(args.rates));
const rawRates = JSON.parse(rateBytes.toString("utf8"));
const card = parseRateCard(args["usd-per-credit"] === undefined ? rawRates : { ...rawRates, usdPerCredit: Number(args["usd-per-credit"]) });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const metadata = { format: 1, generatedAt: new Date().toISOString(),
  rateCard: { file: basename(args.rates), sha256: sha(rateBytes), contents: rawRates, appliedUsdPerCredit: card.usdPerCredit },
  conditions: ["Standard speed; ordinary per-request context. Receipt turn totals are not individual API requests.",
    "API USD is hypothetical API pricing, not an invoice for ChatGPT-authenticated Codex.",
    "Codex credits are token-rate equivalents, not measured debit from the account's included usage or purchased credits.",
    "Input includes cached reads and cache writes; output includes reasoning. Components are not charged twice.",
    "Unknown usage or applicable prices produce bounds; a null upper bound is unknown, not unlimited actual cost.",
    "Tool charges, subscriptions, taxes, development calls, and human work are outside this estimate."] };

function sumEstimates(rows) {
  return { apiUsd: sumCostIntervals(rows.map(row => row.apiUsd)), codexCredits: sumCostIntervals(rows.map(row => row.codexCredits)),
    codexUsdAtAssumedCreditPrice: card.usdPerCredit === null ? null : sumCostIntervals(rows.map(row => row.codexUsdAtAssumedCreditPrice)) };
}
const describe = value => value.upper === null ? `>= ${value.lower.toFixed(6)} (upper unknown)`
  : value.exact ? value.lower.toFixed(6) : `${value.lower.toFixed(6)}–${value.upper.toFixed(6)}`;
const modelName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : "unknown";
const knownMethod = value => ["single-upper", "manager-local", "sheep-fixed", "sheep-full"].includes(value) ? value : null;
function publicConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = {};
  for (const key of ["size", "workers", "concurrency", "maxCalls", "maxMetaCalls", "maxTokens", "reserveTokensPerCall", "timeoutMs", "maxRounds", "maxAttempts"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  for (const key of ["workerModel", "metaModel"]) if (typeof value[key] === "string") output[key] = modelName(value[key]);
  if (["none", "rounded-guidance"].includes(value.fault)) output.fault = value.fault;
  if (knownMethod(value.method)) output.method = value.method;
  return output;
}
let report, markdown;
if (args.scenario) {
  const scenarioBytes = await readFile(resolve(args.scenario));
  const scenario = JSON.parse(scenarioBytes.toString("utf8"));
  if (!Array.isArray(scenario.rows) || !scenario.rows.length) throw new Error("Scenario requires a nonempty rows array");
  const rows = scenario.rows.map(row => estimatePlannedUsage(row, card));
  report = { ...metadata, mode: "planned-usage", scenarioSha256: sha(scenarioBytes), rows, total: sumEstimates(rows.map(row => row.total)) };
  markdown = ["# Planned conditional token costs", "", "| Requested model | Calls | API USD | Codex credit equivalent |",
    "|:---|---:|---:|---:|", ...rows.map(row => `| ${row.model} | ${row.calls} | ${describe(row.total.apiUsd)} | ${describe(row.total.codexCredits)} |`)];
} else {
  const root = resolve(args.run ?? args.root ?? ".sheep");
  // The same eight disjoint families as summarize-comparisons.mjs. Preliminary
  // attempts remain billed work but are not silently merged into primary trials.
  const families = args.run ? [["custom-run", "."]] : [["m2-normal", "luna-4-initial"], ["m2-fault", "luna-4-intervention"],
    ["m3-pretrial", "luna-16-stateful-pilot"], ["m3-primary", "scaling-v1"], ["m4-restart", "durable-real-v1"],
    ["m5-preliminary", "comparison-v1"], ["m5-primary", "comparison-v2"], ["m5-manager-followup", "manager-followup"]];
  const calls = [], runMetadata = new Map(), manifests = [], missingFamilies = [], seenPaths = new Set();
  await readdir(root); // A typo must never become an apparently exact zero-cost report.
  async function files(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const found = [];
    for (const item of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(path, item.name);
      if (item.isDirectory() && item.name !== "transcripts" && !item.name.startsWith("model-workspace")) found.push(...(await files(name) ?? []));
      if (item.isFile() && (/^(compare-)?call-\d+\.json$/.test(item.name) || item.name === "result.json" || item.name === "experiment.json")) found.push(name);
    }
    return found;
  }
  for (const [family, location] of families) {
    const paths = await files(join(root, location));
    if (paths === null) { missingFamilies.push(family); continue; }
    const expected = new Map(), foundCalls = new Set();
    for (const path of paths) {
      const bytes = await readFile(path), data = JSON.parse(bytes.toString("utf8"));
      const run = relative(root, dirname(path)) || ".";
      if (basename(path) === "experiment.json") {
        manifests.push({ family, path: relative(root, path), sha256: sha(bytes) });
        for (const run of data.runs ?? []) {
          if (!run.resultSha256 && run.status !== "passed") continue;
          const id = run.id ?? (typeof run.directory === "string" ? basename(run.directory) : undefined);
          if (typeof id !== "string" || !id || id === "." || id === ".." || basename(id) !== id) throw new Error(`Invalid declared run in ${relative(root, path)}`);
          const resultPath = join(dirname(path), id, "result.json");
          const resultBytes = await readFile(resultPath);
          if (run.resultSha256 && sha(resultBytes) !== run.resultSha256) throw new Error(`Result hash mismatch: ${relative(root, resultPath)}`);
        }
        continue;
      }
      if (basename(path) === "result.json") {
        runMetadata.set(run, { resultSha256: sha(bytes), success: typeof data.success === "boolean" ? data.success : null,
          method: knownMethod(data.method), configuration: publicConfiguration(data.configuration) });
        for (const call of data.calls ?? []) {
          if (typeof call.id !== "string") throw new Error(`Call without id in ${relative(root, path)}`);
          const key = `${run}/${call.id}`;
          if (expected.has(key)) throw new Error(`Duplicate call id in result: ${key}`);
          expected.set(key, { family, run, callId: call.id, requestedModel: modelName(call.model),
            effectiveModelEvidence: call.effectiveModelEvidence == null ? null : modelName(call.effectiveModelEvidence),
            resultPath: relative(root, path), resultSha256: sha(bytes) });
        }
        continue;
      }
      const actualPath = await realpath(path);
      if (seenPaths.has(actualPath)) throw new Error(`Receipt path counted twice: ${relative(root, path)}`);
      seenPaths.add(actualPath);
      const callId = basename(path, ".json"), key = `${run}/${callId}`;
      if (foundCalls.has(key)) throw new Error(`Duplicate call receipt: ${key}`);
      foundCalls.add(key);
      const requestedModel = modelName(data.transcript?.requestedModel ?? data.requestedModel);
      const effectiveModelEvidence = data.transcript?.effectiveModelEvidence == null ? null : modelName(data.transcript.effectiveModelEvidence);
      const usage = extractTokenUsage(data);
      const conflict = effectiveModelEvidence !== null && effectiveModelEvidence !== requestedModel;
      const cost = estimateCallCost(usage, conflict || requestedModel === "unknown" ? "unknown-model-conflict" : requestedModel, card);
      calls.push({ family, run, callId, requestedModel, effectiveModelEvidence,
        modelIdentityVerified: requestedModel !== "unknown" && effectiveModelEvidence === requestedModel,
        modelIdentityConflict: conflict,
        path: relative(root, path), sha256: sha(bytes), receiptPresent: true, usage, cost });
    }
    for (const [key, call] of expected) {
      if (foundCalls.has(key)) continue;
      const usage = extractTokenUsage(null);
      calls.push({ ...call, modelIdentityVerified: false, modelIdentityConflict: false,
        path: null, sha256: null, receiptPresent: false, usage, cost: estimateCallCost(usage, call.requestedModel, card) });
    }
  }
  if (calls.length === 0) throw new Error("No recognized experimental calls found; refusing an exact zero estimate");
  calls.sort((a, b) => a.run.localeCompare(b.run) || a.callId.localeCompare(b.callId, undefined, { numeric: true }));
  function summarize(group) {
    const observedTokens = Object.fromEntries(["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"]
      .map(key => [key, { knownSum: group.reduce((total, row) => total + (row.usage[key] ?? 0), 0), unknownCalls: group.filter(row => row.usage[key] === null).length }]));
    return { calls: group.length, receiptMissingCalls: group.filter(row => !row.receiptPresent).length,
      maxRecordedTurnInputTokens: Math.max(0, ...group.map(row => row.usage.inputTokens ?? 0)),
      modelIdentityUnverifiedCalls: group.filter(row => !row.modelIdentityVerified).length,
      modelIdentityConflictingCalls: group.filter(row => row.modelIdentityConflict).length,
      observedTokens, ...sumEstimates(group.map(row => row.cost)) };
  }
  function groups(keys) {
    const grouped = new Map();
    for (const row of calls) { const key = JSON.stringify(keys.map(key => row[key])); const group = grouped.get(key) ?? []; group.push(row); grouped.set(key, group); }
    return [...grouped.values()].map(group => ({ ...Object.fromEntries(keys.map(key => [key, group[0][key]])),
      ...(keys.includes("run") ? runMetadata.get(group[0].run) ?? {} : {}), ...summarize(group) }));
  }
  report = { ...metadata, mode: "recorded-usage", scope: args.run
    ? "Selected run or experiment directory only. All discovered calls, including retries and preliminary calls, are counted once per receipt path; no raw prompts or transcripts are exported."
    : "Named experimental families only. Retries and preliminary calls are counted once per receipt path; no raw prompts or transcripts are exported.",
    missingFamilies, sourceManifests: manifests, total: summarize(calls), byFamily: groups(["family"]),
    byModel: groups(["requestedModel"]), byRun: groups(["family", "run"]), byFamilyAndModel: groups(["family", "requestedModel"]), calls };
  const cell = value => String(value).replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("\r", " ");
  markdown = ["# Recorded conditional token costs", "", "| Family | Run | Calls | API USD | Codex credit equivalent |",
    "|:---|:---|---:|---:|---:|", ...report.byRun.map(row => `| ${cell(row.family)} | ${cell(row.run)} | ${row.calls} | ${describe(row.apiUsd)} | ${describe(row.codexCredits)} |`)];
  if (missingFamilies.length) markdown.push("", `Missing families: ${missingFamilies.join(", ")}. These are outside the computed subtotal.`);
}
markdown.push("", ...metadata.conditions.map(text => `- ${text}`), "");
await mkdir(dirname(resolve(args.output)), { recursive: true });
await writeFile(resolve(args.output), JSON.stringify(report, null, 2) + "\n");
if (args.markdown) { await mkdir(dirname(resolve(args.markdown)), { recursive: true }); await writeFile(resolve(args.markdown), markdown.join("\n")); }
process.stdout.write(JSON.stringify({ mode: report.mode, output: resolve(args.output), total: report.total }, null, 2) + "\n");
