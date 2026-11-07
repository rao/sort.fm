import {expect,test} from 'bun:test';
import Fastify from 'fastify';
import {Database,migrate,Repository} from '@sortfm/db';
import {ReviewRequestSchema,type TrackCard} from '@sortfm/contracts';
import {QueueService} from './queue';
import {ReviewService} from './service';
import {ReviewWorker} from './worker';
import {createReviewMutationModule,createReviewQueueModule} from './module';
import {SpotifyMutations} from '../spotify/mutations';
import {SpotifyHttp} from '../spotify/http';

test.skipIf(!process.env.TEST_DATABASE_URL)('durable authenticated HTTP review workflow: Keep, Skip, archive partial recovery, unlike, repeated Undo',async()=>{
  const db=new Database(process.env.TEST_DATABASE_URL!,`test_a2_flow_${crypto.randomUUID().replaceAll('-','')}`),repository=new Repository(db),app=Fastify();
  try {
    await migrate(db);const userId='spotify:workflow-test',playlistId='0000000000000000000099';
    await repository.upsertUser({id:userId,spotifyId:'workflow-test',displayName:'Synthetic workflow test',avatarUrl:null},true);
    const liked=new Set<string>(),archived=new Set<string>();let playlist=false,failUnlike=true,addCalls=0,deleteCalls=0;
    const tracks:TrackCard[]=Array.from({length:4},(_,i)=>{const trackId=String(i+1).padStart(22,'0');liked.add(trackId);return {trackId,source:'spotify',spotifyUri:`spotify:track:${trackId}`,title:`Synthetic ${i}`,artists:[{id:null,name:'Test'}],album:'',imageUrl:null,durationMs:1000,explicit:false,originalAddedAt:'2020-01-01T00:00:00Z',releaseDate:null,isPlayable:true};});
    await repository.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved'})));
    const auth={session:async(token?:string)=>token==='session'?{user:{id:userId}}:null,requireScopes:async()=>{},accessToken:async()=>({token:'synthetic-token',version:'v1'}),revoke:async()=>true};
    const playlistObject={id:playlistId,public:false,owner:{id:'workflow-test'},description:'sort.fm archive [sortfm:workflow-test]'};
    const fetcher=async(url:string,init?:RequestInit)=>{
      const parsed=new URL(url),method=init?.method??'GET',trackId=parsed.searchParams.get('uris')?.split(':').at(-1)!;
      if(parsed.pathname==='/v1/me/library/contains')return Response.json([liked.has(trackId)]);
      if(parsed.pathname==='/v1/me/library') {
        if(method==='DELETE'){deleteCalls++;if(failUnlike && trackId===tracks[2]!.trackId){failUnlike=false;return new Response(null,{status:500});}liked.delete(trackId);}
        else liked.add(trackId);return new Response(null,{status:200});
      }
      if(parsed.pathname==='/v1/me/playlists') {if(method==='POST'){playlist=true;return Response.json(playlistObject);}return Response.json({offset:0,total:playlist?1:0,items:playlist?[playlistObject]:[]});}
      if(parsed.pathname===`/v1/playlists/${playlistId}`)return Response.json(playlistObject);
      if(parsed.pathname===`/v1/playlists/${playlistId}/items`) {
        if(method==='POST'){addCalls++;archived.add(JSON.parse(init!.body as string).uris[0].split(':').at(-1));return Response.json({snapshot_id:'snapshot'});}
        return Response.json({offset:0,total:archived.size,items:[...archived].map(id=>({item:{id,type:'track'}}))});
      }
      throw new Error('Unexpected controlled Spotify endpoint');
    };
    const spotify=new SpotifyMutations(auth,new SpotifyHttp({fetch:fetcher}),{fetch:fetcher});
    const worker=()=>new ReviewWorker(new Repository(db),spotify,{auth});
    const service=new ReviewService(repository,{auth,worker:{kick:()=>{}}});
    const routeOptions={auth,config:{secureCookies:false,webOrigin:'http://127.0.0.1:5173',apiOrigin:'http://127.0.0.1:3000'}};
    await app.register(createReviewQueueModule({...routeOptions,queue:new QueueService(repository)}).registerRoutes);
    await app.register(createReviewMutationModule({...routeOptions,service,worker:{start:()=>{},close:async()=>{}},enableWrites:()=>{}}).registerRoutes);
    const headers={cookie:'sortfm_session=session',origin:routeOptions.config.webOrigin};
    expect((await app.inject('/api/decisions/history')).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/decisions',headers:{cookie:headers.cookie},payload:{}})).statusCode).toBe(403);
    const queue=await app.inject({url:'/api/queue',headers});expect(queue.statusCode).toBe(200);
    const items=queue.json().items;
    const decisions=[];
    for(const [index,action] of ['KEEP','SKIP','ARCHIVE','UNLIKE'].entries()) {
      const request=ReviewRequestSchema.parse({trackId:tracks[index]!.trackId,exposureId:items[index].exposure.exposureId,action,idempotencyKey:crypto.randomUUID()});
      const response=await app.inject({method:'POST',url:'/api/decisions',headers,payload:request});expect(response.statusCode).toBe(202);const pending=response.json();decisions.push(pending);
      await worker().runOnce();
      if(action==='ARCHIVE') {
        expect((await repository.getDecision(userId,pending.decisionId))!).toMatchObject({status:'FAILED_RETRYABLE',label:null});expect(liked.has(request.trackId)).toBe(true);expect(archived.has(request.trackId)).toBe(true);
        await db.transaction(async tx=>{await tx`UPDATE review_work SET available_at=clock_timestamp() WHERE user_id=${userId} AND decision_id=${pending.decisionId}`;});
        await worker().runOnce();expect(addCalls).toBe(1);
      }
      const complete=(await repository.getDecision(userId,pending.decisionId))!;expect(complete.status).toBe('COMPLETE');expect(complete.label).toBe(action==='SKIP'?null:action==='KEEP'?0:1);
      const repeated=await app.inject({method:'POST',url:'/api/decisions',headers,payload:request});expect(repeated.statusCode).toBe(200);expect(repeated.json().decisionId).toBe(pending.decisionId);
      const double=await app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,idempotencyKey:crypto.randomUUID()}});expect(double.statusCode).toBe(409);
    }
    expect((await repository.trainingExamples(userId)).examples).toHaveLength(3);
    for(const decision of decisions.slice(2)) {
      const payload={idempotencyKey:crypto.randomUUID()},url=`/api/decisions/${decision.decisionId}/undo`;
      const pending=await app.inject({method:'POST',url,headers,payload});expect(pending.statusCode).toBe(409);expect(pending.json().code).toBe('UNDO_PENDING');
      await worker().runOnce();expect(liked.has(decision.trackId)).toBe(true);
      const done=await app.inject({method:'POST',url,headers,payload});expect(done.statusCode).toBe(200);expect(done.json()).toMatchObject({status:'UNDONE',label:null,labelState:'revoked'});
    }
    expect(addCalls).toBe(1);expect(deleteCalls).toBe(3);expect(archived.size).toBe(1);expect((await repository.trainingExamples(userId)).examples).toHaveLength(1);
    const history=await app.inject({url:'/api/decisions/history',headers});expect(history.json().items).toHaveLength(4);expect(history.body).not.toContain('synthetic-token');
    const events=await db.transaction(async tx=>tx`SELECT count(*)::int n FROM interaction_events WHERE user_id=${userId}`);expect(events[0]!.n).toBeGreaterThanOrEqual(6);
  } finally {await app.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},90000);
