import {createHash} from 'node:crypto';

function h(seed, label) {
  return createHash('sha256').update(seed + '\u0000' + label).digest('hex');
}

function intFrom(hash, start, end) {
  return parseInt(hash.slice(start, end), 16);
}

export function buildReadSelectionFixture({seed, world, documents = 24} = {}) {
  if (typeof seed !== 'string' || seed.length === 0 || seed.length > 256) {
    throw new Error('seed must be a nonempty string of at most 256 characters');
  }
  if (!Number.isSafeInteger(world) || world < 0) {
    throw new Error('world must be a safe integer >= 0');
  }
  if (!Number.isSafeInteger(documents) || documents < 4 || documents > 256) {
    throw new Error('documents must be an integer between 4 and 256');
  }

  const targets = ['a.mjs', 'b.mjs'];
  const files = {};

  for (const target of targets) {
    files[target] = 'export function quote(units){return 0;}';
  }

  const docPaths = [];
  for (let i = 0; i < documents; i++) {
    docPaths.push('docs/' + h(seed, 'doc:' + i).slice(0, 16) + '.json');
  }

  const policies = [];
  for (let i = 0; i < documents; i++) {
    const hash = h(seed, 'policy:' + i);
    const rate = 1 + (intFrom(hash, 0, 8) % 1_000_000);
    const minimum = intFrom(hash, 8, 16) % 1_000_000;
    const cap = minimum + 1 + (intFrom(hash, 16, 24) % 1_000_000);
    policies.push({rate, minimum, cap});
    files[docPaths[i]] = JSON.stringify(policies[i]);
  }

  const registry = {};
  const expectations = [];
  for (let i = 0; i < targets.length; i++) {
    const offset = ((world % documents) + i) % documents;
    const policyPath = docPaths[offset];
    registry[targets[i]] = policyPath;
    expectations.push({
      target: targets[i],
      registryPath: 'registry.json',
      policyPath,
      policy: policies[offset],
    });
  }
  files['registry.json'] = JSON.stringify(registry);

  const catalog = ['registry.json', ...docPaths].sort();

  return {files, targets, catalog, expectations};
}
