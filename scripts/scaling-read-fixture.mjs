import {createHash} from 'node:crypto';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function hash(seed, label) {
  return createHash('sha256').update(seed + '\u0000' + label).digest('hex');
}

function intFrom(hex, start, end) {
  return parseInt(hex.slice(start, end), 16);
}

function pad(index, width) {
  return String(index).padStart(width, '0');
}

export function buildScalingReadFixture({seed, world, targets = 16, documents = 64} = {}) {
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > 256) {
    throw new Error('seed must be a nonempty string of at most 256 characters');
  }
  if (!Number.isSafeInteger(world) || world < 0) {
    throw new Error('world must be a safe integer >= 0');
  }
  if (!Number.isSafeInteger(targets) || targets < 1 || targets > 64) {
    throw new Error('targets must be an integer between 1 and 64');
  }
  if (!Number.isSafeInteger(documents) || documents < 4 || documents > 256) {
    throw new Error('documents must be an integer between 4 and 256');
  }
  if (documents < targets) {
    throw new Error('documents must be >= targets');
  }

  const width = Math.max(2, String(targets - 1).length);
  const targetPaths = [];
  const files = {};
  for (let i = 0; i < targets; i++) {
    const path = 'modules/unit-' + pad(i, width) + '.ts';
    targetPaths.push(path);
    files[path] = 'export function quote(units: unknown): number | null {return 0;}';
  }

  const docPaths = [];
  const policies = [];
  for (let i = 0; i < documents; i++) {
    const docPath = 'docs/' + hash(seed, 'doc:' + i).slice(0, 16) + '.json';
    docPaths.push(docPath);

    const policyHex = hash(seed, 'policy:' + i);
    const rate = 1 + (intFrom(policyHex, 0, 8) % 1_000_000);
    const minimum = intFrom(policyHex, 8, 16) % 1_000_000;
    const capRoom = Math.floor((MAX_SAFE - minimum) / rate);
    const span = Math.max(1, Math.min(1_000_000, capRoom - 1));
    const cap = minimum + 1 + (intFrom(policyHex, 16, 24) % span);
    const policy = {rate, minimum, cap};
    policies.push(policy);
    files[docPath] = JSON.stringify(policy);
  }

  const registry = {};
  const expectations = [];
  for (let i = 0; i < targets; i++) {
    const offset = (world % documents + i) % documents;
    const policyPath = docPaths[offset];
    registry[targetPaths[i]] = policyPath;
    expectations.push({
      target: targetPaths[i],
      registryPath: 'registry.json',
      policyPath,
      policy: policies[offset],
    });
  }
  files['registry.json'] = JSON.stringify(registry);

  const catalog = ['registry.json', ...docPaths].sort();

  return {files, targets: targetPaths, catalog, expectations};
}
