import type {ImpactInput} from './repo-impact-types.ts';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertUniqueNonEmptyStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      throw new TypeError(`${label} must contain only non-empty strings`);
    }
    if (seen.has(item)) {
      throw new TypeError(`${label} must contain unique strings`);
    }
    seen.add(item);
  }
}

function copyNonEmptyStringArray(value: unknown, label: string): string[] {
  assertUniqueNonEmptyStringArray(value, label);
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((item) => item as string);
}

function parseEdge(value: unknown, index: number): {consumer: string; provider: string} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`edges[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const {consumer, provider} = record;
  if (!isNonEmptyString(consumer)) {
    throw new TypeError(`edges[${index}].consumer must be a non-empty string`);
  }
  if (!isNonEmptyString(provider)) {
    throw new TypeError(`edges[${index}].provider must be a non-empty string`);
  }
  return {consumer, provider};
}

export function parseImpactInput(input: unknown): ImpactInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('input must be a non-null, non-array object');
  }
  const record = input as Record<string, unknown>;

  const targets = copyNonEmptyStringArray(record['targets'], 'targets');
  if (targets.length === 0) {
    throw new TypeError('targets must be non-empty');
  }

  const changedPaths = copyNonEmptyStringArray(record['changedPaths'], 'changedPaths');

  const rawEdges = record['edges'];
  if (!Array.isArray(rawEdges)) {
    throw new TypeError('edges must be an array');
  }
  const edges = Array.from(rawEdges, (edge, index) => parseEdge(edge, index));

  const rawUncertainConsumers = record['uncertainConsumers'];
  const uncertainConsumers =
    rawUncertainConsumers === undefined
      ? []
      : copyNonEmptyStringArray(rawUncertainConsumers, 'uncertainConsumers');

  return {targets, changedPaths, edges, uncertainConsumers};
}
