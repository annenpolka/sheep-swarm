import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const amountSpec='Export parseAmount(value). Accept only a string matching unsigned decimal digits (leading zeros allowed), optionally a dot followed by 1..places digits. No whitespace, sign, exponent, trailing dot, or coercion. places comes from settings.mjs. Return an exact nonnegative safe integer in smallest units, padding fractional digits to places. Return null on invalid syntax/type or overflow, never throw. Use exact arithmetic before the safe integer check.';
const cartSpec='Export subtotal(lines). lines is an array of objects {price,quantity}; extra object keys ignored. quantity must be a safe integer 1..1000, price must satisfy parseAmount. Empty array returns 0. Any invalid line, multiplication or sum overflow returns null. Use parseAmount from amount.mjs; no input mutation.';
const invoiceSpec='Export invoice(lines,taxBps). Use subtotal from cart.mjs. taxBps must be an integer 0..10000. Return {net,tax,total} with tax rounded half-up from exact net*taxBps/10000 and total=net+tax. Return null on invalid inputs or any unsafe result; never use floating point rounding of a large product. Preserve inputs.';
const allocateSpec='Export allocate(total,weights). total must be an integer 0..1000000. weights must be a nonempty array of at most 10 integer weights each 1..1000. Otherwise return null. Return allocations summing exactly to total: floor each proportional share, then give remaining units in descending fractional remainder order, ties to lower original index. Preserve input order and never mutate weights.';
const intervalsSpec='Export mergeIntervals(intervals). Accept an array of arrays each exactly two safe integers [start,end] with start<=end. Invalid entry makes entire result null, even if another interval is empty. Validate all entries, drop empty [x,x] intervals, sort ascending start then end, merge overlapping or touching intervals, and return newly allocated pairs. Empty input returns []. Never mutate input.';
export function buildQualitySpeedFixture(family,variant) {
 if(!['independent','propagation'].includes(family)||!Number.isInteger(variant)||variant<0||variant>2)throw new Error('family or variant invalid');
 const places=variant+2;
 const instructions=family==='propagation'?{'amount.mjs':amountSpec,'cart.mjs':cartSpec,'invoice.mjs':invoiceSpec}:{'amount.mjs':amountSpec,'allocate.mjs':allocateSpec,'intervals.mjs':intervalsSpec};
 const targets=Object.keys(instructions);
 const files={
  'settings.mjs':`export const places=${places};\n`,
  'amount.mjs':"import {places} from './settings.mjs';\nexport function parseAmount(value) { return 0; }\n",
  'contract.md':`Implement the declared functions. Return null for invalid input, preserve inputs.\n${Object.entries(instructions).map(([p,s])=>`${p}: ${s}`).join('\n')}\n`,
 };
 if(family==='propagation')Object.assign(files,{'cart.mjs':"import {parseAmount} from './amount.mjs';\nexport function subtotal(lines) { return 0; }\n",'invoice.mjs':"import {subtotal} from './cart.mjs';\nexport function invoice(lines,taxBps) { return {net:0,tax:0,total:0}; }\n"});
 else Object.assign(files,{'allocate.mjs':'export function allocate(total,weights) { return []; }\n','intervals.mjs':'export function mergeIntervals(intervals) { return []; }\n'});
 const publicChecks={
  'amount.mjs':`const {parseAmount:f}=await import('./amount.mjs');assert.equal(f('1.2'),${12*10**(places-1)});assert.equal(f('0'),0);assert.equal(f('-1'),null);assert.equal(f(12),null);`,
  'cart.mjs':`const {subtotal:f}=await import('./cart.mjs');assert.equal(f([{price:'1.2',quantity:2}]),${24*10**(places-1)});assert.equal(f([]),0);assert.equal(f([{price:'1',quantity:0}]),null);`,
  'invoice.mjs':`const {invoice:f}=await import('./invoice.mjs');assert.deepEqual(f([{price:'1',quantity:2}],500),{net:${2*10**places},tax:${10**places/10},total:${21*10**(places-1)}});assert.equal(f([],10001),null);`,
  'allocate.mjs':`const {allocate:f}=await import('./allocate.mjs');assert.deepEqual(f(5,[1,1]),[3,2]);assert.equal(f(1,[]),null);`,
  'intervals.mjs':`const {mergeIntervals:f}=await import('./intervals.mjs');assert.deepEqual(f([[2,4],[0,2],[7,7]]),[[0,4]]);assert.equal(f([[2,1]]),null);`,
 };
 files['public-check.mjs']=`import assert from 'node:assert/strict';\nconst target=process.argv[2];\nswitch(target){\n${targets.map(p=>`case ${JSON.stringify(p)}: {${publicChecks[p]}break;}`).join('\n')}\ndefault:throw new Error('unknown target');}\n`;
 // Hidden oracle uses independent references; it is never part of the public catalog.
 files['holdout.mjs']=`import assert from 'node:assert/strict';
const places=${places};const scale=10n**BigInt(places);const max=BigInt(Number.MAX_SAFE_INTEGER);
const amount=s=>{if(typeof s!=='string'||!new RegExp('^[0-9]+(?:\\\\.[0-9]{1,'+places+'})?$').test(s))return null;const [whole,fraction='']=s.split('.');const n=BigInt(whole)*scale+BigInt(fraction.padEnd(places,'0'));return n>max?null:Number(n);};
const exact=max.toString().padStart(places+1,'0');const boundary=exact.slice(0,-places)+'.'+exact.slice(-places);
const {parseAmount}=await import('./amount.mjs');
for(const v of [null,undefined,true,0,{},[],'',' 1','1 ','+1','-0','1e2','1.','1..0','0.'+'1'.repeat(places+1),'001.2',boundary, (max+1n).toString(),...Array.from({length:30},(_,i)=>(i*37)+'.'+String(i*13).padStart(places,'0').slice(0,places))])assert.equal(parseAmount(v),amount(v),'amount '+String(v));
${family==='propagation'?`
const subtotal=lines=>{if(!Array.isArray(lines))return null;let sum=0n;for(const l of lines){if(!l||typeof l!=='object'||Array.isArray(l)||!Number.isSafeInteger(l.quantity)||l.quantity<1||l.quantity>1000)return null;const p=amount(l.price);if(p===null)return null;sum+=BigInt(p)*BigInt(l.quantity);if(sum>max)return null;}return Number(sum);};
const {subtotal:actualSubtotal}=await import('./cart.mjs');const {invoice}=await import('./invoice.mjs');
for(const lines of [null,{},[],[null],[[]],[{price:'1',quantity:1.5}],[{price:1,quantity:1}],[{price:boundary,quantity:1}],[{price:boundary,quantity:2}],...Array.from({length:15},(_,i)=>[{price:i+'.05',quantity:i+1},{price:'0.01',quantity:3}])]){
 const before=JSON.stringify(lines);const net=subtotal(lines);assert.equal(actualSubtotal(lines),net);
 for(const bps of [-1,0,1,500,3333,9999,10000,10001,0.5,'500',null]){let expected=null;if(net!==null&&Number.isInteger(bps)&&bps>=0&&bps<=10000){const tax=(BigInt(net)*BigInt(bps)+5000n)/10000n;const total=BigInt(net)+tax;if(tax<=max&&total<=max)expected={net,tax:Number(tax),total:Number(total)};}assert.deepEqual(invoice(lines,bps),expected);}
 assert.equal(JSON.stringify(lines),before);
}
`:`
const {allocate}=await import('./allocate.mjs');
for(const weights of [[1],[1,1,1],[1,3,7],[1000,1,1],Array(10).fill(1)])for(const total of [0,1,2,7,99,1000000]){
 const before=JSON.stringify(weights),sum=weights.reduce((a,b)=>a+b,0);const expected=weights.map(w=>Math.floor(total*w/sum));let left=total-expected.reduce((a,b)=>a+b,0);const order=weights.map((w,i)=>({i,r:total*w%sum})).sort((a,b)=>b.r-a.r||a.i-b.i);for(let i=0;i<left;i++)expected[order[i].i]++;assert.deepEqual(allocate(total,weights),expected);assert.equal(JSON.stringify(weights),before);
}
for(const [n,w] of [[-1,[1]],[1.1,[1]],[1000001,[1]],[1,[]],[1,[0]],[1,[1.5]],[1,[1001]],[1,Array(11).fill(1)],[1,null],['1',[1]]])assert.equal(allocate(n,w),null);
const {mergeIntervals}=await import('./intervals.mjs');
for(const [input,expected] of [[[],[]],[[[1,1]],[]],[[[1,3],[2,4],[4,6]],[[1,6]]],[[[5,8],[0,2],[3,4]],[[0,2],[3,4],[5,8]]],[[[-5,-1],[-2,3]], [[-5,3]]],[[[1,1],[2,1]],null],[null,null],[[[0,1,2]],null],[[[0,1.5]],null],[[[0,Infinity]],null]]){const before=JSON.stringify(input);assert.deepEqual(mergeIntervals(input),expected);assert.equal(JSON.stringify(input),before);}
`}
console.log('holdout passed');\n`;
 const task={version:2,goal:'Implement all functions in contract.md and preserve the fixed public interfaces.',files:targets.map(path=>({path,instructions:instructions[path],checks:[{argv:[process.execPath,'public-check.mjs',path]}]})),context:['contract.md','public-check.mjs','settings.mjs'],protected:['holdout.mjs'],checks:[{argv:[process.execPath,'holdout.mjs']}],discovery:{mode:'static+reads',readable:[],maxReadCalls:2,maxDeliveredBytes:262144,maxPathsPerRead:8}};
 return {family,variant,places,files,task};
}
export async function prepareQualitySpeedFixture(directory,family,variant) {
 const fixture=buildQualitySpeedFixture(family,variant);await mkdir(directory,{recursive:false});
 for(const [p,s] of Object.entries(fixture.files))await writeFile(join(directory,p),s);
 execFileSync('git',['init','-q'],{cwd:directory});execFileSync('git',['add','.'],{cwd:directory});execFileSync('git',['-c','user.name=Benchmark Fixture','-c','user.email=fixture@localhost','commit','-qm','Freeze quality and speed fixture'],{cwd:directory});
 return fixture;
}
