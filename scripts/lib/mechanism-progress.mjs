function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function summarizeProgress(report) {
  if (!isObject(report)) throw new TypeError('report must be an object');
  if (report.family !== 'static' && report.family !== 'semantic' && report.family !== 'staged') {
    throw new TypeError('unknown family');
  }
  if (!Array.isArray(report.calls) || !Array.isArray(report.stages) || !isObject(report.budget)) {
    throw new TypeError('report is missing calls, stages, or budget');
  }

  const expectedStages = report.family === 'staged' ? 3 : 1;
  const calls = report.calls.length;
  let lowerCalls = 0;
  let upperCalls = 0;
  let readCalls = 0;
  const committedTargets = [];
  const seenTargets = new Set();

  for (const call of report.calls) {
    if (!isObject(call)) continue;
    if (call.model === 'gpt-5.6-luna') lowerCalls += 1;
    if (call.model === 'gpt-6-astra') upperCalls += 1;
    if (call.outcome === 'read-requested') readCalls += 1;
    if (call.outcome === 'committed' && Array.isArray(call.writtenIds)) {
      for (const id of call.writtenIds) {
        if (typeof id === 'string' && !seenTargets.has(id)) {
          seenTargets.add(id);
          committedTargets.push(id);
        }
      }
    }
  }

  const stages = report.stages.map((entry) => {
    if (!isObject(entry)) {
      return { stage: undefined, success: false, qualityPass: false, protocolClean: false };
    }
    return {
      stage: entry.stage,
      success: entry.success === true,
      qualityPass: entry.qualityPass === true,
      protocolClean: entry.protocolClean === true,
    };
  });

  const unknownUsageCalls = report.budget.unknownUsageCalls;
  if (!Number.isInteger(unknownUsageCalls) || unknownUsageCalls < 0) {
    throw new TypeError('unknownUsageCalls must be a non-negative integer');
  }
  if (typeof report.terminationReason !== 'string') {
    throw new TypeError('terminationReason must be a string');
  }

  const stagesComplete = stages.length === expectedStages && stages.every((entry, index) =>
    entry.stage === index && entry.success && entry.qualityPass && entry.protocolClean
  );
  const complete = report.success === true &&
    stagesComplete &&
    unknownUsageCalls === 0 &&
    report.budget.activeReservations === 0 &&
    report.budget.exceeded === false &&
    report.terminationReason === 'completed';

  return {
    complete,
    expectedStages,
    stages,
    calls,
    lowerCalls,
    upperCalls,
    readCalls,
    committedTargets,
    unknownUsageCalls,
    terminationReason: report.terminationReason,
  };
}
