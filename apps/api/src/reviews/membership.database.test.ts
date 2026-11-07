import {expect,test} from 'bun:test';
import {Database,migrate,Repository,PostgresA1Store} from '@sortfm/db';
import {LibraryImporter} from '../library/importer';
import {QueueService} from './queue';
import {ReviewWorker,type ReviewSpotify} from './worker';
import {ReviewRequestSchema,UndoRequestSchema} from '@sortfm/contracts';

test.skipIf(!process.env.TEST_DATABASE_URL)('import final publication cannot overwrite concurrent confirmed unlike or Undo; retry rescans',async()=>{
  const db=new Database(process.env.TEST_DATABASE_URL!,`test_a2_race_${crypto.randomUUID().replaceAll('-','')}`);let importer:LibraryImporter|undefined;
  try {
    await migrate(db);const repo=new Repository(db),store=new PostgresA1Store(db),userId='spotify:race-test',trackId='0000000000000000000001';
    await repo.upsertUser({id:userId,spotifyId:'race-test',displayName:'Synthetic race test',avatarUrl:null},true);
    let liked=true,trigger=false,now=Date.now();
    const spotify:ReviewSpotify={marker:()=>'',findArchive:async()=>null,createArchive:async()=>{throw new Error('No archive expected');},verifyArchive:async()=>{},archiveContains:async()=>false,addArchive:async()=>{},isLiked:async()=>liked,setLiked:async(_u,_t,value)=>{liked=value;}};
    const worker=new ReviewWorker(repo,spotify,{auth:{requireScopes:async()=>{}}});
    importer=new LibraryImporter(store,{get:async(_u,path)=>{
      if(path.includes('recently-played')){if(trigger){trigger=false;await worker.runOnce();}return {items:[]};}
      return {offset:0,limit:50,total:liked?1:0,next:null,items:liked?[{added_at:'2020-01-01T00:00:00Z',track:{id:trackId,name:'Synthetic track',duration_ms:1000,artists:[{name:'Test'}]}}]:[]};
    }},{now:()=>now});
    await importer.requestSync(userId);await importer.run(userId);expect((await importer.summary(userId)).total).toBe(1);
    const item=(await new QueueService(repo).get(userId,{limit:1,policy:'balanced',mode:'spotify'})).items[0]!;
    const request=ReviewRequestSchema.parse({trackId,action:'UNLIKE',exposureId:item.exposure.exposureId,idempotencyKey:crypto.randomUUID()});
    const pending=await repo.createDecision({userId,decisionId:crypto.randomUUID(),request,requestFingerprint:'race-fixture',createdAt:new Date().toISOString()});
    trigger=true;await importer.requestSync(userId);await importer.run(userId);
    expect((await repo.getDecision(userId,pending.decisionId))!.status).toBe('COMPLETE');expect(liked).toBe(false);
    expect(await importer.status(userId)).toMatchObject({status:'failed',error:{code:'IMPORT_MEMBERSHIP_CHANGED',retryable:true}});
    expect(await importer.summary(userId)).toMatchObject({total:0,remaining:0});expect(await repo.library(userId)).toHaveLength(0);
    now+=30001;await importer.run(userId);expect(await importer.status(userId)).toMatchObject({status:'complete',total:0,processed:0});
    expect(await repo.library(userId)).toHaveLength(0);
    const undo=UndoRequestSchema.parse({idempotencyKey:crypto.randomUUID()});
    await repo.createUndo({userId,commandId:crypto.randomUUID(),decisionId:pending.decisionId,request:undo,requestFingerprint:'race-undo-fixture',createdAt:new Date().toISOString()});
    trigger=true;await importer.requestSync(userId);await importer.run(userId);
    expect((await repo.getDecision(userId,pending.decisionId))!.status).toBe('UNDONE');expect(liked).toBe(true);
    expect(await importer.status(userId)).toMatchObject({status:'failed',error:{code:'IMPORT_MEMBERSHIP_CHANGED',retryable:true}});
    expect(await importer.summary(userId)).toMatchObject({total:1,remaining:1});
    now+=30001;await importer.run(userId);expect(await importer.status(userId)).toMatchObject({status:'complete',total:1,processed:1});
    expect(await repo.library(userId)).toHaveLength(1);
  } finally {await importer?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},60000);
