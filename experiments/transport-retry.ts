import type {TokenBudgetSnapshot} from '../src/token-budget.ts';

export interface RetryAttempt {
 success:boolean; transportRetryable:boolean; elapsedMs:number; retryWaitMs:number;
 budget:TokenBudgetSnapshot; evidenceErrors:string[];
}
export interface RetryLimits {maxCalls:number;maxTokens:number;reserveTokensPerCall:number}
/** Unknown usage remains unknown; its reservation is charged for admission only. */
export function retryAccounting(attempts:readonly RetryAttempt[]) {
 const calls=attempts.flatMap(a=>a.budget.calls);
 const knownTokens=calls.reduce((n,c)=>n+c.knownTokensLower,0);
 const unknownUsageCalls=calls.filter(c=>c.status!=='settled'||c.tokens===null).length;
 const chargedTokens=calls.reduce((n,c)=>n+(c.status==='settled'&&c.tokens!==null?c.tokens:Math.max(c.reservedTokens,c.knownTokensLower)),0);
 return {calls:calls.length,knownTokens,totalTokens:unknownUsageCalls?null:knownTokens,unknownUsageCalls,chargedTokens,
  activeReservations:calls.filter(c=>c.status!=='settled').length,
  elapsedMs:attempts.reduce((n,a)=>n+a.elapsedMs+a.retryWaitMs,0)};
}
export function transientReceipt(receipt:unknown) {
 const r=receipt as {error?:string;requestedModel?:string;transcript?:{requestedModel?:string;httpStatus?:number|null;cancelled?:boolean}};
 const t=r?.transcript;
 if(!t||t.cancelled||r.requestedModel!=='deepseek-flash'||t.requestedModel!=='deepseek-flash'||!['nonzero-exit','timeout'].includes(r.error??''))return false;
 return t.httpStatus===null||t.httpStatus===408||t.httpStatus===429||(typeof t.httpStatus==='number'&&t.httpStatus>=500&&t.httpStatus<=599);
}
/** A generated-code or hidden-oracle failure is terminal, never a retry lottery. */
export function retryAction(attempts:readonly RetryAttempt[],limits:RetryLimits,maxRetries=3):'run'|'done'|'unavailable'|'stop' {
 if(!Number.isSafeInteger(maxRetries)||maxRetries<0)throw new Error('invalid maxRetries');
 const a=retryAccounting(attempts),last=attempts.at(-1);
 if(a.activeReservations||attempts.some(x=>x.budget.reservationOverruns>0))return 'stop';
 if(last&&!last.transportRetryable)return last.evidenceErrors.length?'stop':'done';
 if(last&&attempts.length>=maxRetries+1)return 'unavailable';
 if(a.calls>=limits.maxCalls||a.chargedTokens+limits.reserveTokensPerCall>limits.maxTokens)return 'unavailable';
 return 'run';
}
export function retryObservation(attempts:readonly RetryAttempt[]) {
 if(!attempts.length)throw new Error('no attempts');
 const last=attempts.at(-1)!,a=retryAccounting(attempts);
 return {...a,success:last.success&&!last.evidenceErrors.length,evidenceErrors:last.evidenceErrors,
  tokens:a.totalTokens,retries:attempts.length-1};
}
