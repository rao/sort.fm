/** Local QA only. Serves production assets with a controlled in-memory HTTP fixture.
 * Never contacts Spotify, never uses credentials, never included in the Vite bundle. */
import {resolve, sep} from 'node:path';
import {liveFixture} from '../src/test-support/live-fixture';
if (process.env.SORTFM_TEST_FIXTURE !== '1') throw new Error('Set SORTFM_TEST_FIXTURE=1 for the local synthetic HTTP harness.');
let fixture=liveFixture();
let authenticated=true;
let imported=false;
let importingUntil=0;
let modelUpdated=false;
const root=resolve(import.meta.dir,'../dist');
const panel=`<aside style="position:fixed;bottom:8px;left:8px;z-index:10000;background:#362722;color:#fff;padding:8px 12px;border:1px solid #b98964;border-radius:8px;font:11px sans-serif"><details><summary>HTTP TEST FIXTURE · NO SPOTIFY CONNECTION</summary><nav style="display:flex;gap:12px;padding:8px"><a style="color:#fff" href="/__fixture/reset">Reset</a><a style="color:#fff" href="/__fixture/fail">Fail decisions</a><a style="color:#fff" href="/__fixture/recover">Recover</a><a style="color:#fff" href="/__fixture/expire">Expire session</a><a style="color:#fff" href="/__fixture/model">Publish model update</a></nav></details></aside>`;
Bun.serve({hostname:'127.0.0.1',port:5182,async fetch(request){
 const url=new URL(request.url);
 const json=(value:unknown,status=200)=>Response.json(value,{status});
 if(url.pathname.startsWith('/__fixture/')) {
  if(url.pathname.endsWith('/reset')){fixture=liveFixture();authenticated=true;imported=false;modelUpdated=false;}
  if(url.pathname.endsWith('/fail'))fixture.setDecisionError(true);
  if(url.pathname.endsWith('/recover'))fixture.setDecisionError(false);
  if(url.pathname.endsWith('/expire'))authenticated=false;
  if(url.pathname.endsWith('/model'))modelUpdated=true;
  return Response.redirect('http://127.0.0.1:5182/#/review');
 }
 if(url.pathname==='/api/auth/spotify/start'){authenticated=true;return Response.redirect('http://127.0.0.1:5182/');}
 if(url.pathname==='/api/auth/logout'){authenticated=false;return json({ok:true});}
 if(url.pathname==='/api/me'&&!authenticated)return json({mode:'anonymous',user:null,capabilities:{spotifyRead:false,spotifyWrite:false,playback:false}});
 if(url.pathname.startsWith('/api/')) {
  if(!authenticated)return json({code:'SESSION_EXPIRED',message:'Test session expired.',retryable:false},401);
  if(url.pathname==='/api/library/sync'){importingUntil=Date.now()+3500;imported=true;}
  if(url.pathname.startsWith('/api/library/sync'))return json({jobId:imported?'00000000-0000-4000-8000-000000000001':null,status:importingUntil>Date.now()?'running':imported?'complete':'idle',processed:importingUntil>Date.now()?1:imported?2:0,total:imported?2:null,failed:0,nextOffset:0,updatedAt:imported?new Date().toISOString():null,error:null});
  const result=await fixture.transport(url.pathname+url.search,{method:request.method,credentials:'include',...(request.method==='POST'?{body:await request.text()}:{})});
  if(url.pathname==='/api/ml/insights'&&modelUpdated){const data=await result.json();data.metrics={...data.metrics,modelVersion:'fixture-model-v2',dataset:'synthetic',reason:'Controlled HTTP fixture: evaluation intentionally unavailable.',labeledExamples:30,trainedExamples:10,heldOutExamples:20,heldOutPositive:12,heldOutNegative:8};return json(data);}
  return result;
 }
 const filePath=resolve(root,`.${url.pathname==='/'?'/index.html':url.pathname}`);
 if(!filePath.startsWith(root+sep))return new Response('Not found',{status:404});
 const file=Bun.file(filePath);
 if(!await file.exists())return new Response('Not found',{status:404});
 if(filePath.endsWith('index.html'))return new Response((await file.text()).replace('</body>',panel+'</body>'),{headers:{'Content-Type':'text/html'}});
 return new Response(file);
}});
console.log('Synthetic HTTP fixture preview: http://127.0.0.1:5182 (no Spotify connection)');
