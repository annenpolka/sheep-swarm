import {findKey, fnBody, keepInputs, lit, mulberry32, mustReplace, N, raw, ri, seedDefect, sparseJoinSinks, sparsePlan} from '../common.ts';
import type {Case, Family, MutantSpec, NodeOut} from '../common.ts';

/** Caller-added anchors for the stated plain-object contract. */
function plainChecks(fn: string, record: Record<string, unknown>, expected: unknown, arrayInput = false): string {
  const argument = arrayInput ? '[value]' : 'value';
  return raw(
    `{const value=Object.assign(new Date(0),${lit(record)});assert.equal(m.${fn}(${argument}),null);}`,
    `{const value=Object.create(${lit(record)});assert.equal(m.${fn}(${argument}),null);}`,
    `{const value=Object.assign(Object.create(null),${lit(record)});assert.deepEqual(m.${fn}(${argument}),${lit(expected)});}`,
  );
}

/* ------------------------------------------------------------------ */
/* intervals: inclusive integer interval merging with a gap rule       */
/* ------------------------------------------------------------------ */

const intervals: Family = {
  name: 'intervals',
  title: 'integer interval merge with gap bridging',
  shapes: ['independent', 'fanin', 'sparse'],
  build(variant, topology, count) {
    const r = mulberry32(0x1e7 + variant * 7919);
    const lo = ri(r, -20, 0);
    const hi = lo + ri(r, 15, 60);
    const gap = variant % 3;
    const drop = variant % 2 === 1;

    const sCheck = (p: unknown): [number, number] | null => {
      if (!Array.isArray(p) || p.length !== 2) return null;
      const [s, e] = p;
      if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
      if ((s as number) < lo || (e as number) > hi || (s as number) > (e as number)) return null;
      return [s as number, e as number];
    };
    // oracle formulation: coverage set + gap-bridged runs, then a two-stream
    // fold of kept zero-length intervals (different code path than reference).
    const sMerge = (l: unknown): [number, number][] | null => {
      if (!Array.isArray(l)) return null;
      const covered = new Set<number>();
      const zeros: number[] = [];
      for (const p of l) {
        const c = sCheck(p);
        if (c === null) return null;
        if (c[0] === c[1]) {
          if (!drop) zeros.push(c[0]);
          continue;
        }
        for (let x = c[0]; x < c[1]; x++) covered.add(x);
      }
      const runs: [number, number][] = [];
      let cur: [number, number] | null = null;
      for (let x = lo; x < hi; x++) {
        if (!covered.has(x)) continue;
        if (cur === null) cur = [x, x + 1];
        else if (x <= cur[1] + gap) cur[1] = Math.max(cur[1], x + 1);
        else {
          runs.push(cur);
          cur = [x, x + 1];
        }
      }
      if (cur !== null) runs.push(cur);
      const out: [number, number][] = [];
      const take = (iv: [number, number]) => {
        const last = out[out.length - 1];
        if (last !== undefined && iv[0] <= last[1] + gap) last[1] = Math.max(last[1], iv[1]);
        else out.push([iv[0], iv[1]]);
      };
      let ix = 0;
      for (const z of [...zeros].sort((a, b) => a - b)) {
        while (ix < runs.length && runs[ix]![0] <= z) take(runs[ix++]!);
        take([z, z]);
      }
      while (ix < runs.length) take(runs[ix++]!);
      return out;
    };
    const sMeasure = (l: unknown): {count: number; covered: number} | null => {
      const m = sMerge(l);
      if (m === null) return null;
      let covered = 0;
      for (const [s, e] of m) covered += e - s;
      return {count: m.length, covered};
    };
    const partBounds = Array.from({length: count}, (_, i): [number, number] => {
      const plo = lo + i * 4;
      return [plo, plo + ri(r, 8, 25)];
    });
    const sPart = (i: number, l: unknown): [number, number][] | null => {
      const [plo, phi] = partBounds[i]!;
      if (!Array.isArray(l)) return null;
      const out: [number, number][] = [];
      for (const p of l) {
        if (!Array.isArray(p) || p.length !== 2) return null;
        const [s, e] = p;
        if (!Number.isInteger(s) || !Number.isInteger(e) || (s as number) < plo || (e as number) > phi || (s as number) > (e as number)) return null;
        if ((s as number) === (e as number)) continue;
        out.push([s as number, e as number]);
      }
      out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return out;
    };
    const sUnion = (v: unknown): [number, number][] | null => {
      if (!Array.isArray(v) || v.length !== count - 1) return null;
      const all: [number, number][] = [];
      for (let j = 0; j < count - 1; j++) {
        const p = sPart(j, v[j]);
        if (p === null) return null;
        all.push(...p);
      }
      all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const out: [number, number][] = [];
      for (const [s, e] of all) {
        const last = out[out.length - 1];
        if (last !== undefined && s <= last[1] + gap) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
      }
      return out;
    };
    const spanDeps = (pairs: number): number[] => sparseJoinSinks(pairs);
    const sSpan = (v: unknown, nFeeds: number): {count: number; covered: number} | null => {
      if (!Array.isArray(v) || v.length !== nFeeds) return null;
      const all: [number, number][] = [];
      for (const sub of v) {
        const m = sMerge(sub);
        if (m === null) return null;
        all.push(...m);
      }
      all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const out: [number, number][] = [];
      for (const [s, e] of all) {
        const last = out[out.length - 1];
        if (last !== undefined && s <= last[1] + gap) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
      }
      let covered = 0;
      for (const [s, e] of out) covered += e - s;
      return {count: out.length, covered};
    };


    const mid = Math.floor((lo + hi) / 2);
    const gapProbe: [number, number][] = [
      [lo, lo + 3],
      [lo + 3 + gap, lo + 6 + gap],
    ];

    const sampleList: [number, number][] = [
      [mid + 1, mid + 5],
      [lo, lo + 2],
      [mid + 4, mid + 9],
      [mid + 20, mid + 25],
    ];

    const rulePub = raw(`assert.equal(m.lo,${lo});`, `assert.equal(m.hi,${hi});`, `assert.equal(m.gap,${gap});`, `assert.equal(m.drop,${drop});`);
    const ruleHid = raw(
      `assert.equal(m.lo,${lo});`,
      `assert.equal(m.hi,${hi});`,
      `assert.equal(m.gap,${gap});`,
      `assert.equal(m.drop,${drop});`,
      `assert.equal(Object.keys(m).sort().join(','),'drop,gap,hi,lo');`,
    );
    const checkPub: Case[] = [
      [[[lo, hi]], [lo, hi]],
      [[[hi, lo]], null],
      [[[lo - 1, lo]], null],
      [[[lo, hi + 1]], null],
      [[[1.5, 3]], null],
      [[5], null],
    ];
    const checkHid: Case[] = [
      [[null], null], [[{}], null], [[[]], null], [[[lo]], null], [[[lo, hi, lo]], null],
      [[[mid, mid]], [mid, mid]],
      [[['2', 4]], null], [[[lo + 1, lo + 1]], [lo + 1, lo + 1]],
      [[[Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]], null],
      [[[[lo, hi]]], null],
    ];
    const mergePub: Case[] = [
      [[gapProbe], sMerge(gapProbe)],
      [[sampleList], sMerge(sampleList)],
      [[[]], []],
      [[[[lo, hi + 1]]], null],
    ];
    const mergeHid: Case[] = [
      [[[[lo + 1, lo + 8], [lo + 3, lo + 4]]], sMerge([[lo + 1, lo + 8], [lo + 3, lo + 4]])],
      [[null], null], [[{}], null], [[5], null],
      [[[[mid, mid]]], sMerge([[mid, mid]])],
      [[[[mid, mid], [mid + 1, mid + 1]]], sMerge([[mid, mid], [mid + 1, mid + 1]])],
      [[[[hi, hi]]], sMerge([[hi, hi]])],
      [[[[lo + 1, lo + 4], [lo + 4 + gap + 1, lo + 8 + gap]]], sMerge([[lo + 1, lo + 4], [lo + 5 + gap, lo + 8 + gap]])],
      [[[[mid + 10, mid + 2]]], null],
      [[[[lo, hi], [lo, hi]]], sMerge([[lo, hi], [lo, hi]])],
      [[[[lo, lo], [hi, hi]]], sMerge([[lo, lo], [hi, hi]])],
      [[[[mid - 1, mid + 1], [mid + 1, mid + 3]]], sMerge([[mid - 1, mid + 1], [mid + 1, mid + 3]])],
      [[sampleList.concat([[lo + 3, lo + 3]])], sMerge(sampleList.concat([[lo + 3, lo + 3]]))],
    ];
    const mergeHidExtra = keepInputs([[sampleList]]);
    const measurePub: Case[] = [
      [[sampleList], sMeasure(sampleList)],
      [[[]], {count: 0, covered: 0}],
      [[gapProbe], sMeasure(gapProbe)],
    ];
    const measureHid: Case[] = [
      [[null], null],
      [[[[mid, mid]]], sMeasure([[mid, mid]])],
      [[[[lo, hi]]], sMeasure([[lo, hi]])],
      [[[[lo, lo + 2], [hi - 2, hi]]], sMeasure([[lo, lo + 2], [hi - 2, hi]])],
      [[[[lo - 1, lo]]], null],
      [[[[lo + 2, lo + 5], [lo + 5 + gap, lo + 9 + gap]]], sMeasure([[lo + 2, lo + 5], [lo + 5 + gap, lo + 9 + gap]])],
    ];
    const partIn = (i: number): [number, number][] => {
      const [plo, phi] = partBounds[i]!;
      return [
        [plo, Math.min(phi, plo + 3)],
        [Math.min(phi, plo + 4), Math.min(phi, plo + 6)],
      ];
    };
    const partPub = (i: number): Case[] => [
      [[partIn(i)], sPart(i, partIn(i))],
      [[[]], []],
      [[[[partBounds[i]![0], partBounds[i]![0]]]], []],
    ];
    const partHid = (i: number): Case[] => {
      const [plo, phi] = partBounds[i]!;
      return [
        [[[[plo, phi], [plo + 1, plo + 2]]], sPart(i, [[plo, phi], [plo + 1, plo + 2]])],
        [[[[plo - 1, plo]]], null],
        [[[[plo, phi + 1]]], null],
        [[null], null],
        [[[[plo, plo], [plo, plo]]], []],
        [[[[phi, plo]]], null],
      ];
    };
    const unionIn: unknown[][] = Array.from({length: count - 1}, (_, j) => partIn(j));
    const joinPub: Case[] = [
      [[unionIn], sUnion(unionIn)],
      [[Array.from({length: count - 1}, () => [])], sUnion(Array.from({length: count - 1}, () => []))],
    ];
    const gapFeeds = Array.from({length: count - 1}, (_, j) => j === 0 ? [[partBounds[0]![0], partBounds[0]![0] + 1], [partBounds[0]![0] + gap + 2, partBounds[0]![0] + gap + 4]] : []);
    const joinHid: Case[] = [
      [[gapFeeds], sUnion(gapFeeds)],
      [[null], null],
      [[[]], null],
      [[unionIn.slice(1)], null],
      [[Array.from({length: count - 1}, (_, j) => [[partBounds[j]![0], partBounds[j]![1]]])], sUnion(Array.from({length: count - 1}, (_, j) => [[partBounds[j]![0], partBounds[j]![1]]]))],
    ];
    const probePub = (i: number): Case[] => [
      [[[partBounds[i]![0], partBounds[i]![1]]], [partBounds[i]![0], partBounds[i]![1]]],
      [[[partBounds[i]![1], partBounds[i]![0]]], null],
    ];
    const probeHid = (i: number): Case[] => {
      const [plo, phi] = partBounds[i]!;
      return [
        [[[plo - 1, plo]], null],
        [[[plo, phi + 1]], null],
        [[[plo, plo]], [plo, plo]],
        [[5], null],
        [[null], null],
      ];
    };
    const nSpanFeeds = spanDeps(sparsePlan(count).pairs).length;
    const spanIn: [number, number][][] = Array.from({length: nSpanFeeds}, () => sampleList);
    const spanAug = spanIn.map((sub, j) => (j === 0 ? sub.concat([[lo, lo]]) : sub));
    const spanPub: Case[] = [
      [[spanIn], sSpan(spanIn, nSpanFeeds)],
      [[spanIn.map(() => [])], sSpan(spanIn.map(() => []), nSpanFeeds)],
    ];
    const lastFeed = Array.from({length: nSpanFeeds}, (_, j) => j === nSpanFeeds - 1 ? [[lo, lo + 2]] : []);
    const spanHid: Case[] = [
      [[lastFeed], sSpan(lastFeed, nSpanFeeds)],
      [[null], null],
      [[[]], null],
      [[spanIn.slice(1)], null],
      [[spanAug], sSpan(spanAug, nSpanFeeds)],
      [[spanIn.concat([[]])], null],
    ];

    const ruleText = `Export exactly four constants: lo=${lo}, hi=${hi}, gap=${gap}, drop=${drop}. Intervals are integer pairs [s,e] with lo<=s<=e<=hi. Two consecutive intervals [a,b],[c,d] merge when c <= b+gap. When drop is true, zero-length intervals are discarded before merging; when false they participate like any interval. Export nothing else.`;
    const checkText = `Import {lo,hi} from the rules module listed in dependsOn. Export function checkInterval(p). Return [s,e] when p is an array of exactly two safe integers with lo<=s<=e<=hi, otherwise null.`;
    const mergeText = `Import {checkInterval} from the check module and {gap,drop} from the rules module listed in dependsOn. Export function mergeIntervals(list). list must be an array of intervals accepted by checkInterval. When drop is true discard zero-length intervals first. Sort by start then end and merge consecutively whenever next.start <= current.end + gap. Return the merged array or null on invalid input. Never mutate the input.`;
    const measureText = `Import {mergeIntervals} from the merge module listed in dependsOn. Export function measureIntervals(list). Return null when mergeIntervals rejects list, otherwise {count, covered}: the merged interval count and the total covered length (sum of end-start over merged intervals).`;
    const partText = (i: number, plo: number, phi: number) =>
      `Self-contained module: do not import anything. Export function normPart${i}(list). Validate every element as an integer interval [s,e] with ${plo}<=s<=e<=${phi}, return null on any invalid element or non-array input. Discard zero-length elements, sort the rest by start then end, and return the sorted list.`;
    const joinText = `Import every sibling listed in dependsOn (normPart0..normPart${count - 2}). Export function unionAll(lists). lists must be an array of exactly ${count - 1} arrays; element j is normalized by normPart${'{'}j${'}'}. Concatenate all normalized intervals and merge them with the bridging rule next.start <= current.end + ${gap}. Return the merged list or null when any part rejects.`;
    const probeText = (i: number, plo: number, phi: number) =>
      `Self-contained module: do not import anything. Export function probe${i}(p). Return [s,e] when p is an array of exactly two safe integers with ${plo}<=s<=e<=${phi}, otherwise null.`;
    const spanText = (deps: readonly string[]) =>
      `Import {gap} from the rules module and ${deps.map((d, k) => `{mergeIntervals as m${k}} from './${d}.mjs'`).join(', ')}. Export function spanAll(lists). lists must be an array of exactly ${deps.length} arrays; element k is merged by mergeIntervals from ${deps.map((d) => `'./${d}.mjs'`).join(', ')} in order. Concatenate all merged intervals, merge again under the same gap rule, and return {count, covered}: merged count and total covered length. Return null on any rejection.`;

    const nodeRule = (key: string): NodeOut =>
      N({
        key,
        role: 'rule',
        deps: [],
        instructions: ruleText,
        reference: `export const lo=${lo};\nexport const hi=${hi};\nexport const gap=${gap};\nexport const drop=${drop};\n`,
        publicBody: rulePub,
        holdBody: ruleHid,
        mutants: [
          {
            id: 'gap-plus',
            description: 'rules export gap+1, bridging one extra position',
            content: `export const lo=${lo};\nexport const hi=${hi};\nexport const gap=${gap + 1};\nexport const drop=${drop};\n`,
            publicPass: false,
          },
          {
            id: 'hi-minus',
            description: 'rules export hi-1, rejecting the top boundary',
            content: `export const lo=${lo};\nexport const hi=${hi - 1};\nexport const gap=${gap};\nexport const drop=${drop};\n`,
            publicPass: false,
          },
        ],
      });
    const nodeCheck = (key: string, rule: string): NodeOut => {
      const ref = `import {lo,hi} from './${rule}.mjs';
export function checkInterval(p){
 if(!Array.isArray(p)||p.length!==2)return null;
 const s=p[0],e=p[1];
 if(!Number.isInteger(s)||!Number.isInteger(e))return null;
 if(s<lo||e>hi||s>e)return null;
 return [s,e];
}
`;
      return N({
        key,
        role: 'check',
        deps: [rule],
        instructions: checkText,
        reference: ref,
        publicBody: fnBody('checkInterval', checkPub),
        holdBody: fnBody('checkInterval', checkHid),
        mutants: [
          {
            id: 'hi-open',
            description: 'check rejects intervals ending on hi',
            content: mustReplace(ref, `e>hi`, `e>=hi`),
            publicPass: false,
          },
          {
            id: 'pair-swap',
            description: 'check returns the interval endpoints swapped',
            content: mustReplace(ref, `return [s,e];`, `return [e,s];`),
            publicPass: false,
          },
        ],
      });
    };
    const nodeMerge = (key: string, check: string, rule: string): NodeOut => {
      const ref = `import {checkInterval} from './${check}.mjs';
import {gap,drop} from './${rule}.mjs';
export function mergeIntervals(list){
 if(!Array.isArray(list))return null;
 const iv=[];
 for(const p of list){
  const c=checkInterval(p);
  if(c===null)return null;
  if(drop&&c[0]===c[1])continue;
  iv.push(c);
 }
 iv.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const out=[];
 for(const ivp of iv){
  const last=out[out.length-1];
  if(last!==undefined&&ivp[0]<=last[1]+gap)last[1]=Math.max(last[1],ivp[1]);
  else out.push(ivp);
 }
 return out;
}
`;
      const mutants: MutantSpec[] = [
        {
          id: 'sort-end',
          description: 'merge sorts by end before start',
          content: mustReplace(ref, `iv.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);`, `iv.sort((a,b)=>a[1]-b[1]||a[0]-b[0]);`),
          publicPass: true,
        },
        drop
          ? {
              id: 'drop-keep',
              description: 'merge keeps zero-length intervals',
              content: mustReplace(ref, `if(drop&&c[0]===c[1])continue;`, ``),
              publicPass: true,
            }
          : {
              id: 'keep-drop',
              description: 'merge drops zero-length intervals',
              content: mustReplace(ref, `iv.push(c);`, `if(c[0]!==c[1])iv.push(c);`),
              publicPass: true,
            },
      ];
      return N({
        key,
        role: 'merge',
        deps: [check, rule],
        instructions: mergeText,
        reference: ref,
        publicBody: fnBody('mergeIntervals', mergePub),
        holdBody: fnBody('mergeIntervals', mergeHid, mergeHidExtra),
        mutants,
      });
    };
    const nodeMeasure = (key: string, merge: string): NodeOut => {
      const ref = `import {mergeIntervals} from './${merge}.mjs';
export function measureIntervals(list){
 const m=mergeIntervals(list);
 if(m===null)return null;
 let covered=0;
 for(const iv of m)covered+=iv[1]-iv[0];
 return {count:m.length,covered};
}
`;
      return N({
        key,
        role: 'measure',
        deps: [merge],
        instructions: measureText,
        reference: ref,
        publicBody: fnBody('measureIntervals', measurePub),
        holdBody: fnBody('measureIntervals', measureHid),
        mutants: [
          {
            id: 'count-plus',
            description: 'measure reports one interval too many',
            content: mustReplace(ref, `count:m.length`, `count:m.length+1`),
            publicPass: false,
          },
          {
            id: 'covered-point',
            description: 'measure counts both endpoints of every interval',
            content: mustReplace(ref, `covered+=iv[1]-iv[0]`, `covered+=iv[1]-iv[0]+1`),
            publicPass: false,
          },
        ],
      });
    };
    const nodePart = (key: string, i: number): NodeOut => {
      const [plo, phi] = partBounds[i]!;
      const ref = `const lo=${plo},hi=${phi};
export function normPart${i}(list){
 if(!Array.isArray(list))return null;
 const out=[];
 for(const p of list){
  if(!Array.isArray(p)||p.length!==2)return null;
  const s=p[0],e=p[1];
  if(!Number.isInteger(s)||!Number.isInteger(e)||s<lo||e>hi||s>e)return null;
  if(s!==e)out.push([s,e]);
 }
 out.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 return out;
}
`;
      return N({
        key,
        role: 'part',
        deps: [],
        instructions: partText(i, plo, phi),
        reference: ref,
        publicBody: fnBody(`normPart${i}`, partPub(i)),
        holdBody: fnBody(`normPart${i}`, partHid(i)),
        mutants: [
          {
            id: 'part-keep',
            description: 'part keeps zero-length intervals',
            content: mustReplace(ref, `if(s!==e)out.push([s,e]);`, `out.push([s,e]);`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeJoin = (key: string, parts: readonly string[]): NodeOut => {
      const imports = parts.map((p, j) => `import {normPart${j}} from './${p}.mjs';`).join('\n');
      const ref = `${imports}
const PARTS=[${parts.map((_, j) => `normPart${j}`).join(',')}];
const gap=${gap};
export function unionAll(lists){
 if(!Array.isArray(lists)||lists.length!==PARTS.length)return null;
 const all=[];
 for(let j=0;j<PARTS.length;j++){
  const p=PARTS[j](lists[j]);
  if(p===null)return null;
  for(const iv of p)all.push(iv);
 }
 all.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const out=[];
 for(const iv of all){
  const last=out[out.length-1];
  if(last!==undefined&&iv[0]<=last[1]+gap)last[1]=Math.max(last[1],iv[1]);
  else out.push(iv);
 }
 return out;
}
`;
      return N({
        key,
        role: 'join',
        deps: parts,
        instructions: joinText,
        reference: ref,
        publicBody: fnBody('unionAll', joinPub),
        holdBody: fnBody('unionAll', joinHid),
        mutants: [
          {
            id: 'join-strict',
            description: 'union uses strict < for the gap bridge',
            content: mustReplace(ref, `iv[0]<=last[1]+gap`, `iv[0]<last[1]+gap`),
            publicPass: false,
          },
        ],
      });
    };
    const nodeProbe = (key: string, i: number): NodeOut => {
      const [plo, phi] = partBounds[i]!;
      const ref = `const lo=${plo},hi=${phi};
export function probe${i}(p){
 if(!Array.isArray(p)||p.length!==2)return null;
 const s=p[0],e=p[1];
 if(!Number.isInteger(s)||!Number.isInteger(e)||s<lo||e>hi||s>e)return null;
 return [s,e];
}
`;
      return N({
        key,
        role: 'probe',
        deps: [],
        instructions: probeText(i, plo, phi),
        reference: ref,
        publicBody: fnBody(`probe${i}`, probePub(i)),
        holdBody: fnBody(`probe${i}`, probeHid(i)),
        mutants: [
          {
            id: 'probe-open',
            description: 'probe rejects the lower bound',
            content: mustReplace(ref, `s<lo`, `s<=lo`),
            publicPass: false,
          },
        ],
      });
    };
    const nodeSpan = (key: string, rule: string, merges: readonly string[]): NodeOut => {
      const imports = [`import {gap} from './${rule}.mjs';`, ...merges.map((m2, k) => `import {mergeIntervals as m${k}} from './${m2}.mjs';`)].join('\n');
      const ref = `${imports}
const MERGES=[${merges.map((_, k) => `m${k}`).join(',')}];
export function spanAll(lists){
 if(!Array.isArray(lists)||lists.length!==MERGES.length)return null;
 const all=[];
 for(let k=0;k<MERGES.length;k++){
  const m=MERGES[k](lists[k]);
  if(m===null)return null;
  for(const iv of m)all.push(iv);
 }
 all.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const out=[];
 for(const iv of all){
  const last=out[out.length-1];
  if(last!==undefined&&iv[0]<=last[1]+gap)last[1]=Math.max(last[1],iv[1]);
  else out.push([iv[0],iv[1]]);
 }
 let covered=0;
 for(const iv of out)covered+=iv[1]-iv[0];
 return {count:out.length,covered};
}
`;
      return N({
        key,
        role: 'span',
        deps: [rule, ...merges],
        instructions: spanText(merges),
        reference: ref,
        publicBody: fnBody('spanAll', spanPub),
        holdBody: fnBody('spanAll', spanHid),
        mutants: [
          {
            id: 'span-drop',
            description: 'span ignores the last merged feed',
            content: mustReplace(ref, `const m=MERGES[k](lists[k]);`, `const m=k===MERGES.length-1?[]:MERGES[k](lists[k]);`),
            publicPass: true,
          },
        ],
      });
    };

    const nodes: NodeOut[] = [];
    if (topology === 'independent') {
      for (let i = 0; i < count / 4; i++) {
        const ru = `rule-${i}`, ck = `check-${i}`, mg = `merge-${i}`, ms = `measure-${i}`;
        nodes.push(nodeRule(ru), nodeCheck(ck, ru), nodeMerge(mg, ck, ru), nodeMeasure(ms, mg));
      }
    } else if (topology === 'fanin') {
      const parts: string[] = [];
      for (let i = 0; i < count - 1; i++) {
        const k = `part-${i}`;
        parts.push(k);
        nodes.push(nodePart(k, i));
      }
      nodes.push(nodeJoin('join-0', parts));
    } else {
      // sparse: shared rules + check->merge branch pairs + span join + probes
      const plan = sparsePlan(count);
      nodes.push(nodeRule('rule-0'));
      const merges: string[] = [];
      for (let i = 0; i < plan.pairs; i++) {
        const ck = `check-${i}`, mg = `merge-${i}`;
        nodes.push(nodeCheck(ck, 'rule-0'), nodeMerge(mg, ck, 'rule-0'));
        if (i % 2 === 0) merges.push(mg);
      }
      nodes.push(nodeSpan('span-0', 'rule-0', merges));
      for (let i = 0; i < plan.solos; i++) nodes.push(nodeProbe(`probe-${i}`, i + 1));
    }

    const menu: {role: string; desc: string; f: (s: string) => string}[] = [];
    if (topology === 'fanin') {
      menu.push(
        {
          role: 'part',
          desc: 'one part normalizer keeps zero-length intervals',
          f: (s) => mustReplace(s, `if(s!==e)out.push([s,e]);`, `out.push([s,e]);`),
        },
        {
          role: 'join',
          desc: 'union uses a wider gap than the contract',
          f: (s) => mustReplace(s, `const gap=${gap};`, `const gap=${gap + 1};`),
        },
      );
    } else {
      menu.push(
        {
          role: 'rule',
          desc: 'rules export gap+1, over-bridging every merge',
          f: (s) => mustReplace(s, `const gap=${gap};`, `const gap=${gap + 1};`),
        },
        {
          role: 'check',
          desc: 'check rejects intervals ending on hi',
          f: (s) => mustReplace(s, `e>hi`, `e>=hi`),
        },
      );
      if (topology === 'independent') {
        menu.push({
          role: 'merge',
          desc: 'merge bridges only when strictly inside the gap',
          f: (s) => mustReplace(s, `ivp[0]<=last[1]+gap`, `ivp[0]<last[1]+gap`),
        });
        menu.push({
          role: 'measure',
          desc: 'measure counts both endpoints of every interval',
          f: (s) => mustReplace(s, `covered+=iv[1]-iv[0]`, `covered+=iv[1]-iv[0]+1`),
        });
      } else {
        menu.push({
          role: 'span',
          desc: 'span ignores the last merged feed',
          f: (s) => mustReplace(s, `const m=MERGES[k](lists[k]);`, `const m=k===MERGES.length-1?[]:MERGES[k](lists[k]);`),
        });
      }
    }
    const d = menu[variant % menu.length]!;
    const key = findKey(nodes, d.role);
    seedDefect(nodes, key, d.f);
    return {
      goal: `Repair the interval modules so the whole contract is satisfied. Intervals are integer pairs within [${lo},${hi}], merged with gap ${gap}; zero-length intervals are ${drop ? 'dropped' : 'kept'}.`,
      defect: `${key}: ${d.desc}`,
      nodes,
    };
  },
};

/* ------------------------------------------------------------------ */
/* apportion: largest-remainder proportional allocation                */
/* ------------------------------------------------------------------ */

const apportion: Family = {
  name: 'apportion',
  title: 'largest-remainder proportional allocation',
  shapes: ['independent', 'fanin', 'diamond'],
  build(variant, topology, count) {
    const r = mulberry32(0x4aa1 + variant * 7919);
    const maxTotal = ri(r, 20, 200);
    const maxParts = ri(r, 3, 8);
    const maxWeight = ri(r, 10, 999);

    const sValid = (v: unknown): {total: number; weights: number[]} | null => {
      if (!Array.isArray(v) || v.length !== 2) return null;
      const [total, weights] = v;
      if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > maxTotal) return null;
      if (!Array.isArray(weights) || weights.length === 0 || weights.length > maxParts) return null;
      for (const w of weights) {
        if (!Number.isInteger(w) || (w as number) < 1 || (w as number) > maxWeight) return null;
      }
      return {total: total as number, weights: weights as number[]};
    };
    // oracle: iterative one-unit assignment to the largest remainder.
    const sShare2 = (v: unknown): number[] | null => {
      const ok = sValid(v);
      if (ok === null) return null;
      const {total, weights} = ok;
      const wsum = weights.reduce((a, b) => a + b, 0);
      const alloc = weights.map((w) => Math.floor((total * w) / wsum));
      const rem = weights.map((w) => (total * w) % wsum);
      let left = total - alloc.reduce((a, b) => a + b, 0);
      while (left > 0) {
        let pick = 0;
        for (let j = 1; j < weights.length; j++) if (rem[j]! > rem[pick]!) pick = j;
        alloc[pick]!++;
        rem[pick] = -1;
        left--;
      }
      return alloc;
    };
    const sAudit = (v: unknown): {alloc: number[]; ok: boolean} | null => {
      const a = sShare2(v);
      if (a === null) return null;
      const ok = sValid(v)!;
      return {alloc: a, ok: a.reduce((x, y) => x + y, 0) === ok.total && a.every((x) => x >= 0)};
    };
    const partWeights = Array.from({length: count - 1}, (_, i) =>
      Array.from({length: (i % 3) + 2 }, (_, j) => ((variant * 13 + i * 7 + (j < 2 ? 0 : j * 29)) % 9) + 1),
    );
    const partMax = ri(r, 20, 100);
    const sPart = (i: number, total: unknown): number[] | null => {
      if (!Number.isInteger(total) || (total as number) < 1 || (total as number) > partMax) return null;
      const ws = partWeights[i]!;
      const wsum = ws.reduce((a, b) => a + b, 0);
      const t = total as number;
      const alloc = ws.map((w) => Math.floor((t * w) / wsum));
      const rem = ws.map((w) => (t * w) % wsum);
      let left = t - alloc.reduce((a, b) => a + b, 0);
      while (left > 0) {
        let pick = 0;
        for (let j = 1; j < ws.length; j++) if (rem[j]! > rem[pick]!) pick = j;
        alloc[pick]!++;
        rem[pick] = -1;
        left--;
      }
      return alloc;
    };
    const sCombine = (v: unknown): {alloc: number[]; total: number} | null => {
      if (!Array.isArray(v) || v.length !== count - 1) return null;
      const alloc: number[] = [];
      let total = 0;
      for (let j = 0; j < count - 1; j++) {
        const a = sPart(j, v[j]);
        if (a === null) return null;
        alloc.push(...a);
        total += v[j] as number;
      }
      return {alloc, total};
    };


    const wTyp = Array.from({length: Math.min(maxParts, 3 + (variant % 3))}, (_, i) => i + 1 + (variant % 2));
    const tTyp = Math.min(maxTotal, 10 + variant);
    const tieTotal = Math.min(maxTotal, Math.max(2, Math.min(9, wTyp.length + 1)));
    const tieWeights = wTyp.map(() => 1);
    const lastPick = Math.min(maxTotal, 7);
    const lastWeights = [1, 2, 3];

    const rulePub = raw(`assert.equal(m.maxTotal,${maxTotal});`, `assert.equal(m.maxParts,${maxParts});`, `assert.equal(m.maxWeight,${maxWeight});`);
    const ruleHid = raw(
      `assert.equal(m.maxTotal,${maxTotal});`,
      `assert.equal(m.maxParts,${maxParts});`,
      `assert.equal(m.maxWeight,${maxWeight});`,
      `assert.equal(Object.keys(m).sort().join(','),'maxParts,maxTotal,maxWeight');`,
    );
    const validPub: Case[] = [
      [[[tTyp, wTyp]], {total: tTyp, weights: wTyp}],
      [[[0, wTyp]], null],
      [[[maxTotal + 1, wTyp]], null],
      [[[tTyp, [0]]], null],
      [[5], null],
    ];
    const validHid: Case[] = [
      [[null], null], [[{}], null], [[[]], null], [[[tTyp]], null],
      [[[tTyp, wTyp, 3]], null],
      [[[1, [1]]], {total: 1, weights: [1]}],
      [[[maxTotal, [maxWeight]]], {total: maxTotal, weights: [maxWeight]}],
      [[[tTyp, []]], null],
      [[[tTyp, Array.from({length: maxParts + 1}, () => 1)]], null],
      [[[1.5, wTyp]], null],
      [[[tTyp, [1.5]]], null],
      [[[tTyp, [maxWeight + 1]]], null],
      [[[tTyp, [-1]]], null],
      [[['3', wTyp]], null],
    ];
    const sharePub: Case[] = [
      [[[tTyp, wTyp]], sShare2([tTyp, wTyp])],
      [[[tieTotal, tieWeights]], sShare2([tieTotal, tieWeights])],
      [[[0, wTyp]], null],
      [[5], null],
    ];
    const shareHid: Case[] = [
      [[null], null], [[[]], null],
      [[[1, [1]]], [1]],
      [[[lastPick, lastWeights]], sShare2([lastPick, lastWeights])],
      [[[maxTotal, [maxWeight, maxWeight - 1, 1].slice(0, maxParts)]], sShare2([maxTotal, [maxWeight, maxWeight - 1, 1].slice(0, maxParts)])],
      [[[3, [1, 1, 1]]], sShare2([3, [1, 1, 1]])],
      [[[4, [2, 1, 1]]], sShare2([4, [2, 1, 1]])],
      [[[9, [2, 2, 3]]], sShare2([9, [2, 2, 3]])],
      [[[maxTotal + 1, wTyp]], null],
      [[[tTyp, [0, 1]]], null],
    ];
    const shareHidExtra = keepInputs([[[tTyp, wTyp]]]);
    const auditPub: Case[] = [
      [[[tTyp, wTyp]], sAudit([tTyp, wTyp])],
      [[[0, wTyp]], null],
    ];
    const auditHid: Case[] = [
      [[null], null],
      [[[lastPick, lastWeights]], sAudit([lastPick, lastWeights])],
      [[[1, [1]]], sAudit([1, [1]])],
      [[[tTyp, [0]]], null],
    ];

    const ruleText = `Export exactly three constants: maxTotal=${maxTotal}, maxParts=${maxParts}, maxWeight=${maxWeight}. A valid allocation request is [total, weights] where total is an integer in 1..maxTotal and weights is a nonempty array of at most maxParts integers, each in 1..maxWeight. Export nothing else.`;
    const validText = `Import {maxTotal,maxParts,maxWeight} from the rules module listed in dependsOn. Export function validInputs(req). Accept an array of exactly two elements [total, weights] satisfying the contract bounds; return {total, weights}. Return null otherwise.`;
    const shareText = `Import {validInputs} from the validation module listed in dependsOn. Export function shareInputs(req). Validate req with validInputs (null on rejection), then apportion total proportionally to weights by largest remainder: every part gets floor(total*w/wsum); distribute the remaining units one at a time to the largest fractional remainder, breaking ties toward the lower index. Return the allocation array.`;
    const auditText = `Import {shareInputs} and {validInputs} from the modules listed in dependsOn. Export function auditInputs(req). Return null when shareInputs rejects req; otherwise return {alloc, ok} where alloc is shareInputs(req) and ok reports whether alloc sums exactly to total with all parts nonnegative.`;
    const partText = (i: number, ws: readonly number[]) =>
      `Self-contained module: do not import anything. Export function splitPart${i}(total). total must be an integer in 1..${partMax}. Split total over the fixed weights ${lit([...ws])} by largest remainder (ties toward the lower index) and return the allocation array; return null on invalid total.`;
    const combineText = `Import every sibling listed in dependsOn (splitPart0..splitPart${count - 2}). Export function combine(totals). totals must be an array of exactly ${count - 1} integers; element j is split by splitPart${'{'}j${'}'}. Return null when any split rejects. Otherwise return {alloc, total}: the concatenated allocations and the sum of all input totals.`;


    const nodeRule = (key: string): NodeOut =>
      N({
        key,
        role: 'rule',
        deps: [],
        instructions: ruleText,
        reference: `export const maxTotal=${maxTotal};\nexport const maxParts=${maxParts};\nexport const maxWeight=${maxWeight};\n`,
        publicBody: rulePub,
        holdBody: ruleHid,
        mutants: [
          {
            id: 'parts-minus',
            description: 'rules allow one fewer weight than the contract',
            content: `export const maxTotal=${maxTotal};\nexport const maxParts=${maxParts - 1};\nexport const maxWeight=${maxWeight};\n`,
            publicPass: false,
          },
        ],
      });
    const nodeValid = (key: string, rule: string): NodeOut => {
      const ref = `import {maxTotal,maxParts,maxWeight} from './${rule}.mjs';
export function validInputs(req){
 if(!Array.isArray(req)||req.length!==2)return null;
 const total=req[0],weights=req[1];
 if(!Number.isInteger(total)||total<1||total>maxTotal)return null;
 if(!Array.isArray(weights)||weights.length===0||weights.length>maxParts)return null;
 for(const w of weights){
  if(!Number.isInteger(w)||w<1||w>maxWeight)return null;
 }
 return {total,weights};
}
`;
      return N({
        key,
        role: 'valid',
        deps: [rule],
        instructions: validText,
        reference: ref,
        publicBody: fnBody('validInputs', validPub),
        holdBody: fnBody('validInputs', validHid),
        mutants: [
          {
            id: 'zero-ok',
            description: 'validation accepts zero weights',
            content: mustReplace(ref, `w<1`, `w<0`),
            publicPass: true,
          },
          {
            id: 'total-one',
            description: 'validation rejects total of one',
            content: mustReplace(ref, `total<1`, `total<=1`),
            publicPass: false,
          },
        ],
      });
    };
    const nodeShare = (key: string, valid: string): NodeOut => {
      const ref = `import {validInputs} from './${valid}.mjs';
export function shareInputs(req){
 const ok=validInputs(req);
 if(ok===null)return null;
 const total=ok.total,weights=ok.weights;
 const wsum=weights.reduce((a,b)=>a+b,0);
 const alloc=weights.map(w=>Math.floor(total*w/wsum));
 const order=weights.map((w,j)=>({r:total*w-Math.floor(total*w/wsum)*wsum,j})).sort((a,b)=>b.r-a.r||a.j-b.j);
 let left=total-alloc.reduce((a,b)=>a+b,0);
 for(const o of order){
  if(left===0)break;
  alloc[o.j]++;
  left--;
 }
 return alloc;
}
`;
      return N({
        key,
        role: 'share',
        deps: [valid],
        instructions: shareText,
        reference: ref,
        publicBody: fnBody('shareInputs', sharePub),
        holdBody: fnBody('shareInputs', shareHid, shareHidExtra),
        mutants: [
          {
            id: 'tie-high',
            description: 'remainder ties break toward the higher index',
            content: mustReplace(ref, `a.j-b.j`, `b.j-a.j`),
            publicPass: false,
          },
          {
            id: 'skip-last',
            description: 'the last weight never receives a remainder unit',
            content: mustReplace(ref, `const order=weights.map((w,j)=>({r:total*w-Math.floor(total*w/wsum)*wsum,j})).sort((a,b)=>b.r-a.r||a.j-b.j);`, `const order=weights.map((w,j)=>({r:j===weights.length-1?-1:total*w-Math.floor(total*w/wsum)*wsum,j})).sort((a,b)=>b.r-a.r||a.j-b.j);`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeAudit = (key: string, share: string, valid: string): NodeOut => {
      const ref = `import {shareInputs} from './${share}.mjs';
import {validInputs} from './${valid}.mjs';
export function auditInputs(req){
 const ok=validInputs(req);
 if(ok===null)return null;
 const alloc=shareInputs(req);
 if(alloc===null)return null;
 return {alloc,ok:alloc.reduce((a,b)=>a+b,0)===ok.total&&alloc.every(x=>x>=0)};
}
`;
      return N({
        key,
        role: 'audit',
        deps: [share, valid],
        instructions: auditText,
        reference: ref,
        publicBody: fnBody('auditInputs', auditPub),
        holdBody: fnBody('auditInputs', auditHid),
        mutants: [
          {
            id: 'audit-null1',
            description: 'audit rejects requests whose total is one',
            content: mustReplace(ref, `if(ok===null)return null;`, `if(ok===null||ok.total===1)return null;`),
            publicPass: true,
          },
        ],
      });
    };
    const nodePart = (key: string, i: number): NodeOut => {
      const ws = partWeights[i]!;
      const ref = `const weights=${lit([...ws])};
const maxTotal=${partMax};
export function splitPart${i}(total){
 if(!Number.isInteger(total)||total<1||total>maxTotal)return null;
 const wsum=weights.reduce((a,b)=>a+b,0);
 const alloc=weights.map(w=>Math.floor(total*w/wsum));
 const order=weights.map((w,j)=>({r:total*w-Math.floor(total*w/wsum)*wsum,j})).sort((a,b)=>b.r-a.r||a.j-b.j);
 let left=total-alloc.reduce((a,b)=>a+b,0);
 for(const o of order){
  if(left===0)break;
  alloc[o.j]++;
  left--;
 }
 return alloc;
}
`;
      const t0 = Math.min(partMax, 5 + i);
      return N({
        key,
        role: 'part',
        deps: [],
        instructions: partText(i, ws),
        reference: ref,
        publicBody: fnBody(`splitPart${i}`, [
          [[t0], sPart(i, t0)],
          [[0], null],
          [[partMax + 1], null],
        ]),
        holdBody: fnBody(`splitPart${i}`, [
          ...Array.from({length: partMax}, (_, t): Case => [[t + 1], sPart(i, t + 1)]),
          [[partMax], sPart(i, partMax)],
          [[null], null],
          [['5'], null],
          [[1.5], null],
          [[Math.min(partMax, 9 + i)], sPart(i, Math.min(partMax, 9 + i))],
        ]),
        mutants: [
          {
            id: 'part-tie',
            description: 'part breaks remainder ties toward the higher index',
            content: mustReplace(ref, `a.j-b.j`, `b.j-a.j`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeCombine = (key: string, parts: readonly string[]): NodeOut => {
      const imports = parts.map((p, j) => `import {splitPart${j}} from './${p}.mjs';`).join('\n');
      const ref = `${imports}
const PARTS=[${parts.map((_, j) => `splitPart${j}`).join(',')}];
export function combine(totals){
 if(!Array.isArray(totals)||totals.length!==PARTS.length)return null;
 const alloc=[];
 let total=0;
 for(let j=0;j<PARTS.length;j++){
  const a=PARTS[j](totals[j]);
  if(a===null)return null;
  for(const x of a)alloc.push(x);
  total+=totals[j];
 }
 return {alloc,total};
}
`;
      const goodIn = parts.map((_, j) => Math.min(partMax, 4 + j));
      const pub: Case[] = [
        [[goodIn], sCombine(goodIn)],
        [[parts.map(() => 0)], null],
      ];
      const hid: Case[] = [
        [[null], null],
        [[[]], null],
        [[goodIn.slice(1)], null],
        [[parts.map((_, j) => Math.min(partMax, 8 + j))], sCombine(parts.map((_, j) => Math.min(partMax, 8 + j)))],
        [[parts.map(() => 1)], sCombine(parts.map(() => 1))],
      ];
      return N({
        key,
        role: 'join',
        deps: parts,
        instructions: combineText,
        reference: ref,
        publicBody: fnBody('combine', pub),
        holdBody: fnBody('combine', hid),
        mutants: [
          {
            id: 'join-total-offset',
            description: 'combine adds one extra unit per part',
            content: mustReplace(ref, `total+=totals[j];`, `total+=totals[j]+1;`),
            publicPass: false,
          },
        ],
      });
    };

    const nodes: NodeOut[] = [];
    if (topology === 'independent') {
      for (let i = 0; i < count / 4; i++) {
        const ru = `rule-${i}`, va = `valid-${i}`, sh = `share-${i}`, au = `audit-${i}`;
        nodes.push(nodeRule(ru), nodeValid(va, ru), nodeShare(sh, va), nodeAudit(au, sh, va));
      }
    } else if (topology === 'fanin') {
      const parts: string[] = [];
      for (let i = 0; i < count - 1; i++) {
        const k = `part-${i}`;
        parts.push(k);
        nodes.push(nodePart(k, i));
      }
      nodes.push(nodeCombine('join-0', parts));
    } else {
      // diamond: shared rules -> valid mids -> share mids -> verify join
      nodes.push(nodeRule('rule-0'));
      let firstValid = '', lastShare = '';
      for (let i = 0; i < count - 2; i++) {
        if (i % 2 === 0) {
          const v = `valid-${i}`;
          if (firstValid === '') firstValid = v;
          nodes.push(nodeValid(v, 'rule-0'));
        } else {
          lastShare = `share-${i}`;
          nodes.push(nodeShare(lastShare, firstValid));
        }
      }
      nodes.push(nodeAudit('verify-0', lastShare, firstValid));
    }

    const menu: {role: string; desc: string; f: (s: string) => string}[] = [];
    if (topology === 'fanin') {
      menu.push(
        {
          role: 'part',
          desc: 'one part breaks remainder ties toward the higher index',
          f: (s) => mustReplace(s, `a.j-b.j`, `b.j-a.j`),
        },
        {
          role: 'join',
          desc: 'combine reports the sum of allocations instead of the input totals',
          f: (s) => mustReplace(s, `total+=totals[j];`, `total+=totals[j]+1;`),
        },
      );
    } else {
      menu.push(
        {
          role: 'rule',
          desc: 'rules allow one fewer weight than the contract',
          f: (s) => mustReplace(s, `const maxParts=${maxParts};`, `const maxParts=${maxParts - 1};`),
        },
        {
          role: 'valid',
          desc: 'validation accepts zero weights',
          f: (s) => mustReplace(s, `w<1`, `w<0`),
        },
        {
          role: 'share',
          desc: 'remainder ties break toward the higher index',
          f: (s) => mustReplace(s, `a.j-b.j`, `b.j-a.j`),
        },
      );
      if (topology === 'independent') {
        menu.push({
          role: 'audit',
          desc: 'audit falsely marks a correct allocation invalid',
          f: (s) => mustReplace(s, `alloc.reduce((a,b)=>a+b,0)===ok.total`, `false`),
        });
      }
    }
    const d = menu[variant % menu.length]!;
    const key = findKey(nodes, d.role);
    seedDefect(nodes, key, d.f);
    return {
      goal: `Repair the largest-remainder apportionment modules so the whole contract is satisfied. Requests are [total, weights] with total in 1..${maxTotal}, at most ${maxParts} weights in 1..${maxWeight}; remainder ties go to the lower index.`,
      defect: `${key}: ${d.desc}`,
      nodes,
    };
  },
};

/* ------------------------------------------------------------------ */
/* topk: ranked selection with deterministic tie-breaking              */
/* ------------------------------------------------------------------ */

const topk: Family = {
  name: 'topk',
  title: 'ranked top-k selection',
  shapes: ['independent', 'fanout', 'sparse'],
  build(variant, topology, count) {
    const r = mulberry32(0x709 + variant * 7919);
    const k = ri(r, 2, 5);
    const dir = variant % 2 === 0 ? 'desc' : 'asc';
    const sMax = ri(r, 10, 99);
    const tMax = ri(r, 3, 20);

    const sScore = (v: unknown): {id: string; s: number; t: number} | null => {
      if (v === null || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return null;
      const o = v as Record<string, unknown>;
      if (typeof o['id'] !== 'string' || o['id'].length === 0 || o['id'].length > 24) return null;
      if (!Number.isInteger(o['s']) || (o['s'] as number) < 0 || (o['s'] as number) > sMax) return null;
      if (!Number.isInteger(o['t']) || (o['t'] as number) < 0 || (o['t'] as number) > tMax) return null;
      return {id: o['id'] as string, s: o['s'] as number, t: o['t'] as number};
    };
    const cmp = (a: {id: string; s: number; t: number}, b: {id: string; s: number; t: number}): number => {
      const ds = dir === 'desc' ? b.s - a.s : a.s - b.s;
      if (ds !== 0) return ds;
      if (a.t !== b.t) return b.t - a.t;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    // oracle: selection-loop instead of sort+slice.
    const sRank = (v: unknown): string[] | null => {
      if (!Array.isArray(v)) return null;
      const items: {id: string; s: number; t: number}[] = [];
      const seen = new Set<string>();
      for (const it of v) {
        const s = sScore(it);
        if (s === null) return null;
        if (seen.has(s.id)) return null;
        seen.add(s.id);
        items.push(s);
      }
      const pool = [...items];
      const out: string[] = [];
      while (out.length < Math.min(k, items.length)) {
        let bi = 0;
        for (let j = 1; j < pool.length; j++) if (cmp(pool[j]!, pool[bi]!) < 0) bi = j;
        out.push(pool.splice(bi, 1)[0]!.id);
      }
      return out;
    };
    const sEmit = (v: unknown): string[] | null => {
      const ids = sRank(v);
      if (ids === null || !Array.isArray(v)) return null;
      const byId = new Map<string, {id: string; s: number; t: number}>();
      for (const it of v) {
        const s = sScore(it);
        if (s === null) return null;
        byId.set(s.id, s);
      }
      return ids.map((id) => `${id}:${byId.get(id)!.s}`);
    };



    const sChamp = (v: unknown, nFeeds: number): string | null => {
      if (!Array.isArray(v) || v.length !== nFeeds) return null;
      const ranked: string[][] = [];
      for (const sub of v) {
        const rk = sRank(sub);
        if (rk === null) return null;
        ranked.push(rk);
      }
      const winners = ranked.map((r2) => r2[0]).filter((x): x is string => x !== undefined);
      if (winners.length === 0) return null;
      const all: {id: string; s: number; t: number}[] = [];
      for (const sub of v) for (const it of sub as unknown[]) all.push(sScore(it)!);
      const wset = new Set(winners);
      const cands = all.filter((x) => wset.has(x.id));
      let best = cands[0]!;
      for (const it of cands.slice(1)) if (cmp(it, best) < 0) best = it;
      return best.id;
    };


    const items = (n: number, salt = 0): {id: string; s: number; t: number}[] =>
      Array.from({length: n}, (_, i) => ({
        id: `it${i + salt * 7}`,
        s: (variant * 7 + i * 11 + salt * 3) % (sMax + 1),
        t: (variant + i * 3 + salt) % (tMax + 1),
      }));
    const tieItems = [
      {id: 'b', s: 5, t: 1},
      {id: 'a', s: 5, t: 1},
      {id: 'c', s: 5, t: 3},
      {id: 'd', s: 2, t: 9},
    ];
    const listTyp = items(Math.max(k + 2, 4));

    const ordPub = raw(`assert.equal(m.k,${k});`, `assert.equal(m.dir,${lit(dir)});`, `assert.equal(m.sMax,${sMax});`, `assert.equal(m.tMax,${tMax});`);
    const ordHid = raw(
      `assert.equal(m.k,${k});`,
      `assert.equal(m.dir,${lit(dir)});`,
      `assert.equal(m.sMax,${sMax});`,
      `assert.equal(m.tMax,${tMax});`,
      `assert.equal(Object.keys(m).sort().join(','),'dir,k,sMax,tMax');`,
    );
    const scorePub: Case[] = [
      [[{id: 'a', s: 1, t: 0}], {id: 'a', s: 1, t: 0}],
      [[{id: 'a', s: sMax + 1, t: 0}], null],
      [[{id: '', s: 1, t: 0}], null],
      [[{id: 'a', s: 1.5, t: 0}], null],
      [[5], null],
    ];
    const scoreHid: Case[] = [
      [[null], null], [[[]], null], [[{}], null],
      [[{id: 'a'}], null],
      [[{id: 'a', s: 0, t: 0}], {id: 'a', s: 0, t: 0}],
      [[{id: 'a', s: sMax, t: tMax}], {id: 'a', s: sMax, t: tMax}],
      [[{id: 'a', s: -1, t: 0}], null],
      [[{id: 'a', s: 1, t: tMax + 1}], null],
      [[{id: 'a', s: 1, t: 0, extra: 9}], {id: 'a', s: 1, t: 0}],
      [[{id: 'ab'.repeat(13), s: 1, t: 0}], null], [[{id: ' x ', s: 0, t: 0}], {id: ' x ', s: 0, t: 0}],
    ];
    const rankPub: Case[] = [
      [[listTyp], sRank(listTyp)],
      [[tieItems], sRank(tieItems)],
      [[[]], []],
      [[[{id: 'a', s: -1, t: 0}]], null],
    ];
    const exactTie = [{id: 'z', s: 1, t: 0}, {id: 'a', s: 1, t: 0}];
    const rankHid: Case[] = [
      [[exactTie], sRank(exactTie)],
      [[null], null], [[{}], null],
      [[items(3)], sRank(items(3))],
      [[items(1, 2)], sRank(items(1, 2))],
      [[[{id: 'x', s: 1, t: 0}, {id: 'x', s: 2, t: 0}]], null],
      [[tieItems.concat(items(2, 5))], sRank(tieItems.concat(items(2, 5)))],
      [[[{id: 'long'.repeat(7), s: 1, t: 0}]], null],
    ];
    const rankHidExtra = keepInputs([[listTyp], [exactTie]]);
    const emitPub: Case[] = [
      [[listTyp], sEmit(listTyp)],
      [[[]], []],
    ];
    const emitHid: Case[] = [
      [[tieItems], sEmit(tieItems)],
      [[null], null],
      [[[{id: 'a', s: -1, t: 0}]], null],
      [[items(3, 4)], sEmit(items(3, 4))],
    ];
    const partIn = (i: number): {id: string; s: number; t: number}[] =>
      Array.from({length: 4}, (_, j) => ({id: `p${i}x${j}`, s: (variant * 3 + i * 5 + j * 7) % (sMax + 1), t: (i + j) % (tMax + 1)}));

    const champFeeds = (k2: number): {id: string; s: number; t: number}[][] => Array.from({length: k2}, (_, j) => partIn(j * 2));

    const ordText = `Export exactly four constants: k=${k}, dir=${lit(dir)}, sMax=${sMax}, tMax=${tMax}. Items are {id,s,t}: id a nonempty string of at most 24 chars, s an integer 0..sMax, t an integer 0..tMax. Ranking sorts by s ${dir === 'desc' ? 'descending' : 'ascending'}, breaks ties by t descending, then by id ascending. Export nothing else.`;
    const scoreText = `Import {sMax,tMax} from the order module listed in dependsOn. Export function scoreItem(item). Accept a plain object (prototype Object.prototype or null) {id,s,t} satisfying the contract bounds and return {id,s,t}; ignore extra keys. Return null otherwise.`;
    const rankText = `Import {scoreItem} from the score module and {k,dir} from the order module listed in dependsOn. Export function rankItems(items). items must be an array of acceptable items with unique ids (duplicate ids or any invalid element return null). Return the ids of the top k items under the contract ordering (s ${dir}, t descending, id ascending), or fewer when the input is smaller. Never mutate the input.`;
    const emitText = `Import {rankItems} and {scoreItem} from the modules listed in dependsOn. Export function emitItems(items). Return null when ranking rejects items; otherwise return the ranked ids formatted as 'id:s' strings.`;


    const probeText = (i: number) =>
      `Self-contained module: do not import anything. Export function probe${i}(item). Accept a plain object (prototype Object.prototype or null) {id,s,t} with id a nonempty string of at most 24 chars, s an integer 0..${sMax}, t an integer 0..${tMax}; return {id,s,t}. Return null otherwise.`;
    const champText = (deps: readonly string[]) =>
      `Import {k,dir} from the order module and ${deps.map((d, kk) => `{rankItems as r${kk}} from './${d}.mjs'`).join(', ')}. Export function champion(lists). lists must be an array of exactly ${deps.length} arrays; element kk is ranked by the module in dependsOn order. Take the first-ranked id of each feed (skip empty feeds), then among those winning items return the id of the best under the contract ordering (s ${dir}, t descending, id ascending). Return null on any rejection or when every feed is empty.`;

    const nodeOrd = (key: string): NodeOut =>
      N({
        key,
        role: 'ord',
        deps: [],
        instructions: ordText,
        reference: `export const k=${k};\nexport const dir=${lit(dir)};\nexport const sMax=${sMax};\nexport const tMax=${tMax};\n`,
        publicBody: ordPub,
        holdBody: ordHid,
        mutants: [
          {
            id: 'k-plus',
            description: 'order exports k+1',
            content: `export const k=${k + 1};\nexport const dir=${lit(dir)};\nexport const sMax=${sMax};\nexport const tMax=${tMax};\n`,
            publicPass: false,
          },
          {
            id: 'dir-flip',
            description: 'order exports the opposite direction',
            content: `export const k=${k};\nexport const dir=${lit(dir === 'desc' ? 'asc' : 'desc')};\nexport const sMax=${sMax};\nexport const tMax=${tMax};\n`,
            publicPass: false,
          },
        ],
      });
    const nodeScore = (key: string, ord: string): NodeOut => {
      const ref = `import {sMax,tMax} from './${ord}.mjs';
export function scoreItem(item){
 if(item===null||typeof item!=='object'||Array.isArray(item)||![Object.prototype,null].includes(Object.getPrototypeOf(item)))return null;
 const id=item.id,s=item.s,t=item.t;
 if(typeof id!=='string'||id.length===0||id.length>24)return null;
 if(!Number.isInteger(s)||s<0||s>sMax)return null;
 if(!Number.isInteger(t)||t<0||t>tMax)return null;
 return {id,s,t};
}
`;
      return N({
        key,
        role: 'score',
        deps: [ord],
        instructions: scoreText,
        reference: ref,
        publicBody: fnBody('scoreItem', scorePub),
        holdBody: fnBody('scoreItem', scoreHid),
        mutants: [
          {
            id: 's-open',
            description: 'score rejects the top score bound',
            content: mustReplace(ref, `s>sMax`, `s>=sMax`),
            publicPass: false,
          },
          {
            id: 'id-trim',
            description: 'score trims whitespace from ids',
            content: mustReplace(ref, `return {id,s,t};`, `return {id:id.trim(),s,t};`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeRank = (key: string, score: string, ord: string): NodeOut => {
      const ref = `import {scoreItem} from './${score}.mjs';
import {k,dir} from './${ord}.mjs';
export function rankItems(items){
 if(!Array.isArray(items))return null;
 const seen=new Set();
 const list=[];
 for(const it of items){
  const s=scoreItem(it);
  if(s===null)return null;
  if(seen.has(s.id))return null;
  seen.add(s.id);
  list.push(s);
 }
 const sorted=[...list].sort((a,b)=>{
  const ds=dir==='desc'?b.s-a.s:a.s-b.s;
  if(ds!==0)return ds;
  if(a.t!==b.t)return b.t-a.t;
  return a.id<b.id?-1:a.id>b.id?1:0;
 });
 return sorted.slice(0,k).map(x=>x.id);
}
`;
      return N({
        key,
        role: 'rank',
        deps: [score, ord],
        instructions: rankText,
        reference: ref,
        publicBody: fnBody('rankItems', rankPub),
        holdBody: fnBody('rankItems', rankHid, rankHidExtra),
        mutants: [
          {
            id: 'id-desc',
            description: 'final tie-break sorts ids descending',
            content: mustReplace(ref, `return a.id<b.id?-1:a.id>b.id?1:0;`, `return a.id<b.id?1:a.id>b.id?-1:0;`),
            publicPass: true,
          },
          {
            id: 'in-place',
            description: 'rank mutates the caller array while sorting',
            content: mustReplace(ref, `const sorted=[...list].sort`, `const sorted=items.sort`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeEmit = (key: string, rank: string, score: string): NodeOut => {
      const ref = `import {rankItems} from './${rank}.mjs';
import {scoreItem} from './${score}.mjs';
export function emitItems(items){
 const ids=rankItems(items);
 if(ids===null)return null;
 const byId=new Map();
 for(const it of items){
  const s=scoreItem(it);
  if(s===null)return null;
  byId.set(s.id,s);
 }
 return ids.map(id=>id+':'+byId.get(id).s);
}
`;
      return N({
        key,
        role: 'emit',
        deps: [rank, score],
        instructions: emitText,
        reference: ref,
        publicBody: fnBody('emitItems', emitPub),
        holdBody: fnBody('emitItems', emitHid),
        mutants: [
          {
            id: 'fmt-eq',
            description: 'emit formats entries as id=s instead of id:s',
            content: mustReplace(ref, `id+':'+byId.get(id).s`, `id+'='+byId.get(id).s`),
            publicPass: false,
          },
        ],
      });
    };


    const nodeProbe = (key: string, i: number): NodeOut => {
      const ref = `const sMax=${sMax},tMax=${tMax};
export function probe${i}(item){
 if(item===null||typeof item!=='object'||Array.isArray(item)||![Object.prototype,null].includes(Object.getPrototypeOf(item)))return null;
 const id=item.id,s=item.s,t=item.t;
 if(typeof id!=='string'||id.length===0||id.length>24)return null;
 if(!Number.isInteger(s)||s<0||s>sMax)return null;
 if(!Number.isInteger(t)||t<0||t>tMax)return null;
 return {id,s,t};
}
`;
      return N({
        key,
        role: 'probe',
        deps: [],
        instructions: probeText(i),
        reference: ref,
        publicBody: fnBody(`probe${i}`, [
          [[{id: 'a', s: 0, t: 0}], {id: 'a', s: 0, t: 0}],
          [[{id: 'a', s: sMax + 1, t: 0}], null],
        ]),
        holdBody: fnBody(`probe${i}`, [
          [[null], null], [[5], null],
          [[{id: 'a', s: sMax, t: tMax}], {id: 'a', s: sMax, t: tMax}],
          [[{id: 'a', s: 1, t: -1}], null],
          [[{id: ' ', s: 1, t: 0}], {id: ' ', s: 1, t: 0}], [[{id: 7, s: 0, t: 0}], null],
        ]),
        mutants: [
          {
            id: 'probe-loose',
            description: 'probe accepts numeric ids',
            content: mustReplace(ref, `typeof id!=='string'`, `typeof id!=='string'&&typeof id!=='number'`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeChamp = (key: string, ord: string, ranks: readonly string[]): NodeOut => {
      const imports = [`import {k,dir} from './${ord}.mjs';`, ...ranks.map((rk, kk) => `import {rankItems as r${kk}} from './${rk}.mjs';`)].join('\n');
      const ref = `${imports}
const RANKS=[${ranks.map((_, kk) => `r${kk}`).join(',')}];
export function champion(lists){
 if(!Array.isArray(lists)||lists.length!==RANKS.length)return null;
 const tops=[];
 for(let kk=0;kk<RANKS.length;kk++){
  const rk=RANKS[kk](lists[kk]);
  if(rk===null)return null;
  if(rk.length>0)tops.push({id:rk[0],list:lists[kk]});
 }
 if(tops.length===0)return null;
 let best=null;
 for(const top of tops){
  for(const it of top.list){
   if(it.id!==top.id)continue;
   const c={id:it.id,s:it.s,t:it.t};
   if(best===null){best=c;continue;}
   const ds=dir==='desc'?c.s-best.s:best.s-c.s;
   if(ds!==0){if(ds>0)best=c;continue;}
   if(c.t!==best.t){if(c.t>best.t)best=c;continue;}
   if(c.id<best.id)best=c;
  }
 }
 return best.id;
}
`;
      return N({
        key,
        role: 'champ',
        deps: [ord, ...ranks],
        instructions: champText(ranks),
        reference: ref,
        publicBody: fnBody('champion', [
          [[champFeeds(ranks.length)], sChamp(champFeeds(ranks.length), ranks.length)],
        ]),
        holdBody: fnBody('champion', [
          [[null], null],
          [[[]], null],
          [[champFeeds(ranks.length).slice(1)], null],
          [[Array.from({length: ranks.length}, () => [])], sChamp(Array.from({length: ranks.length}, () => []), ranks.length)],
        ]),
        mutants: [
          {
            id: 'champ-empty',
            description: 'champion rejects nonempty feeds',
            content: mustReplace(ref, `let best=null;`, `return null;let best=null;`),
            publicPass: false,
          },
        ],
      });
    };

    const nodes: NodeOut[] = [];
    if (topology === 'independent') {
      for (let i = 0; i < count / 4; i++) {
        const o = `ord-${i}`, sc = `score-${i}`, rk = `rank-${i}`, em = `emit-${i}`;
        nodes.push(nodeOrd(o), nodeScore(sc, o), nodeRank(rk, sc, o), nodeEmit(em, rk, sc));
      }
    } else if (topology === 'fanout') {
      nodes.push(nodeOrd('ord-0'));
      for (let i = 0; i < count - 1; i++) {
        if (i % 3 === 0) nodes.push(nodeScore(`score-${i}`, 'ord-0'));
        else if (i % 3 === 1) nodes.push(nodeProbe(`probe-${i}`, i));
        else nodes.push(nodeScore(`score-${i}`, 'ord-0'));
      }
    } else {
      // sparse: shared order + score->rank branch pairs + champion join + probes
      const plan = sparsePlan(count);
      nodes.push(nodeOrd('ord-0'));
      const ranks: string[] = [];
      for (let i = 0; i < plan.pairs; i++) {
        const sc = `score-${i}`, rk = `rank-${i}`;
        nodes.push(nodeScore(sc, 'ord-0'), nodeRank(rk, sc, 'ord-0'));
        if (i % 2 === 0) ranks.push(rk);
      }
      nodes.push(nodeChamp('champ-0', 'ord-0', ranks));
      for (let i = 0; i < plan.solos; i++) nodes.push(nodeProbe(`probe-${i}`, i + 2));
    }

    const menu: {role: string; desc: string; f: (s: string) => string}[] = [];
    if (topology === 'fanin') {
      menu.push(
        {
          role: 'part',
          desc: 'one part picker breaks ties by descending id',
          f: (s) => mustReplace(s, `id<best.id`, `id>best.id`),
        },
        {
          role: 'join',
          desc: 'board reports the largest winner id instead of the smallest',
          f: (s) => mustReplace(s, `valid.slice().sort()[0]`, `valid.slice().sort().reverse()[0]`),
        },
      );
    } else {
      menu.push(
        {
          role: 'ord',
          desc: 'order exports the opposite direction',
          f: (s) => mustReplace(s, `dir=${lit(dir)}`, `dir=${lit(dir === 'desc' ? 'asc' : 'desc')}`),
        },
        {
          role: 'score',
          desc: 'score rejects the top score bound',
          f: (s) => mustReplace(s, `s>sMax`, `s>=sMax`),
        },
      );
      if (topology === 'independent') {
        menu.push(
          {
            role: 'rank',
            desc: 'final tie-break sorts ids descending',
            f: (s) => mustReplace(s, `return a.id<b.id?-1:a.id>b.id?1:0;`, `return a.id<b.id?1:a.id>b.id?-1:0;`),
          },
          {
            role: 'emit',
            desc: 'emit formats entries as id=s',
            f: (s) => mustReplace(s, `id+':'+byId.get(id).s`, `id+'='+byId.get(id).s`),
          },
        );
      } else {
        menu.push({
          role: 'champ',
          desc: 'champion rejects nonempty feeds',
          f: (s) => mustReplace(s, `let best=null;`, `return null;let best=null;`),
        });
      }
    }
    const d = menu[variant % menu.length]!;
    const key = findKey(nodes, d.role);
    seedDefect(nodes, key, d.f);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.role === 'score' || n.role === 'probe') {
        const fn = /export function (\w+)\(/.exec(n.reference)![1]!;
        nodes[i] = {...n, holdBody: n.holdBody + '\n' + plainChecks(fn, {id: 'x', s: 0, t: 0}, {id: 'x', s: 0, t: 0})};
      }
    }
    return {
      goal: `Repair the ranking modules so the whole contract is satisfied. Items are {id,s,t}; the top ${k} ids order by s ${dir === 'desc' ? 'descending' : 'ascending'}, then t descending, then id ascending.`,
      defect: `${key}: ${d.desc}`,
      nodes,
    };
  },
};

/* ------------------------------------------------------------------ */
/* dedup: key-based deduplication with keep policy                     */
/* ------------------------------------------------------------------ */

const dedup: Family = {
  name: 'dedup',
  title: 'key-based record deduplication',
  shapes: ['independent', 'fanin', 'sparse'],
  build(variant, topology, count) {

    const field = (['k', 'id', 'key'] as const)[variant % 3]!;
    const keep = variant % 2 === 0 ? 'first' : 'last';
    const maxKey = 20 + (variant % 5);

    const sKeyof = (v: unknown): string | null => {
      if (v === null || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return null;
      const o = v as Record<string, unknown>;
      const k = o[field];
      if (typeof k !== 'string' || k.length === 0 || k.length > maxKey) return null;
      return k;
    };
    // oracle: two-pass winning-index selection, different from one-pass ref.
    const sDedup = (v: unknown): Record<string, unknown>[] | null => {
      if (!Array.isArray(v)) return null;
      const win = new Map<string, number>();
      const recs: Record<string, unknown>[] = [];
      for (let i = 0; i < v.length; i++) {
        const rec = v[i];
        const kk = sKeyof(rec);
        if (kk === null) return null;
        recs.push(rec as Record<string, unknown>);
        if (keep === 'first') {
          if (!win.has(kk)) win.set(kk, i);
        } else win.set(kk, i);
      }
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < recs.length; i++) {
        if (win.get(sKeyof(recs[i])!) === i) out.push(recs[i]!);
      }
      return out;
    };
    const sReport = (v: unknown): {kept: number; dropped: number; keys: string[]} | null => {
      const d = sDedup(v);
      if (d === null || !Array.isArray(v)) return null;
      return {kept: d.length, dropped: v.length - d.length, keys: d.map((rec) => sKeyof(rec)!)};
    };
    const partField = (i: number): string => `f${i}`;
    const sFeed = (i: number, v: unknown): {k: string; v: unknown}[] | null => {
      if (!Array.isArray(v)) return null;
      const out: {k: string; v: unknown}[] = [];
      for (const rec of v) {
        if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || ![Object.prototype, null].includes(Object.getPrototypeOf(rec))) return null;
        const o = rec as Record<string, unknown>;
        const kk = o[partField(i)];
        const vv = o['v'];
        if (typeof kk !== 'string' || kk.length === 0 || kk.length > maxKey) return null;
        out.push({k: kk, v: vv === undefined ? null : vv});
      }
      return out;
    };
    const sCombine = (v: unknown): {k: string; v: unknown}[] | null => {
      if (!Array.isArray(v) || v.length !== count - 1) return null;
      const all: {k: string; v: unknown}[] = [];
      for (let j = 0; j < count - 1; j++) {
        const f = sFeed(j, v[j]);
        if (f === null) return null;
        all.push(...f);
      }
      const win = new Map<string, number>();
      for (let i = 0; i < all.length; i++) win.set(all[i]!.k, i);
      const out: {k: string; v: unknown}[] = [];
      for (let i = 0; i < all.length; i++) if (win.get(all[i]!.k) === i) out.push(all[i]!);
      return out;
    };
    const spanDepsI = (pairs: number): number[] => sparseJoinSinks(pairs);
    const sLedger = (v: unknown, nFeeds: number): {kept: number; keys: string[]} | null => {
      if (!Array.isArray(v) || v.length !== nFeeds) return null;
      const all: Record<string, unknown>[] = [];
      for (const sub of v) {
        const d = sDedup(sub);
        if (d === null) return null;
        all.push(...d);
      }
      const win = new Map<string, number>();
      for (let i = 0; i < all.length; i++) win.set(sKeyof(all[i])!, i);
      const out: Record<string, unknown>[] = [];
      for (let i = 0; i < all.length; i++) if (win.get(sKeyof(all[i])!) === i) out.push(all[i]!);
      return {kept: out.length, keys: out.map((rec) => sKeyof(rec)!)};
    };


    const rec = (k: string, v2: number): Record<string, unknown> => ({[field]: k, v: v2});
    const dupList = [rec('a', 1), rec('b', 2), rec('a', 3), rec('c', 4), rec('b', 5)];
    const cleanList = [rec('a', 1), rec('b', 2), rec('c', 3)];

    const polPub = raw(`assert.equal(m.field,${lit(field)});`, `assert.equal(m.keep,${lit(keep)});`, `assert.equal(m.maxKey,${maxKey});`);
    const polHid = raw(
      `assert.equal(m.field,${lit(field)});`,
      `assert.equal(m.keep,${lit(keep)});`,
      `assert.equal(m.maxKey,${maxKey});`,
      `assert.equal(Object.keys(m).sort().join(','),'field,keep,maxKey');`,
    );
    const keyofPub: Case[] = [
      [[rec('a', 1)], 'a'],
      [[{[field]: ''}], null],
      [[{}], null],
      [[5], null],
      [[{[field]: 9}], null],
    ];
    const keyofHid: Case[] = [
      [[null], null], [[[]], null],
      [[{[field]: 'x'.repeat(maxKey)}], 'x'.repeat(maxKey)],
      [[{[field]: 'x'.repeat(maxKey + 1)}], null],
      [[{[field]: ' a'}], ' a'],
      [[{[field]: 'a', extra: 1}], 'a'],
      [[{k: 'a'}], field === 'k' ? 'a' : null],
      [[{[field]: true}], null],
    ];
    const dedupPub: Case[] = [
      [[dupList], sDedup(dupList)],
      [[cleanList], sDedup(cleanList)],
      [[[]], []],
      [[[{k: 'a'}]], field === 'k' ? [{k: 'a'}] : null],
    ];
    const dedupHid: Case[] = [
      [[null], null], [[{}], null],
      [[dupList.concat([rec('a', 9), rec('d', 0)])], sDedup(dupList.concat([rec('a', 9), rec('d', 0)]))],
      [[[rec('a', 1), rec('a', 2), rec('a', 3)]], sDedup([rec('a', 1), rec('a', 2), rec('a', 3)])],
      [[[{[field]: 5}]], null],
      [[[rec('a', 1), 'x']], null],
      [[[rec('a', 1), rec('a', 2), rec('b', 3)]], sDedup([rec('a', 1), rec('a', 2), rec('b', 3)])],
    ];
    const dedupHidExtra = keepInputs([[dupList]]);
    const reportPub: Case[] = [
      [[dupList], sReport(dupList)],
      [[[]], sReport([])],
    ];
    const reportHid: Case[] = [
      [[[rec('z', 1), rec('a', 2)]], sReport([rec('z', 1), rec('a', 2)])],
      [[null], null],
      [[cleanList], sReport(cleanList)],
      [[dupList.concat([rec('z', 8)])], sReport(dupList.concat([rec('z', 8)]))],
      [[[{[field]: 7}]], null],
    ];
    const feedIn = (i: number): Record<string, unknown>[] => [
      {[partField(i)]: `w${i}a`, v: i * 10 + 1},
      {[partField(i)]: `w${i}b`, v: i * 10 + 2},
      {[partField(i)]: 'shared', v: i},
    ];
    const feedPub = (i: number): Case[] => [
      [[feedIn(i)], sFeed(i, feedIn(i))],
      [[[]], []],
      [[[{[partField(i)]: 3}]], null],
    ];
    const feedHid = (i: number): Case[] => [
      [[[{[partField(i)]: 'x', v: 1}, {[partField(i)]: 'x'}]], sFeed(i, [{[partField(i)]: 'x', v: 1}, {[partField(i)]: 'x'}])],
      [[null], null],
      [[[{v: 1}]], null],
      [[[{[partField(i)]: 'y'.repeat(maxKey + 1)}]], null],
    ];
    const ledgerFeeds = (k2: number): Record<string, unknown>[][] => Array.from({length: k2}, () => dupList.map((x) => ({...x, v: x['v'] as number})));
    const sparseK = spanDepsI(sparsePlan(count).pairs).length;

    const polText = `Export exactly three constants: field=${lit(field)}, keep=${lit(keep)}, maxKey=${maxKey}. Records are plain objects (prototype Object.prototype or null) whose key is the nonempty string value of property ${lit(field)} of at most maxKey chars. keep selects which record survives a key collision: 'first' keeps the earliest occurrence, 'last' keeps the latest; survivors keep the order of their winning positions. Export nothing else.`;
    const keyofText = `Import {field,maxKey} from the policy module listed in dependsOn. Export function keyofRecord(rec). Return the record's key when rec is a plain object (prototype Object.prototype or null) whose field property is a nonempty string of at most maxKey chars, otherwise null.`;
    const dedupText = `Import {keyofRecord} from the keyof module and {keep} from the policy module listed in dependsOn. Export function dedupRecords(records). records must be an array of acceptable records (any invalid element returns null). Return the deduplicated array under the configured keep policy, preserving the order of winning positions. Never mutate the input.`;
    const reportText = `Import {dedupRecords} and {keyofRecord} from the modules listed in dependsOn. Export function reportRecords(records). Return null when dedupRecords rejects records; otherwise return {kept, dropped, keys}: kept is the survivor count, dropped is records.length-kept, keys is the survivor keys in output order.`;
    const feedText = (i: number) =>
      `Self-contained module: do not import anything. Export function feedPart${i}(records). records must be an array of plain objects (prototype Object.prototype or null) whose ${lit(partField(i))} property is a nonempty string of at most ${maxKey} chars (any invalid element returns null). Return the normalized array [{k, v}] where k is the field value and v is the record's v property (null when absent).`;
    const combineText = `Import every sibling listed in dependsOn (feedPart0..feedPart${count - 2}). Export function combine(sets). sets must be an array of exactly ${count - 1} arrays; element j is normalized by feedPart${'{'}j${'}'}. Concatenate all feeds and deduplicate by k keeping the LATEST occurrence (survivors keep the order of their winning positions). Return the deduplicated array or null on any rejection.`;
    const ledgerText = (deps: readonly string[]) =>
      `Import {field,keep} from the policy module and ${deps.map((d2, kk) => `{dedupRecords as d${kk}} from './${d2}.mjs'`).join(', ')}. Export function ledger(sets). sets must be an array of exactly ${deps.length} arrays; element kk is deduplicated by the module in dependsOn order. Concatenate the survivors and deduplicate again by the policy field keeping the LATEST occurrence. Return {kept, keys}: survivor count and keys in output order. Return null on any rejection.`;
    const probeText = (i: number) =>
      `Self-contained module: do not import anything. Export function probe${i}(rec). rec must be a plain object (prototype Object.prototype or null). Return the record's ${lit(`z${i}`)} property when it is a nonempty string of at most ${maxKey} chars, otherwise null.`;

    const nodePol = (key: string): NodeOut =>
      N({
        key,
        role: 'pol',
        deps: [],
        instructions: polText,
        reference: `export const field=${lit(field)};\nexport const keep=${lit(keep)};\nexport const maxKey=${maxKey};\n`,
        publicBody: polPub,
        holdBody: polHid,
        mutants: [
          {
            id: 'keep-flip',
            description: 'policy exports the opposite keep rule',
            content: `export const field=${lit(field)};\nexport const keep=${lit(keep === 'first' ? 'last' : 'first')};\nexport const maxKey=${maxKey};\n`,
            publicPass: false,
          },
          {
            id: 'max-plus',
            description: 'policy allows keys one char longer',
            content: `export const field=${lit(field)};\nexport const keep=${lit(keep)};\nexport const maxKey=${maxKey + 1};\n`,
            publicPass: false,
          },
        ],
      });
    const nodeKeyof = (key: string, pol: string): NodeOut => {
      const ref = `import {field,maxKey} from './${pol}.mjs';
export function keyofRecord(rec){
 if(rec===null||typeof rec!=='object'||Array.isArray(rec)||![Object.prototype,null].includes(Object.getPrototypeOf(rec)))return null;
 const k=rec[field];
 if(typeof k!=='string'||k.length===0||k.length>maxKey)return null;
 return k;
}
`;
      return N({
        key,
        role: 'keyof',
        deps: [pol],
        instructions: keyofText,
        reference: ref,
        publicBody: fnBody('keyofRecord', keyofPub),
        holdBody: fnBody('keyofRecord', keyofHid),
        mutants: [
          {
            id: 'num-ok',
            description: 'keyof accepts numeric keys',
            content: mustReplace(ref, `typeof k!=='string'`, `typeof k!=='string'&&typeof k!=='number'`),
            publicPass: true,
          },
          {
            id: 'key-trim',
            description: 'keyof trims whitespace around keys',
            content: mustReplace(ref, `return k;`, `return k.trim();`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeDedup = (key: string, keyof2: string, pol: string): NodeOut => {
      const ref = `import {keyofRecord} from './${keyof2}.mjs';
import {keep} from './${pol}.mjs';
export function dedupRecords(records){
 if(!Array.isArray(records))return null;
 const win=new Map();
 for(const rec of records){
  const k=keyofRecord(rec);
  if(k===null)return null;
  if(keep==='first'){
   if(!win.has(k))win.set(k,rec);
  }else{
   if(win.has(k))win.delete(k);
   win.set(k,rec);
  }
 }
 return [...win.values()];
}
`;
      return N({
        key,
        role: 'dedup',
        deps: [keyof2, pol],
        instructions: dedupText,
        reference: ref,
        publicBody: fnBody('dedupRecords', dedupPub),
        holdBody: fnBody('dedupRecords', dedupHid, dedupHidExtra),
        mutants: [
          {
            id: 'sort-keys',
            description: 'dedup returns survivors sorted by key instead of position',
            content: mustReplace(ref, `return [...win.values()];`, `return [...win.values()].sort((a,b)=>keyofRecord(a)<keyofRecord(b)?-1:1);`),
            publicPass: true,
          },
          {
            id: 'keep-flip',
            description: 'dedup keeps the opposite occurrence of every key',
            content: mustReplace(ref, `keep==='first'`, `keep!=='first'`),
            publicPass: false,
          },
        ],
      });
    };
    const nodeReport = (key: string, dedup2: string, keyof2: string): NodeOut => {
      const ref = `import {dedupRecords} from './${dedup2}.mjs';
import {keyofRecord} from './${keyof2}.mjs';
export function reportRecords(records){
 const d=dedupRecords(records);
 if(d===null)return null;
 return {kept:d.length,dropped:records.length-d.length,keys:d.map(rec=>keyofRecord(rec))};
}
`;
      return N({
        key,
        role: 'report',
        deps: [dedup2, keyof2],
        instructions: reportText,
        reference: ref,
        publicBody: fnBody('reportRecords', reportPub),
        holdBody: fnBody('reportRecords', reportHid),
        mutants: [
          {
            id: 'drop-plus',
            description: 'report counts one extra dropped record',
            content: mustReplace(ref, `dropped:records.length-d.length`, `dropped:records.length-d.length+1`),
            publicPass: false,
          },
          {
            id: 'keys-sorted',
            description: 'report sorts keys instead of keeping output order',
            content: mustReplace(ref, `keys:d.map(rec=>keyofRecord(rec))`, `keys:d.map(rec=>keyofRecord(rec)).sort()`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeFeed = (key: string, i: number): NodeOut => {
      const f2 = partField(i);
      const ref = `const field=${lit(f2)},maxKey=${maxKey};
export function feedPart${i}(records){
 if(!Array.isArray(records))return null;
 const out=[];
 for(const rec of records){
  if(rec===null||typeof rec!=='object'||Array.isArray(rec)||![Object.prototype,null].includes(Object.getPrototypeOf(rec)))return null;
  const k=rec[field];
  if(typeof k!=='string'||k.length===0||k.length>maxKey)return null;
  out.push({k,v:rec.v===undefined?null:rec.v});
 }
 return out;
}
`;
      return N({
        key,
        role: 'feed',
        deps: [],
        instructions: feedText(i),
        reference: ref,
        publicBody: fnBody(`feedPart${i}`, feedPub(i)),
        holdBody: fnBody(`feedPart${i}`, feedHid(i)),
        mutants: [
          {
            id: 'feed-keep',
            description: 'feed normalizes missing v to zero instead of null',
            content: mustReplace(ref, `rec.v===undefined?null:rec.v`, `rec.v===undefined?0:rec.v`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeCombine = (key: string, parts: readonly string[]): NodeOut => {
      const imports = parts.map((p, j) => `import {feedPart${j}} from './${p}.mjs';`).join('\n');
      const ref = `${imports}
const PARTS=[${parts.map((_, j) => `feedPart${j}`).join(',')}];
export function combine(sets){
 if(!Array.isArray(sets)||sets.length!==PARTS.length)return null;
 const all=[];
 for(let j=0;j<PARTS.length;j++){
  const f=PARTS[j](sets[j]);
  if(f===null)return null;
  for(const x of f)all.push(x);
 }
 const win=new Map();
 for(let i=0;i<all.length;i++)win.set(all[i].k,i);
 const out=[];
 for(let i=0;i<all.length;i++)if(win.get(all[i].k)===i)out.push(all[i]);
 return out;
}
`;
      const goodIn = Array.from({length: count - 1}, (_, j) => feedIn(j));
      const dupIn = Array.from({length: count - 1}, (_, j) => [
        {[partField(j)]: 'dup', v: j},
        {[partField(j)]: `u${j}`, v: 0},
      ]);
      return N({
        key,
        role: 'join',
        deps: parts,
        instructions: combineText,
        reference: ref,
        publicBody: fnBody('combine', [
          [[goodIn], sCombine(goodIn)],
          [[parts.map(() => [])], sCombine(parts.map(() => []))],
        ]),
        holdBody: fnBody('combine', [
          [[null], null],
          [[[]], null],
          [[goodIn.slice(1)], null],
          [[dupIn], sCombine(dupIn)],
          [[Array.from({length: count - 1}, (_, j) => [{[partField(j)]: 'same', v: j}])], sCombine(Array.from({length: count - 1}, (_, j) => [{[partField(j)]: 'same', v: j}]))],
        ]),
        mutants: [
          {
            id: 'join-first',
            description: 'combine keeps the first occurrence instead of the last',
            content: mustReplace(ref, `win.set(all[i].k,i);`, `if(!win.has(all[i].k))win.set(all[i].k,i);`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeLedger = (key: string, pol: string, dedups: readonly string[]): NodeOut => {
      const imports = [`import {field,keep} from './${pol}.mjs';`, ...dedups.map((d2, kk) => `import {dedupRecords as d${kk}} from './${d2}.mjs';`)].join('\n');
      const ref = `${imports}
const DEDUPS=[${dedups.map((_, kk) => `d${kk}`).join(',')}];
export function ledger(sets){
 if(!Array.isArray(sets)||sets.length!==DEDUPS.length)return null;
 const all=[];
 for(let kk=0;kk<DEDUPS.length;kk++){
  const d=DEDUPS[kk](sets[kk]);
  if(d===null)return null;
  for(const x of d)all.push(x);
 }
 const win=new Map();
 for(let i=0;i<all.length;i++)win.set(all[i][field],i);
 const out=[];
 for(let i=0;i<all.length;i++)if(win.get(all[i][field])===i)out.push(all[i]);
 return {kept:out.length,keys:out.map(rec=>rec[field])};
}
`;
      return N({
        key,
        role: 'ledger',
        deps: [pol, ...dedups],
        instructions: ledgerText(dedups),
        reference: ref,
        publicBody: fnBody('ledger', [
          [[ledgerFeeds(sparseK)], sLedger(ledgerFeeds(sparseK), sparseK)],
        ]),
        holdBody: fnBody('ledger', [
          [[null], null],
          [[[]], null],
          [[ledgerFeeds(sparseK).slice(1)], null],
          [[Array.from({length: sparseK}, () => [rec('x', 1), rec('x', 2)])], sLedger(Array.from({length: sparseK}, () => [rec('x', 1), rec('x', 2)]), sparseK)],
        ]),
        mutants: [
          {
            id: 'ledger-reverse',
            description: 'ledger reverses the output key order',
            content: mustReplace(ref, `keys:out.map(rec=>rec[field])`, `keys:out.map(rec=>rec[field]).reverse()`),
            publicPass: true,
          },
        ],
      });
    };
    const nodeProbeD = (key: string, i: number): NodeOut => {
      const ref = `const field=${lit(`z${i}`)},maxKey=${maxKey};
export function probe${i}(rec){
 if(rec===null||typeof rec!=='object'||Array.isArray(rec)||![Object.prototype,null].includes(Object.getPrototypeOf(rec)))return null;
 const k=rec[field];
 if(typeof k!=='string'||k.length===0||k.length>maxKey)return null;
 return k;
}
`;
      return N({
        key,
        role: 'probe',
        deps: [],
        instructions: probeText(i),
        reference: ref,
        publicBody: fnBody(`probe${i}`, [
          [[{[`z${i}`]: 'a'}], 'a'],
          [[{[`z${i}`]: ''}], null],
        ]),
        holdBody: fnBody(`probe${i}`, [
          [[null], null], [[{}], null], [[5], null],
          [[{[`z${i}`]: 'x'.repeat(maxKey)}], 'x'.repeat(maxKey)],
          [[{[`z${i}`]: 'x'.repeat(maxKey + 1)}], null],
        ]),
        mutants: [
          {
            id: 'probe-num',
            description: 'probe accepts numeric fields',
            content: mustReplace(ref, `typeof k!=='string'`, `typeof k!=='string'&&typeof k!=='number'`),
            publicPass: true,
          },
        ],
      });
    };

    const nodes: NodeOut[] = [];
    if (topology === 'independent') {
      for (let i = 0; i < count / 4; i++) {
        const p = `pol-${i}`, kf = `keyof-${i}`, dd = `dedup-${i}`, rp = `report-${i}`;
        nodes.push(nodePol(p), nodeKeyof(kf, p), nodeDedup(dd, kf, p), nodeReport(rp, dd, kf));
      }
    } else if (topology === 'fanin') {
      const parts: string[] = [];
      for (let i = 0; i < count - 1; i++) {
        const k2 = `feed-${i}`;
        parts.push(k2);
        nodes.push(nodeFeed(k2, i));
      }
      nodes.push(nodeCombine('join-0', parts));
    } else {
      // sparse: shared policy + keyof->dedup branch pairs + ledger join + probes
      const plan = sparsePlan(count);
      nodes.push(nodePol('pol-0'));
      const dedups: string[] = [];
      for (let i = 0; i < plan.pairs; i++) {
        const kf = `keyof-${i}`, dd = `dedup-${i}`;
        nodes.push(nodeKeyof(kf, 'pol-0'), nodeDedup(dd, kf, 'pol-0'));
        if (i % 2 === 0) dedups.push(dd);
      }
      nodes.push(nodeLedger('ledger-0', 'pol-0', dedups));
      for (let i = 0; i < plan.solos; i++) nodes.push(nodeProbeD(`probe-${i}`, i));
    }

    const menu: {role: string; desc: string; f: (s: string) => string}[] = [];
    if (topology === 'fanin') {
      menu.push(
        {
          role: 'feed',
          desc: 'one feed normalizes missing v to zero instead of null',
          f: (s) => mustReplace(s, `rec.v===undefined?null:rec.v`, `rec.v===undefined?0:rec.v`),
        },
        {
          role: 'join',
          desc: 'combine keeps the first occurrence instead of the last',
          f: (s) => mustReplace(s, `win.set(all[i].k,i);`, `if(!win.has(all[i].k))win.set(all[i].k,i);`),
        },
      );
    } else {
      menu.push(
        {
          role: 'pol',
          desc: 'policy exports the opposite keep rule',
          f: (s) => mustReplace(s, `keep=${lit(keep)}`, `keep=${lit(keep === 'first' ? 'last' : 'first')}`),
        },
        {
          role: 'keyof',
          desc: 'keyof accepts numeric keys',
          f: (s) => mustReplace(s, `typeof k!=='string'`, `typeof k!=='string'&&typeof k!=='number'`),
        },
      );
      if (topology === 'independent') {
        menu.push(
          {
            role: 'dedup',
            desc: keep === 'first' ? 'dedup keeps the last occurrence' : 'dedup keeps the first occurrence',
            f: (s) =>
              mustReplace(s, `if(keep==='first'){`, `if(keep==='last'){`),
          },
          {
            role: 'report',
            desc: 'report counts one extra dropped record',
            f: (s) => mustReplace(s, `dropped:records.length-d.length`, `dropped:records.length-d.length+1`),
          },
        );
      } else {
        menu.push({
          role: 'ledger',
          desc: 'ledger reverses the output key order',
          f: (s) => mustReplace(s, `keys:out.map(rec=>rec[field])`, `keys:out.map(rec=>rec[field]).reverse()`),
        });
      }
    }
    const d = menu[variant % menu.length]!;
    const key = findKey(nodes, d.role);
    seedDefect(nodes, key, d.f);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (!['keyof', 'feed', 'probe'].includes(n.role)) continue;
      const fn = /export function (\w+)\(/.exec(n.reference)![1]!;
      const index = Number(n.key.split('-').at(-1));
      const record = n.role === 'keyof' ? {[field]: 'x'} : n.role === 'feed' ? {[partField(index)]: 'x', v: 1} : {['z' + index]: 'x'};
      nodes[i] = {...n, holdBody: n.holdBody + '\n' + plainChecks(fn, record, n.role === 'feed' ? [{k: 'x', v: 1}] : 'x', n.role === 'feed')};
    }
    return {
      goal: `Repair the deduplication modules so the whole contract is satisfied. Records key on the ${lit(field)} property (nonempty string of at most ${maxKey} chars); the keep policy is ${lit(keep)}.`,
      defect: `${key}: ${d.desc}`,
      nodes,
    };
  },
};

export const f2: readonly Family[] = [intervals, apportion, topk, dedup];
