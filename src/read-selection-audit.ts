export interface AuditTargetResult {
  target: string;
  registryDelivered: boolean;
  policyRequested: boolean;
  sequentialRead: boolean;
  policyDeliveredBeforeCommit: boolean;
}

export interface AuditReadSelectionResult {
  valid: boolean;
  errors: string[];
  targets: AuditTargetResult[];
}

interface Expectation {
  target: string;
  registryPath: string;
  policyPath: string;
}

interface CallRow {
  id: string;
  role: 'worker' | 'meta';
  target: string;
  outcome: string;
}

interface RequestRow {
  callId: string;
  target: string;
  paths: string[];
  accepted: boolean;
}

interface DeliveryRow {
  callId: string;
  target: string;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function auditReadSelection(input: unknown): AuditReadSelectionResult {
  const errors: string[] = [];
  const targets: AuditTargetResult[] = [];

  if (!isRecord(input)) {
    return { valid: false, errors: ['input must be an object'], targets };
  }

  const requiredFields = ['expectations', 'calls', 'requests', 'deliveries'] as const;
  for (const field of requiredFields) {
    if (!(field in input)) {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (errors.length > 0) {
    return { valid: false, errors, targets };
  }

  const expectationsRaw = input['expectations'];
  const callsRaw = input['calls'];
  const requestsRaw = input['requests'];
  const deliveriesRaw = input['deliveries'];

  if (!Array.isArray(expectationsRaw)) {
    errors.push('expectations must be an array');
  }
  if (!Array.isArray(callsRaw)) {
    errors.push('calls must be an array');
  }
  if (!Array.isArray(requestsRaw)) {
    errors.push('requests must be an array');
  }
  if (!Array.isArray(deliveriesRaw)) {
    errors.push('deliveries must be an array');
  }
  if (errors.length > 0) {
    return { valid: false, errors, targets };
  }

  const expectationsArray = expectationsRaw as unknown[];
  const callsArray = callsRaw as unknown[];
  const requestsArray = requestsRaw as unknown[];
  const deliveriesArray = deliveriesRaw as unknown[];

  if (expectationsArray.length === 0) errors.push("expectations must not be empty");
  const expectations: Expectation[] = [];
  const seenTargets = new Set<string>();
  for (let i = 0; i < expectationsArray.length; i += 1) {
    const raw = expectationsArray[i];
    if (!isRecord(raw)) {
      errors.push(`expectations[${i}] must be an object`);
      continue;
    }
    const target = raw['target'];
    const registryPath = raw['registryPath'];
    const policyPath = raw['policyPath'];
    if (!isNonemptyString(target)) {
      errors.push(`expectations[${i}].target must be a nonempty string`);
      continue;
    }
    if (!isNonemptyString(registryPath)) {
      errors.push(`expectations[${i}].registryPath must be a nonempty string`);
      continue;
    }
    if (!isNonemptyString(policyPath)) {
      errors.push(`expectations[${i}].policyPath must be a nonempty string`);
      continue;
    }
    if (seenTargets.has(target)) {
      errors.push(`duplicate expectation target: ${target}`);
      continue;
    }
    seenTargets.add(target);
    expectations.push({ target, registryPath, policyPath });
  }

  const calls: CallRow[] = [];
  const seenCallIds = new Set<string>();
  for (let i = 0; i < callsArray.length; i += 1) {
    const raw = callsArray[i];
    if (!isRecord(raw)) {
      errors.push(`calls[${i}] must be an object`);
      continue;
    }
    const id = raw['id'];
    const role = raw['role'];
    const target = raw['target'];
    const outcome = raw['outcome'];
    if (!isNonemptyString(id)) {
      errors.push(`calls[${i}].id must be a nonempty string`);
      continue;
    }
    if (role !== 'worker' && role !== 'meta') {
      errors.push(`calls[${i}].role must be 'worker' or 'meta'`);
      continue;
    }
    if (!isNonemptyString(target)) {
      errors.push(`calls[${i}].target must be a nonempty string`);
      continue;
    }
    if (!isNonemptyString(outcome)) {
      errors.push(`calls[${i}].outcome must be a nonempty string`);
      continue;
    }
    if (seenCallIds.has(id)) {
      errors.push(`duplicate call id: ${id}`);
      continue;
    }
    seenCallIds.add(id);
    calls.push({ id, role, target, outcome });
  }

  const callById = new Map<string, CallRow>();
  for (const call of calls) {
    callById.set(call.id, call);
  }

  const requests: RequestRow[] = [];
  const seenRequestCallIds = new Set<string>();
  for (let i = 0; i < requestsArray.length; i += 1) {
    const raw = requestsArray[i];
    if (!isRecord(raw)) {
      errors.push(`requests[${i}] must be an object`);
      continue;
    }
    const callId = raw['callId'];
    const target = raw['target'];
    const paths = raw['paths'];
    const accepted = raw['accepted'];
    if (!isNonemptyString(callId)) {
      errors.push(`requests[${i}].callId must be a nonempty string`);
      continue;
    }
    if (!isNonemptyString(target)) {
      errors.push(`requests[${i}].target must be a nonempty string`);
      continue;
    }
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every(isNonemptyString) || new Set(paths).size !== paths.length) {
      errors.push(`requests[${i}].paths must be an array of nonempty strings`);
      continue;
    }
    if (typeof accepted !== 'boolean') {
      errors.push(`requests[${i}].accepted must be a boolean`);
      continue;
    }
    if (seenRequestCallIds.has(callId)) {
      errors.push(`duplicate request callId: ${callId}`);
      continue;
    }
    seenRequestCallIds.add(callId);
    requests.push({ callId, target, paths: [...paths], accepted });
  }

  const deliveries: DeliveryRow[] = [];
  const seenDeliveries = new Set<string>();
  for (let i = 0; i < deliveriesArray.length; i += 1) {
    const raw = deliveriesArray[i];
    if (!isRecord(raw)) {
      errors.push(`deliveries[${i}] must be an object`);
      continue;
    }
    const callId = raw['callId'];
    const target = raw['target'];
    const path = raw['path'];
    if (!isNonemptyString(callId)) {
      errors.push(`deliveries[${i}].callId must be a nonempty string`);
      continue;
    }
    if (!isNonemptyString(target)) {
      errors.push(`deliveries[${i}].target must be a nonempty string`);
      continue;
    }
    if (!isNonemptyString(path)) {
      errors.push(`deliveries[${i}].path must be a nonempty string`);
      continue;
    }
    const key = JSON.stringify([callId, target, path]);
    if (seenDeliveries.has(key)) {
      errors.push(`duplicate delivery: ${callId} ${target} ${path}`);
      continue;
    }
    seenDeliveries.add(key);
    deliveries.push({ callId, target, path });
  }

  const callIndexById = new Map<string, number>();
  for (const [i, call] of calls.entries()) {
    callIndexById.set(call.id, i);
  }

  for (const request of requests) {
    const call = callById.get(request.callId);
    if (call === undefined) {
      errors.push(`request ${request.callId} references unknown call`);
      continue;
    }
    if (call.role !== 'worker') {
      errors.push(`request ${request.callId} references non-worker call`);
      continue;
    }
    if (call.target !== request.target) {
      errors.push(`request ${request.callId} target mismatch with call`);
      continue;
    }
    if (!seenTargets.has(request.target)) {
      errors.push(`request ${request.callId} references undeclared target ${request.target}`);
    }
  }

  for (const delivery of deliveries) {
    const call = callById.get(delivery.callId);
    if (call === undefined) {
      errors.push(`delivery ${delivery.callId} references unknown call`);
      continue;
    }
    if (call.role !== 'worker') {
      errors.push(`delivery ${delivery.callId} references non-worker call`);
      continue;
    }
    if (call.target !== delivery.target) {
      errors.push(`delivery ${delivery.callId} target mismatch with call`);
      continue;
    }
    if (!seenTargets.has(delivery.target)) {
      errors.push(`delivery ${delivery.callId} references undeclared target ${delivery.target}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, targets };
  }

  for (const expectation of expectations) {
    const target = expectation.target;
    const registryPath = expectation.registryPath;
    const policyPath = expectation.policyPath;

    const firstCommittedIndex = (() => {
      for (const [i, call] of calls.entries()) {
        if (call.role === 'worker' && call.target === target && call.outcome === 'committed') {
          return i;
        }
      }
      return -1;
    })();

    const hasCommittedCall = firstCommittedIndex >= 0;

    let registryDelivered = false;
    let policyDeliveredBeforeCommit = false;
    if (hasCommittedCall) {
      for (const delivery of deliveries) {
        const callIndex = callIndexById.get(delivery.callId);
        if (callIndex === undefined || callIndex > firstCommittedIndex) {
          continue;
        }
        if (delivery.target !== target) {
          continue;
        }
        if (delivery.path === registryPath) {
          registryDelivered = true;
        }
        if (delivery.path === policyPath) {
          policyDeliveredBeforeCommit = true;
        }
      }
    }

    let policyRequested = false;
    const acceptedPolicyRequests: Array<{ callIndex: number; callId: string }> = [];
    if (hasCommittedCall) {
      for (const request of requests) {
        if (!request.accepted) {
          continue;
        }
        if (request.target !== target) {
          continue;
        }
        if (!request.paths.includes(policyPath)) {
          continue;
        }
        const callIndex = callIndexById.get(request.callId);
        if (callIndex === undefined || callIndex > firstCommittedIndex) {
          continue;
        }
        policyRequested = true;
        acceptedPolicyRequests.push({ callIndex, callId: request.callId });
      }
    }

    let sequentialRead = false;
    if (hasCommittedCall) {
      for (const request of acceptedPolicyRequests) {
        let registryBeforeOrAt = false;
        for (const delivery of deliveries) {
          if (delivery.target !== target) {
            continue;
          }
          if (delivery.path !== registryPath) {
            continue;
          }
          const deliveryIndex = callIndexById.get(delivery.callId);
          if (deliveryIndex === undefined) {
            continue;
          }
          if (deliveryIndex <= request.callIndex) {
            registryBeforeOrAt = true;
            break;
          }
        }
        if (!registryBeforeOrAt) {
          continue;
        }
        let policyAfterRequestBeforeCommit = false;
        for (const delivery of deliveries) {
          if (delivery.target !== target) {
            continue;
          }
          if (delivery.path !== policyPath) {
            continue;
          }
          const deliveryIndex = callIndexById.get(delivery.callId);
          if (deliveryIndex === undefined) {
            continue;
          }
          if (deliveryIndex > request.callIndex && deliveryIndex <= firstCommittedIndex) {
            policyAfterRequestBeforeCommit = true;
            break;
          }
        }
        if (policyAfterRequestBeforeCommit) {
          sequentialRead = true;
          break;
        }
      }
    }

    targets.push({
      target,
      registryDelivered,
      policyRequested,
      sequentialRead,
      policyDeliveredBeforeCommit,
    });
  }

  return { valid: true, errors, targets };
}

export default auditReadSelection;
