// Four synthetic repair families over string pipelines. Every node exports
// `run(x)`: own(x) concatenated with each declared dependency's run(x) applied
// to the ORIGINAL x, in declared order. Dependency edges are real static
// imports of sibling './KEY.mjs' modules. Expected values are computed by the
// spec-side mirrors below, never by executing the generated reference.

import {
  mulberry32, ri, fnBody, flagOf, mod, N, sparseJoinSinks, sparsePlan,
  type Case, type Family, type FamilyBuild, type MutantSpec, type NodeOut, type Topology,
} from '../common.ts';

type Own = (x: string) => string;
interface MutSem { readonly own?: Own; readonly rev?: boolean; readonly noown?: boolean }
interface Cand {
  readonly id: string; readonly desc: string; readonly sem: MutSem;
  readonly ob?: string; readonly mode?: 'rev' | 'noown'; readonly covert?: boolean;
}
interface Defect { readonly id: string; readonly desc: string; readonly ob: string; readonly sem: Own }
interface Params {
  readonly own: Own; readonly ownBody: string; readonly ownText: string;
  readonly muts: readonly Cand[]; readonly defects: readonly Defect[];
}
interface GNode extends Params {
  readonly key: string; readonly deps: readonly string[];
  readonly prelude: string; readonly pub: readonly string[]; readonly hold: readonly string[];
}
interface Fam {
  readonly name: string; readonly title: string; readonly seed: number;
  readonly shapes: readonly Topology[];
  readonly goal: string; readonly domain: string; readonly prelude: string;
  params(i: number, r: () => number): Params;
  pubs(r: () => number): readonly string[];
  holds(r: () => number): readonly string[];
}

const J = JSON.stringify;

/** Dependency layouts; every edge points at a lower index so graphs stay acyclic. */
function layout(t: Topology, c: number): string[][] {
  const d: string[][] = Array.from({ length: c }, () => []);
  const k = (i: number) => `n${i}`;
  if (t === 'chain') for (let i = 1; i < c; i++) d[i] = [k(i - 1)];
  else if (t === 'fanout') for (let i = 1; i < c; i++) d[i] = [k(0)];
  else if (t === 'fanin') d[c - 1] = Array.from({ length: c - 1 }, (_, i) => k(i));
  else if (t === 'diamond') {
    for (let i = 1; i < c - 1; i++) d[i] = [k(0)];
    d[c - 1] = Array.from({ length: c - 2 }, (_, i) => k(i + 1));
  } else if (t === 'sparse') {
    const { pairs } = sparsePlan(c);
    const sinks: string[] = [];
    let n = 1;
    for (let p = 0; p < pairs; p++) {
      const s = k(n++);
      d[n] = [s];
      sinks.push(k(n));
      n++;
    }
    d[n] = [k(0), ...sparseJoinSinks(pairs).map((p) => sinks[p]!)];
  }
  return d;
}

/** Spec-side evaluator: mirrors the emitted run() semantics exactly. */
function evAt(
  nodes: readonly GNode[], ix: ReadonlyMap<string, number>,
  i: number, x: string, mk?: string, ms?: MutSem,
): string {
  const n = nodes[i]!;
  const m = mk === n.key ? ms : undefined;
  let a = m?.noown === true ? '' : (m?.own ?? n.own)(x);
  const ds = m?.rev === true ? [...n.deps].reverse() : n.deps;
  for (const k of ds) a += evAt(nodes, ix, ix.get(k)!, x, mk, ms);
  return a;
}

/** Emits the complete node file: imports, dep table, prelude helpers, own, run. */
function srcOf(g: GNode, ob?: string, mode?: 'rev' | 'noown'): string {
  const run =
    mode === 'rev'
      ? 'export function run(x){let a=own(x);for(const d of[...ds].reverse())a+=d(x);return a;}'
      : mode === 'noown'
        ? 'export function run(x){let a="";for(const d of ds)a+=d(x);return a;}'
        : 'export function run(x){let a=own(x);for(const d of ds)a+=d(x);return a;}';
  return mod(
    ...g.deps.map((k, j) => `import {run as d${j}} from './${k}.mjs';`),
    `const ds=[${g.deps.map((_, j) => 'd' + j).join(',')}];`,
    g.prelude,
    `function own(x){${ob ?? g.ownBody}}`,
    run,
  );
}

const word = (r: () => number, n: number): string =>
  Array.from({ length: n }, () => 'abCD19xz'.charAt(ri(r, 0, 7))).join('');

// ---------------------------------------------------------------- family 1: text-normalize
const F1PUB = ['', 'A', 'a b', '  Pad  ed  ', 'X9 yZ', 'Q\tR'];
const F1HOLD = ['\tEdge tab', 'Newline\n', 'a  b  c', 'MiXeD CaSe', '   ', '\n\tx\n', 'Sole'];
const f1: Fam = {
  name: 'text-normalize',
  title: 'ASCII text normalization pipeline',
  seed: 101,
  shapes: ['independent', 'chain', 'diamond', 'fanin'],
  goal: 'Repair the staged ASCII text-normalization pipeline: every src/*.mjs exports run(x) = own(x) plus dependency outputs.',
  domain: '`x` is an ASCII string over [A-Za-z0-9], space, tab and newline.',
  prelude: '',
  params(_i, r) {
    const sep = [' ', '-', '_'][ri(r, 0, 2)]!;
    const fold = r() < 0.5;
    const FG = 't=t.replace(/[A-Z]/g,c=>c.toLowerCase());';
    const F1s = 't=t.replace(/[A-Z]/,c=>c.toLowerCase());';
    const TA = 't=t.replace(/^[ \\t\\n]+|[ \\t\\n]+$/g,\'\');';
    const TS = 't=t.replace(/^[ ]+|[ ]+$/g,\'\');';
    const RS = `t=t.replace(/[ \\t\\n]+/g,${J(sep)});`;
    const RC = `t=t.replace(/[ \\t\\n]/g,${J(sep)});`;
    const RSp = `t=t.replace(/[ \\t\\n]+/g,' ');`;
    const asm = (f: string, t: string, p: string) => `let t=x;${f}${t}${p}return t;`;
    const base = (fl: (s: string) => string, tr: (s: string) => string, rp: (s: string) => string): Own =>
      (x) => rp(tr(fl(x)));
    const id = (s: string) => s;
    const g = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const o = (s: string) => s.replace(/[A-Z]/, (c) => c.toLowerCase());
    const tAll = (s: string) => s.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
    const tSp = (s: string) => s.replace(/^[ ]+|[ ]+$/g, '');
    const rSep = (s: string) => s.replace(/[ \t\n]+/g, sep);
    const rChr = (s: string) => s.replace(/[ \t\n]/g, sep);
    const rSpc = (s: string) => s.replace(/[ \t\n]+/g, ' ');
    const fl = fold ? g : id;
    const defects: Defect[] = [
      { id: 'trimskip', desc: 'own(x) never strips leading/trailing whitespace, so edges become separators', ob: asm(fold ? FG : '', '', RS), sem: base(fl, id, rSep) },
      ...(fold ? [{ id: 'foldonce', desc: 'only the first uppercase letter is lowercased', ob: asm(F1s, TA, RS), sem: base(o, tAll, rSep) }] : []),
      ...(sep !== ' ' ? [{ id: 'sepspace', desc: "the configured separator is ignored and runs become ' '", ob: asm(fold ? FG : '', TA, RSp), sem: base(fl, tAll, rSpc) }] : []),
    ];
    return {
      own: base(fl, tAll, rSep),
      ownBody: asm(fold ? FG : '', TA, RS),
      ownText: `${fold ? 'map every ASCII uppercase letter to lowercase, then ' : ''}strip all leading and trailing whitespace characters (space/tab/newline), then replace each maximal remaining whitespace run with the single separator ${J(sep)}`,
      muts: [
        { id: 'perchar', desc: 'each whitespace character becomes a separator instead of collapsing runs', ob: asm(fold ? FG : '', TA, RC), sem: { own: base(fl, tAll, rChr) } },
        { id: 'spacetrim', desc: 'only spaces are stripped at the edges; tabs/newlines survive', ob: asm(fold ? FG : '', TS, RS), sem: { own: base(fl, tSp, rSep) }, covert: true },
      ],
      defects,
    };
  },
  pubs: (r) => [...F1PUB, `${word(r, 3)}  ${word(r, 4)}`],
  holds: (r) => [...F1HOLD, `${word(r, 5)} ${word(r, 2)}`],
};

// ---------------------------------------------------------------- family 2: kvcodec
function dec2(s: string, up: boolean, lax: boolean, pl: boolean, lo: boolean): [string, string][] | null {
  if (s === '') return [];
  const o: [string, string][] = [];
  for (const f of s.split('&')) {
    const e = f.indexOf('=');
    const kr = up ? /^[a-zA-Z0-9]+$/ : /^[a-z0-9]+$/;
    if (e <= 0 || !kr.test(f.slice(0, e))) return null;
    const v = f.slice(e + 1);
    let d = '';
    for (let i = 0; i < v.length; i++) {
      const c = v.charAt(i);
      if (/[a-z0-9]/.test(c) || (lax && c === '=')) { d += c; continue; }
      if (pl && c === '+') { d += ' '; continue; }
      if (c === '%' && i + 2 < v.length) {
        const h = v.slice(i + 1, i + 3);
        const hr = lo ? /^[0-9A-Fa-f]{2}$/ : /^[0-9A-F]{2}$/;
        if (hr.test(h)) { d += String.fromCharCode(parseInt(h, 16)); i += 2; continue; }
      }
      return null;
    }
    o.push([f.slice(0, e), d]);
  }
  return o;
}
function enc2(p: readonly (readonly [string, string])[], raw: boolean): string {
  return p.map(([k, v]) => k + '=' + [...v].map((c) => /[a-z0-9]/.test(c) || (raw && c === '=') ? c : '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('')).join('&');
}
const own2 = (sort: boolean, dedup: boolean, o: { up?: boolean; lax?: boolean; pl?: boolean; lo?: boolean; raw?: boolean } = {}): Own =>
  (x) => {
    const d = dec2(x, o.up === true, o.lax === true, o.pl === true, o.lo !== false);
    if (d === null) return '!';
    let p = d;
    if (dedup) { const w = new Set<string>(); p = p.filter(([k]) => !w.has(k) && (w.add(k), true)); }
    if (sort) p = [...p].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return enc2(p, o.raw === true);
  };
const PRE2 = `function dec(s,up,lax,pl,lo){if(s==='')return[];const o=[];for(const f of s.split('&')){const e=f.indexOf('=');const kr=up?/^[a-zA-Z0-9]+$/:/^[a-z0-9]+$/;if(e<=0||!kr.test(f.slice(0,e)))return null;const v=f.slice(e+1);let d='';for(let i=0;i<v.length;i++){const c=v[i];if(/[a-z0-9]/.test(c)||(lax&&c==='=')){d+=c;continue}if(pl&&c==='+'){d+=' ';continue}if(c==='%'&&i+2<v.length){const h=v.slice(i+1,i+3);const hr=lo?/^[0-9A-Fa-f]{2}$/:/^[0-9A-F]{2}$/;if(hr.test(h)){d+=String.fromCharCode(parseInt(h,16));i+=2;continue}}return null}o.push([f.slice(0,e),d])}return o}
function enc(p,raw){return p.map(([k,v])=>k+'='+[...v].map(c=>/[a-z0-9]/.test(c)||(raw&&c==='=')?c:'%'+c.charCodeAt(0).toString(16).toUpperCase().padStart(2,'0')).join('')).join('&')}`;
const F2PUB = ['', 'a=1', 'b=2&a=1', 'a=1&a=2', 'A=1', 'a=b=c', 'a=b%3Dc', 'a=b+c', 'x=%20'];
const F2HOLD = ['a=%3d', 'a=', 'q=%7e', 'm=n%26o', 'a=%', 'a=%2g', '&a=1', 'a=1&', 'b=1&a=2&a=0', 'z=%41%42'];
const f2: Fam = {
  name: 'kvcodec',
  title: 'escaped key/value codec',
  seed: 202,
  shapes: ['chain', 'fanout', 'fanin', 'sparse'],
  goal: 'Repair the escaped key/value canonicalization pipeline: every src/*.mjs exports run(x) = own(x) plus dependency outputs.',
  domain: "`x` is a '&'-joined record of `key=value` fields: keys are `[a-z0-9]+`, values are runs of `[a-z0-9]` or `%XX` hex escapes (either hex case accepted on input). The empty string decodes to zero fields; ANY malformed input (empty key, missing '=', stray '%', bad hex, illegal raw character) makes own(x) return the sentinel '!'.",
  prelude: PRE2,
  params(_i, r) {
    const sort = r() < 0.5, dedup = r() < 0.5;
    const B = (decA: string, encR: string) =>
      `const d=dec(x,${decA});if(d===null)return'!';let p=d;${dedup ? 'const w=new Set();p=p.filter(([k])=>!w.has(k)&&(w.add(k),true));' : ''}${sort ? 'p=[...p].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);' : ''}return enc(p,${encR});`;
    const R = 'false,false,false,true';
    return {
      own: own2(sort, dedup),
      ownBody: B(R, 'false'),
      ownText: `decode x, ${dedup ? 'drop later occurrences of repeated keys keeping the first, ' : ''}${sort ? 'stable-sort fields by key ascending, ' : ''}then re-encode: each character outside [a-z0-9] becomes '%' plus two UPPERCASE hex digits and fields join with '&'`,
      muts: [
        { id: 'raweq', desc: "re-encode leaves '=' raw inside values", ob: B(R, 'true'), sem: { own: own2(sort, dedup, { raw: true }) } },
        { id: 'lowhex', desc: 'decode rejects lowercase hex escapes', ob: B('false,false,false,false', 'false'), sem: { own: own2(sort, dedup, { lo: false }) }, covert: true },
      ],
      defects: [
        { id: 'upkey', desc: 'decode accepts uppercase letters in keys', ob: B('true,false,false,true', 'false'), sem: own2(sort, dedup, { up: true }) },
        { id: 'laxval', desc: "decode accepts raw '=' inside values", ob: B('false,true,false,true', 'false'), sem: own2(sort, dedup, { lax: true }) },
        { id: 'plus', desc: "decode maps '+' to a space", ob: B('false,false,true,true', 'false'), sem: own2(sort, dedup, { pl: true }) },
      ],
    };
  },
  pubs: (r) => [...F2PUB, `p${ri(r, 1, 9)}=q${ri(r, 1, 9)}&z=w${ri(r, 1, 9)}`],
  holds: (r) => [...F2HOLD, `h${ri(r, 1, 9)}=v${ri(r, 1, 9)}`],
};

// ---------------------------------------------------------------- family 3: rle
function dec3(s: string, z: boolean, up: boolean): string | null {
  const re = up ? (z ? /^([a-dA-D][0-9])+$/ : /^([a-dA-D][1-9])+$/) : (z ? /^([a-d][0-9])+$/ : /^([a-d][1-9])+$/);
  if (s !== '' && !re.test(s)) return null;
  let o = '';
  for (let i = 0; i < s.length; i += 2) o += s.charAt(i).toLowerCase().repeat(+s.charAt(i + 1));
  return o;
}
function enc3(s: string, k: number, o: 'sc' | 'cs'): string {
  let r = '';
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j < s.length && s.charAt(j) === s.charAt(i)) j++;
    let n = j - i;
    while (n > 0) { const c = Math.min(n, k); r += o === 'sc' ? s.charAt(i) + c : String(c) + s.charAt(i); n -= c; }
    i = j;
  }
  return r;
}
const A3 = 'abcd';
const rot3 = (s: string, q: number): string => [...s].map((c) => A3.charAt((A3.indexOf(c) + q) % 4)).join('');
const own3 = (rot: number, o: { z?: boolean; up?: boolean; k?: number; ord?: 'sc' | 'cs' } = {}): Own =>
  (x) => {
    const d = dec3(x, o.z === true, o.up === true);
    return d === null ? '!' : enc3(rot3(d, rot), o.k ?? 9, o.ord ?? 'sc');
  };
const PRE3 = `const A='abcd';
function dec(s,z,up){const re=up?(z?/^([a-dA-D][0-9])+$/:/^([a-dA-D][1-9])+$/):(z?/^([a-d][0-9])+$/:/^([a-d][1-9])+$/);if(s!==''&&!re.test(s))return null;let o='';for(let i=0;i<s.length;i+=2)o+=s[i].toLowerCase().repeat(+s[i+1]);return o}
function enc(s,k,o){let r='';for(let i=0;i<s.length;){let j=i;while(j<s.length&&s[j]===s[i])j++;let n=j-i;while(n>0){const c=Math.min(n,k);r+=o==='sc'?s[i]+c:''+c+s[i];n-=c}i=j}return r}
function rot(s,r){return[...s].map(c=>A[(A.indexOf(c)+r)%4]).join('')}`;
const F3PUB = ['', 'a1', 'a2b1', 'a9a3', 'A1B1', 'ab', 'a1b1c1d1', 'd4'];
const F3HOLD = ['a0b1', 'c9c9c3', 'a10', 'b2a', 'a1B1', 'd9d9d9d1', 'x1', 'e1'];
const f3rle: Fam = {
  name: 'rle',
  title: 'run-length codec over abcd',
  seed: 303,
  shapes: ['independent', 'fanout', 'diamond', 'sparse'],
  goal: 'Repair the run-length codec pipeline: every src/*.mjs exports run(x) = own(x) plus dependency outputs.',
  domain: "`x` is an encoded symbol string: zero or more pairs of a symbol in [a-d] and a count digit [1-9]; '' decodes to ''. Any malformed input makes own(x) return the sentinel '!'.",
  prelude: PRE3,
  params(_i, r) {
    const rot = ri(r, 0, 3);
    const B = (decA: string, k: number, o: string) =>
      `const d=dec(x,${decA});if(d===null)return'!';return enc(rot(d,${rot}),${k},'${o}');`;
    return {
      own: own3(rot),
      ownBody: B('false,false', 9, 'sc'),
      ownText: `decode x, rotate every decoded symbol ${rot} step(s) forward inside 'abcd' (wrap-around), then re-encode canonically: each maximal run is emitted as symbol followed by a single digit, splitting runs longer than 9 into chunks of at most 9`,
      muts: [
        { id: 'wide', desc: 're-encode emits multi-digit counts instead of splitting runs at 9', ob: B('false,false', 99, 'sc'), sem: { own: own3(rot, { k: 99 }) } },
        { id: 'zero', desc: "decode accepts '0' count digits as empty repetitions", ob: B('true,false', 9, 'sc'), sem: { own: own3(rot, { z: true }) }, covert: true },
      ],
      defects: [
        { id: 'countsym', desc: 'encode writes each count before its symbol', ob: B('false,false', 9, 'cs'), sem: own3(rot, { ord: 'cs' }) },
        { id: 'updec', desc: 'decode accepts uppercase symbols A-D', ob: B('false,true', 9, 'sc'), sem: own3(rot, { up: true }) },
      ],
    };
  },
  pubs: (r) => [...F3PUB, `${'abcd'.charAt(ri(r, 0, 3))}${ri(r, 1, 9)}${'abcd'.charAt(ri(r, 0, 3))}${ri(r, 1, 9)}`],
  holds: (r) => [...F3HOLD, `${'abcd'.charAt(ri(r, 0, 3))}9${'abcd'.charAt(ri(r, 0, 3))}2`],
};

// ---------------------------------------------------------------- family 4: paths
type Nm = (p: string) => [boolean, string[]];
const nmB: Nm = (p) => {
  const a = p.startsWith('/');
  const s: string[] = [];
  for (const g of p.split('/')) {
    if (g === '' || g === '.') continue;
    if (g === '..') { if (s.length > 0 && s[s.length - 1] !== '..') s.pop(); else if (!a) s.push('..'); continue; }
    s.push(g);
  }
  return [a, s];
};
const nkB: Nm = (p) => {
  const a = p.startsWith('/');
  const s: string[] = [];
  for (const g of p.split('/')) {
    if (g === '') continue;
    if (g === '..') { if (s.length > 0) s.pop(); else if (!a) s.push('..'); continue; }
    s.push(g);
  }
  return [a, s];
};
const nrB: Nm = (p) => {
  const a = p.startsWith('/');
  const s: string[] = [];
  for (const g of p.split('/')) {
    if (g === '' || g === '.') continue;
    if (g === '..') { if (s.length > 0 && s[s.length - 1] !== '..') s.pop(); else s.push('..'); continue; }
    s.push(g);
  }
  return [a, s];
};
const npB: Nm = (p) => {
  const a = p.startsWith('/');
  const s: string[] = [];
  for (const g of p.split('/')) { if (g === '' || g === '.') continue; s.push(g); }
  return [a, s];
};
const nqB: Nm = (p) => {
  const s: string[] = [];
  for (const g of p.split('/')) {
    if (g === '' || g === '.') continue;
    if (g === '..') { if (s.length > 0 && s[s.length - 1] !== '..') s.pop(); else s.push('..'); continue; }
    s.push(g);
  }
  return [false, s];
};
const rd4 = (a: boolean, s: readonly string[]): string => {
  const b = s.join('/');
  return a ? '/' + b : b === '' ? '.' : b;
};
const own4 = (mode: string, trail: boolean, nf: Nm): Own =>
  (x) => {
    const [a, s] = nf(x);
    let r = rd4(a, s);
    if (mode === 'a') r = r === '.' ? '/' : r.startsWith('/') ? r : '/' + r;
    if (mode === 'r') r = r.startsWith('/') ? r.slice(1) || '.' : r;
    return trail && r !== '/' && r !== '.' ? r + '/' : r;
  };
const PRE4 = `function nm(p){const a=p.startsWith('/');const s=[];for(const g of p.split('/')){if(g===''||g==='.')continue;if(g==='..'){if(s.length&&s[s.length-1]!=='..')s.pop();else if(!a)s.push('..');continue}s.push(g)}return[a,s]}
function nk(p){const a=p.startsWith('/');const s=[];for(const g of p.split('/')){if(g==='')continue;if(g==='..'){if(s.length)s.pop();else if(!a)s.push('..');continue}s.push(g)}return[a,s]}
function nr(p){const a=p.startsWith('/');const s=[];for(const g of p.split('/')){if(g===''||g==='.')continue;if(g==='..'){if(s.length&&s[s.length-1]!=='..')s.pop();else s.push('..');continue}s.push(g)}return[a,s]}
function np(p){const a=p.startsWith('/');const s=[];for(const g of p.split('/')){if(g===''||g==='.')continue;s.push(g)}return[a,s]}
function nq(p){const s=[];for(const g of p.split('/')){if(g===''||g==='.')continue;if(g==='..'){if(s.length&&s[s.length-1]!=='..')s.pop();else s.push('..');continue}s.push(g)}return[false,s]}
function rd(a,s){const b=s.join('/');return a?'/'+b:(b===''?'.':b)}`;
const F4PUB = ['', '/', 'a/b', 'a//b/./c', 'a/../b', '/x//y', './a', 'x/', '..', '../a', 'a/b/..'];
const F4HOLD = ['/../a', '/x/../../y', '/a/./../b', 'a/b/c/../../d', '//', '/./', 'p//q//r', 'z/../../w'];
const f4p: Fam = {
  name: 'paths',
  title: 'synthetic slash-path normalization',
  seed: 404,
  shapes: ['independent', 'chain', 'fanout', 'sparse'],
  goal: 'Repair the slash-path normalization pipeline: every src/*.mjs exports run(x) = own(x) plus dependency outputs.',
  domain: '`x` is a synthetic slash path over ASCII [a-z0-9._/]; no filesystem calls are involved.',
  prelude: PRE4,
  params(_i, r) {
    const mode = 'kar'.charAt(ri(r, 0, 2));
    const trail = r() < 0.5;
    const B = (nf: string) =>
      `const[a,s]=${nf}(x);let r=rd(a,s);${mode === 'a' ? `r=r==='.'?'/':(r.startsWith('/')?r:'/'+r);` : ''}${mode === 'r' ? `r=r.startsWith('/')?(r.slice(1)||'.'):r;` : ''}return ${trail ? `r==='/'||r==='.'?r:r+'/'` : 'r'};`;
    const modeText =
      mode === 'a' ? "force a leading '/' ('.' becomes '/')" :
      mode === 'r' ? "strip any leading '/' ('/' becomes '.')" :
      'keep the leading-slash status as-is';
    return {
      own: own4(mode, trail, nmB),
      ownBody: B('nm'),
      ownText: `normalize x: split on '/', drop '' and '.' segments, each '..' removes the last kept segment only when that segment is not '..' (when none can be removed it is dropped for absolute paths and kept for relative ones); render '/' + joined segments for absolute paths, '.' for an empty relative result; then ${modeText}${trail ? ", and finally append a trailing '/' unless the result is '/' or '.'" : ''}`,
      muts: [
        { id: 'keepdot', desc: "'.' segments are kept as literal segments", ob: B('nk'), sem: { own: own4(mode, trail, nkB) } },
        { id: 'rootkeep', desc: "absolute paths keep an unresolvable '..'", ob: B('nr'), sem: { own: own4(mode, trail, nrB) }, covert: true },
      ],
      defects: [
        { id: 'keepdd', desc: "'..' is kept as a literal segment instead of resolving", ob: B('np'), sem: own4(mode, trail, npB) },
        ...(mode === 'k' ? [{ id: 'noabs', desc: 'the absolute flag is ignored so leading slashes are lost', ob: B('nq'), sem: own4(mode, trail, nqB) }] : []),
      ],
    };
  },
  pubs: (r) => [...F4PUB, `s${ri(r, 1, 9)}/t${ri(r, 1, 9)}//u`],
  holds: (r) => [...F4HOLD, `h${ri(r, 1, 9)}/../k`],
};

// ---------------------------------------------------------------- shared builder
function instr(f: Fam, g: GNode): string {
  const dep =
    g.deps.length === 0
      ? 'It has no dependencies, so run(x) = own(x).'
      : `It must statically import run from ${g.deps.map((k) => `'./${k}.mjs'`).join(', ')} and run(x) = own(x) concatenated with each dependency's run applied to the ORIGINAL x, in this order: own(x)${g.deps.map((k) => ` + ${k}.run(x)`).join('')}.`;
  return `${f.domain} Export one ESM binding \`run(x)\` returning a string. own(x): ${g.ownText}. ${dep}`;
}

function buildFam(f: Fam, variant: number, topology: Topology, count: number): FamilyBuild {
  const r = mulberry32((variant + 1) * 0x9e3779b1 + f.seed);
  const nodes: GNode[] = layout(topology, count).map((deps, i) => ({
    key: `n${i}`, deps, prelude: f.prelude, ...f.params(i, r), pub: f.pubs(r), hold: f.holds(r),
  }));
  const ix = new Map(nodes.map((n, i) => [n.key, i] as const));
  const ev = (i: number, x: string, mk?: string, ms?: MutSem) => evAt(nodes, ix, i, x, mk, ms);
  const depOn = new Map<string, string[]>();
  for (const n of nodes) {
    for (const d of n.deps) {
      const l = depOn.get(d);
      if (l === undefined) depOn.set(d, [n.key]);
      else l.push(n.key);
    }
  }
  const affected = (k: string): string[] => {
    const out = new Set([k]);
    const q = [k];
    while (q.length > 0) {
      for (const w of depOn.get(q.pop()!) ?? []) {
        if (!out.has(w)) { out.add(w); q.push(w); }
      }
    }
    return [...out];
  };
  // Defect target: alternate between broken-consumer and broken-provider
  // classes by variant, preferring the matching role when the topology has one.
  const order = nodes.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = ri(r, 0, i);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  const want = variant % 2 === 0;
  const score = (i: number) => ((nodes[i]!.deps.length > 0) === want ? 1 : 0);
  order.sort((a, b) => score(b) - score(a));
  let dKey = '', dDesc = '', dBody = '';
  outer: for (const i of order) {
    for (const k of nodes[i]!.defects) {
      if (nodes[i]!.pub.some((x) => k.sem(x) !== nodes[i]!.own(x))) {
        dKey = nodes[i]!.key;
        dDesc = k.desc;
        dBody = k.ob;
        break outer;
      }
    }
  }
  if (dKey === '') throw new Error(`${f.name} v${variant}: no defect target`);
  const outs: NodeOut[] = nodes.map((g, i) => {
    const pubC: Case[] = g.pub.map((x) => [[x], ev(i, x)] as const);
    const holdC: Case[] = g.hold.map((x) => [[x], ev(i, x)] as const);
    const cands: Cand[] = [
      ...g.muts,
      { id: 'revdeps', desc: 'dependency results are concatenated in reverse order', mode: 'rev', sem: { rev: true } },
      { id: 'noown', desc: 'the own(x) contribution is dropped from run(x)', mode: 'noown', sem: { noown: true } },
    ];
    const mutants: MutantSpec[] = [];
    for (const c of cands) {
      if (c.mode === 'rev' && g.deps.length < 2) continue;
      const probe = c.covert === true ? g.hold : g.pub;
      if (!probe.some((x) => ev(i, x, g.key, c.sem) !== ev(i, x))) continue;
      const groups = affected(g.key).map((k) => {
        const w = ix.get(k)!;
        const wc: Case[] = nodes[w]!.pub.map((x) => [[x], ev(w, x)] as const);
        return [
          wc,
          (a: readonly unknown[]) => ev(w, String(a[0])),
          (a: readonly unknown[]) => ev(w, String(a[0]), g.key, c.sem),
        ] as const;
      });
      mutants.push({
        id: c.id,
        description: c.desc,
        content: srcOf(g, c.ob, c.mode),
        publicPass: flagOf(groups),
      });
    }
    return N({
      key: g.key,
      role: g.deps.length === 0 ? 'source' : 'pipe',
      deps: g.deps,
      instructions: instr(f, g),
      reference: srcOf(g),
      ...(g.key === dKey ? { baseline: srcOf(g, dBody) } : {}),
      publicBody: fnBody('run', pubC),
      holdBody: fnBody('run', holdC),
      mutants,
    });
  });
  return { goal: f.goal, defect: `${dKey}: ${dDesc}`, nodes: outs };
}

const FAMS: readonly Fam[] = [f1, f2, f3rle, f4p];
export const f3: readonly Family[] = FAMS.map((f) => ({
  name: f.name,
  title: f.title,
  shapes: f.shapes,
  build: (variant, topology, count) => buildFam(f, variant, topology, count),
}));
