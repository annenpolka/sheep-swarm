import policy from './policies/retail.json' with {type:'json'};
export function quote(units) {
  if(!Number.isSafeInteger(units)||units<0)return null;
  return Math.min(policy.cap,Math.max(policy.minimum,units))*policy.rate;
}
