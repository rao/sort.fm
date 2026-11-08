import type {FitResponse} from '@sortfm/contracts';
import type {RepositoryMl} from './ml/repository';

/** Record actual completed fits without coupling C1 success to optional policy storage. */
export function withPolicyFitReceipts(
 ml:RepositoryMl,
 record:(userId:string,response:FitResponse)=>Promise<boolean>,
 options:{timeoutMs?:number;onError?:(code:string)=>void}={},
):RepositoryMl {
 const timeoutMs=options.timeoutMs??2000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>2_147_483_647)
  throw new RangeError('Policy receipt timeout must be positive, finite and timer-safe.');
 const report=(code:string)=>{
  try {void Promise.resolve(options.onError?.(code)).catch(()=>{});}catch{/* Diagnostics cannot change fit completion. */}
 };
 return {...ml,async fit(userId:string){
  // This continuation belongs to the actual fit, so an HTTP caller timing out
  // does not cancel receipt persistence when the underlying fit completes later.
  const response=await ml.fit(userId);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   // Handle synchronous errors and late rejection before racing the bounded wait.
   // A false return (for example, missing optional migration016) is harmless.
   const recording=Promise.resolve().then(()=>record(userId,response))
    .then(()=>'completed' as const,()=>'failed' as const);
   const outcome=await Promise.race([recording,new Promise<'timeout'>(resolve=>{
    timer=setTimeout(()=>resolve('timeout'),timeoutMs);
   })]);
   if(outcome!=='completed')report(outcome==='timeout'?'POLICY_FIT_RECEIPT_TIMEOUT':'POLICY_FIT_RECEIPT_UNAVAILABLE');
  }finally{clearTimeout(timer);}
  return response;
 }};
}
