export interface ProbeAdmission {
  readonly target: string;
  readonly provider: string;
  readonly upstream: readonly string[];
  readonly eligible: readonly string[];
  readonly required: readonly string[];
  readonly reads: Readonly<Record<string, { version: number; evidenceEpoch: number }>>;
  readonly current: Readonly<Record<string, { version: number; evidenceEpoch: number }>>;
  readonly key: string;
  readonly seen: readonly string[];
  readonly requests: number;
  readonly maxRequests: number;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Return a refusal reason, or null when a host-selected public probe may run. */
export function admitPublicProbe(input: ProbeAdmission): string | null {
  const {
    target,
    provider,
    upstream,
    eligible,
    required,
    reads,
    current,
    key,
    seen,
    requests,
    maxRequests,
  } = input;

  if (!isNonNegativeSafeInteger(requests) || !isNonNegativeSafeInteger(maxRequests)) {
    throw new RangeError('requests and maxRequests must be nonnegative safe integers');
  }

  if (requests >= maxRequests) {
    return 'probe-request-limit';
  }

  if (provider === target || !upstream.includes(provider)) {
    return 'not-upstream';
  }

  if (!eligible.includes(provider)) {
    return 'provider-unavailable';
  }

  for (const path of required) {
    if (!Object.prototype.hasOwnProperty.call(reads, path)) {
      return 'undelivered-probe-input';
    }
  }

  for (const readKey of Object.keys(reads)) {
    const read: { version: number; evidenceEpoch: number } | undefined = reads[readKey];
    if (read === undefined) {
      return 'stale-observation';
    }

    if (!Object.prototype.hasOwnProperty.call(current, readKey)) {
      return 'stale-observation';
    }

    const currentStamp: { version: number; evidenceEpoch: number } | undefined = current[readKey];
    if (
      currentStamp === undefined ||
      read.version !== currentStamp.version ||
      read.evidenceEpoch !== currentStamp.evidenceEpoch
    ) {
      return 'stale-observation';
    }
  }

  if (seen.includes(key)) {
    return 'duplicate-probe';
  }

  return null;
}
