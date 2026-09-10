export function summarizeTools(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  const calls = [];
  const byId = new Map();
  const byTool = {};
  const responseErrors = new Set();

  for (const event of events) {
    if (!event || typeof event !== 'object' || event.type !== 'tool_call') continue;
    const call = event.tool_call;
    if (!call || typeof call !== 'object') continue;
    const id = call.id;
    const fn = call.function;
    const name = fn && typeof fn === 'object' ? fn.name : undefined;
    if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0) continue;
    if (byId.has(id)) continue;
    const entry = { id, name, responded: false };
    byId.set(id, entry);
    calls.push(entry);
    if (Object.prototype.hasOwnProperty.call(byTool, name)) {
      byTool[name] += 1;
    } else {
      Object.defineProperty(byTool, name, { value: 1, enumerable: true, writable: true, configurable: true });
    }
  }

  for (const event of events) {
    if (!event || typeof event !== 'object' || event.type !== 'tool_call_response') continue;
    const id = event.tool_call_id;
    if (typeof id !== 'string' || !byId.has(id)) continue;
    const entry = byId.get(id);
    entry.responded = true;
    if (event.result && typeof event.result === 'object' && event.result.isError === true) {
      responseErrors.add(id);
    }
  }

  const pending = [];
  const errors = [];
  let responded = 0;
  let structuredOutputDelivered = false;
  for (const entry of calls) {
    if (!entry.responded) pending.push(entry.id);
    else {
      responded += 1;
      if (responseErrors.has(entry.id)) errors.push(entry.id);
      else if (entry.name === '__structured_output__') structuredOutputDelivered = true;
    }
  }

  return { calls: calls.length, byTool, responded, pending, errors, structuredOutputDelivered };
}
