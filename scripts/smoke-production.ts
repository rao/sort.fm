/** Anonymous deployment checks only: no account cookies, provider calls or owner mutations. */
import {parseArgs} from 'node:util';
import {AccountSessionSchema,DemoBootstrapSchema,QueueResultSchema} from '../packages/contracts/src/index';

const {values}=parseArgs({options:{web:{type:'string',default:'https://sort.fm'},api:{type:'string',default:'https://api.sort.fm'},'allow-local-http':{type:'boolean',default:false}}});
function checkedOrigin(value:string):string {
 const url=new URL(value);
 if(url.origin!==value||url.username||url.password)throw new Error('Supply a plain origin without credentials, path or trailing slash.');
 if(url.protocol!=='https:'&&!(values['allow-local-http']&&url.protocol==='http:'&&url.hostname==='127.0.0.1'))
  throw new Error('HTTPS is required; --allow-local-http permits only explicit 127.0.0.1 verification.');
 return url.origin;
}
const web=checkedOrigin(values.web!),api=checkedOrigin(values.api!);
function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
async function request(path:string,expected:number,init:RequestInit={}) {
 const response=await fetch(`${api}${path}`,{...init,redirect:'manual',signal:AbortSignal.timeout(15000)});
 check(response.status===expected,`${path}: expected HTTP ${expected}, received ${response.status}`);
 return response;
}
const page=await fetch(web,{redirect:'manual',signal:AbortSignal.timeout(15000)});
check(page.status===200,'Frontend must serve HTTP 200 at the configured origin without redirect.');
check(page.headers.get('content-type')?.includes('text/html'),'Frontend did not serve HTML.');
check(/id=["']root["']/.test(await page.text()),'Frontend did not contain the React root.');
const health=await(await request('/api/health',200)).json() as {status?:string;capabilities?:Record<string,boolean>};
check(health.status==='ok','API liveness failed.');
check(['demo','spotify','database','ml'].every(name=>health.capabilities?.[name]===true),'Production wiring is incomplete; health flags are not provider readiness proof.');
const me=await request('/api/me',200,{headers:{origin:web}});
check(me.headers.get('access-control-allow-origin')===web,'Credentialed browser origin is not allowed.');
check(me.headers.get('access-control-allow-credentials')==='true','Credentialed CORS is unavailable.');
check(me.headers.get('cache-control')?.includes('no-store'),'Account responses must not be cached.');
const session=AccountSessionSchema.parse(await me.json());
check(session.mode==='anonymous'&&session.user===null,'Anonymous access exposed an account.');
check(!session.capabilities.spotifyRead&&!session.capabilities.spotifyWrite&&!session.capabilities.playback,'Anonymous session advertised owner capabilities.');
const demo=DemoBootstrapSchema.parse(await(await request('/api/demo/bootstrap',200)).json());
check(demo.session.mode==='demo'&&demo.queue.mode==='demo','Demo is not explicitly identified.');
check(demo.queue.items.length>0&&demo.queue.items.every(item=>item.track.source==='synthetic'&&item.track.spotifyUri===null),'Demo must contain isolated synthetic tracks.');
const queue=QueueResultSchema.parse(await(await request('/api/queue?mode=demo&limit=2',200)).json());
check(queue.mode==='demo'&&queue.items.every(item=>item.track.source==='synthetic'),'Demo queue leaked live tracks.');
await request('/api/queue',401);
await request('/api/ml/insights',401);
for(const path of ['/api/calibration/queue','/api/calibration/history']){
 const response=await request(path,401,{headers:{origin:web}});
 check(response.headers.get('cache-control')?.includes('no-store'),'Calibration responses must not be cached.');
 check(response.headers.get('access-control-allow-origin')===web,'Calibration browser origin is not allowed.');
}
// This request cannot fit a model: it carries no owner session or cookie.
await request('/api/ml/retrain',401,{method:'POST',headers:{origin:web}});
const preflight=await request('/api/ml/retrain',204,{method:'OPTIONS',headers:{origin:web,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
check(preflight.headers.get('access-control-allow-origin')===web,'Allowed preflight origin mismatch.');
const rejected=await fetch(`${api}/api/me`,{headers:{origin:'https://untrusted.invalid'},redirect:'manual',signal:AbortSignal.timeout(15000)});
check(rejected.status===403,'Unexpected browser origins must be rejected.');
console.log(`PASS anonymous smoke for ${web} and ${api}: frontend, API wiring, isolated demo, owner guards and credentialed CORS. No owner login, provider mutation, model learning or continuous readiness proof.`);
