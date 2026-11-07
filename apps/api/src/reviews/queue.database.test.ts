import {expect,test} from 'bun:test';
import {Database,migrate,Repository} from '@sortfm/db';
import {QueueService} from './queue';
import type {TrackCard} from '@sortfm/contracts';

test.skipIf(!process.env.TEST_DATABASE_URL)('Tiger Data queue persists exact exposure snapshots across reconstruction and isolates users',async()=>{
  const schema=`test_a2_queue_${crypto.randomUUID().replaceAll('-','')}`;
  const db=new Database(process.env.TEST_DATABASE_URL!,schema), repository=new Repository(db);
  try {
    await migrate(db);
    const userId='spotify:queue-test',other='spotify:other-test';
    for(const id of [userId,other]) await repository.upsertUser({id,spotifyId:id.slice(8),displayName:'Synthetic queue account',avatarUrl:null},true);
    const track:TrackCard={trackId:'0000000000000000000001',source:'spotify',spotifyUri:'spotify:track:0000000000000000000001',title:'Synthetic integration track',artists:[{id:null,name:'Test'}],album:'',imageUrl:null,durationMs:1000,explicit:false,originalAddedAt:'2020-01-01T00:00:00Z',releaseDate:null,isPlayable:true};
    await repository.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved'}]);
    const result=await new QueueService(repository).get(userId,{limit:1,policy:'balanced',mode:'spotify'});
    expect(result.items).toHaveLength(1);
    const reconstructed=new Repository(db), item=result.items[0]!;
    const persisted=await reconstructed.getExposure(userId,item.exposure.exposureId);
    expect(persisted?.exposure).toEqual(item.exposure); expect(persisted?.prediction).toEqual(item.prediction);
    expect(persisted?.features.values.energy).toBeUndefined();
    expect(await reconstructed.getExposure(other,item.exposure.exposureId)).toBeNull();
    expect((await new QueueService(reconstructed).get(other,{limit:20,policy:'balanced',mode:'spotify'})).items).toHaveLength(0);
    await expect(reconstructed.insertExposure({...persisted!,features:{...persisted!.features,values:{duration_ms:42}}})).rejects.toThrow('EXPOSURE_CONFLICT');
  } finally {await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await db.close();}
},60_000);
