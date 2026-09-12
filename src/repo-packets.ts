export interface WorkPacket { id:string; paths:string[]; dependsOn:string[]; oversizeReasons:string[] }
export interface PacketPartition { packets:WorkPacket[]; boundaryEdges:number }
const cmpCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function planPackets(
  nodes: readonly { path: string; dependsOn: readonly string[] }[],
  size: number | "all"
): PacketPartition {
  if (!Array.isArray(nodes)) {
    throw new TypeError("nodes must be an array");
  }
  if (nodes.length === 0) {
    throw new TypeError("nodes must not be empty");
  }
  for (let i = 0; i < nodes.length; i++) {
    if (!Object.hasOwn(nodes, i)) {
      throw new TypeError("nodes must not be sparse");
    }
  }

  let capacity: number;
  if (size === "all") {
    capacity = Infinity;
  } else if (typeof size === "number" && Number.isSafeInteger(size) && size > 0) {
    capacity = size;
  } else {
    throw new TypeError('size must be a positive safe integer or "all"');
  }

  const rawDeps = new Map<string, string[]>();
  const paths: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const entry = nodes[i] as { path?: unknown; dependsOn?: unknown };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("malformed node entry");
    }
    const p = entry.path;
    if (typeof p !== "string" || p.trim() === "") {
      throw new TypeError("node path must be a non-blank string");
    }
    if (rawDeps.has(p)) {
      throw new TypeError("duplicate node path: " + p);
    }
    const depsRaw = entry.dependsOn;
    if (!Array.isArray(depsRaw)) {
      throw new TypeError("node dependsOn must be an array");
    }
    for (let j = 0; j < depsRaw.length; j++) {
      if (!Object.hasOwn(depsRaw, j)) {
        throw new TypeError("node dependsOn must not be sparse");
      }
    }
    const deps: string[] = [];
    for (const d of depsRaw) {
      if (typeof d !== "string" || d.trim() === "") {
        throw new TypeError("dependency must be a non-blank string");
      }
      deps.push(d);
    }
    rawDeps.set(p, deps);
    paths.push(p);
  }

  for (const deps of rawDeps.values()) {
    for (const d of deps) {
      if (!rawDeps.has(d)) {
        throw new TypeError("unknown dependency: " + d);
      }
    }
  }

  const sortedPaths = paths.slice().sort(cmpCodepoint);
  const depsOf = new Map<string, string[]>();
  for (const p of sortedPaths) {
    const uniq = Array.from(new Set(rawDeps.get(p)!)).sort(cmpCodepoint);
    depsOf.set(p, uniq);
  }

  const n = sortedPaths.length;
  const pathIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    pathIndex.set(sortedPaths[i]!, i);
  }
  const adj: number[][] = sortedPaths.map((p) => depsOf.get(p)!.map((d) => pathIndex.get(d)!));

  // Iterative Tarjan strongly connected components (provider/consumer edges).
  const idxArr = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const sccOfNode = new Array<number>(n).fill(-1);
  const sccList: number[][] = [];
  let counter = 0;

  for (let s = 0; s < n; s++) {
    if (idxArr[s]! !== -1) continue;
    const work: { v: number; i: number }[] = [{ v: s, i: 0 }];
    idxArr[s]! = counter;
    low[s]! = counter;
    counter++;
    stack.push(s);
    onStack[s]! = true;
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.v;
      if (frame.i < adj[v]!.length) {
        const w = adj[v]![frame.i]!;
        frame.i++;
        if (idxArr[w]! === -1) {
          idxArr[w]! = counter;
          low[w]! = counter;
          counter++;
          stack.push(w);
          onStack[w]! = true;
          work.push({ v: w, i: 0 });
        } else if (onStack[w]!) {
          if (idxArr[w]! < low[v]!) low[v]! = idxArr[w]!;
        }
      } else {
        work.pop();
        if (low[v]! === idxArr[v]!) {
          const comp: number[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack[w]! = false;
            sccOfNode[w]! = sccList.length;
            comp.push(w);
            if (w === v) break;
          }
          sccList.push(comp);
        }
        if (work.length > 0) {
          const parent = work[work.length - 1]!.v;
          if (low[v]! < low[parent]!) low[parent]! = low[v]!;
        }
      }
    }
  }

  const numScc = sccList.length;
  const sccFirstPath: string[] = [];
  const sccSize: number[] = [];
  for (const comp of sccList) {
    let first = sortedPaths[comp[0]!]!;
    for (const u of comp) {
      const p = sortedPaths[u]!;
      if (p < first) first = p;
    }
    sccFirstPath.push(first);
    sccSize.push(comp.length);
  }

  const providerSccs: Set<number>[] = [];
  for (let a = 0; a < numScc; a++) providerSccs.push(new Set<number>());
  for (let u = 0; u < n; u++) {
    const a = sccOfNode[u]!;
    for (const d of adj[u]!) {
      const b = sccOfNode[d]!;
      if (b !== a) providerSccs[a]!.add(b);
    }
  }

  const emitted = new Array<boolean>(numScc).fill(false);
  const packetSccs: number[][] = [];
  let current: number[] = [];
  let currentSccSet = new Set<number>();
  let currentNodes = new Set<string>();
  let currentSize = 0;

  const adjacencyToCurrent = (a: number): number => {
    let count = 0;
    for (const u of sccList[a]!) {
      for (const d of adj[u]!) {
        if (currentNodes.has(sortedPaths[d]!)) count++;
      }
    }
    for (const pv of currentNodes) {
      const vi = pathIndex.get(pv)!;
      for (const d of adj[vi]!) {
        if (sccOfNode[d]! === a) count++;
      }
    }
    return count;
  };

  for (;;) {
    let remaining = 0;
    for (let i = 0; i < numScc; i++) {
      if (!emitted[i]!) remaining++;
    }
    if (remaining === 0) break;

    let best = -1;
    let bestAdj = -1;
    for (let a = 0; a < numScc; a++) {
      if (emitted[a]! || currentSccSet.has(a)) continue;
      let ready = true;
      for (const b of providerSccs[a]!) {
        if (!emitted[b]! && !currentSccSet.has(b)) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      if (current.length > 0 && currentSize + sccSize[a]! > capacity) continue;
      const ad = current.length > 0 ? adjacencyToCurrent(a) : 0;
      if (
        ad > bestAdj ||
        (ad === bestAdj && (best === -1 || cmpCodepoint(sccFirstPath[a]!, sccFirstPath[best]!) < 0))
      ) {
        best = a;
        bestAdj = ad;
      }
    }

    if (best === -1) {
      if (current.length === 0) break;
      for (const a of current) emitted[a]! = true;
      packetSccs.push(current);
      current = [];
      currentSccSet = new Set<number>();
      currentNodes = new Set<string>();
      currentSize = 0;
      continue;
    }

    current.push(best);
    currentSccSet.add(best);
    for (const u of sccList[best]!) currentNodes.add(sortedPaths[u]!);
    currentSize += sccSize[best]!;
  }
  if (current.length > 0) {
    for (const a of current) emitted[a]! = true;
    packetSccs.push(current);
  }

  const nodePacket = new Map<string, number>();
  for (let pi = 0; pi < packetSccs.length; pi++) {
    for (const a of packetSccs[pi]!) {
      for (const u of sccList[a]!) nodePacket.set(sortedPaths[u]!, pi);
    }
  }

  const packets = packetSccs.map((sccs, pi) => {
    const pktPaths: string[] = [];
    for (const a of sccs) {
      for (const u of sccList[a]!) pktPaths.push(sortedPaths[u]!);
    }
    pktPaths.sort(cmpCodepoint);
    const oversizeReasons: string[] = [];
    if (pktPaths.length > capacity) {
      oversizeReasons.push("strongly-connected-component");
    }
    const depSet = new Set<string>();
    for (const p of pktPaths) {
      for (const d of depsOf.get(p)!) {
        const dp = nodePacket.get(d)!;
        if (dp !== pi) depSet.add("packet-" + (dp + 1));
      }
    }
    const dependsOn = Array.from(depSet).sort(cmpCodepoint);
    return { id: "packet-" + (pi + 1), paths: pktPaths, dependsOn, oversizeReasons };
  });

  let boundaryEdges = 0;
  for (const p of sortedPaths) {
    const pp = nodePacket.get(p)!;
    for (const d of depsOf.get(p)!) {
      const dp = nodePacket.get(d)!;
      if (dp !== pp) boundaryEdges++;
    }
  }

  return { packets, boundaryEdges };
}
