export interface TrialMetric {readonly group:string;readonly success:boolean;readonly elapsedMs:number;readonly completionMs:number|null;readonly calls:number;readonly tokens:number|null}
export interface GroupMetric {group:string;runs:number;successes:number;failures:number;medianCompletionMs:number|null;medianElapsedMs:number;calls:number;knownTokens:number;totalTokens:number|null;unknownTokenRuns:number}

interface GroupAccumulator {
  runs: number;
  successes: number;
  failures: number;
  completionValues: number[];
  elapsedValues: number[];
  calls: number;
  knownTokens: number;
  unknownTokenRuns: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! / 2 + sorted[mid]! / 2);
}

function validateTrial(row: TrialMetric): void {
  if (typeof row.group !== 'string' || row.group.length === 0) {
    throw new Error('group must be a nonempty string');
  }
  if (typeof row.success !== 'boolean') {
    throw new Error('success must be a boolean');
  }
  if (typeof row.elapsedMs !== 'number' || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) {
    throw new Error('elapsedMs must be a finite nonnegative number');
  }
  if (row.success) {
    if (
      typeof row.completionMs !== 'number' ||
      !Number.isFinite(row.completionMs) ||
      row.completionMs !== row.elapsedMs
    ) {
      throw new Error('completionMs must equal elapsedMs for successful runs');
    }
  } else if (row.completionMs !== null) {
    throw new Error('completionMs must be null for failed runs');
  }
  if (typeof row.calls !== 'number' || !Number.isSafeInteger(row.calls) || row.calls < 0) {
    throw new Error('calls must be a nonnegative safe integer');
  }
  if (row.tokens !== null) {
    if (typeof row.tokens !== 'number' || !Number.isSafeInteger(row.tokens) || row.tokens < 0) {
      throw new Error('tokens must be null or a nonnegative safe integer');
    }
  }
}

export function summarizeTrials(rows: readonly TrialMetric[]): GroupMetric[] {
  const groups = new Map<string, GroupAccumulator>();

  for (const row of rows) {
    validateTrial(row);

    let acc = groups.get(row.group);
    if (acc === undefined) {
      acc = {
        runs: 0,
        successes: 0,
        failures: 0,
        completionValues: [],
        elapsedValues: [],
        calls: 0,
        knownTokens: 0,
        unknownTokenRuns: 0,
      };
      groups.set(row.group, acc);
    }

    acc.runs += 1;
    if (row.success) {
      acc.successes += 1;
      acc.completionValues.push(row.completionMs as number);
    } else {
      acc.failures += 1;
    }
    acc.elapsedValues.push(row.elapsedMs);
    acc.calls += row.calls;
    if (row.tokens === null) {
      acc.unknownTokenRuns += 1;
    } else {
      acc.knownTokens += row.tokens;
    }
  }

  const result: GroupMetric[] = [];
  for (const [group, acc] of groups) {
    result.push({
      group,
      runs: acc.runs,
      successes: acc.successes,
      failures: acc.failures,
      medianCompletionMs: median(acc.completionValues),
      medianElapsedMs: median(acc.elapsedValues) as number,
      calls: acc.calls,
      knownTokens: acc.knownTokens,
      totalTokens: acc.unknownTokenRuns > 0 ? null : acc.knownTokens,
      unknownTokenRuns: acc.unknownTokenRuns,
    });
  }

  result.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  return result;
}
