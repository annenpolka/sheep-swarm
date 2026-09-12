import type {Case, Family, NodeOut, SpecGen} from '../common.ts';
import {N, findKey, flagOf, fnBody, keepInputs, lit, mulberry32, mustReplace, raw, ri, seedDefect, sparseJoinSinks, sparsePlan} from '../common.ts';

// ---------------------------------------------------------------------------
// Family: units — decimal fixed-point strings <-> integer unit values.
// ---------------------------------------------------------------------------
const units: SpecGen = (variant, topology, count) => {
  const scale = 10 ** (variant % 4);
  const limit = 1000 + variant * 137;
  const p = variant % 4;
  const goal = `This repository converts between decimal strings and integer units at scale ${scale} with limit ${limit}. Follow contract.md exactly.`;
  const confText = `Export exactly two constants: scale=${scale} and limit=${limit}. Export nothing else.`;
  const parseText = `Import {scale} from the config module listed in dependsOn. Export function parseUnits(s). Accept only strings matching a non-negative integer with an optional fractional part: the whole part must be 1-12 digits, no sign, no whitespace, no leading +.${p === 0 ? ' No dot or fractional part is allowed.' : ` A dot requires 1 to ${p} fractional digits.`} The resulting integer unit count must not exceed limit. Return the integer unit value Math.round(value*scale) or null on rejection.`;
  const sumText = `Import {parseUnits} from the parser module and {limit} from the config module listed in dependsOn. Export function sumUnits(lines). lines must be an array of strings; each element is passed through parseUnits; if any element is rejected return null. Sum the parsed unit values; return the sum, or null when the sum exceeds limit. An empty array returns 0.`;
  const emitText = `Import {scale,limit} from the config module listed in dependsOn. Export function renderUnits(units). units must be a safe integer with 0<=units<=limit, else null. Emit the canonical decimal string with exactly ${p} fractional digits${p === 0 ? ' (i.e. a plain integer string)' : ', zero-padded'}, no sign, no leading zeros on the whole part beyond a single 0.`;
  const capText = `Export function capUnits(units). units must be a safe integer >=0, else null. Return Math.min(units, ${limit}).`;
  const reconText = `Import {parseUnits} from the parser module and {renderUnits} from the emitter module listed in dependsOn. Export function reconcile(line). Parse line with parseUnits; on rejection return 'bad'; otherwise double the parsed unit value, cap at limit (${limit}), and return renderUnits of the capped value.`;
  const poolText = `Import {sumUnits} from every sum module listed in dependsOn. Export function poolUnits(lines). Run each part's sumUnits over the same lines array; if any part returns null return null; otherwise return the sum of all part results.`;

  const sParse = (v: unknown): number | null => {
    if (typeof v !== 'string') return null;
    const dot = v.indexOf('.');
    const whole = dot < 0 ? v : v.slice(0, dot);
    const frac = dot < 0 ? '' : v.slice(dot + 1);
    if (whole.length < 1 || whole.length > 12 || !/^[0-9]+$/.test(whole)) return null;
    if (p === 0 ? dot >= 0 : dot >= 0 && !(frac.length >= 1 && frac.length <= p && /^[0-9]+$/.test(frac))) return null;
    const units = Number(BigInt(whole) * BigInt(scale) + BigInt(frac.padEnd(p, '0') || '0'));
    if (!Number.isSafeInteger(units) || units < 0 || units > limit) return null;
    return units;
  };
  const sParseS = (v: unknown): number | null =>
    typeof v === 'string' && v[0] === '+' ? sParse(v.slice(1)) : sParse(v);
  const sSum = (v: unknown): number | null => {
    if (!Array.isArray(v)) return null;
    let t = 0;
    for (const x of v) {
      const u = sParse(x);
      if (u === null) return null;
      t += u;
    }
    return t > limit ? null : t;
  };
  const sSumS = (v: unknown): number | null => {
    if (!Array.isArray(v)) return null;
    let t = 0;
    for (const x of v) {
      const u = sParseS(x);
      if (u === null) return null;
      t += u;
    }
    return t > limit ? null : t;
  };
  const sEmit = (v: unknown): string | null => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > limit) return null;
    const whole = Math.floor(v / scale);
    const frac = v % scale;
    return p === 0 ? String(whole) : `${whole}.${String(frac).padStart(p, '0')}`;
  };
  const sEmitL = (v: unknown): string | null => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > limit + 9) return null;
    const whole = Math.floor(v / scale);
    const frac = v % scale;
    return p === 0 ? String(whole) : `${whole}.${String(frac).padStart(p, '0')}`;
  };
  const sEmitN = (v: unknown): string | null => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < -99 || v > limit) return null;
    if (v < 0) {
      const whole = Math.floor(-v / scale);
      const frac = -v % scale;
      return '-' + (p === 0 ? String(whole) : `${whole}.${String(frac).padStart(p, '0')}`);
    }
    return sEmit(v);
  };
  const sCap = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, limit) : null;
  const sCapS = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= limit ? v : null;
  const sRecon = (v: unknown): string | 'bad' | null => {
    const u = sParse(v);
    if (u === null) return 'bad';
    return sEmit(Math.min(u * 2, limit));
  };
  const sReconS = (v: unknown): string | 'bad' | null => {
    const u = sParseS(v);
    if (u === null) return 'bad';
    return sEmit(Math.min(u * 2, limit));
  };
  const sReconN = (v: unknown): string | 'bad' | null => {
    const u = sParse(v);
    if (u === null) return 'bad';
    return sEmitN(Math.min(u * 2, limit));
  };
  const sPool = (v: unknown, nParts: number, skipLast = false): number | null => {
    if (!Array.isArray(v)) return null;
    let total = 0;
    for (let j = 0; j < nParts; j++) {
      const u = sSum(v);
      if (u === null) return null;
      if (!(skipLast && j === nParts - 1)) total += u;
    }
    return total;
  };

  const fracProbe = `1.${'9'.repeat(p + 1)}`;
  const sTyp = sEmit(Math.min(limit, 3 * scale + Math.min(5, scale - 1)))!;

  const confPub = raw(`assert.equal(m.scale,${scale});`, `assert.equal(m.limit,${limit});`, `assert.equal(Object.keys(m).sort().join(','),'limit,scale');`);
  const confHid = raw(`assert.ok(Number.isSafeInteger(m.scale));`, `assert.ok(Number.isSafeInteger(m.limit));`, `assert.equal(m.scale*1,${scale});`);
  const parsePub: Case[] = [
    [[' 1'], null], [[sTyp], sParse(sTyp)], [['-1'], null], [[42], null], [['1'], sParse('1')],
  ];
  const parseHid: Case[] = [
    [[fracProbe], sParse(fracProbe)], [['1.2.3'], null], [[''], null], [['+1'], null], [['1.'], null],
    [[p === 0 ? '1.0' : `1.${'5'.repeat(p)}`], sParse(p === 0 ? '1.0' : `1.${'5'.repeat(p)}`)],
    [['1234567890123'], null], [['.5'], null], [['0001'], sParse('0001')], [['1 '], null],
  ];
  const sumPub: Case[] = [
    [[['1', '2']], sSum(['1', '2'])], [[['x']], null], [[42], null],
  ];
  const sumHid: Case[] = [
    [[[]], 0], [[['1', 'x']], null], [[null], null], [[[sEmit(limit), sEmit(1)]], null],
    [[Array.from({length: 40}, () => sTyp)], sSum(Array.from({length: 40}, () => sTyp))],
    [[['0.5', '0.5']], sSum(['0.5', '0.5'])],
  ];
  const emitPub: Case[] = [
    [[0], sEmit(0)], [[scale], sEmit(scale)], [[scale + 1], sEmit(scale + 1)], [[limit], sEmit(limit)], [[limit + 1], null],
  ];
  const emitHid: Case[] = [
    [[-1], null], [[1.5], null], [[limit + 9], null], [[limit - 1], sEmit(limit - 1)],
    [[Number.MAX_SAFE_INTEGER + 1], null], [[Number.MAX_SAFE_INTEGER], null],
  ];
  const capPub: Case[] = [[[0], 0], [[5], Math.min(5, limit)], [[limit + 3], limit], [[-1], null]];
  const capHid: Case[] = [
    [[Number.MAX_SAFE_INTEGER + 1], null], [[Number.MAX_SAFE_INTEGER], limit], [[1.5], null],
    [[limit], limit], [[null], null], [['5'], null],
  ];
  const reconPub: Case[] = [[['1'], sRecon('1')], [['x'], 'bad'], [[sTyp], sRecon(sTyp)]];
  const reconHid: Case[] = [[['-2'], 'bad'], [[null], 'bad'], [[String(limit)], sRecon(String(limit))], [[fracProbe], sRecon(fracProbe)], [['0'], sRecon('0')]];

  const nodeConf = (key: string): NodeOut =>
    N({
      key, role: 'conf', deps: [], instructions: confText,
      reference: `export const scale=${scale};\nexport const limit=${limit};\n`,
      publicBody: confPub, holdBody: confHid,
      mutants: [
        {id: 'limit-minus', description: 'config exports limit-1', content: `export const scale=${scale};\nexport const limit=${limit - 1};\n`, publicPass: false},
        {id: 'places-plus', description: 'config scale off by factor ten', content: `export const scale=${scale * 10};\nexport const limit=${limit};\n`, publicPass: false},
      ],
    });
  const nodeParse = (key: string, conf: string): NodeOut => {
    const ref = `import {scale,limit} from './${conf}.mjs';
export function parseUnits(s){
 if(typeof s!=='string')return null;
 const dot=s.indexOf('.');
 const whole=dot<0?s:s.slice(0,dot);
 const frac=dot<0?'':s.slice(dot+1);
 if(whole.length<1||whole.length>12||!/^[0-9]+$/.test(whole))return null;
 ${p === 0 ? 'if(dot>=0)return null;' : `if(dot>=0&&(frac.length<1||frac.length>${p}||!/^[0-9]+$/.test(frac)))return null;`}
 const units=Math.round((Number(whole)+Number(frac===''?'0':frac)/Math.pow(10,frac.length))*scale);
 if(!Number.isSafeInteger(units)||units<0||units>limit)return null;
 return units;
}
`;
    const mutants = [
      {
        id: 'sign-loose', description: 'parser accepts a leading + sign',
        content: mustReplace(ref, `!/^[0-9]+$/.test(whole)`, `!/^[+]?[0-9]+$/.test(whole)`),
        publicPass: flagOf([
          [parsePub, (a) => sParse(a[0]), (a) => sParseS(a[0])],
          [sumPub, (a) => sSum(a[0]), (a) => sSumS(a[0])],
          [reconPub, (a) => sRecon(a[0]), (a) => sReconS(a[0])],
        ]),
      },
    ];
    if (p > 0) {
      const sParseL = (v: unknown): number | null => {
        if (typeof v !== 'string') return null;
        const dot = v.indexOf('.');
        const whole = dot < 0 ? v : v.slice(0, dot);
        const frac = dot < 0 ? '' : v.slice(dot + 1);
        if (whole.length < 1 || whole.length > 12 || !/^[0-9]+$/.test(whole)) return null;
        if (dot >= 0 && !(frac.length >= 1 && frac.length <= p + 1 && /^[0-9]+$/.test(frac))) return null;
        const u = Math.round((Number(whole) + Number(frac === '' ? '0' : frac) / 10 ** frac.length) * scale);
        if (!Number.isSafeInteger(u) || u < 0 || u > limit) return null;
        return u;
      };
      mutants.push({
        id: 'frac-long', description: `parser accepts ${p + 1} fractional digits`,
        content: mustReplace(ref, `frac.length>${p}`, `frac.length>${p + 1}`),
        publicPass: flagOf([[parsePub, (a) => sParse(a[0]), (a) => sParseL(a[0])]]),
      });
    } else {
      mutants.push({
        id: 'whole-trim', description: 'parser trims leading whitespace',
        content: mustReplace(ref, `const dot=s.indexOf('.');`, `s=s.trimStart();const dot=s.indexOf('.');`),
        publicPass: flagOf([[parsePub, (a) => sParse(a[0]), (a) => sParse(typeof a[0] === 'string' ? a[0].trimStart() : a[0])]]),
      });
    }
    return N({key, role: 'parse', deps: [conf], instructions: parseText, reference: ref, publicBody: fnBody('parseUnits', parsePub), holdBody: fnBody('parseUnits', parseHid), mutants});
  };
  const nodeSum = (key: string, parse: string, conf: string): NodeOut => {
    const ref = `import {parseUnits} from './${parse}.mjs';
import {limit} from './${conf}.mjs';
export function sumUnits(lines){
 if(!Array.isArray(lines))return null;
 let t=0;
 for(const x of lines){
  const u=parseUnits(x);
  if(u===null)return null;
  t+=u;
 }
 return t>limit?null:t;
}
`;
    const sSumE = (v: unknown): number | null => (Array.isArray(v) && v.length === 0 ? null : sSum(v));
    const sSumO = (v: unknown): number | null => {
      if (!Array.isArray(v)) return null;
      let t = 0;
      for (const x of v) {
        const u = sParse(x);
        if (u === null) return null;
        t += u;
      }
      return t;
    };
    return N({
      key, role: 'sum', deps: [parse, conf], instructions: sumText, reference: ref,
      publicBody: fnBody('sumUnits', sumPub), holdBody: fnBody('sumUnits', sumHid),
      mutants: [
        {id: 'empty-null', description: 'sum rejects the empty array', content: mustReplace(ref, `if(!Array.isArray(lines))return null;`, `if(!Array.isArray(lines)||lines.length===0)return null;`), publicPass: flagOf([[sumPub, (a) => sSum(a[0]), (a) => sSumE(a[0])]])},
        {id: 'over-limit', description: 'sum never enforces limit', content: mustReplace(ref, `return t>limit?null:t;`, `return t;`), publicPass: flagOf([[sumPub, (a) => sSum(a[0]), (a) => sSumO(a[0])]])},
      ],
    });
  };
  const nodeEmit = (key: string, conf: string): NodeOut => {
    const ref = `import {scale,limit} from './${conf}.mjs';
export function renderUnits(units){
 if(!Number.isSafeInteger(units)||units<0||units>limit)return null;
 const whole=Math.floor(units/scale);
 const frac=units%scale;
 ${p === 0 ? 'return String(whole);' : `const f=String(frac).padStart(${p},'0');return whole+'.'+f;`}
}
`;
    return N({
      key, role: 'emit', deps: [conf], instructions: emitText, reference: ref,
      publicBody: fnBody('renderUnits', emitPub), holdBody: fnBody('renderUnits', emitHid),
      mutants: [
        {id: 'neg-loose', description: 'emitter renders small negatives', content: mustReplace(ref, `units<0`, `units<-99`), publicPass: flagOf([[emitPub, (a) => sEmit(a[0]), (a) => sEmitN(a[0])], [reconPub, (a) => sRecon(a[0]), (a) => sReconN(a[0])]])},
        {id: 'over-limit', description: 'emitter accepts values over limit', content: mustReplace(ref, `units>limit`, `units>limit+9`), publicPass: flagOf([[emitPub, (a) => sEmit(a[0]), (a) => sEmitL(a[0])]])},
      ],
    });
  };
  const nodeCap = (key: string): NodeOut => {
    const ref = `export function capUnits(units){
 if(!Number.isSafeInteger(units)||units<0)return null;
 return Math.min(units,${limit});
}
`;
    return N({
      key, role: 'cap', deps: [], instructions: capText, reference: ref,
      publicBody: fnBody('capUnits', capPub), holdBody: fnBody('capUnits', capHid),
      mutants: [
        {id: 'cap-strict', description: 'cap rejects values over limit instead of clamping', content: mustReplace(ref, `return Math.min(units,${limit});`, `if(units>${limit})return null;return units;`), publicPass: flagOf([[capPub, (a) => sCap(a[0]), (a) => sCapS(a[0])]])},
      ],
    });
  };
  const nodeRecon = (key: string, parse: string, emit: string, conf: string): NodeOut => {
    const ref = `import {parseUnits} from './${parse}.mjs';
import {renderUnits} from './${emit}.mjs';
export function reconcile(line){
 const u=parseUnits(line);
 if(u===null)return 'bad';
 const d=Math.min(u*2,${limit});
 return renderUnits(d);
}
`;
    void conf;
    return N({
      key, role: 'recon', deps: [parse, emit], instructions: reconText, reference: ref,
      publicBody: fnBody('reconcile', reconPub), holdBody: fnBody('reconcile', reconHid),
      mutants: [
        {id: 'raw-total', description: 'reconcile returns the doubled integer instead of a rendered string', content: mustReplace(ref, `return renderUnits(d);`, `return d;`), publicPass: false},
      ],
    });
  };
  const nodePool = (key: string, sinkKeys: readonly string[]): NodeOut => {
    const imports = sinkKeys.map((k, j) => `import {sumUnits as P${j}} from './${k}.mjs';`).join('\n');
    const ref = `${imports}
const PARTS=[${sinkKeys.map((_, j) => `P${j}`).join(',')}];
export function poolUnits(lines){
 if(!Array.isArray(lines))return null;
 let total=0;
 for(const f of PARTS){
  const v=f(lines);
  if(v===null)return null;
  total+=v;
 }
 return total;
}
`;
    const poolPub: Case[] = [
      [[['1', '2']], sPool(['1', '2'], sinkKeys.length)],
      [[['x']], null],
      [[[]], sPool([], sinkKeys.length)],
    ];
    const poolHid: Case[] = [
      [[null], null],
      [[[sTyp]], sPool([sTyp], sinkKeys.length)],
      [[['1', 'bad']], null],
    ];
    const mutants = [
      {id: 'pool-double', description: 'pool doubles each part result', content: mustReplace(ref, `total+=v;`, `total+=v*2;`), publicPass: false},
    ];
    if (sinkKeys.length >= 2) {
      mutants.push({id: 'pool-first', description: 'pool returns only the first part result', content: mustReplace(ref, `let total=0;\n for(const f of PARTS){`, `let total=0;\n for(const f of PARTS.slice(0,1)){`), publicPass: flagOf([[poolPub, (a) => sPool(a[0], sinkKeys.length), (a) => sPool(a[0], 1)]])});
    }
    return N({
      key, role: 'pool', deps: [...sinkKeys], instructions: poolText, reference: ref,
      publicBody: fnBody('poolUnits', poolPub), holdBody: fnBody('poolUnits', poolHid), mutants,
    });
  };

  const nodes: NodeOut[] = [nodeConf('conf-0')];
  if (topology === 'independent') {
    for (let i = 0; i < count - 1; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeParse(`parse-${i}`, 'conf-0'));
      else if (k === 1) nodes.push(nodeEmit(`emit-${i}`, 'conf-0'));
      else nodes.push(nodeSum(`sum-${i}`, `parse-${i - 2}`, 'conf-0'));
    }
  } else if (topology === 'fanout') {
    for (let i = 0; i < count - 1; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeParse(`parse-${i}`, 'conf-0'));
      else if (k === 1) nodes.push(nodeEmit(`emit-${i}`, 'conf-0'));
      else nodes.push(nodeCap(`cap-${i}`));
    }
  } else if (topology === 'diamond') {
    const mids = count - 2;
    for (let i = 0; i < mids; i++) {
      if (i % 2 === 0) nodes.push(nodeParse(`parse-${i}`, 'conf-0'));
      else nodes.push(nodeEmit(`emit-${i}`, 'conf-0'));
    }
    const lastParse = [...nodes].reverse().find((n) => n.role === 'parse')!.key;
    const lastEmit = [...nodes].reverse().find((n) => n.role === 'emit')!.key;
    nodes.push(nodeRecon('recon-0', lastParse, lastEmit, 'conf-0'));
  } else {
    // sparse: conf -> parse_j -> sum_j branches; solo emit/cap leaves; pool joins even sinks.
    const {pairs, solos} = sparsePlan(count);
    const sinkKeys: string[] = [];
    for (let j = 0; j < pairs; j++) {
      nodes.push(nodeParse(`parse-${j}`, 'conf-0'));
      nodes.push(nodeSum(`sum-${j}`, `parse-${j}`, 'conf-0'));
      sinkKeys.push(`sum-${j}`);
    }
    for (let s = 0; s < solos; s++) {
      if (s % 2 === 0) nodes.push(nodeEmit(`emit-${s}`, 'conf-0'));
      else nodes.push(nodeCap(`cap-${s}`));
    }
    const sinks = sparseJoinSinks(pairs).map((j) => sinkKeys[j]!);
    nodes.push(nodePool('pool-0', sinks));
  }

  const menu: {role: string; desc: string; f: (s: string) => string}[] =
    topology === 'independent'
      ? [
          {role: 'conf', desc: 'config limit is off by one', f: (s) => mustReplace(s, `export const limit=${limit};`, `export const limit=${limit - 1};`)},
          {role: 'parse', desc: p === 0 ? 'parser trims leading whitespace' : `parser accepts ${p + 1} fractional digits`, f: (s) => (p === 0 ? mustReplace(s, `const dot=s.indexOf('.');`, `s=s.trimStart();const dot=s.indexOf('.');`) : mustReplace(s, `frac.length>${p}`, `frac.length>${p + 1}`))},
          {role: 'emit', desc: p < 2 ? 'emitter accepts values up to limit*10' : 'emitter drops zero padding', f: (s) => (p < 2 ? mustReplace(s, `units>limit`, `units>limit*10`) : mustReplace(s, `padStart(${p},'0')`, `padStart(0,'0')`))},
          {role: 'sum', desc: 'sum drops the last line', f: (s) => mustReplace(s, `for(const x of lines){`, `lines=lines.slice(0,-1);for(const x of lines){`)},
        ]
      : topology === 'fanout'
        ? [
            {role: 'conf', desc: 'config limit is off by one', f: (s) => mustReplace(s, `export const limit=${limit};`, `export const limit=${limit - 1};`)},
            {role: 'parse', desc: 'parser accepts a leading + sign', f: (s) => mustReplace(s, `!/^[0-9]+$/.test(whole)`, `!/^[+]?[0-9]+$/.test(whole)`)},
            {role: 'emit', desc: 'emitter accepts values over limit', f: (s) => mustReplace(s, `units>limit`, `units>limit+9`)},
            {role: 'cap', desc: 'cap rejects values over limit instead of clamping', f: (s) => mustReplace(s, `return Math.min(units,${limit});`, `if(units>${limit})return null;return units;`)},
          ]
        : topology === 'diamond'
          ? [
              {role: 'conf', desc: 'config scale is off by ten', f: (s) => mustReplace(s, `export const scale=${scale};`, `export const scale=${scale * 10};`)},
              {role: 'parse', desc: 'parser accepts a leading + sign', f: (s) => mustReplace(s, `!/^[0-9]+$/.test(whole)`, `!/^[+]?[0-9]+$/.test(whole)`)},
              {role: 'emit', desc: 'emitter accepts values over limit', f: (s) => mustReplace(s, `units>limit`, `units>limit+9`)},
              {role: 'recon', desc: 'reconcile returns the doubled integer', f: (s) => mustReplace(s, `return renderUnits(d);`, `return d;`)},
            ]
          : [
              {role: 'conf', desc: 'config scale is off by ten', f: (s) => mustReplace(s, `export const scale=${scale};`, `export const scale=${scale * 10};`)},
              {role: 'parse', desc: p === 0 ? 'parser trims leading whitespace' : `parser accepts ${p + 1} fractional digits`, f: (s) => (p === 0 ? mustReplace(s, `const dot=s.indexOf('.');`, `s=s.trimStart();const dot=s.indexOf('.');`) : mustReplace(s, `frac.length>${p}`, `frac.length>${p + 1}`))},
              {role: 'sum', desc: 'sum drops the last line', f: (s) => mustReplace(s, `for(const x of lines){`, `lines=lines.slice(0,-1);for(const x of lines){`)},
              {role: 'pool', desc: 'pool doubles each part result', f: (s) => mustReplace(s, `total+=v;`, `total+=v*2;`)},
            ];
  const available = menu.filter(m => nodes.some(n => n.role === m.role));
  const pick = available[variant % available.length]!;
  const target = findKey(nodes, pick.role, 0);
  seedDefect(nodes, target, pick.f);
  return {goal, defect: `${pick.desc} (in ${target})`, nodes};
};

// ---------------------------------------------------------------------------
// Family: baseconv — positional numeral systems over custom alphabets.
// ---------------------------------------------------------------------------
const baseconv: SpecGen = (variant, topology, count) => {
  const r = mulberry32(0xba5e + variant * 97);
  const base = ri(r, 3, 8);
  const alphabets = ['0123456789abcdef', 'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba'];
  const alphaFull = alphabets[variant % 3]!;
  const digits = alphaFull.slice(0, base);
  const max = 4 * base * base + (variant % 5) * base + 6;
  const cased = alphaFull !== alphabets[0];
  const goal = `This repository converts non-negative integers to and from base-${base} strings over the digit alphabet ${JSON.stringify(digits)} (index order), with an upper bound of ${max}. Follow contract.md exactly.`;

  const alphaText = `Export exactly two constants: digits=${JSON.stringify(digits)} (a string whose index i is the digit for value i) and max=${max}. Export nothing else.`;
  const digitText = `Import {digits} from the alphabet module listed in dependsOn. Export function digitValue(ch). Accept only a string of length exactly 1 that appears in digits; return its index. Otherwise null.`;
  const parseText = `Import {digits,max} from the alphabet module listed in dependsOn. Export function parseValue(text). text must be a nonempty string of at most 12 characters all present in digits; parse it as a positional numeral (most significant first). Return the value, or null when invalid or when the value exceeds max.`;
  const emitText = `Import {digits,max} from the alphabet module listed in dependsOn. Export function emitValue(value). value must be a safe integer with 0<=value<=max, else null. Emit the canonical positional string (most significant digit first, no leading zeros beyond the representation of 0 as digits[0]).`;
  const magText = `Import {digits,max} from the alphabet module listed in dependsOn. Export function magnitude(value). value must be a safe integer with 0<=value<=max, else null. Return the number of digits the canonical representation of value has.`;
  const canonText = `Import {digits,max} from the alphabet module and {digitValue} from the digit module and {emitValue} from the emit module listed in dependsOn. Export function canonical(text). Parse text with digitValue over digits (nonempty, <=12 chars, all chars valid, value<=max); return emitValue of the parsed value, or null on rejection.`;


  const joinText = `Import {parsePart} from every part module listed in dependsOn. Export function joinValues(texts). texts must be an array whose length equals the number of parts; parse texts[i] with part i; if any part rejects, return null. Otherwise return the sum of all parsed values.`;

  const sDigit = (v: unknown): number | null =>
    typeof v === 'string' && v.length === 1 ? (digits.indexOf(v) < 0 ? null : digits.indexOf(v)) : null;
  const sDigitC = (v: unknown): number | null =>
    typeof v === 'string' && v.length === 1 ? (digits.indexOf(v.toLowerCase()) < 0 ? null : digits.indexOf(v.toLowerCase())) : null;
  const sDigitL = (v: unknown): number | null =>
    typeof v === 'string' && v.length >= 1 ? (digits.indexOf(v[0]!) < 0 ? null : digits.indexOf(v[0]!)) : null;
  const sParse = (v: unknown): number | null => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 12) return null;
    let acc = 0;
    for (const ch of v) {
      const d = digits.indexOf(ch);
      if (d < 0) return null;
      acc = acc * base + d;
    }
    return acc > max ? null : acc;
  };
  const sParseE = (v: unknown): number | null => {
    if (typeof v !== 'string' || v.length > 12) return null;
    let acc = 0;
    for (const ch of v) {
      const d = digits.indexOf(ch);
      if (d < 0) return null;
      acc = acc * base + d;
    }
    return acc > max ? null : acc;
  };
  const sParseO = (v: unknown): number | null => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 12) return null;
    let acc = 0;
    for (const ch of v) {
      const d = digits.indexOf(ch);
      if (d < 0) return null;
      acc = acc * base + d;
    }
    return acc;
  };
  const sEmit = (v: unknown): string | null => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) return null;
    if (v === 0) return digits[0]!;
    let out = '';
    let n = v;
    while (n > 0) {
      const d = n % base;
      out = digits[d]! + out;
      n = Math.floor(n / base);
    }
    return out;
  };
  const sEmitN = (v: unknown): string | null => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < -max || v > max) return null;
    const s = sEmit(Math.abs(v));
    return s === null ? null : v < 0 ? '-' + s : s;
  };
  const sMag = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) return null;
    if (v === 0) return 1;
    let pp = 1;
    let ppCount = 1;
    while (pp * base <= v) {
      pp *= base;
      ppCount++;
    }
    return ppCount;
  };
  const sCanon = (v: unknown): string | null => {
    const x = sParse(v);
    return x === null ? null : sEmit(x);
  };
  const sCanonN = (v: unknown): string | null => {
    const x = sParse(v);
    return x === null ? null : sEmitN(x);
  };
  const sCanonR = (v: unknown): number | string | null => sParse(v);

  const typVal = ((variant * 13 + 5) % (max - 1)) + 1;
  const sTyp = sEmit(typVal)!;
  const sOver = digits[base - 1]!.repeat(5); // always exceeds max
  const emitRaw = (u: number): string => {
    if (u === 0) return digits[0]!;
    let s = '';
    let pv = 1;
    while (pv * base <= u) pv *= base;
    let rem = u;
    while (pv > 0) {
      const d = Math.floor(rem / pv);
      s += digits[d]!;
      rem -= d * pv;
      pv = Math.floor(pv / base);
    }
    return s;
  };

  const alphaPub = raw(`assert.equal(m.digits,${lit(digits)});`, `assert.equal(m.max,${max});`, `assert.equal(Object.keys(m).sort().join(','),'digits,max');`);
  const alphaHid = raw(`assert.equal(m.digits.length,${base});`, `assert.ok(new Set(m.digits).size===${base});`);
  const upperProbe = cased ? digits[0]!.toUpperCase() : 'A';
  const digitPub: Case[] = [
    [[digits[0]], 0], [[digits[base - 1]], base - 1], [['?'], null], [['ab'], null],
  ];
  const digitHid: Case[] = [
    [[null], null], [[0], null], [[''], null], [[digits[1] ?? digits[0]], 1],
    [[digits.slice(0, 2)], null], [[upperProbe], sDigit(upperProbe)], [[alphaFull === alphabets[2] ? 'a' : '!'], null],
  ];
  const parsePub: Case[] = [
    [[sTyp], sParse(sTyp)], [[digits[0]], 0], [[digits[1]! + digits[0]!], sParse(digits[1]! + digits[0]!)], [['?'], null], [[42], null], [[sOver], null],
  ];
  const parseHid: Case[] = [
    [[digits[0]!.repeat(2)], sParse(digits[0]!.repeat(2))], [[digits[0] + sTyp], sParse(digits[0] + sTyp)], [[''], null], [[digits[1]! + '?'], null], [[null], null],
    [[digits[0]!.repeat(13)], null], [[sEmit(max)!], sParse(sEmit(max)!)], [[emitRaw(max + 1)], null],
    [[digits[base - 1]! + digits[0]! + digits[1]!], sParse(digits[base - 1]! + digits[0]! + digits[1]!)],
  ];
  const emitPub: Case[] = [
    [[0], digits[0]], [[base], sEmit(base)], [[typVal], sTyp], [[max], sEmit(max)], [[max + 1], null],
  ];
  const emitHid: Case[] = [
    [[-1], null], [[1.5], null], [[Number.MAX_SAFE_INTEGER + 1], null], [[base - 1], sEmit(base - 1)], [[base + 1], sEmit(base + 1)], [[max - 1], sEmit(max - 1)],
    [[base * base + base + 1], sEmit(base * base + base + 1)], [[Math.floor(max / 2)], sEmit(Math.floor(max / 2))], [[base + 2], sEmit(base + 2)], [[2 * base], sEmit(2 * base)], [[3 * base + 1], sEmit(3 * base + 1)],
  ];
  const magPub: Case[] = [
    [[0], 1], [[base - 1], 1], [[base], 2], [[max + 1], null],
  ];
  const magHid: Case[] = [
    [[max], sMag(max)], [[-1], null], [[base * base], sMag(base * base)], [[base * base - 1], sMag(base * base - 1)], [[null], null],
    [[Math.floor(max / base)], sMag(Math.floor(max / base))], [[base * base * base - 1], sMag(base * base * base - 1)], [[1.5], null],
  ];
  const canonPub: Case[] = [
    [[sTyp], sCanon(sTyp)], [[digits[0] + sTyp], sCanon(digits[0] + sTyp)], [['?'], null],
  ];
  const canonHid: Case[] = [
    [[sOver], null], [[''], null], [[sEmit(max)!], sCanon(sEmit(max)!)], [[42], null], [[null], null],
  ];

  const nodeAlpha = (key: string): NodeOut =>
    N({
      key, role: 'alpha', deps: [], instructions: alphaText,
      reference: `export const digits=${JSON.stringify(digits)};\nexport const max=${max};\n`,
      publicBody: alphaPub, holdBody: alphaHid,
      mutants: [
        {id: 'digits-swap', description: 'alphabet swaps first two digits', content: `export const digits=${JSON.stringify(digits.length > 1 ? digits[1]! + digits[0]! + digits.slice(2) : digits)};\nexport const max=${max};\n`, publicPass: false},
        {id: 'max-plus', description: 'alphabet max is off by one', content: `export const digits=${JSON.stringify(digits)};\nexport const max=${max + 1};\n`, publicPass: false},
      ],
    });
  const nodeDigit = (key: string, alpha: string): NodeOut => {
    const ref = `import {digits} from './${alpha}.mjs';
export function digitValue(ch){
 if(typeof ch!=='string'||ch.length!==1)return null;
 const i=digits.indexOf(ch);
 return i<0?null:i;
}
`;
    const mutants = [];
    if (cased) {
      mutants.push({
        id: 'case-loose', description: 'digit lookup lowercases input',
        content: mustReplace(ref, `digits.indexOf(ch)`, `digits.indexOf(ch.toLowerCase())`),
        publicPass: flagOf([[digitPub, (a) => sDigit(a[0]), (a) => sDigitC(a[0])]]),
      });
    } else {
      mutants.push({
        id: 'digit-shift', description: 'digit value is off by one',
        content: mustReplace(ref, `return i<0?null:i;`, `return i<0?null:i+1;`),
        publicPass: false,
      });
    }
    mutants.push({
      id: 'len-loose', description: 'digit lookup accepts alphabet substrings longer than one character',
      content: mustReplace(ref, `ch.length!==1`, `ch.length<1`),
      publicPass: flagOf([[digitPub, (a) => sDigit(a[0]), (a) => sDigitL(a[0])]]),
    });
    return N({key, role: 'digit', deps: [alpha], instructions: digitText, reference: ref, publicBody: fnBody('digitValue', digitPub), holdBody: fnBody('digitValue', digitHid), mutants});
  };
  const nodeParse = (key: string, alpha: string): NodeOut => {
    const ref = `import {digits,max} from './${alpha}.mjs';
export function parseValue(text){
 if(typeof text!=='string'||text.length===0||text.length>12)return null;
 let acc=0;
 for(const ch of text){
  const d=digits.indexOf(ch);
  if(d<0)return null;
  acc=acc*digits.length+d;
 }
 return acc>max?null:acc;
}
`;
    return N({
      key, role: 'parse', deps: [alpha], instructions: parseText, reference: ref,
      publicBody: fnBody('parseValue', parsePub), holdBody: fnBody('parseValue', parseHid),
      mutants: [
        {id: 'empty-zero', description: 'parser returns 0 for the empty string', content: mustReplace(ref, `text.length===0`, `text.length<0`), publicPass: flagOf([[parsePub, (a) => sParse(a[0]), (a) => sParseE(a[0])]])},
        {id: 'over-ok', description: 'parser ignores the max bound', content: mustReplace(ref, `return acc>max?null:acc;`, `return acc;`), publicPass: flagOf([[parsePub, (a) => sParse(a[0]), (a) => sParseO(a[0])]])},
      ],
    });
  };
  const nodeEmit = (key: string, alpha: string): NodeOut => {
    const ref = `import {digits,max} from './${alpha}.mjs';
export function emitValue(value){
 if(!Number.isSafeInteger(value)||value<0||value>max)return null;
 if(value===0)return digits[0];
 let out='';
 let n=value;
 while(n>0){
  const d=n%digits.length;
  out=digits[d]+out;
  n=Math.floor(n/digits.length);
 }
 return out;
}
`;
    return N({
      key, role: 'emit', deps: [alpha], instructions: emitText, reference: ref,
      publicBody: fnBody('emitValue', emitPub), holdBody: fnBody('emitValue', emitHid),
      mutants: [
        {id: 'neg-sign', description: 'emitter renders negatives with a minus sign', content: mustReplace(ref, `value<0`, `value<-max`), publicPass: flagOf([[emitPub, (a) => sEmit(a[0]), (a) => sEmitN(a[0])], [canonPub, (a) => sCanon(a[0]), (a) => sCanonN(a[0])]])},
        {id: 'zero-empty', description: 'emitter returns the empty string for 0', content: mustReplace(ref, `if(value===0)return digits[0];`, `if(value===0)return '';`), publicPass: flagOf([[emitPub, (a) => sEmit(a[0]), (a) => (a[0] === 0 ? '' : sEmit(a[0]))]])},
      ],
    });
  };
  const nodeMag = (key: string, alpha: string): NodeOut => {
    const ref = `import {digits,max} from './${alpha}.mjs';
export function magnitude(value){
 if(!Number.isSafeInteger(value)||value<0||value>max)return null;
 if(value===0)return 1;
 let p=0;
 let pp=1;
 while(pp*digits.length<=value){pp*=digits.length;p++;}
 return p+1;
}
`;
    return N({
      key, role: 'mag', deps: [alpha], instructions: magText, reference: ref,
      publicBody: fnBody('magnitude', magPub), holdBody: fnBody('magnitude', magHid),
      mutants: [
        {id: 'zero-two', description: 'magnitude says 0 needs two digits', content: mustReplace(ref, `if(value===0)return 1;`, `if(value===0)return 2;`), publicPass: flagOf([[magPub, (a) => sMag(a[0]), (a) => (a[0] === 0 ? 2 : sMag(a[0]))]])},
      ],
    });
  };
  const nodeCanon = (key: string, alpha: string, digit: string, emit: string): NodeOut => {
    const ref = `import {digits,max} from './${alpha}.mjs';
import {digitValue} from './${digit}.mjs';
import {emitValue} from './${emit}.mjs';
export function canonical(text){
 if(typeof text!=='string'||text.length===0||text.length>12)return null;
 let acc=0;
 for(const ch of text){
  const d=digitValue(ch);
  if(d===null)return null;
  acc=acc*digits.length+d;
 }
 if(acc>max)return null;
 return emitValue(acc);
}
`;
    return N({
      key, role: 'canon', deps: [alpha, digit, emit], instructions: canonText, reference: ref,
      publicBody: fnBody('canonical', canonPub), holdBody: fnBody('canonical', canonHid),
      mutants: [
        {id: 'canon-raw', description: 'canonical returns the integer instead of the emitted string', content: mustReplace(ref, `return emitValue(acc);`, `return acc;`), publicPass: flagOf([[canonPub, (a) => sCanon(a[0]), (a) => sCanonR(a[0])]])},
      ],
    });
  };

  const nodes: NodeOut[] = [nodeAlpha('alpha-0')];
  if (topology === 'independent') {
    for (let i = 0; i < count - 1; i++) {
      const k = i % 4;
      if (k === 0) nodes.push(nodeDigit(`digit-${i}`, 'alpha-0'));
      else if (k === 1) nodes.push(nodeParse(`parse-${i}`, 'alpha-0'));
      else if (k === 2) nodes.push(nodeEmit(`emit-${i}`, 'alpha-0'));
      else nodes.push(nodeMag(`mag-${i}`, 'alpha-0'));
    }
  } else if (topology === 'fanin') {
    // Standalone part parsers (each embeds its own alphabet+bound) -> join.
    const nParts = count - 2;
    const partParams = Array.from({length: nParts}, (_, i) => {
      const off = (i * 2) % (alphaFull.length - base);
      return {d: alphaFull.slice(off, off + base), m: 3 * base * base + i * 7};
    });
    const partStr = (i: number, u: number): string => {
      const d = partParams[i]!.d;
      if (u === 0) return d[0]!;
      let s = '';
      let pv = 1;
      while (pv * base <= u) pv *= base;
      let rem = u;
      while (pv > 0) {
        const dd = Math.floor(rem / pv);
        s += d[dd]!;
        rem -= dd * pv;
        pv = Math.floor(pv / base);
      }
      return s;
    };
    const sPart = (i: number, v: unknown, over = 0): number | null => {
      const {d, m} = partParams[i]!;
      if (typeof v !== 'string' || v.length === 0 || v.length > 8) return null;
      let acc = 0;
      for (const ch of v) {
        const dd = d.indexOf(ch);
        if (dd < 0) return null;
        acc = acc * base + dd;
      }
      return acc > m + over ? null : acc;
    };
    const sJoin = (v: unknown): number | null => {
      if (!Array.isArray(v) || v.length !== nParts) return null;
      let total = 0;
      for (let j = 0; j < v.length; j++) {
        const x = sPart(j, v[j]);
        if (x === null) return null;
        total += x;
      }
      return total;
    };
    const partKeys: string[] = [];
    for (let i = 0; i < nParts; i++) {
      const {d, m} = partParams[i]!;
      const pref = `const digits=${JSON.stringify(d)};
const max=${m};
export function parsePart(text){
 if(typeof text!=='string'||text.length===0||text.length>8)return null;
 let acc=0;
 for(const ch of text){
  const dd=digits.indexOf(ch);
  if(dd<0)return null;
  acc=acc*digits.length+dd;
 }
 return acc>max?null:acc;
}
`;
      const partPub: Case[] = [
        [[d[0]], 0], [[d[1]! + d[0]!], sPart(i, d[1]! + d[0]!)], [['?'], null], [[5], null],
        [[d[0]!.repeat(9)], null], [[partStr(i, m + 1)], null],
      ];
      const partHid: Case[] = [
        [[d[0]!.repeat(2)], sPart(i, d[0]!.repeat(2))], [[''], null], [[d[1]! + '?'], null],
        [[partStr(i, m)], m], [[partStr(i, m - 1)], sPart(i, partStr(i, m - 1))],
      ];
      nodes.push(
        N({
          key: `part-${i}`, role: 'part', deps: [], instructions: `Export function parsePart(text). Positional parse over the fixed digit alphabet ${JSON.stringify(d)} (embedded in the module), rejecting strings longer than 8 characters or values over ${m}. Return the parsed integer or null.`, reference: pref,
          publicBody: fnBody('parsePart', partPub), holdBody: fnBody('parsePart', partHid),
          mutants: [
            {id: 'part-max', description: 'part parse accepts max+1', content: mustReplace(pref, `acc>max`, `acc>max+1`), publicPass: flagOf([[partPub, (a) => sPart(i, a[0]), (a) => sPart(i, a[0], 1)]])},
          ],
        }),
      );
      partKeys.push(`part-${i}`);
    }
    const joinImports = partKeys.map((k, j) => `import {parsePart as P${j}} from './${k}.mjs';`).join('\n');
    const joinRef = `${joinImports}
const PARTS=[${partKeys.map((_, j) => `P${j}`).join(',')}];
export function joinValues(texts){
 if(!Array.isArray(texts)||texts.length!==PARTS.length)return null;
 let total=0;
 for(let j=0;j<texts.length;j++){
  const v=PARTS[j](texts[j]);
  if(v===null)return null;
  total+=v;
 }
 return total;
}
`;
    const validInputs = Array.from({length: nParts}, (_, j) => partStr(j, 1));
    const joinPub: Case[] = [
      [[validInputs], sJoin(validInputs)],
      [[validInputs.map((s, j) => (j === 0 ? '?' : s))], null],
      [[[]], null],
    ];
    const joinHid: Case[] = [
      [[null], null],
      [[validInputs.slice(1)], null],
      [[validInputs.concat([partStr(0, 0)])], null],
      [[validInputs.map((s, j) => (j === nParts - 1 ? partStr(j, partParams[j]!.m + 1) : s))], null],
      [[validInputs.map((s, j) => (j === 1 ? partStr(1, 2) : s))], sJoin(validInputs.map((s, j) => (j === 1 ? partStr(1, 2) : s)))],
    ];
    nodes.push(
      N({
        key: 'join-0', role: 'join', deps: partKeys, instructions: joinText, reference: joinRef,
        publicBody: fnBody('joinValues', joinPub), holdBody: fnBody('joinValues', joinHid),
        mutants: [
          {id: 'join-len', description: 'join reports the number of parts instead of the sum', content: mustReplace(joinRef, `return total;`, `return texts.length;`), publicPass: false},
        ],
      }),
    );
  } else {
    // diamond: alpha -> digit/emit/mag mids -> canon(alpha,digit,emit)
    const mids = count - 2;
    for (let i = 0; i < mids; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeDigit(`digit-${i}`, 'alpha-0'));
      else if (k === 1) nodes.push(nodeEmit(`emit-${i}`, 'alpha-0'));
      else nodes.push(nodeMag(`mag-${i}`, 'alpha-0'));
    }
    const lastDigit = [...nodes].reverse().find((n) => n.role === 'digit')!.key;
    const lastEmit = [...nodes].reverse().find((n) => n.role === 'emit')!.key;
    nodes.push(nodeCanon('canon-0', 'alpha-0', lastDigit, lastEmit));
  }

  const menu: {role: string; desc: string; f: (s: string) => string}[] =
    topology === 'independent'
      ? [
          {role: 'alpha', desc: 'alphabet swaps first two digits', f: (s) => mustReplace(s, `export const digits=${JSON.stringify(digits)};`, `export const digits=${JSON.stringify(digits.length > 1 ? digits[1]! + digits[0]! + digits.slice(2) : digits)};`)},
          {role: 'parse', desc: 'parser reverses place values', f: (s) => mustReplace(s, `acc=acc*digits.length+d;`, `acc=acc+d;`)},
          {role: 'emit', desc: 'emitter writes least significant digit first', f: (s) => mustReplace(s, `out=digits[d]+out;`, `out=out+digits[d];`)},
        ]
      : topology === 'fanin'
        ? [
            {role: 'part', desc: 'part parse accepts values over max', f: (s) => mustReplace(s, `acc>max`, `acc>max+1`)},
            {role: 'part', desc: 'part parse drops the length bound', f: (s) => mustReplace(s, `text.length>8`, `text.length>80`)},
            {role: 'join', desc: 'join counts parts instead of summing', f: (s) => mustReplace(s, `return total;`, `return texts.length;`)},
          ]
        : [
            {role: 'alpha', desc: 'alphabet max is off by one', f: (s) => mustReplace(s, `export const max=${max};`, `export const max=${max + 1};`)},
            {role: 'emit', desc: 'emitter writes least significant digit first', f: (s) => mustReplace(s, `out=digits[d]+out;`, `out=out+digits[d];`)},
            {role: 'canon', desc: 'canonical adds one per character', f: (s) => mustReplace(s, `acc=acc*digits.length+d;`, `acc=acc*digits.length+d+1;`)},
          ];
  const available = menu.filter(m => nodes.some(n => n.role === m.role));
  const pick = available[variant % available.length]!;
  const target = findKey(nodes, pick.role, 0);
  seedDefect(nodes, target, pick.f);
  return {goal, defect: `${pick.desc} (in ${target})`, nodes};
};

// ---------------------------------------------------------------------------
// Family: window — sliding-window event counting and admission policy.
// ---------------------------------------------------------------------------
const window_: SpecGen = (variant, topology, count) => {
  const r = mulberry32(0x111d + variant * 31);
  const size = ri(r, 4, 20);
  const max = ri(r, 2, 5);
  const goal = `This repository assigns integer event ticks to sliding windows of size ${size} and enforces an admission cap of ${max} events per window. Follow contract.md exactly.`;
  const limText = `Export exactly two constants: size=${size} and max=${max}. Export nothing else.`;
  const bucketText = `Import {size} from the limits module listed in dependsOn. Export function bucketIndex(t). t must be a safe integer >=0, else null. Return Math.floor(t/size).`;
  const countText = `Import {size} from the limits module and {bucketIndex} from the bucket module listed in dependsOn. Export function countWindows(ticks). ticks must be an array of safe integers >=0 (each checked via bucketIndex semantics); return an array of [windowIndex,count] pairs sorted ascending by window index, or null on invalid input.`;
  const decideText = `Import {max} from the limits module and {bucketIndex} from the bucket module and {countWindows} from the counter module listed in dependsOn. Export function decide(ticks,b). b must be a safe integer >=0 else null. Count ticks via countWindows; return 'deny' when the count at window b is >= max, else 'allow'. Return null when countWindows rejects.`;
  const phaseText = `Import {size} from the limits module listed in dependsOn. Export function phaseOf(t,k). t and k must be safe integers >=0, else null. Return floor(t/size)*k + (t mod size).`;
  const partText = (i: number): string => `Import {size} from the limits module listed in dependsOn. Export function countPart(ticks). ticks must be an array of safe integers >=0; return how many ticks fall in window ${i} (Math.floor(t/size)===${i}), or null on invalid input.`;
  const joinText = `Import {countPart} from every part module listed in dependsOn plus {size} from the limits module. Export function summarize(ticks). ticks must be an array of safe integers >=0; return {total,byWindow} where total is ticks.length and byWindow is the sorted [[window,count]] list of nonzero windows. Return null on invalid input.`;

  const sBucket = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.floor(v / size) : null;
  const sBucketN = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > -size ? Math.floor(v / size) : null;
  const sBucketC = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? Math.ceil(v / size) : null;
  const sCount = (v: unknown, loose = false): [number, number][] | null => {
    if (!Array.isArray(v)) return null;
    const m = new Map<number, number>();
    for (const t of v) {
      const b = loose ? (typeof t === 'number' && t >= 0 ? Math.floor(t / size) : null) : sBucket(t);
      if (b === null) return null;
      m.set(b, (m.get(b) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  };
  const sDecide = (v: unknown, b: unknown, loose = false, cap = max): string | null => {
    const c = sCount(v, loose);
    if (c === null) return null;
    if (typeof b !== 'number' || !Number.isSafeInteger(b) || b < 0) return null;
    const n = c.find(([k]) => k === b)?.[1] ?? 0;
    return n < cap ? 'allow' : 'deny';
  };
  const sDecideA = (v: unknown, b: unknown): string | null => {
    const c = sCount(v);
    if (c === null) return null;
    if (typeof b !== 'number' || !Number.isSafeInteger(b) || b < 0) return null;
    return 'allow';
  };
  const sPhase = (t: unknown, k: unknown, drop = false): number | null => {
    if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) return null;
    if (typeof k !== 'number' || !Number.isSafeInteger(k) || k < 0) return null;
    return (drop ? 0 : Math.floor(t / size)) * k + (t % size);
  };

  const sPart = (i: number, v: unknown, extra = false): number | null => {
    if (!Array.isArray(v)) return null;
    let n = 0;
    for (const t of v) {
      if (sBucket(t) === null) return null;
      const w = Math.floor((t as number) / size);
      if (w === i || (extra && w === i + 1)) n++;
    }
    return n;
  };
  const sJoin = (v: unknown, bump = false): {total: number; byWindow: [number, number][]} | null => {
    const c = sCount(v);
    if (c === null) return null;
    return {total: (v as unknown[]).length + (bump ? 1 : 0), byWindow: c};
  };

  const times = (k: number, w: number): number[] => Array.from({length: k}, (_, i) => w * size + ((i * 2 + variant) % Math.max(1, size - 1)));
  const timesExact = (k: number, w: number): number[] => Array.from({length: k}, () => w * size);
  const belowLimit = timesExact(Math.max(0, max - 1), 0);
  const atLimit = timesExact(max, 0);

  const limPub = raw(`assert.equal(m.size,${size});`, `assert.equal(m.max,${max});`);
  const limHid = raw(`assert.ok(m.size>0&&m.max>0);`, `assert.equal(m.size*1,${size});`, `assert.equal(m.max*1,${max});`);
  const bucketPub: Case[] = [
    [[0], 0], [[size - 1], 0], [[size], 1], [[-1], null], [[size * 2 + 1], 2],
  ];
  const bucketHid: Case[] = [
    [[1.5], null], [[null], null], [['3'], null], [[size * 7], 7], [[Number.MAX_SAFE_INTEGER], Math.floor(Number.MAX_SAFE_INTEGER / size)], [[Number.MAX_SAFE_INTEGER + 1], null], [[size * 3 - 1], 2],
  ];
  const countPub: Case[] = [
    [[[0, size, 0]], [[0, 2], [1, 1]]], [[atLimit], [[0, max]]], [[[]], []], [[null], null],
  ];
  const countHid: Case[] = [
    [[[size + 1, -1]], null], [[[1.5]], null], [['x'], null], [[[size * 2]], [[2, 1]]],
    [[atLimit.concat([size * 4])], sCount(atLimit.concat([size * 4]))], [[[size - 1, size, size + 1, 0]], sCount([size - 1, size, size + 1, 0])],
  ];
  const decidePub: Case[] = [
    [[belowLimit, 0], 'allow'], [[atLimit, 0], 'deny'], [[[], 0], 'allow'], [[null, 0], null], [[atLimit, -1], null],
  ];
  const decideHid: Case[] = [
    [[atLimit, 1], 'allow'], [[timesExact(max, 1), 1], 'deny'], [[timesExact(Math.max(0, max - 2), 0), 0], 'allow'], [[[], 1], 'allow'],
    [[atLimit.concat([size * 3]), 3], 'allow'], [['x', 0], null], [[atLimit, 0.5], null],
  ];
  const phaseCases = (i: number): Case[] => {
    const ph = (i % 5) + 1;
    return [
      [[0, ph], sPhase(0, ph)], [[size + 2, ph], sPhase(size + 2, ph)], [[-1, ph], null], [[size, ph], sPhase(size, ph)],
    ];
  };
  const phaseHid = (i: number): Case[] => {
    const ph = (i % 5) + 1;
    return [[[1.5, ph], null], [[size, -ph], null], [[size * 3 + 1, ph], sPhase(size * 3 + 1, ph)], [[0, 0], sPhase(0, 0)], [[null, ph], null]];
  };
  const partCases = (i: number): Case[] => [
    [[timesExact(2, i)], 2], [[times(3, i)], sPart(i, times(3, i))], [[timesExact(3, i + 1)], 0], [[[]], 0], [[null], null],
  ];
  const partHid = (i: number): Case[] => [
    [[[-1]], null], [[[i * size + size - 1]], 1], [[timesExact(max, i).concat([i * size + 1])], sPart(i, timesExact(max, i).concat([i * size + 1]))], [[['x']], null],
  ];
  const joinPub: Case[] = [
    [[timesExact(2, 0)], sJoin(timesExact(2, 0))], [[timesExact(1, 1).concat(timesExact(2, 0))], sJoin(timesExact(1, 1).concat(timesExact(2, 0)))], [[[]], {total: 0, byWindow: []}],
  ];
  const joinHid: Case[] = [
    [[null], null], [[[1.5]], null], [[timesExact(1, 3)], sJoin(timesExact(1, 3))], [[timesExact(max, 2).concat([0])], sJoin(timesExact(max, 2).concat([0]))],
  ];

  const nodeLim = (key: string): NodeOut =>
    N({
      key, role: 'lim', deps: [], instructions: limText, reference: `export const size=${size};\nexport const max=${max};\n`,
      publicBody: limPub, holdBody: limHid,
      mutants: [
        {id: 'max-plus', description: 'limits export max+1', content: `export const size=${size};\nexport const max=${max + 1};\n`, publicPass: false},
        {id: 'size-minus', description: 'limits export size-1', content: `export const size=${size - 1};\nexport const max=${max};\n`, publicPass: false},
      ],
    });
  const nodeBucket = (key: string, lim: string): NodeOut => {
    const ref = `import {size} from './${lim}.mjs';
export function bucketIndex(t){
 if(!Number.isSafeInteger(t)||t<0)return null;
 return Math.floor(t/size);
}
`;
    return N({
      key, role: 'bucket', deps: [lim], instructions: bucketText, reference: ref,
      publicBody: fnBody('bucketIndex', bucketPub), holdBody: fnBody('bucketIndex', bucketHid),
      mutants: [
        {id: 'neg-ok', description: 'bucket accepts small negatives', content: mustReplace(ref, `t<0`, `t<-size`), publicPass: flagOf([[bucketPub, (a) => sBucket(a[0]), (a) => sBucketN(a[0])], [countPub, (a) => sCount(a[0]), (a) => { if (!Array.isArray(a[0])) return null; const m = new Map<number, number>(); for (const t of a[0]) { const b = sBucketN(t); if (b === null) return null; m.set(b, (m.get(b) ?? 0) + 1); } return [...m.entries()].sort((x, y) => x[0] - y[0]); }]])},
        {id: 'off-one', description: 'bucket uses ceil instead of floor', content: mustReplace(ref, `Math.floor(t/size)`, `Math.ceil(t/size)`), publicPass: flagOf([[bucketPub, (a) => sBucket(a[0]), (a) => sBucketC(a[0])]])},
      ],
    });
  };
  const nodeCount = (key: string, lim: string, bucket: string): NodeOut => {
    const ref = `import {size} from './${lim}.mjs';
import {bucketIndex} from './${bucket}.mjs';
export function countWindows(ticks){
 if(!Array.isArray(ticks))return null;
 const seen={};
 for(const t of ticks){
  const b=bucketIndex(t);
  if(b===null)return null;
  seen[b]=(seen[b]??0)+1;
 }
 return Object.keys(seen).map(k=>Number(k)).sort((a,b)=>a-b).map(k=>[k,seen[k]]);
}
`;
    return N({
      key, role: 'count', deps: [lim, bucket], instructions: countText, reference: ref,
      publicBody: fnBody('countWindows', countPub), holdBody: fnBody('countWindows', countHid, keepInputs([[atLimit]])),
      mutants: [
        {id: 'float-ok', description: 'counter accepts non-integer ticks', content: mustReplace(ref, `const b=bucketIndex(t);`, `const b=typeof t==='number'&&t>=0?Math.floor(t/size):null;`), publicPass: flagOf([[countPub, (a) => sCount(a[0]), (a) => sCount(a[0], true)], [decidePub, (a) => sDecide(a[0], a[1]), (a) => sDecide(a[0], a[1], true)]])},
      ],
    });
  };
  const nodeDecide = (key: string, lim: string, bucket: string, count_: string): NodeOut => {
    const ref = `import {max} from './${lim}.mjs';
import {bucketIndex} from './${bucket}.mjs';
import {countWindows} from './${count_}.mjs';
export function decide(ticks,b){
 if(!Number.isSafeInteger(b)||b<0)return null;
 const counts=countWindows(ticks);
 if(counts===null)return null;
 const row=counts.find(([k])=>k===b);
 const n=row?row[1]:0;
 return n<max?'allow':'deny';
}
`;
    return N({
      key, role: 'decide', deps: [lim, bucket, count_], instructions: decideText, reference: ref,
      publicBody: fnBody('decide', decidePub), holdBody: fnBody('decide', decideHid),
      mutants: [
        {id: 'deny-early', description: 'decide denies one below the cap', content: mustReplace(ref, `n<max`, `n<max-1`), publicPass: flagOf([[decidePub, (a) => sDecide(a[0], a[1]), (a) => sDecide(a[0], a[1], false, max - 1)]])},
        {id: 'always-allow', description: 'decide always allows', content: mustReplace(ref, `const n=row?row[1]:0;`, `const n=0;`), publicPass: flagOf([[decidePub, (a) => sDecide(a[0], a[1]), (a) => sDecideA(a[0], a[1])]])},
      ],
    });
  };
  const nodePhase = (key: string, lim: string, i: number): NodeOut => {
    const ref = `import {size} from './${lim}.mjs';
export function phaseOf(t,k){
 if(!Number.isSafeInteger(t)||t<0)return null;
 if(!Number.isSafeInteger(k)||k<0)return null;
 return Math.floor(t/size)*k+(t%size);
}
`;
    return N({
      key, role: 'phase', deps: [lim], instructions: phaseText, reference: ref,
      publicBody: fnBody('phaseOf', phaseCases(i)), holdBody: fnBody('phaseOf', phaseHid(i)),
      mutants: [
        {id: 'phase-zero', description: 'phase drops the bucket term', content: mustReplace(ref, `Math.floor(t/size)*k`, `0*k`), publicPass: flagOf([[phaseCases(i), (a) => sPhase(a[0], a[1]), (a) => sPhase(a[0], a[1], true)]])},
      ],
    });
  };

  const nodes: NodeOut[] = [nodeLim('lim-0')];
  if (topology === 'independent') {
    for (let i = 0; i < count - 1; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeBucket(`bucket-${i}`, 'lim-0'));
      else if (k === 1) nodes.push(nodeCount(`count-${i}`, 'lim-0', `bucket-${i - 1}`));
      else nodes.push(nodeDecide(`decide-${i}`, 'lim-0', `bucket-${i - 2}`, `count-${i - 1}`));
    }
  } else if (topology === 'fanout') {
    for (let i = 0; i < count - 1; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeBucket(`bucket-${i}`, 'lim-0'));
      else if (k === 1) nodes.push(nodePhase(`phase-${i}`, 'lim-0', i));
      else nodes.push(nodeCount(`count-${i}`, 'lim-0', `bucket-${i - 2}`));
    }
  } else {
    // fanin: lim -> per-part counters -> summarize join
    const partKeys: string[] = [];
    for (let i = 0; i < count - 2; i++) {
      const pref = `import {size} from './lim-0.mjs';
export function countPart(ticks){
 if(!Array.isArray(ticks))return null;
 let n=0;
 for(const t of ticks){
  if(!Number.isSafeInteger(t)||t<0)return null;
  if(Math.floor(t/size)===${i})n++;
 }
 return n;
}
`;
      nodes.push(
        N({
          key: `part-${i}`, role: 'part', deps: ['lim-0'], instructions: partText(i), reference: pref,
          publicBody: fnBody('countPart', partCases(i)), holdBody: fnBody('countPart', partHid(i)),
          mutants: [
            {id: 'part-skip', description: `part also counts window ${i + 1}`, content: mustReplace(pref, `Math.floor(t/size)===${i})n++`, `Math.floor(t/size)===${i}||Math.floor(t/size)===${i + 1})n++`), publicPass: flagOf([[partCases(i), (a) => sPart(i, a[0]), (a) => sPart(i, a[0], true)]])},
          ],
        }),
      );
      partKeys.push(`part-${i}`);
    }
    const joinImports = partKeys.map((k, j) => `import {countPart as P${j}} from './${k}.mjs';`).join('\n');
    const joinRef = `${joinImports}
import {size} from './lim-0.mjs';
const PARTS=[${partKeys.map((_, j) => `P${j}`).join(',')}];
export function summarize(ticks){
 if(!Array.isArray(ticks))return null;
 const seen={};
 for(const t of ticks){
  if(!Number.isSafeInteger(t)||t<0)return null;
  const b=Math.floor(t/size);
  seen[b]=(seen[b]??0)+1;
 }
 const parts=PARTS.map((f)=>f(ticks));
 if(parts.some((x)=>x===null))return null;
 const byWindow=Object.keys(seen).map(k=>Number(k)).sort((a,b)=>a-b).map(k=>[k,seen[k]]);
 return {total:ticks.length,byWindow};
}
`;
    nodes.push(
      N({
        key: 'join-0', role: 'join', deps: ['lim-0', ...partKeys], instructions: joinText, reference: joinRef,
        publicBody: fnBody('summarize', joinPub), holdBody: fnBody('summarize', joinHid),
        mutants: [
          {id: 'join-total', description: 'summarize reports total+1', content: mustReplace(joinRef, `total:ticks.length`, `total:ticks.length+1`), publicPass: flagOf([[joinPub, (a) => sJoin(a[0]), (a) => sJoin(a[0], true)]])},
        ],
      }),
    );
  }

  const menu: {role: string; desc: string; f: (s: string) => string}[] =
    topology === 'independent'
      ? [
          {role: 'lim', desc: 'limits export size+1', f: (s) => mustReplace(s, `export const size=${size};`, `export const size=${size + 1};`)},
          {role: 'bucket', desc: 'bucket uses ceil instead of floor', f: (s) => mustReplace(s, `Math.floor(t/size)`, `Math.ceil(t/size)`)},
          {role: 'count', desc: 'counter drops the last tick', f: (s) => mustReplace(s, `for(const t of ticks){`, `ticks=ticks.slice(0,-1);for(const t of ticks){`)},
          {role: 'decide', desc: 'decide allows at the cap', f: (s) => mustReplace(s, `n<max`, `n<=max`)},
        ]
      : topology === 'fanout'
        ? [
            {role: 'lim', desc: 'limits export size+1', f: (s) => mustReplace(s, `export const size=${size};`, `export const size=${size + 1};`)},
            {role: 'bucket', desc: 'bucket uses ceil instead of floor', f: (s) => mustReplace(s, `Math.floor(t/size)`, `Math.ceil(t/size)`)},
            {role: 'phase', desc: 'phase uses ceil for the bucket', f: (s) => mustReplace(s, `Math.floor(t/size)*k`, `Math.ceil(t/size)*k`)},
          ]
        : [
            {role: 'lim', desc: 'limits export max+1', f: (s) => mustReplace(s, `export const max=${max};`, `export const max=${max + 1};`)},
            {role: 'part', desc: 'part counts the wrong window', f: (s) => mustReplace(s, `===0`, `===1`)},
            {role: 'join', desc: 'summarize reports total+1', f: (s) => mustReplace(s, `total:ticks.length`, `total:ticks.length+1`)},
          ];
  const available = menu.filter(m => nodes.some(n => n.role === m.role));
  const pick = available[variant % available.length]!;
  const target = findKey(nodes, pick.role, 0);
  seedDefect(nodes, target, pick.f);
  return {goal, defect: `${pick.desc} (in ${target})`, nodes};
};

// ---------------------------------------------------------------------------
// Family: stats — bounded integer streams, medians, rollup audits.
// ---------------------------------------------------------------------------
const stats: SpecGen = (variant, topology, count) => {
  const r = mulberry32(0x57a75 + variant * 53);
  const lo = -ri(r, 5, 30);
  const span = ri(r, 15, 60);
  const hi = lo + span;
  const modes = ['lower', 'upper', 'mean'] as const;
  const mode = modes[variant % 3]!;
  const goal = `This repository checks integer values in [${lo},${hi}], computes aggregates (count/sum/min/max) and a ${mode} median, and audits streams. Follow contract.md exactly.`;
  const boundText = `Export exactly three constants: lo=${lo}, hi=${hi}, mode=${JSON.stringify(mode)}. Export nothing else.`;
  const checkText = `Import {lo,hi} from the bounds module listed in dependsOn. Export function checkValue(x). Accept only safe integers with lo<=x<=hi; return x. Otherwise null.`;
  const aggText = `Import {checkValue} from the check module listed in dependsOn. Export function aggregate(list). list must be an array where every element passes checkValue; return {count,sum,min,max} (min/max are null when empty). Return null on invalid input. Never mutate the input.`;
  const medianText = `Import {checkValue} from the check module and {mode} from the bounds module listed in dependsOn. Export function median(values). values must be an array where every element passes checkValue; sort a COPY ascending; for odd count return the middle element; for even count use the lower middle for mode='lower', upper middle for mode='upper', or their arithmetic mean for mode='mean'. Return null on invalid input or empty list. Never mutate the input.`;
  const auditText = `Import {aggregate} from the aggregate module and {lo,hi} from the bounds module listed in dependsOn. Export function audit(list). Run aggregate; when it returns null return null; return {agg, ok} where ok is true iff count===0 or (min>=lo and max<=hi).`;
  const partText = (plo: number, phi: number): string => `Import nothing. Export function partStats(list). list must be an array of safe integers in [${plo},${phi}] (this part's fixed bounds); return {count,sum,min,max}, or null on invalid input.`;
  const joinText = `Import {partStats} from every part module listed in dependsOn. Export function rollup(lists). lists must be an array whose length equals the number of parts; run part j on lists[j]; if any returns null return null; otherwise return {count,sum,min,max,mean} over the combined stream (mean=sum/count, null when count===0).`;

  const sCheck = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : null;
  const sCheckL = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > lo && v <= hi ? v : null;
  const sCheckF = (v: unknown): number | null =>
    typeof v === 'number' && v >= lo && v <= hi ? v : null;
  const sAgg = (v: unknown, loose = false): {count: number; sum: number; min: number | null; max: number | null} | null => {
    if (!Array.isArray(v)) return null;
    let sum = 0;
    let mn: number | null = null;
    let mx: number | null = null;
    for (const x of v) {
      const ok = loose ? sCheckF(x) : sCheck(x);
      if (ok === null) return null;
      sum += x as number;
      mn = mn === null ? (x as number) : Math.min(mn, x as number);
      mx = mx === null ? (x as number) : Math.max(mx, x as number);
    }
    return {count: v.length, sum, min: mn, max: mx};
  };
  const sMedian = (v: unknown): number | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    for (const x of v) if (sCheck(x) === null) return null;
    const vs = (v as number[]).slice().sort((a, b) => a - b);
    const mid = Math.floor(vs.length / 2);
    if (vs.length % 2 === 1) return vs[mid]!;
    if (mode === 'lower') return vs[mid - 1]!;
    if (mode === 'upper') return vs[mid]!;
    return (vs[mid - 1]! + vs[mid]!) / 2;
  };
  const sMedianMut = (v: unknown, m2: 'lower' | 'upper' | 'floor'): number | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    for (const x of v) if (sCheck(x) === null) return null;
    const vs = (v as number[]).slice().sort((a, b) => a - b);
    const mid = Math.floor(vs.length / 2);
    if (vs.length % 2 === 1) return vs[mid]!;
    if (m2 === 'lower' || m2 === 'floor') return vs[mid - 1]!;
    return vs[mid]!;
  };
  const sAudit = (v: unknown, openLo = false): {agg: unknown; ok: boolean} | null => {
    const a = sAgg(v);
    if (a === null) return null;
    const ok = a.count === 0 ? true : openLo ? (a.min as number) > lo && (a.max as number) <= hi : (a.min as number) >= lo && (a.max as number) <= hi;
    return {agg: a, ok};
  };
  const inRange = (k: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < k; i++) out.push(lo + ((variant * 7 + i * 13 + 5) % (hi - lo)));
    return out;
  };
  // memoized per-part bounds (deterministic, independent of call order)
  const partBounds = Array.from({length: Math.max(0, count - 2)}, (_, i) => {
    const plo = lo + i * 3;
    const phi = plo + 10 + ((variant + i) % 6);
    return [plo, phi] as const;
  });
  const partIn = (i: number, k: number): number[] => {
    const [plo, phi] = partBounds[i]!;
    const out: number[] = [];
    for (let j = 0; j < k; j++) out.push(plo + ((variant * 5 + i * 7 + j * 11) % (phi - plo + 1)));
    return out;
  };
  const sPart = (i: number, v: unknown, open = false) => {
    const [plo, phi] = partBounds[i]!;
    if (!Array.isArray(v)) return null;
    let sum = 0;
    let mn: number | null = null;
    let mx: number | null = null;
    for (const x of v) {
      if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < plo || (open ? x >= phi : x > phi)) return null;
      sum += x;
      mn = mn === null ? x : Math.min(mn, x);
      mx = mx === null ? x : Math.max(mx, x);
    }
    return {count: v.length, sum, min: mn, max: mx};
  };
  const sRollup = (v: unknown, floor = false): {count: number; sum: number; min: number | null; max: number | null; mean: number | null} | null => {
    if (!Array.isArray(v) || v.length !== count - 2) return null;
    let cnt = 0;
    let sum = 0;
    let mn: number | null = null;
    let mx: number | null = null;
    for (let j = 0; j < v.length; j++) {
      const p = sPart(j, v[j]);
      if (p === null) return null;
      cnt += p.count;
      sum += p.sum;
      if (p.min !== null) mn = mn === null ? p.min : Math.min(mn, p.min);
      if (p.max !== null) mx = mx === null ? p.max : Math.max(mx, p.max);
    }
    const mean = cnt === 0 ? null : floor ? Math.floor(sum / cnt) : sum / cnt;
    return {count: cnt, sum, min: mn, max: mx, mean};
  };

  const oddSet = inRange(5).filter((x) => x <= hi);
  const evenSet = inRange(4);
  const boundPub = raw(`assert.equal(m.lo,${lo});`, `assert.equal(m.hi,${hi});`, `assert.equal(m.mode,${lit(mode)});`);
  const boundHid = raw(`assert.ok(m.lo<m.hi);`, `assert.equal(m.lo*1,${lo});`, `assert.equal(m.hi*1,${hi});`, `assert.equal(m.mode,${lit(mode)});`);
  const checkPub: Case[] = [
    [[lo], lo], [[hi], hi], [[lo - 1], null], [[hi + 1], null], [[1.5], null], [[0], sCheck(0)],
  ];
  const checkHid: Case[] = [
    [[null], null], [['5'], null], [[{}], null], [[[]], null], [[hi + 100], null], [[-10000], sCheck(-10000)],
    [[Number.MAX_SAFE_INTEGER], null], [[lo + 1], sCheck(lo + 1)], [[Math.floor((lo + hi) / 2)], sCheck(Math.floor((lo + hi) / 2))],
  ];
  const aggPub: Case[] = [
    [[oddSet], sAgg(oddSet)], [[[]], {count: 0, sum: 0, min: null, max: null}], [[[hi + 1]], null], [[null], null],
  ];
  const aggHid: Case[] = [
    [[[lo]], {count: 1, sum: lo, min: lo, max: lo}], [[[hi]], {count: 1, sum: hi, min: hi, max: hi}], [[[1.5]], null], [['x'], null],
    [[inRange(9)], sAgg(inRange(9))], [[[lo, hi]], sAgg([lo, hi])],
  ];
  const aggHidExtra = keepInputs([[inRange(4)]]);
  const medianPub: Case[] = [
    [[oddSet], sMedian(oddSet)], [[evenSet], sMedian(evenSet)], [[[]], null], [[[lo]], lo],
  ];
  const medianHid: Case[] = [
    [[null], null], [[[hi + 1]], null], [[inRange(6)], sMedian(inRange(6))], [[inRange(3)], sMedian(inRange(3))],
    [[[lo, lo + 1]], sMedian([lo, lo + 1])], [[[hi - 1, hi]], sMedian([hi - 1, hi])], [[[lo, hi]], sMedian([lo, hi])],
  ];
  const medianHidExtra = keepInputs([[evenSet]]);
  const auditPub: Case[] = [
    [[oddSet], sAudit(oddSet)], [[[]], sAudit([])], [[[hi + 1]], null],
  ];
  const auditHid: Case[] = [
    [[null], null], [[[lo, lo + 3]], sAudit([lo, lo + 3])], [[[hi, hi - 2]], sAudit([hi, hi - 2])], [[inRange(7)], sAudit(inRange(7))],
    [[[lo, hi]], sAudit([lo, hi])],
  ];

  const nodeBound = (key: string): NodeOut =>
    N({
      key, role: 'bound', deps: [], instructions: boundText, reference: `export const lo=${lo};\nexport const hi=${hi};\nexport const mode=${JSON.stringify(mode)};\n`,
      publicBody: boundPub, holdBody: boundHid,
      mutants: [
        {id: 'hi-plus', description: 'bounds export hi+1', content: `export const lo=${lo};\nexport const hi=${hi + 1};\nexport const mode=${JSON.stringify(mode)};\n`, publicPass: false},
        {id: 'mode-swap', description: 'bounds export a different median mode', content: `export const lo=${lo};\nexport const hi=${hi};\nexport const mode=${JSON.stringify(mode === 'lower' ? 'upper' : 'lower')};\n`, publicPass: false},
      ],
    });
  const nodeCheck = (key: string, bound: string): NodeOut => {
    const ref = `import {lo,hi} from './${bound}.mjs';
export function checkValue(x){
 if(!Number.isSafeInteger(x)||x<lo||x>hi)return null;
 return x;
}
`;
    return N({
      key, role: 'check', deps: [bound], instructions: checkText, reference: ref,
      publicBody: fnBody('checkValue', checkPub), holdBody: fnBody('checkValue', checkHid),
      mutants: [
        {id: 'lo-open', description: 'check rejects the lower bound', content: mustReplace(ref, `x<lo`, `x<=lo`), publicPass: flagOf([[checkPub, (a) => sCheck(a[0]), (a) => sCheckL(a[0])]])},
        {id: 'float-ok', description: 'check accepts non-integers in range', content: mustReplace(ref, `Number.isSafeInteger(x)`, `typeof x==='number'`), publicPass: flagOf([[checkPub, (a) => sCheck(a[0]), (a) => sCheckF(a[0])], [aggPub, (a) => sAgg(a[0]), (a) => sAgg(a[0], true)]])},
      ],
    });
  };
  const nodeAgg = (key: string, check: string): NodeOut => {
    const ref = `import {checkValue} from './${check}.mjs';
export function aggregate(list){
 if(!Array.isArray(list))return null;
 let sum=0,min=null,max=null,count=0;
 for(const x of list){
  const v=checkValue(x);
  if(v===null)return null;
  sum+=v;
  count++;
  if(min===null||v<min)min=v;
  if(max===null||v>max)max=v;
 }
 return {count,sum,min,max};
}
`;
    return N({
      key, role: 'agg', deps: [check], instructions: aggText, reference: ref,
      publicBody: fnBody('aggregate', aggPub), holdBody: fnBody('aggregate', aggHid, aggHidExtra),
      mutants: [
        {id: 'no-check', description: 'aggregate accepts out-of-range values', content: mustReplace(ref, `const v=checkValue(x);`, `const v=x;`), publicPass: flagOf([[aggPub, (a) => sAgg(a[0]), (a) => { if (!Array.isArray(a[0])) return null; let s = 0; let mn: number | null = null; let mx: number | null = null; for (const x of a[0]) { if (typeof x !== 'number' || !Number.isSafeInteger(x)) return null; s += x; mn = mn === null ? x : Math.min(mn, x); mx = mx === null ? x : Math.max(mx, x); } return {count: a[0].length, sum: s, min: mn, max: mx}; }]])},
        {id: 'sum-skip', description: 'aggregate doubles every value', content: mustReplace(ref, `sum+=v;`, `sum+=v*2;`), publicPass: false},
      ],
    });
  };
  const nodeMedian = (key: string, check: string, bound: string): NodeOut => {
    const ref = `import {checkValue} from './${check}.mjs';
import {mode} from './${bound}.mjs';
export function median(values){
 if(!Array.isArray(values)||values.length===0)return null;
 const vs=[...values];
 for(const x of vs){
  if(checkValue(x)===null)return null;
 }
 vs.sort((a,b)=>a-b);
 const mid=Math.floor(vs.length/2);
 if(vs.length%2===1)return vs[mid];
 if(mode==='lower')return vs[mid-1];
 if(mode==='upper')return vs[mid];
 return (vs[mid-1]+vs[mid])/2;
}
`;
    const alt =
      mode === 'lower'
        ? {id: 'median-upper', description: 'median picks the upper middle', content: mustReplace(ref, `if(mode==='lower')return vs[mid-1]`, `if(mode==='lower')return vs[mid]`), m2: 'upper' as const}
        : mode === 'upper'
          ? {id: 'median-lower', description: 'median picks the lower middle', content: mustReplace(ref, `if(mode==='upper')return vs[mid]`, `if(mode==='upper')return vs[mid-1]`), m2: 'lower' as const}
          : {id: 'median-floor', description: 'median returns the lower middle instead of the mean', content: mustReplace(ref, `(vs[mid-1]+vs[mid])/2`, `vs[mid-1]`), m2: 'floor' as const};
    return N({
      key, role: 'median', deps: [check, bound], instructions: medianText, reference: ref,
      publicBody: fnBody('median', medianPub), holdBody: fnBody('median', medianHid, medianHidExtra),
      mutants: [
        {id: alt.id, description: alt.description, content: alt.content, publicPass: flagOf([[medianPub, (a) => sMedian(a[0]), (a) => sMedianMut(a[0], alt.m2)]])},
        {id: 'median-mutate', description: 'median sorts the input array in place', content: mustReplace(ref, `const vs=[...values];`, `const vs=values;`), publicPass: true},
      ],
    });
  };
  const nodeAudit = (key: string, agg: string, bound: string): NodeOut => {
    const ref = `import {aggregate} from './${agg}.mjs';
import {lo,hi} from './${bound}.mjs';
export function audit(list){
 const agg=aggregate(list);
 if(agg===null)return null;
 const ok=agg.count===0?true:(agg.min>=lo&&agg.max<=hi);
 return {agg,ok};
}
`;
    return N({
      key, role: 'audit', deps: [agg, bound], instructions: auditText, reference: ref,
      publicBody: fnBody('audit', auditPub), holdBody: fnBody('audit', auditHid),
      mutants: [
        {id: 'audit-open', description: 'audit requires min strictly above lo', content: mustReplace(ref, `agg.min>=lo`, `agg.min>lo`), publicPass: flagOf([[auditPub, (a) => sAudit(a[0]), (a) => sAudit(a[0], true)]])},
      ],
    });
  };

  const nodes: NodeOut[] = [nodeBound('bound-0')];
  if (topology === 'independent') {
    for (let i = 0; i < count - 1; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeCheck(`check-${i}`, 'bound-0'));
      else if (k === 1) nodes.push(nodeAgg(`agg-${i}`, `check-${i - 1}`));
      else nodes.push(nodeMedian(`median-${i}`, `check-${i - 2}`, 'bound-0'));
    }
  } else if (topology === 'fanin') {
    const partKeys: string[] = [];
    for (let i = 0; i < count - 2; i++) {
      const [plo, phi] = partBounds[i]!;
      const pref = `export function partStats(list){
 if(!Array.isArray(list))return null;
 let sum=0,min=null,max=null,count=0;
 for(const x of list){
  if(!Number.isSafeInteger(x)||x<${plo}||x>${phi})return null;
  sum+=x;
  count++;
  if(min===null||x<min)min=x;
  if(max===null||x>max)max=x;
 }
 return {count,sum,min,max};
}
`;
      const partPub: Case[] = [
        [[partIn(i, 3)], sPart(i, partIn(i, 3))], [[[]], {count: 0, sum: 0, min: null, max: null}], [[[phi]], sPart(i, [phi])], [[[phi + 1]], null], [[null], null],
      ];
      const partHid: Case[] = [
        [[[plo - 1]], null], [[[plo]], sPart(i, [plo])], [[[1.5]], null], [[partIn(i, 6)], sPart(i, partIn(i, 6))], [[[plo, phi]], sPart(i, [plo, phi])],
      ];
      nodes.push(
        N({
          key: `part-${i}`, role: 'part', deps: [], instructions: partText(plo, phi), reference: pref,
          publicBody: fnBody('partStats', partPub), holdBody: fnBody('partStats', partHid, keepInputs([[partIn(i, 3)]])),
          mutants: [
            {id: 'part-open', description: 'part rejects its upper bound', content: mustReplace(pref, `x>${phi}`, `x>=${phi}`), publicPass: flagOf([[partPub, (a) => sPart(i, a[0]), (a) => sPart(i, a[0], true)]])},
          ],
        }),
      );
      partKeys.push(`part-${i}`);
    }
    const joinImports = partKeys.map((k, j) => `import {partStats as P${j}} from './${k}.mjs';`).join('\n');
    const joinRef = `${joinImports}
const PARTS=[${partKeys.map((_, j) => `P${j}`).join(',')}];
export function rollup(lists){
 if(!Array.isArray(lists)||lists.length!==PARTS.length)return null;
 let count=0,sum=0,min=null,max=null;
 for(let j=0;j<lists.length;j++){
  const p=PARTS[j](lists[j]);
  if(p===null)return null;
  count+=p.count;
  sum+=p.sum;
  if(p.min!==null&&(min===null||p.min<min))min=p.min;
  if(p.max!==null&&(max===null||p.max>max))max=p.max;
 }
 return {count,sum,min,max,mean:count===0?null:sum/count};
}
`;
    const joinIn = (k: number) => Array.from({length: count - 2}, (_, j) => partIn(j, k));
    // hidden case whose expected mean is guaranteed fractional
    let fracFeeds: number[][] | null = null;
    for (let a = 0; a < 4 && fracFeeds === null; a++) {
      for (let b = 0; b < 4 && fracFeeds === null; b++) {
        const feeds = Array.from({length: count - 2}, (_, j) =>
          j === 0 ? [partBounds[0]![0] + a] : j === 1 ? [partBounds[1]![0] + b, partBounds[1]![0] + b + 1] : []);
        const res = sRollup(feeds);
        if (res !== null && res.mean !== null && !Number.isInteger(res.mean)) fracFeeds = feeds;
      }
    }
    const joinPub: Case[] = [
      [[joinIn(2)], sRollup(joinIn(2))], [[joinIn(0)], sRollup(joinIn(0))], [[[]], null], [[null], null],
    ];
    const joinHid: Case[] = [
      [[joinIn(3)], sRollup(joinIn(3))],
      [[joinIn(2).slice(1)], null],
      [[joinIn(2).concat([[]])], null],
      [[joinIn(2).map((l, j) => (j === 0 ? l.concat([partBounds[0]![1] + 1]) : l))], null],
      ...(fracFeeds !== null ? ([[[fracFeeds], sRollup(fracFeeds)]] as Case[]) : []),
    ];
    nodes.push(
      N({
        key: 'join-0', role: 'join', deps: partKeys, instructions: joinText, reference: joinRef,
        publicBody: fnBody('rollup', joinPub), holdBody: fnBody('rollup', joinHid),
        mutants: [
          {id: 'join-floor', description: 'rollup floors the mean', content: mustReplace(joinRef, `mean:count===0?null:sum/count`, `mean:count===0?null:Math.floor(sum/count)`), publicPass: flagOf([[joinPub, (a) => sRollup(a[0]), (a) => sRollup(a[0], true)]])},
        ],
      }),
    );
  } else {
    // diamond: bound -> check/agg/median mids -> audit(lastAgg, bound)
    const mids = count - 2;
    for (let i = 0; i < mids; i++) {
      const k = i % 3;
      if (k === 0) nodes.push(nodeCheck(`check-${i}`, 'bound-0'));
      else if (k === 1) nodes.push(nodeAgg(`agg-${i}`, `check-${Math.max(0, i - 1)}`));
      else nodes.push(nodeMedian(`median-${i}`, `check-${Math.max(0, i - 2)}`, 'bound-0'));
    }
    const lastAgg = [...nodes].reverse().find((n) => n.role === 'agg')!.key;
    nodes.push(nodeAudit('audit-0', lastAgg, 'bound-0'));
  }

  const menu: {role: string; desc: string; f: (s: string) => string}[] =
    topology === 'independent'
      ? [
          {role: 'bound', desc: 'bounds export hi+1', f: (s) => mustReplace(s, `export const hi=${hi};`, `export const hi=${hi + 1};`)},
          {role: 'check', desc: 'check rejects the upper bound', f: (s) => mustReplace(s, `x>hi`, `x>=hi`)},
          {role: 'agg', desc: 'aggregate never seeds min/max', f: (s) => mustReplace(s, `if(min===null||v<min)min=v;`, `if(false)min=v;`)},
          {
            role: 'median',
            desc: mode === 'lower' ? 'median picks the wrong middle' : mode === 'upper' ? 'median picks the lower middle' : 'median returns the lower middle',
            f: (s) =>
              mode === 'lower'
                ? mustReplace(s, `if(mode==='lower')return vs[mid-1]`, `if(mode==='lower')return vs[mid]`)
                : mode === 'upper'
                  ? mustReplace(s, `if(mode==='upper')return vs[mid]`, `if(mode==='upper')return vs[mid-1]`)
                  : mustReplace(s, `(vs[mid-1]+vs[mid])/2`, `vs[mid-1]`),
          },
        ]
      : topology === 'fanin'
        ? [
            {role: 'part', desc: 'part accepts a wider bound', f: (s) => { const m = /x>(-?\d+)/.exec(s); if (m === null) throw new Error('part defect pattern absent'); return mustReplace(s, m[0], `x>${Number(m[1]) + 5}`); }},
            {role: 'join', desc: 'rollup drops the last part', f: (s) => mustReplace(s, `const p=PARTS[j](lists[j]);`, `const p=j===PARTS.length-1?{count:0,sum:0,min:null,max:null}:PARTS[j](lists[j]);`)},
          ]
        : [
            {role: 'bound', desc: 'bounds export lo-1', f: (s) => mustReplace(s, `export const lo=${lo};`, `export const lo=${lo - 1};`)},
            {role: 'check', desc: 'check accepts floats', f: (s) => mustReplace(s, `Number.isSafeInteger(x)`, `typeof x==='number'`)},
            {role: 'median', desc: mode === 'lower' ? 'median picks the wrong middle' : 'median picks the other middle', f: (s) => (mode === 'lower' ? mustReplace(s, `if(mode==='lower')return vs[mid-1]`, `if(mode==='lower')return vs[mid]`) : mode === 'upper' ? mustReplace(s, `if(mode==='upper')return vs[mid]`, `if(mode==='upper')return vs[mid-1]`) : mustReplace(s, `(vs[mid-1]+vs[mid])/2`, `vs[mid]`))},
            {role: 'audit', desc: 'audit requires min strictly above lo', f: (s) => mustReplace(s, `agg.min>=lo`, `agg.min>lo`)},
          ];
  const available = menu.filter(m => nodes.some(n => n.role === m.role));
  const pick = available[variant % available.length]!;
  const target = findKey(nodes, pick.role, 0);
  seedDefect(nodes, target, pick.f);
  return {goal, defect: `${pick.desc} (in ${target})`, nodes};
};

export const f1: Family[] = [
  {name: 'units', title: 'Fixed-point decimal units: parse, render, cap, reconcile', shapes: ['independent', 'fanout', 'diamond', 'sparse'], build: units},
  {name: 'baseconv', title: 'Positional base conversion over custom digit alphabets', shapes: ['independent', 'fanin', 'diamond'], build: baseconv},
  {name: 'window', title: 'Sliding-window counting and admission decisions', shapes: ['independent', 'fanout', 'fanin'], build: window_},
  {name: 'stats', title: 'Bounded integer stream statistics and rollup audits', shapes: ['independent', 'fanin', 'diamond'], build: stats},
];
