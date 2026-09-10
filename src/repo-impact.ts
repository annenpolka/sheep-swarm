import {parseImpactInput} from './repo-impact-input.ts';
export function selectImpactedTargets(input: unknown): {activeTargets: string[]; unaffectedTargets: string[]} {
  const {targets,changedPaths,edges,uncertainConsumers}=parseImpactInput(input);

  const affected = new Set<string>();
  for (const c of changedPaths) {
    affected.add(c);
  }
  for (const u of uncertainConsumers) {
    affected.add(u);
  }

  const consumerByProvider = new Map<string, string[]>();
  for (const edge of edges) {
    const list = consumerByProvider.get(edge.provider);
    if (list === undefined) {
      consumerByProvider.set(edge.provider, [edge.consumer]);
    } else {
      list.push(edge.consumer);
    }
  }

  const queue: string[] = [];
  for (const node of affected) {
    queue.push(node);
  }
  let head = 0;
  while (head < queue.length) {
    const provider = queue[head];
    head += 1;
    if (provider === undefined) {
      continue;
    }
    const consumers = consumerByProvider.get(provider);
    if (consumers === undefined) {
      continue;
    }
    for (const consumer of consumers) {
      if (!affected.has(consumer)) {
        affected.add(consumer);
        queue.push(consumer);
      }
    }
  }

  const activeTargets: string[] = [];
  const unaffectedTargets: string[] = [];
  for (const target of targets) {
    if (affected.has(target)) {
      activeTargets.push(target);
    } else {
      unaffectedTargets.push(target);
    }
  }

  return {activeTargets, unaffectedTargets};
}
