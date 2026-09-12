import {N, fnBody, keepInputs, mod, mulberry32, mustReplace, raw, ri, seedDefect, sparseJoinSinks, sparsePlan} from '../common.ts';
import type {Case, Family, FamilyBuild, NodeOut, Topology} from '../common.ts';

type Deps = number[][];
type Mut = {node: number; tag: string} | null;
type Ev = (i: number, a: readonly unknown[], m: Mut) => unknown;
interface MutDef {id: string; desc: string; tag: string; apply: (src: string) => string}
interface CG {pub: Case[]; pk: unknown[][]; hold: Case[]; hk: unknown[][]; hr: string}

const keyOf = (i: number): string => `n${i}`;
const PO = `const po=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);`;
const poT = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const cp = (a: readonly unknown[]): unknown[] => a.map((x) => JSON.parse(JSON.stringify(x)) as unknown);
const rep = (from: string, to: string) => (src: string) => mustReplace(src, from, to);

function layout(topo: Topology, count: number): Deps {
  const d: Deps = Array.from({length: count}, () => []);
  if (topo === 'chain') for (let i = 1; i < count; i++) d[i] = [i - 1];
  else if (topo === 'fanout') for (let i = 1; i < count; i++) d[i] = [0];
  else if (topo === 'fanin') d[count - 1] = [...Array(count - 1).keys()];
  else if (topo === 'diamond') {
    for (let i = 1; i < count - 1; i++) d[i] = [0];
    d[count - 1] = [...Array(count - 2).keys()].map((k) => k + 1);
  } else if (topo === 'sparse') {
    const {pairs} = sparsePlan(count);
    for (let p = 0; p < pairs; p++) d[2 + 2 * p] = [1 + 2 * p];
    d[1 + 2 * pairs] = [0, ...sparseJoinSinks(pairs).map((p) => 2 + 2 * p)];
  }
  return d;
}
const roleOf = (d: readonly number[]): string => (d.length === 0 ? 'core' : d.length === 1 ? 'gate' : 'join');

/** Observable difference: return value or caller-visible argument state. */
const changed = (ev: Ev, j: number, a: readonly unknown[], m: Mut): boolean => {
  const am = cp(a), ar = cp(a);
  const rm = ev(j, am, m), rr = ev(j, ar, null);
  return JSON.stringify(rm) !== JSON.stringify(rr) || JSON.stringify(am) !== JSON.stringify(ar);
};
const pubOk = (ev: Ev, pub: readonly (readonly unknown[])[][], m: {node: number; tag: string}): boolean =>
  pub.every((ls, j) => ls.every((a) => !changed(ev, j, a, m)));
/** Drop candidates that have no observed semantic difference in this composition.
 * A local bound can be redundant behind a stricter provider. Preflight still
 * requires every selected baseline and mutant to fail the actual final oracle. */
function observable(ev: Ev, all: readonly (readonly unknown[])[][], defs: readonly MutDef[][]): MutDef[][] {
  return defs.map((ms, i) => ms.filter(m =>
    all.some((ls, j) => ls.some(a => changed(ev, j, a, {node: i, tag: m.tag})))));
}
function seed(nodes: NodeOut[], deps: Deps, defs: readonly MutDef[][], variant: number, fam: string): string {
  const eligible = nodes.map((_, i) => i).filter(i => defs[i]!.length > 0);
  if (!eligible.length) throw new Error(`${fam}: no observable defect`);
  const prov = [...new Set(deps.flat())].filter(i => defs[i]!.length > 0).sort((a, b) => a - b);
  const cons = deps.map((d, i) => (d.length && defs[i]!.length ? i : -1)).filter((i) => i >= 0);
  const ti = variant % 2 === 0
    ? (prov.length ? prov[variant % prov.length]! : eligible[variant % eligible.length]!)
    : (cons.length ? cons[variant % cons.length]! : eligible[(variant + 1) % eligible.length]!);
  const md = defs[ti]![variant % defs[ti]!.length]!;
  seedDefect(nodes, keyOf(ti), md.apply);
  return `${fam} defect in src/${keyOf(ti)}.mjs: ${md.desc}`;
}
const pipeDefs: MutDef[] = [
  {id: 'gelim', desc: 'ops length bound uses >= so a full batch is rejected', tag: 'gelim', apply: rep('ops.length>LIM', 'ops.length>=LIM')},
  {id: 'tol', desc: 'a failing stage is skipped instead of aborting the batch', tag: 'tol', apply: rep('{s=f(s,ops);if(s===null)return null;}', '{const q=f(s,ops);if(q!==null)s=q;}')},
];

/* ---------------- inventory ---------------- */

function invBuild(variant: number, topo: Topology, count: number): FamilyBuild {
  const r = mulberry32(0x51a7 + variant * 7919);
  const deps = layout(topo, count);
  const P = deps.map((d) => (d.length === 0 ? {cap: ri(r, 20, 60)} : d.length === 1 ? {step: ri(r, 3, 9)} : {lim: ri(r, 2, 5)}));
  const minCap = (i: number): number => (deps[i]!.length ? Math.min(...deps[i]!.map(minCap)) : P[i]!.cap!);
  const ev: Ev = (i, a, m) => {
    const d = deps[i]!, p = P[i]!, tag = m !== null && m.node === i ? m.tag : '';
    const [stock, ops] = a as [Record<string, number>, {sku: string; d: number}[]];
    if (d.length === 0) {
      if (!poT(stock) || !Array.isArray(ops) ||
          !Object.keys(stock).every((k) => Number.isSafeInteger(stock[k]) && stock[k]! >= 0 && stock[k]! <= p.cap!)) return null;
      const next: Record<string, number> = tag === 'alias' ? stock : {...stock};
      for (const op of ops) {
        if (!poT(op) || Object.keys(op).length !== 2 || typeof op.sku !== 'string' ||
            !Object.hasOwn(next, op.sku) || !Number.isSafeInteger(op.d)) return null;
        const v = tag === 'noacc' ? op.d : next[op.sku]! + op.d;
        if (tag === 'zban' ? v <= 0 : v < 0) return null;
        if (tag === 'gecap' ? v >= p.cap! : v > p.cap!) return null;
        next[op.sku] = v;
      }
      return next;
    }
    if (d.length === 1) {
      if (!Array.isArray(ops)) return null;
      for (const op of ops)
        if (poT(op) && Number.isSafeInteger(op.d) &&
            (tag === 'gestep' ? Math.abs(op.d) >= p.step! : tag === 'side' ? op.d > p.step! : Math.abs(op.d) > p.step!)) return null;
      return ev(d[0]!, a, m);
    }
    if (!Array.isArray(ops) || (tag === 'gelim' ? ops.length >= p.lim! : ops.length > p.lim!)) return null;
    let s: unknown = stock;
    for (const j of d) {
      const q = ev(j, [s, ops], m);
      if (tag === 'tol') { if (q !== null) s = q; } else { if (q === null) return null; s = q; }
    }
    return s;
  };
  const ref = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) return mod(PO, `const CAP=${p.cap!};`,
      `const vs=(s)=>po(s)&&Object.keys(s).every((k)=>Number.isSafeInteger(s[k])&&s[k]>=0&&s[k]<=CAP);`,
      `export function run(stock,ops){`,
      `if(!vs(stock)||!Array.isArray(ops))return null;`,
      `const next={...stock};`,
      `for(const op of ops){`,
      `if(!po(op)||Object.keys(op).length!==2||typeof op.sku!=='string'||!Object.hasOwn(next,op.sku)||!Number.isSafeInteger(op.d))return null;`,
      `const v=next[op.sku]+op.d;`,
      `if(v<0||v>CAP)return null;`,
      `next[op.sku]=v;}`,
      `return next;}`);
    if (d.length === 1) return mod(`import{run as up}from'./${keyOf(d[0]!)}.mjs';`, PO, `const STEP=${p.step!};`,
      `export function run(stock,ops){`,
      `if(!Array.isArray(ops))return null;`,
      `for(const op of ops)if(po(op)&&Number.isSafeInteger(op.d)&&Math.abs(op.d)>STEP)return null;`,
      `return up(stock,ops);}`);
    return mod(...d.map((j, k) => `import{run as s${k}}from'./${keyOf(j)}.mjs';`), `const LIM=${p.lim!};`,
      `export function run(stock,ops){`,
      `if(!Array.isArray(ops)||ops.length>LIM)return null;`,
      `let s=stock;`,
      `for(const f of[${d.map((_, k) => 's' + k).join(',')}]){s=f(s,ops);if(s===null)return null;}`,
      `return s;}`);
  };
  const defs = (i: number): MutDef[] => {
    const d = deps[i]!;
    if (d.length === 0) return [
      {id: 'gecap', desc: 'cap check rejects a quantity equal to CAP', tag: 'gecap', apply: rep('v>CAP', 'v>=CAP')},
      {id: 'zban', desc: 'floor check rejects a zero quantity', tag: 'zban', apply: rep('v<0', 'v<=0')},
      {id: 'alias', desc: 'ops mutate the caller stock object', tag: 'alias', apply: rep('const next={...stock};', 'const next=stock;')},
      {id: 'noacc', desc: 'delta replaces the stored quantity instead of accumulating', tag: 'noacc', apply: rep('const v=next[op.sku]+op.d;', 'const v=op.d;')},
    ];
    if (d.length === 1) return [
      {id: 'gestep', desc: 'step bound rejects |d| == STEP', tag: 'gestep', apply: rep('Math.abs(op.d)>STEP', 'Math.abs(op.d)>=STEP')},
      {id: 'side', desc: 'only positive deltas are bounded', tag: 'side', apply: rep('Math.abs(op.d)>STEP', 'op.d>STEP')},
    ];
    return pipeDefs;
  };
  const instr = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0)
      return `Export run(stock, ops). stock must be a plain object (prototype Object.prototype or null) mapping strings to safe integers in [0, ${p.cap!}]. ops must be an array of plain objects with exactly the keys sku (a string present in stock) and d (a safe integer). Apply ops in array order; after each op the quantity must stay in [0, ${p.cap!}]. If anything is invalid return null applying nothing. Never mutate stock; always return a fresh object, a new reference even for empty ops.`;
    if (d.length === 1)
      return `Export run(stock, ops). If ops is not an array return null. For every element that is a plain object with a safe-integer d, return null when |d| > ${p.step!}. Otherwise return the result of run(stock, ops) imported from './${keyOf(d[0]!)}.mjs'. Do not mutate stock.`;
    return `Export run(stock, ops). If ops is not an array or ops.length > ${p.lim!} return null. Otherwise feed the current stock through the stages imported from ${d.map((j) => `'./${keyOf(j)}.mjs'`).join(', ')} in that order: s = stage(s, ops); if a stage returns null return null. Return the final s.`;
  };
  const st = (v: number) => ({a: v, b: v, c: v});
  const C = (i: number, a: unknown[]): Case => [a, ev(i, a, null)];
  const cases = (i: number): CG => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) {
      const cap = p.cap!;
      return {
        pub: [
          C(i, [{a: 4, b: 9, c: 0}, [{sku: 'b', d: -9}]]),
          C(i, [{a: 1, b: 2, c: 3}, [{sku: 'a', d: 2}, {sku: 'c', d: -2}, {sku: 'a', d: 1}]]),
          C(i, [st(0), []]),
          C(i, [st(1), [{sku: 'zz', d: 1}]]),
          C(i, [st(2), [{sku: 'a', d: -3}]]),
          C(i, [st(1), [{sku: 'a', d: 1.5}]]),
          C(i, [st(1), 'x']),
          C(i, [st(1), [{sku: 'a', d: 1, x: 0}]]),
          C(i, [{a: cap, b: 0, c: 0}, [{sku: 'a', d: 1}]]),
        ],
        pk: [[{a: 3, b: 3, c: 3}, [{sku: 'a', d: 1}]], [{a: 3, b: 3, c: 3}, [{sku: 'a', d: 1}, {sku: 'zz', d: 1}]]],
        hold: [
          C(i, [{a: cap - 2, b: 1, c: 1}, [{sku: 'a', d: 2}]]),
          C(i, [{a: 3, b: 1, c: 1}, [{sku: 'a', d: -3}]]),
          C(i, [{a: 1, b: 0, c: 0}, [{sku: 'a', d: 1}, {sku: 'a', d: 1}]]),
          C(i, [{a: 5, b: 5, c: 5}, [{sku: 'a', d: 1}, {sku: 'b', d: -9}]]),
          C(i, [st(2), [{sku: 'a', d: 9007199254740992}]]),
          C(i, [{a: 9007199254740992, b: 0, c: 0}, []]),
          C(i, [st(1), [[1, 2]]]),
          C(i, [{a: cap, b: cap, c: cap}, []]),
        ],
        hk: [[{a: 4, b: 4, c: 4}, [{sku: 'b', d: -2}]]],
        hr: raw(`{const s={a:1,b:2,c:3};assert.notEqual(f(s,[]),s);}`, `assert.equal(f(new Date(),[]),null);`, `assert.deepEqual(f(Object.assign(Object.create(null),{a:1}),[]),{a:1});`),
      };
    }
    if (d.length === 1) {
      const stp = p.step!;
      return {
        pub: [
          C(i, [st(5), [{sku: 'a', d: 2}, {sku: 'b', d: -2}]]),
          C(i, [st(9), [{sku: 'a', d: stp + 1}]]),
          C(i, [st(1), [{sku: 'zz', d: 1}]]),
          C(i, [st(1), [{sku: 'a', d: 'x'}]]),
          C(i, [st(1), 'x']),
          C(i, [st(0), []]),
        ],
        pk: [[st(4), [{sku: 'a', d: 1}]]],
        hold: [
          C(i, [st(9), [{sku: 'a', d: stp}]]),
          C(i, [st(9), [{sku: 'a', d: -(stp + 1)}]]),
          C(i, [{a: 9, b: 1, c: 1}, [{sku: 'a', d: -stp}, {sku: 'b', d: stp}]]),
          C(i, [st(2), [{sku: 'a', d: 9007199254740992}]]),
          C(i, [st(1), [{sku: 'a'}]]),
        ],
        hk: [[st(6), [{sku: 'b', d: -1}]]],
        hr: raw(`assert.equal(f(new Date(),[]),null);`),
      };
    }
    const lim = p.lim!, mc = Math.min(...d.map(minCap));
    const fill = Array.from({length: lim}, (_, k) => ({sku: 'abc'[k % 3]!, d: k % 2 ? -1 : 1}));
    return {
      pub: [
        C(i, [st(4), [{sku: 'a', d: 1}, {sku: 'b', d: -1}]]),
        C(i, [st(4), Array.from({length: lim + 1}, () => ({sku: 'a', d: 1}))]),
        C(i, [st(4), [{sku: 'a', d: 99}]]),
        C(i, [st(4), [{sku: 'zz', d: 1}]]),
        C(i, [st(4), 'x']),
      ],
      pk: [[st(5), [{sku: 'a', d: 1}]]],
      hold: [
        C(i, [st(mc - lim), fill]),
        C(i, [st(4), [{sku: 'a', d: mc}]]),
        C(i, [st(4), [{sku: 'a', d: 1}, {sku: 'zz', d: 1}]]),
        C(i, [st(0), []]),
      ],
      hk: [[st(6), [{sku: 'c', d: 1}]]],
      hr: raw(`assert.equal(f(new Date(),[]),null);`),
    };
  };
  const cgs = deps.map((_, i) => cases(i));
  const pubA = cgs.map((cg) => [...cg.pub.map((c) => c[0]), ...cg.pk] as unknown[][]);
  const allA = cgs.map((cg, i) => [...pubA[i]!, ...cg.hold.map((c) => c[0]), ...cg.hk] as unknown[][]);
  const mds = observable(ev, allA, deps.map((_, i) => defs(i)));
  const nodes: NodeOut[] = deps.map((d, i) => N({
    key: keyOf(i), role: roleOf(d), deps: d.map(keyOf), instructions: instr(i), reference: ref(i),
    publicBody: fnBody('run', cgs[i]!.pub, keepInputs(cgs[i]!.pk)),
    holdBody: fnBody('run', cgs[i]!.hold, [keepInputs(cgs[i]!.hk), cgs[i]!.hr].filter(Boolean).join('\n')),
    mutants: mds[i]!.map((md) => ({id: md.id, description: md.desc, content: md.apply(ref(i)), publicPass: pubOk(ev, pubA, {node: i, tag: md.tag})})),
  }));
  const defect = seed(nodes, deps, mds, variant, 'inventory');
  return {goal: 'Repair the inventory batch modules under src/ so every exported run(stock, ops) satisfies its documented contract.', defect, nodes};
}

/* ---------------- workflow ---------------- */

function wfBuild(variant: number, topo: Topology, count: number): FamilyBuild {
  const r = mulberry32(0x77f1 + variant * 7919);
  const deps = layout(topo, count);
  const NS = ri(r, 3, 4);
  const EVS = ['e0', 'e1', 'e2'], TERMS = ['end', 'bad'];
  const STATES = [...Array(NS).keys()].map((k) => 's' + k);
  const TERM = new Set(TERMS);
  interface Wp {tab?: Record<string, Record<string, string>>; block?: string[]; cs?: string; ce?: string; ct?: string}
  const P: Wp[] = new Array(count);
  const ev: Ev = (i, a, m) => {
    const d = deps[i]!, p = P[i]!, tag = m !== null && m.node === i ? m.tag : '';
    const [stt, e] = a as [string, string];
    if (d.length === 0) {
      if (TERM.has(stt)) return tag === 'termerr' || tag === 'term1' && stt === 'bad' ? 'ERR' : 'TERM';
      const row = Object.hasOwn(p.tab!, stt) ? p.tab![stt] : undefined;
      if (row === undefined) return 'ERR';
      let n: string | undefined = Object.hasOwn(row, e) ? row[e] : undefined;
      if (tag === 'cell' && stt === p.cs && e === p.ce) n = p.ct;
      return n === undefined ? (tag === 'stay' ? stt : 'ERR') : n;
    }
    if (d.length === 1) {
      const k = tag === 'keyord' ? `${e}:${stt}` : `${stt}:${e}`;
      const has = p.block!.includes(k);
      if (tag === 'inv' ? !has : tag === 'unblock' ? false : has) return 'ERR';
      return ev(d[0]!, a, m);
    }
    const ds = tag === 'lastonly' ? [d[1]!] : d;
    let r2: unknown = 'ERR';
    for (const j of ds) {
      r2 = ev(j, a, m);
      if (tag === 'swerr' ? r2 === 'ERR' : tag === 'nofb' ? true : r2 !== 'ERR') break;
    }
    return r2;
  };
  for (let i = 0; i < count; i++) {
    const d = deps[i]!;
    if (d.length === 0) {
      const tab: Record<string, Record<string, string>> = {};
      for (const s of STATES) {
        const row: Record<string, string> = {};
        for (const e of EVS) if (r() < 0.7) row[e] = [...STATES, ...TERMS][ri(r, 0, NS + 1)]!;
        tab[s] = row;
      }
      tab[`s${NS - 1}`]!['e2'] = 's0';
      if (EVS.every((e) => e in tab[STATES[0]!]!)) delete tab[STATES[0]!]!['e0'];
      P[i] = {tab, cs: `s${NS - 1}`, ce: 'e2', ct: 's1'};
    } else if (d.length === 1) {
      const live: string[] = [];
      for (const s of STATES) for (const e of EVS) if (ev(d[0]!, [s, e], null) !== 'ERR') live.push(`${s}:${e}`);
      const p0 = live.length ? live[ri(r, 0, live.length - 1)]! : `end:reserved${i}`;
      const extra = live.filter((k) => k !== p0 && k.split(':').reverse().join(':') !== p0);
      const block = r() < 0.5 && extra.length ? [p0, extra[ri(r, 0, extra.length - 1)]!] : [p0];
      P[i] = {block};
    } else P[i] = {};
  }
  const J = deps.findIndex((d) => d.length > 1);
  if (J >= 0) {
    const setAcc = (i: number, k: string, on: boolean): void => {
      const d = deps[i]!, [s, e] = k.split(':') as [string, string];
      if (d.length === 0) {
        if (on) P[i]!.tab![s]![e] = P[i]!.tab![s]![e] ?? 's0';
        else delete P[i]!.tab![s]![e];
      } else {
        const b = new Set(P[i]!.block);
        if (on) { b.delete(k); P[i]!.block = [...b]; setAcc(d[0]!, k, true); }
        else { b.add(k); P[i]!.block = [...b]; }
      }
    };
    const [c0, c1] = [deps[J]![0]!, deps[J]![1]!];
    setAcc(c0, 's0:e0', false); setAcc(c1, 's0:e0', true);
    setAcc(c0, 's1:e1', true); setAcc(c1, 's1:e1', false);
  }
  for (let i = 0; i < count; i++)
    if (deps[i]!.length === 0 && STATES.every((s) => EVS.every((e) => e in P[i]!.tab![s]!))) delete P[i]!.tab!['s2']!['e0'];
  const rowTxt = (row: Record<string, string>): string => Object.entries(row).map(([k, v]) => `${k}:'${v}'`).join(',');
  const ref = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) return mod(
      `const T={${STATES.map((s) => `${s}:{${rowTxt(p.tab![s]!)}}`).join(',')}};`,
      `const TERM=new Set(['end','bad']);`,
      `export function step(state,event){`,
      `if(TERM.has(state))return'TERM';`,
      `const r=Object.hasOwn(T,state)?T[state]:undefined;`,
      `if(r===undefined)return'ERR';`,
      `const n=Object.hasOwn(r,event)?r[event]:undefined;`,
      `return n===undefined?'ERR':n;}`);
    if (d.length === 1) return mod(`import{step as up}from'./${keyOf(d[0]!)}.mjs';`,
      `const BLOCK=new Set([${p.block!.map((k) => `'${k}'`).join(',')}]);`,
      `export function step(state,event){`,
      `if(BLOCK.has(state+':'+event))return'ERR';`,
      `return up(state,event);}`);
    return mod(...d.map((j, k) => `import{step as s${k}}from'./${keyOf(j)}.mjs';`),
      `export function step(state,event){`,
      `let r='ERR';`,
      `for(const f of[${d.map((_, k) => 's' + k).join(',')}]){r=f(state,event);if(r!=='ERR')break;}`,
      `return r;}`);
  };
  const defs = (i: number): MutDef[] => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) {
      const sl = p.cs!, row = p.tab![sl]!;
      const from = `${sl}:{${rowTxt(row)}}`, to = `${sl}:{${rowTxt({...row, e2: 's1'})}}`;
      return [
        {id: 'cell', desc: `transition ${sl}:e2 retargeted to s1`, tag: 'cell', apply: rep(from, to)},
        {id: 'termerr', desc: 'terminal states report ERR', tag: 'termerr', apply: rep(`return'TERM'`, `return'ERR'`)},
        {id: 'stay', desc: 'absent events keep the current state', tag: 'stay', apply: rep(`n===undefined?'ERR':n`, `n===undefined?state:n`)},
        {id: 'term1', desc: "only 'end' is treated as terminal", tag: 'term1', apply: rep(`['end','bad']`, `['end']`)},
      ];
    }
    if (d.length === 1) return [
      {id: 'keyord', desc: 'block key composed as event:state', tag: 'keyord', apply: rep(`state+':'+event`, `event+':'+state`)},
      {id: 'inv', desc: 'block predicate negated', tag: 'inv', apply: rep(`if(BLOCK.has(state+':'+event))return'ERR';`, `if(!BLOCK.has(state+':'+event))return'ERR';`)},
      {id: 'unblock', desc: 'block list never consulted', tag: 'unblock', apply: rep(`if(BLOCK.has(state+':'+event))return'ERR';`, `if(false)return'ERR';`)},
    ];
    return [
      {id: 'nofb', desc: 'fallback skipped: first stage result wins', tag: 'nofb', apply: rep(`{r=f(state,event);if(r!=='ERR')break;}`, `{r=f(state,event);break;}`)},
      {id: 'swerr', desc: 'stops at the first ERR instead of the first success', tag: 'swerr', apply: rep(`if(r!=='ERR')break;`, `if(r==='ERR')break;`)},
      {id: 'lastonly', desc: 'only the second stage is consulted', tag: 'lastonly', apply: rep(`of[${d.map((_, k) => 's' + k).join(',')}]`, `of[s1]`)},
    ];
  };
  const instr = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0)
      return `Export step(state, event). Non-terminal states are ${STATES.join(', ')}; terminal states are end and bad. A terminal state returns 'TERM' for any event. An unknown state returns 'ERR'. A known state whose table row lacks the event returns 'ERR'. Otherwise return the table target. Table T = ${JSON.stringify(p.tab)}.`;
    if (d.length === 1)
      return `Export step(state, event). If state+':'+event is one of ${JSON.stringify(p.block)} return 'ERR'; this check runs before anything else. Otherwise return step(state, event) imported from './${keyOf(d[0]!)}.mjs'.`;
    return `Export step(state, event). Consult the stages imported from ${d.map((j) => `'./${keyOf(j)}.mjs'`).join(', ')} in that order and return the first result that is not 'ERR'; if every stage returns 'ERR' return 'ERR'.`;
  };
  const pairs: [string, string][] = [];
  for (const s of [...STATES, ...TERMS, 'qq', 'constructor', '__proto__']) for (const e of [...EVS, 'zz', 'toString', '__proto__']) pairs.push([s, e]);
  for (const p of P) for (const key of p.block ?? []) pairs.push(key.split(':') as [string, string]);
  const cases = (i: number): CG => {
    const d = deps[i]!, p = P[i]!;
    const resv = new Set<string>(p.block ?? []);
    if (d.length === 0) resv.add(`${p.cs}:${p.ce}`);
    if (d.length > 1) { resv.add('s0:e0'); resv.add('s1:e1'); }
    const all = pairs.map(([s, e]) => ({s, e, r: ev(i, [s, e], null)}));
    const norm = all.filter((x) => x.r !== 'ERR' && x.r !== 'TERM' && !resv.has(`${x.s}:${x.e}`));
    const term = all.filter((x) => x.r === 'TERM');
    const err = all.filter((x) => x.r === 'ERR' && !resv.has(`${x.s}:${x.e}`));
    const pub: Case[] = [...norm.slice(0, 4), ...term.slice(0, 1), ...err.slice(0, 2)].map((x) => [[x.s, x.e], x.r]);
    const hold: Case[] = [];
    if (d.length === 0) {
      hold.push([[p.cs!, p.ce!], ev(i, [p.cs!, p.ce!], null)]);
      const miss = all.find((x) => x.r === 'ERR' && STATES.includes(x.s) && EVS.includes(x.e));
      if (miss) hold.push([[miss.s, miss.e], 'ERR']);
      hold.push([['bad', 'e1'], 'TERM']);
      const n2 = norm[norm.length - 1];
      if (n2) hold.push([[n2.s, n2.e], n2.r]);
    } else if (d.length === 1) {
      for (const k of p.block!) { const [s, e] = k.split(':'); hold.push([[s!, e!], 'ERR']); }
      const nz = norm[0];
      if (nz) hold.push([[nz.s, nz.e], nz.r]);
      hold.push([['bad', 'e0'], ev(i, ['bad', 'e0'], null)]);
    } else {
      hold.push([['s0', 'e0'], ev(i, ['s0', 'e0'], null)]);
      hold.push([['s1', 'e1'], ev(i, ['s1', 'e1'], null)]);
      hold.push([['end', 'e2'], 'TERM']);
      const nz = norm[0];
      if (nz) hold.push([[nz.s, nz.e], nz.r]);
    }
    return {pub, pk: [], hold, hk: [], hr: ''};
  };
  const cgs = deps.map((_, i) => cases(i));
  const pubA = cgs.map((cg) => [...cg.pub.map((c) => c[0])] as unknown[][]);
  const allA = cgs.map((cg, i) => [...pubA[i]!, ...cg.hold.map((c) => c[0])] as unknown[][]);
  const mds = observable(ev, allA, deps.map((_, i) => defs(i)));
  const nodes: NodeOut[] = deps.map((d, i) => N({
    key: keyOf(i), role: roleOf(d), deps: d.map(keyOf), instructions: instr(i), reference: ref(i),
    publicBody: fnBody('step', cgs[i]!.pub),
    holdBody: fnBody('step', cgs[i]!.hold),
    mutants: mds[i]!.map((md) => ({id: md.id, description: md.desc, content: md.apply(ref(i)), publicPass: pubOk(ev, pubA, {node: i, tag: md.tag})})),
  }));
  const defect = seed(nodes, deps, mds, variant, 'workflow');
  return {goal: 'Repair the workflow state-machine modules under src/ so every exported step(state, event) satisfies its documented contract.', defect, nodes};
}

/* ---------------- permissions ---------------- */

function pmBuild(variant: number, topo: Topology, count: number): FamilyBuild {
  const r = mulberry32(0x9c4d + variant * 7919);
  const deps = layout(topo, count);
  const UNI = ['p1', 'p2', 'p3', 'p4'];
  const P = deps.map((d, i) =>
    d.length === 0 ? {d0: [`u${i}`, 'p0']} : d.length === 1 ? {pin: [UNI[ri(r, 0, 3)]!]} : {cut: [`w${i}`]});
  const ev: Ev = (i, a, m) => {
    const d = deps[i]!, p = P[i]!, tag = m !== null && m.node === i ? m.tag : '';
    const [allow, deny] = a as [string[], string[]];
    const strs = (v: unknown): v is string[] => Array.isArray(v) && Array.from(v).every((x) => typeof x === 'string');
    if (d.length === 0) {
      if (!strs(allow) || !strs(deny)) return null;
      const dd = new Set(deny);
      for (const x of p.d0!) { if (tag === 'und0') dd.delete(x); else dd.add(x); }
      const out: string[] = [];
      for (const x of tag === 'nodupe' ? allow : new Set(allow))
        if (tag === 'keepdeny' ? dd.has(x) : !dd.has(x)) out.push(x);
      return tag === 'nosort' ? out : out.sort();
    }
    if (d.length === 1) {
      if (!Array.isArray(deny)) return null;
      const dd = tag === 'pindeny' ? deny : tag === 'pininv' ? deny.filter((x) => p.pin!.includes(x)) : deny.filter((x) => !p.pin!.includes(x));
      return ev(d[0]!, [allow, dd], m);
    }
    let acc: string[] | null = null;
    for (const j of d) {
      const v = ev(j, a, m) as string[] | null;
      if (v === null) return null;
      acc = tag === 'lastonly' ? v : acc === null ? v : acc.concat(v);
    }
    const arr = tag === 'nodupe' ? [...acc!] : [...new Set(acc!)];
    const fil = tag === 'nocut' ? arr : arr.filter((x) => !p.cut!.includes(x));
    return fil.sort();
  };
  const ref = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) return mod(`const D0=new Set([${p.d0!.map((q) => `'${q}'`).join(',')}]);`,
      `export function eff(allow,deny){`,
      `if(!Array.isArray(allow)||!Array.isArray(deny)||!Array.from(allow).every((p)=>typeof p==='string')||!Array.from(deny).every((p)=>typeof p==='string'))return null;`,
      `const d=new Set(deny);for(const p of D0)d.add(p);`,
      `const out=[];for(const p of new Set(allow))if(!d.has(p))out.push(p);`,
      `return out.sort();}`);
    if (d.length === 1) return mod(`import{eff as up}from'./${keyOf(d[0]!)}.mjs';`,
      `const PIN=[${p.pin!.map((q) => `'${q}'`).join(',')}];`,
      `export function eff(allow,deny){`,
      `if(!Array.isArray(deny))return null;`,
      `return up(allow,deny.filter((p)=>!PIN.includes(p)));}`);
    return mod(...d.map((j, k) => `import{eff as s${k}}from'./${keyOf(j)}.mjs';`),
      `const CUT=[${p.cut!.map((q) => `'${q}'`).join(',')}];`,
      `export function eff(allow,deny){`,
      `let a=null;`,
      `for(const f of[${d.map((_, k) => 's' + k).join(',')}]){const v=f(allow,deny);if(v===null)return null;a=a===null?v:a.concat(v);}`,
      `const c=new Set(CUT);`,
      `return[...new Set(a)].filter((p)=>!c.has(p)).sort();}`);
  };
  const defs = (i: number): MutDef[] => {
    const d = deps[i]!;
    if (d.length === 0) return [
      {id: 'keepdeny', desc: 'deny predicate inverted: only denied entries kept', tag: 'keepdeny', apply: rep('!d.has(p)', 'd.has(p)')},
      {id: 'nodupe', desc: 'allow duplicates leak into the result', tag: 'nodupe', apply: rep('new Set(allow)', 'allow')},
      {id: 'und0', desc: 'base denies removed from the deny set', tag: 'und0', apply: rep('d.add(p)', 'd.delete(p)')},
      {id: 'nosort', desc: 'result not sorted', tag: 'nosort', apply: rep('return out.sort();', 'return out;')},
    ];
    if (d.length === 1) return [
      {id: 'pindeny', desc: 'pinned entries are no longer shielded from deny', tag: 'pindeny', apply: rep('deny.filter((p)=>!PIN.includes(p))', 'deny')},
      {id: 'pininv', desc: 'only pinned entries stay denied', tag: 'pininv', apply: rep('!PIN.includes(p)', 'PIN.includes(p)')},
    ];
    return [
      {id: 'nocut', desc: 'cut list never applied', tag: 'nocut', apply: rep('.filter((p)=>!c.has(p)).sort()', '.sort()')},
      {id: 'lastonly', desc: 'only the last stage contributes', tag: 'lastonly', apply: rep('a=a===null?v:a.concat(v)', 'a=v')},
      {id: 'nodupe', desc: 'stage results not deduplicated', tag: 'nodupe', apply: rep('new Set(a)', 'a')},
    ];
  };
  const instr = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0)
      return `Export eff(allow, deny). Both arguments must be arrays of strings, else return null. Result: a sorted array of the unique strings in allow that are absent from deny and absent from the embedded base-deny list D0 = ${JSON.stringify(p.d0)}. Never mutate the inputs; always return a fresh array.`;
    if (d.length === 1)
      return `Export eff(allow, deny). If deny is not an array return null. Remove every element of PIN = ${JSON.stringify(p.pin)} from deny first (pinned permissions cannot be denied), then return eff(allow, filteredDeny) imported from './${keyOf(d[0]!)}.mjs'.`;
    return `Export eff(allow, deny). Evaluate every imported stage from ${d.map((j) => `'./${keyOf(j)}.mjs'`).join(', ')} on the same arguments; if any returns null return null. Return the sorted unique union of all stage results with every element of CUT = ${JSON.stringify(p.cut)} removed. Never mutate the inputs.`;
  };
  // This family lists each two-argument vector inside one tuple.
  const C = (i: number, [a]: [unknown[]]): Case => [a, ev(i, a, null)];
  const cases = (i: number): CG => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) {
      return {
        pub: [
          C(i, [[['p1', 'p2'], ['p2']]]),
          C(i, [[[], []]]),
          C(i, [[['p3'], ['zz']]]),
          C(i, [['x', []]]),
          C(i, [[['p1', 5], []]]),
          C(i, [[['p2', 'p3'], ['p1']]]),
        ],
        pk: [[[['p1', 'p2'], ['p1']]][0] as unknown[]],
        hold: [
          C(i, [[[`u${i}`, 'p1'], []]]),
          C(i, [[['p2', 'p1', 'p2'], []]]),
          C(i, [[['p3', 'p1'], []]]),
          C(i, [[['p1'], ['p1']]]),
          C(i, [[['p1'], 'x']]),
        ],
        hk: [[[['p4'], []]][0] as unknown[]],
        hr: raw(`assert.equal(f('x',[]),null);`, `assert.equal(f(Array(2),[]),null);`, `{const a=['p1','p3'];assert.notEqual(f(a,[]),a);}`),
      };
    }
    if (d.length === 1) {
      const pin = p.pin![0]!;
      return {
        pub: [
          C(i, [[['p1', 'p2', 'p3'], ['p2']]]),
          C(i, [[['p3'], []]]),
          C(i, [[['p1'], 'x']]),
          C(i, [[['p1', 'p2'], ['p9']]]),
        ],
        pk: [[[['p1', 'p2'], ['p2']]][0] as unknown[]],
        hold: [
          C(i, [[[pin, 'p1'], [pin]]]),
          C(i, [[[pin, 'p1', 'p2'], [pin, 'p2']]]),
          C(i, [[[], []]]),
        ],
        hk: [],
        hr: raw(`assert.equal(f(new Date(),[]),null);`),
      };
    }
    const [c0, c1] = [d[0]!, d[1]!];
    return {
      pub: [
        C(i, [[['p1', 'p2'], []]]),
        C(i, [[['p3', 'p4'], ['p4']]]),
        C(i, [['x', []]]),
        C(i, [[['p1'], ['p1']]]),
      ],
      pk: [[[['p1', 'p3'], []]][0] as unknown[]],
      hold: [
        C(i, [[[`u${c1}`], []]]),
        C(i, [[['w' + i, 'p1'], []]]),
        C(i, [[['p1'], []]]),
        C(i, [[[`u${c0}`], []]]),
      ],
      hk: [],
      hr: '',
    };
  };
  const cgs = deps.map((_, i) => cases(i));
  const pubA = cgs.map((cg) => [...cg.pub.map((c) => c[0]), ...cg.pk] as unknown[][]);
  const allA = cgs.map((cg, i) => [...pubA[i]!, ...cg.hold.map((c) => c[0]), ...cg.hk] as unknown[][]);
  const mds = observable(ev, allA, deps.map((_, i) => defs(i)));
  const nodes: NodeOut[] = deps.map((d, i) => N({
    key: keyOf(i), role: roleOf(d), deps: d.map(keyOf), instructions: instr(i), reference: ref(i),
    publicBody: fnBody('eff', cgs[i]!.pub, keepInputs(cgs[i]!.pk)),
    holdBody: fnBody('eff', cgs[i]!.hold, [keepInputs(cgs[i]!.hk), cgs[i]!.hr].filter(Boolean).join('\n')),
    mutants: mds[i]!.map((md) => ({id: md.id, description: md.desc, content: md.apply(ref(i)), publicPass: pubOk(ev, pubA, {node: i, tag: md.tag})})),
  }));
  const defect = seed(nodes, deps, mds, variant, 'permissions');
  return {goal: 'Repair the allow/deny modules under src/ so every exported eff(allow, deny) satisfies its documented contract.', defect, nodes};
}

/* ---------------- ledger ---------------- */

function ldBuild(variant: number, topo: Topology, count: number): FamilyBuild {
  const r = mulberry32(0x33b7 + variant * 7919);
  const deps = layout(topo, count);
  const P = deps.map((d) => {
    if (d.length === 0) return {lim: ri(r, 30, 80)};
    if (d.length === 1) {
      const f = ri(r, 0, 2);
      let t = ri(r, 0, 2);
      while (t === f) t = ri(r, 0, 2);
      return {ban: [`${f}:${t}`]};
    }
    return {lim: ri(r, 2, 4)};
  });
  const ev: Ev = (i, a, m) => {
    const d = deps[i]!, p = P[i]!, tag = m !== null && m.node === i ? m.tag : '';
    const [bal, ops] = a as [number[], {f: number; t: number; a: number}[]];
    if (d.length === 0) {
      if (!Array.isArray(bal) || !Array.from(bal).every((x) => Number.isSafeInteger(x) && x >= 0) || !Array.isArray(ops)) return null;
      const n = tag === 'alias' ? bal : bal.slice();
      for (const op of ops) {
        if (!poT(op) || Object.keys(op).length !== 3 || !Number.isInteger(op.f) || !Number.isInteger(op.t) || !Number.isSafeInteger(op.a)) return null;
        if (op.f < 0 || op.f >= n.length || op.t < 0 || op.t >= n.length || (tag !== 'selfok' && op.f === op.t)) return null;
        if ((tag === 'zero' ? op.a < 0 : op.a < 1) || op.a > p.lim! || (tag === 'gebal' ? op.a >= n[op.f]! : op.a > n[op.f]!)) return null;
        if (!Number.isSafeInteger(n[op.t]! + op.a)) return null;
        n[op.f]! -= op.a; n[op.t]! += op.a;
      }
      return n;
    }
    if (d.length === 1) {
      if (!Array.isArray(ops)) return null;
      for (const op of ops)
        if (poT(op) && tag !== 'unban' && p.ban!.includes(tag === 'keyord' ? `${op.t}:${op.f}` : `${op.f}:${op.t}`)) return null;
      return ev(d[0]!, a, m);
    }
    if (!Array.isArray(ops) || (tag === 'gelim' ? ops.length >= p.lim! : ops.length > p.lim!)) return null;
    let s: unknown = bal;
    for (const j of d) {
      const q = ev(j, [s, ops], m);
      if (tag === 'tol') { if (q !== null) s = q; } else { if (q === null) return null; s = q; }
    }
    return s;
  };
  const ref = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) return mod(PO, `const LIM=${p.lim!};`,
      `const vb=(b)=>Array.isArray(b)&&Array.from(b).every((x)=>Number.isSafeInteger(x)&&x>=0);`,
      `export function run(bal,ops){`,
      `if(!vb(bal)||!Array.isArray(ops))return null;`,
      `const n=bal.slice();`,
      `for(const op of ops){`,
      `if(!po(op)||Object.keys(op).length!==3||!Number.isInteger(op.f)||!Number.isInteger(op.t)||!Number.isSafeInteger(op.a))return null;`,
      `if(op.f<0||op.f>=n.length||op.t<0||op.t>=n.length||op.f===op.t)return null;`,
      `if(op.a<1||op.a>LIM||op.a>n[op.f])return null;`,
      `if(!Number.isSafeInteger(n[op.t]+op.a))return null;`,
      `n[op.f]-=op.a;n[op.t]+=op.a;}`,
      `return n;}`);
    if (d.length === 1) return mod(`import{run as up}from'./${keyOf(d[0]!)}.mjs';`, PO,
      `const BAN=new Set([${p.ban!.map((k) => `'${k}'`).join(',')}]);`,
      `export function run(bal,ops){`,
      `if(!Array.isArray(ops))return null;`,
      `for(const op of ops)if(po(op)&&BAN.has(op.f+':'+op.t))return null;`,
      `return up(bal,ops);}`);
    return mod(...d.map((j, k) => `import{run as s${k}}from'./${keyOf(j)}.mjs';`), `const LIM=${p.lim!};`,
      `export function run(bal,ops){`,
      `if(!Array.isArray(ops)||ops.length>LIM)return null;`,
      `let s=bal;`,
      `for(const f of[${d.map((_, k) => 's' + k).join(',')}]){s=f(s,ops);if(s===null)return null;}`,
      `return s;}`);
  };
  const defs = (i: number): MutDef[] => {
    const d = deps[i]!;
    if (d.length === 0) return [
      {id: 'gebal', desc: 'balance check rejects an exact drain', tag: 'gebal', apply: rep('op.a>n[op.f]', 'op.a>=n[op.f]')},
      {id: 'selfok', desc: 'self transfers are allowed', tag: 'selfok', apply: rep('||op.f===op.t', '')},
      {id: 'zero', desc: 'zero-amount transfers are allowed', tag: 'zero', apply: rep('op.a<1', 'op.a<0')},
      {id: 'alias', desc: 'transfers mutate the caller balances', tag: 'alias', apply: rep('const n=bal.slice();', 'const n=bal;')},
    ];
    if (d.length === 1) return [
      {id: 'keyord', desc: 'ban key composed as t:f', tag: 'keyord', apply: rep(`op.f+':'+op.t`, `op.t+':'+op.f`)},
      {id: 'unban', desc: 'ban list never consulted', tag: 'unban', apply: rep(`for(const op of ops)if(po(op)&&BAN.has(op.f+':'+op.t))return null;`, '')},
    ];
    return pipeDefs;
  };
  const instr = (i: number): string => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0)
      return `Export run(bal, ops). bal must be an array of nonnegative safe integers. ops must be an array of plain objects with exactly the keys f, t (integer indices into bal) and a (a safe integer). Apply ops in order; each requires f !== t, 0 <= f,t < bal.length, 1 <= a <= ${p.lim!}, a <= bal[f] at that moment, and a safe-integer destination balance after addition. If anything is invalid return null applying nothing. Never mutate bal; always return a fresh array.`;
    if (d.length === 1)
      return `Export run(bal, ops). If ops is not an array return null. For every element that is a plain object, return null when f+':'+t is one of ${JSON.stringify(p.ban)}. Otherwise return run(bal, ops) imported from './${keyOf(d[0]!)}.mjs'. Do not mutate bal.`;
    return `Export run(bal, ops). If ops is not an array or ops.length > ${p.lim!} return null. Otherwise feed the current balances through the stages imported from ${d.map((j) => `'./${keyOf(j)}.mjs'`).join(', ')} in that order: s = stage(s, ops); if a stage returns null return null. Return the final s.`;
  };
  const C = (i: number, a: unknown[]): Case => [a, ev(i, a, null)];
  const cases = (i: number): CG => {
    const d = deps[i]!, p = P[i]!;
    if (d.length === 0) {
      const lim = p.lim!;
      return {
        pub: [
          C(i, [[5, 7, 9], [{f: 0, t: 1, a: 2}]]),
          C(i, [[5, 7, 9], []]),
          C(i, [[5, 7, 9], [{f: 0, t: 1, a: 6}]]),
          C(i, [[5, 7, 9], [{f: 0, t: 9, a: 1}]]),
          C(i, [[5, 7, 9], 'x']),
          C(i, [[5, 7, 9], [{f: 0, t: 1, a: 2, x: 9}]]),
          C(i, [[5, 7, 9], [{f: 0, t: 1, a: lim + 1}]]),
        ],
        pk: [[[5, 7, 9], [{f: 0, t: 1, a: 2}]], [[5, 7, 9], [{f: 0, t: 1, a: 2}, {f: 0, t: 9, a: 1}]]],
        hold: [
          C(i, [[5, 7, 9], [{f: 0, t: 2, a: 5}]]),
          C(i, [[5, 7, 9], [{f: 1, t: 1, a: 3}]]),
          C(i, [[5, 7, 9], [{f: 0, t: 1, a: 0}]]),
          C(i, [[5, 2, 0], [{f: 0, t: 1, a: 4}, {f: 1, t: 2, a: 5}]]),
          C(i, [[5, 2, 0], [{f: 1, t: 2, a: 5}, {f: 0, t: 1, a: 4}]]),
          C(i, [[5, 7, 9], [{f: 0, t: 1, a: 9007199254740992}]]),
          C(i, [[9007199254740992, 1], [{f: 0, t: 1, a: 1}]]),
          C(i, [[5, -1, 9], [{f: 0, t: 1, a: 1}]]),
          C(i, [[5, 7, 9], [{f: 0, t: 1}]]),
        ],
        hk: [[[3, 3, 3], [{f: 2, t: 0, a: 3}]]],
        hr: raw(`{const r=f([5,7,9],[{f:0,t:1,a:5}]);assert.equal(r[0]+r[1]+r[2],21);}`, `{const b=[1,2];assert.notEqual(f(b,[]),b);}`, `assert.equal(f([1,Number.MAX_SAFE_INTEGER],[{f:0,t:1,a:1}]),null);`, `assert.equal(f(Array(2),[]),null);`, `assert.equal(f(new Date(),[]),null);`),
      };
    }
    if (d.length === 1) {
      const [f0, t0] = p.ban![0]!.split(':').map(Number) as [number, number];
      return {
        pub: [
          C(i, [[9, 9, 9], [{f: 0, t: 1, a: 2}]]),
          C(i, [[9, 9, 9], [{f: 0, t: 1, a: 10}]]),
          C(i, [[9, 9, 9], 'x']),
          C(i, [[9, 9, 9], [{f: 0}]]),
          C(i, [[9, 9, 9], []]),
        ],
        pk: [[[4, 4, 4], [{f: 1, t: 2, a: 2}]]],
        hold: [
          C(i, [[9, 9, 9], [{f: f0, t: t0, a: 1}]]),
          C(i, [[9, 9, 9], [{f: t0, t: f0, a: 1}]]),
          C(i, [[9, 9, 9], [{f: 0, t: 1, a: 1}, {f: f0, t: t0, a: 1}]]),
          C(i, [[9, 9, 9], [{f: 0, t: 1, a: 'x'}]]),
        ],
        hk: [[[4, 4, 4], [{f: 0, t: 2, a: 1}]]],
        hr: raw(`assert.equal(f(new Date(),[]),null);`),
      };
    }
    const lim = p.lim!;
    const fill = Array.from({length: lim}, (_, k) => ({f: k % 3, t: (k + 1) % 3, a: 1}));
    return {
      pub: [
        C(i, [[5, 5, 5], [{f: 0, t: 1, a: 1}]]),
        C(i, [[5, 5, 5], Array.from({length: lim + 1}, () => ({f: 0, t: 1, a: 1}))]),
        C(i, [[5, 5, 5], [{f: 0, t: 1, a: 99}]]),
        C(i, [[5, 5, 5], 'x']),
      ],
      pk: [[[5, 5, 5], [{f: 0, t: 1, a: 1}]]],
      hold: [
        C(i, [[6, 6, 6], fill]),
        C(i, [[5, 5, 5], [{f: 0, t: 0, a: 1}]]),
        C(i, [[5, 5, 5], [{f: 0, t: 9, a: 1}]]),
      ],
      hk: [[[4, 4, 4], [{f: 2, t: 1, a: 1}]]],
      hr: raw(`assert.deepEqual(f([5,5,5],[]),[5,5,5]);`),
    };
  };
  const cgs = deps.map((_, i) => cases(i));
  const pubA = cgs.map((cg) => [...cg.pub.map((c) => c[0]), ...cg.pk] as unknown[][]);
  const allA = cgs.map((cg, i) => [...pubA[i]!, ...cg.hold.map((c) => c[0]), ...cg.hk] as unknown[][]);
  const mds = observable(ev, allA, deps.map((_, i) => defs(i)));
  const nodes: NodeOut[] = deps.map((d, i) => N({
    key: keyOf(i), role: roleOf(d), deps: d.map(keyOf), instructions: instr(i), reference: ref(i),
    publicBody: fnBody('run', cgs[i]!.pub, keepInputs(cgs[i]!.pk)),
    holdBody: fnBody('run', cgs[i]!.hold, [keepInputs(cgs[i]!.hk), cgs[i]!.hr].filter(Boolean).join('\n')),
    mutants: mds[i]!.map((md) => ({id: md.id, description: md.desc, content: md.apply(ref(i)), publicPass: pubOk(ev, pubA, {node: i, tag: md.tag})})),
  }));
  const defect = seed(nodes, deps, mds, variant, 'ledger');
  return {goal: 'Repair the point-ledger modules under src/ so every exported run(bal, ops) satisfies its documented contract.', defect, nodes};
}

export const f4: readonly Family[] = [
  {name: 'inventory', title: 'Inventory stock batches', shapes: ['independent', 'chain', 'fanout', 'fanin'], build: invBuild},
  {name: 'workflow', title: 'Workflow state machine', shapes: ['chain', 'fanin', 'diamond', 'sparse'], build: wfBuild},
  {name: 'permissions', title: 'Allow/deny precedence', shapes: ['independent', 'fanout', 'diamond', 'sparse'], build: pmBuild},
  {name: 'ledger', title: 'Point ledger transfers', shapes: ['independent', 'chain', 'fanin', 'sparse'], build: ldBuild},
];
