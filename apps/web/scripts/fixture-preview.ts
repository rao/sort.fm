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
let playerAvailable=true;
let playerFailure=false;
let playingUri:string|null=null;
let fitFailure=false;
const root=resolve(import.meta.dir,'../dist');
const panel=`<aside style="position:fixed;bottom:8px;left:8px;z-index:10000;background:#362722;color:#fff;padding:8px 12px;border:1px solid #b98964;border-radius:8px;font:11px sans-serif"><details><summary>HTTP TEST FIXTURE · NO SPOTIFY CONNECTION</summary><nav style="display:flex;gap:12px;padding:8px"><a style="color:#fff" href="/__fixture/reset">Reset</a><a style="color:#fff" href="/__fixture/fail">Fail decisions</a><a style="color:#fff" href="/__fixture/recover">Recover</a><a style="color:#fff" href="/__fixture/expire">Expire session</a><a style="color:#fff" href="/__fixture/model">Publish model update</a><a style="color:#fff" href="/__fixture/no-device">No playback device</a><a style="color:#fff" href="/__fixture/play-fail">Fail playback</a><a style="color:#fff" href="/__fixture/fit-fail">Fail training</a></nav></details></aside>`;
const port=Number(process.env.SORTFM_FIXTURE_PORT ?? 5182);
Bun.serve({hostname:'127.0.0.1',port,async fetch(request){
 const url=new URL(request.url);
 const json=(value:unknown,status=200)=>Response.json(value,{status});
 if(url.pathname.startsWith('/__fixture/')) {
  if(url.pathname.endsWith('/reset')){fixture=liveFixture();authenticated=true;imported=false;modelUpdated=false;playerAvailable=true;playerFailure=false;playingUri=null;fitFailure=false;}
  if(url.pathname.endsWith('/fail'))fixture.setDecisionError(true);
  if(url.pathname.endsWith('/recover')){fixture.setDecisionError(false);playerAvailable=true;playerFailure=false;fitFailure=false;}
  if(url.pathname.endsWith('/expire'))authenticated=false;
  if(url.pathname.endsWith('/model'))modelUpdated=true;
  if(url.pathname.endsWith('/no-device')){playerAvailable=false;playingUri=null;}
  if(url.pathname.endsWith('/play-fail'))playerFailure=true;
  if(url.pathname.endsWith('/fit-fail'))fitFailure=true;
  return Response.redirect(`${url.origin}/#/review`);
 }
 if(url.pathname==='/api/auth/spotify/start'){authenticated=true;return Response.redirect(`${url.origin}/`);}
 if(url.pathname==='/api/auth/logout'){authenticated=false;return json({ok:true});}
 if(url.pathname==='/api/me'&&!authenticated)return json({mode:'anonymous',user:null,capabilities:{spotifyRead:false,spotifyWrite:false,playback:false}});
 if(url.pathname.startsWith('/api/')) {
  if(!authenticated)return json({code:'SESSION_EXPIRED',message:'Test session expired.',retryable:false},401);
  if(url.pathname==='/api/library/sync'){importingUntil=Date.now()+3500;imported=true;}
  if(url.pathname.startsWith('/api/library/sync'))return json({jobId:imported?'00000000-0000-4000-8000-000000000001':null,status:importingUntil>Date.now()?'running':imported?'complete':'idle',processed:importingUntil>Date.now()?1:imported?2:0,total:imported?2:null,failed:0,nextOffset:0,updatedAt:imported?new Date().toISOString():null,error:null});
  const metrics={...((await (await fixture.transport('/api/ml/insights')).json()).metrics),modelVersion:modelUpdated?'fixture-model-v2':'untrained-v0',dataset:'user_feedback',reason:'Controlled HTTP fixture: evaluation intentionally unavailable.',labeledExamples:modelUpdated?30:0,trainedExamples:modelUpdated?10:0,heldOutExamples:modelUpdated?20:0,heldOutPositive:modelUpdated?12:0,heldOutNegative:modelUpdated?8:0};
  if(url.pathname==='/api/me')return json({...fixture.session,capabilities:{...fixture.session.capabilities,playback:true}});
  if(url.pathname==='/api/player/status')return json({available:playerAvailable,deviceId:playerAvailable?'fixture-device':null,isPlaying:!!playingUri,trackUri:playingUri,reason:playerAvailable?null:'Open Spotify and select an available device, then check again.'});
  if(url.pathname==='/api/player/play'){
   if(playerFailure)return json({code:'PLAYBACK_UNAVAILABLE',message:'Fixture playback unavailable. Open in Spotify remains available.',retryable:true},503);
   const body=await request.json();playingUri=body.trackUri;return json({ok:true});
  }
  if(url.pathname==='/api/ml/retrain'){
   if(fitFailure)return json({code:'TRAINING_UNAVAILABLE',message:'Fixture training service unavailable.',retryable:true},503);
   modelUpdated=true;
   return json({userId:'owner',modelVersion:'fixture-model-v2',featureVersion:'sortfm.features.v1',feedbackRevision:30,trainedExamples:10,metrics:{...metrics,modelVersion:'fixture-model-v2',labeledExamples:30,trainedExamples:10,heldOutExamples:20,heldOutPositive:12,heldOutNegative:8}});
  }
  const result=await fixture.transport(url.pathname+url.search,{method:request.method,credentials:'include',...(request.method==='POST'?{body:await request.text()}:{})});
  if(url.pathname==='/api/ml/insights'){const data=await result.json();data.metrics=metrics;data.audioFeatures.missingness={energy:0,tempo_bpm:0.25};return json(data);}
  return result;
 }
 const filePath=resolve(root,`.${url.pathname==='/'?'/index.html':url.pathname}`);
 if(!filePath.startsWith(root+sep))return new Response('Not found',{status:404});
 const file=Bun.file(filePath);
 if(!await file.exists())return new Response('Not found',{status:404});
 if(filePath.endsWith('index.html'))return new Response((await file.text()).replace('</body>',panel+'</body>'),{headers:{'Content-Type':'text/html'}});
 return new Response(file);
}});
console.log(`Synthetic HTTP fixture preview: http://127.0.0.1:${port} (no Spotify connection)`);
