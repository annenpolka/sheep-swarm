/** Host-only reference candidates. Never included in a worker snapshot/catalog. */
export function referenceContents(family) {
 const amount=`import {places} from './settings.mjs';
export function parseAmount(value) {
 if(typeof value!=='string')return null;
 const parts=value.split('.');if(parts.length>2||!/^\\d+$/.test(parts[0]))return null;
 const f=parts[1];if(f!==undefined&&(!/^\\d+$/.test(f)||f.length>places))return null;
 const digits=parts[0]+(f??'').padEnd(places,'0');const n=BigInt(digits);
 return n>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(n);
}\n`;
 if(family==='propagation')return {
  'amount.mjs':amount,
  'cart.mjs':`import {parseAmount} from './amount.mjs';
export function subtotal(lines){if(!Array.isArray(lines))return null;let total=0n;for(const line of lines){if(!line||typeof line!=='object'||Array.isArray(line)||!Number.isSafeInteger(line.quantity)||line.quantity<1||line.quantity>1000)return null;const unit=parseAmount(line.price);if(unit===null)return null;total+=BigInt(unit)*BigInt(line.quantity);if(total>BigInt(Number.MAX_SAFE_INTEGER))return null;}return Number(total);}\n`,
  'invoice.mjs':`import {subtotal} from './cart.mjs';
export function invoice(lines,taxBps){if(!Number.isInteger(taxBps)||taxBps<0||taxBps>10000)return null;const net=subtotal(lines);if(net===null)return null;const product=BigInt(net)*BigInt(taxBps);let tax=product/10000n;if(product%10000n>=5000n)tax++;const total=BigInt(net)+tax;if(total>BigInt(Number.MAX_SAFE_INTEGER))return null;return {net,tax:Number(tax),total:Number(total)};}\n`,
 };
 return {'amount.mjs':amount,
 'allocate.mjs':`export function allocate(total,weights){if(!Number.isInteger(total)||total<0||total>1000000||!Array.isArray(weights)||weights.length<1||weights.length>10||weights.some(w=>!Number.isInteger(w)||w<1||w>1000))return null;const sum=weights.reduce((a,b)=>a+b,0);const result=weights.map(w=>Math.trunc(total*w/sum));const order=weights.map((w,i)=>i).sort((a,b)=>(total*weights[b]%sum)-(total*weights[a]%sum)||a-b);for(let rest=total-result.reduce((a,b)=>a+b,0),i=0;i<rest;i++)result[order[i]]++;return result;}\n`,
 'intervals.mjs':`export function mergeIntervals(intervals){if(!Array.isArray(intervals))return null;const work=[];for(const pair of intervals){if(!Array.isArray(pair)||pair.length!==2||!pair.every(Number.isSafeInteger)||pair[0]>pair[1])return null;if(pair[0]<pair[1])work.push([...pair]);}work.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const result=[];for(const [a,b] of work){const last=result.at(-1);if(last&&a<=last[1])last[1]=Math.max(last[1],b);else result.push([a,b]);}return result;}\n`};
}
