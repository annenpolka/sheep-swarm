export interface RecoverySelection {
  readonly target: string;
  readonly targets: readonly string[];
  readonly edges: readonly {consumer: string; provider: string}[];
  readonly delivered: readonly string[];
  readonly eligible: readonly string[];
  readonly rechecked: readonly string[];
  readonly limit: number;
}

export function selectUpstreamRechecks(_options: RecoverySelection): string[] {
  const { target, targets, edges, delivered, eligible, rechecked, limit } = _options;

  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('limit must be a nonnegative safe integer');
  }

  const targetSet = new Set<string>(targets);
  const deliveredSet = new Set<string>(delivered);
  const eligibleSet = new Set<string>(eligible);
  const recheckedSet = new Set<string>(rechecked);

  // Build adjacency: consumer -> lexicographically sorted providers.
  // New arrays only; inputs are never mutated.
  const providersByConsumer = new Map<string, string[]>();
  for (const edge of edges) {
    const list = providersByConsumer.get(edge.consumer);
    if (list === undefined) {
      providersByConsumer.set(edge.consumer, [edge.provider]);
    } else {
      list.push(edge.provider);
    }
  }
  for (const list of providersByConsumer.values()) {
    list.sort();
  }

  // Iterative depth-first postorder traversal from target, following
  // consumer -> provider. Sorted providers give deterministic ordering, and
  // visited prevents cycles and duplicate visits. Traversal continues through
  // nodes even if they are excluded from output.
  const visited = new Set<string>();
  const postorder: string[] = [];

  interface Frame {
    node: string;
    children: string[];
    index: number;
  }

  const stack: Frame[] = [];
  visited.add(target);
  stack.push({ node: target, children: providersByConsumer.get(target) ?? [], index: 0 });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index < frame.children.length) {
      const child = frame.children[frame.index]!;
      frame.index += 1;
      if (!visited.has(child)) {
        visited.add(child);
        stack.push({ node: child, children: providersByConsumer.get(child) ?? [], index: 0 });
      }
    } else {
      stack.pop();
      postorder.push(frame.node);
    }
  }

  // Emit nodes present in ALL of targets, delivered and eligible, absent from
  // rechecked, excluding the target itself, stopping once limit is reached.
  const result: string[] = [];
  for (const node of postorder) {
    if (result.length >= limit) break;
    if (node === target) continue;
    if (!targetSet.has(node)) continue;
    if (!deliveredSet.has(node)) continue;
    if (!eligibleSet.has(node)) continue;
    if (recheckedSet.has(node)) continue;
    result.push(node);
  }

  return result;
}
