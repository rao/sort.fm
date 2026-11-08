import {expect,test} from 'bun:test';
import * as contracts from '../src';
import {demoQueue} from '../src/fixtures';
const c=contracts as unknown as Record<string,any>;
const fresh={source:'spotify-recently-played',completeHistory:false,sampleLimit:50,status:'fresh',
 asOf:'2026-11-08T02:00:00.000Z',fetchedAt:'2026-11-08T01:59:00.000Z',ageMs:60000,
 windowStart:'2026-10-09T02:00:00.000Z',cachedEventCount:4,uniqueEventCount:3,windowEventCount:2};
test('listening coverage preserves incomplete observed sample counts separately from model features',()=>{
 expect(c.ListeningContextSnapshotSchema).toBeDefined();
 expect(c.ListeningContextSnapshotSchema.parse(fresh)).toEqual(fresh);
 const item=demoQueue.items[0]!;
 const input={userId:'demo:owner',exposure:item.exposure,prediction:item.prediction,features:{featureVersion:contracts.FEATURE_VERSION,values:{recent_play_count:2},provenance:'synthetic',permittedForTraining:true}};
 expect(c.ExposureInputSchema.parse(input)).toEqual(input);
 expect(c.ExposureInputSchema.parse({...input,listeningContext:fresh}).listeningContext).toEqual(fresh);
 expect(c.FeatureVectorSchema.safeParse({...input.features,listeningContext:fresh}).success).toBe(false);
});
test('empty fresh samples and quarantined missing samples are distinct',()=>{
 const empty={...fresh,cachedEventCount:0,uniqueEventCount:0,windowEventCount:0};
 expect(c.ListeningContextSnapshotSchema.parse(empty)).toEqual(empty);
 for(const status of ['missing','read_error','owner_mismatch','invalid']){
  const absent={...fresh,status,fetchedAt:null,ageMs:null,cachedEventCount:null,uniqueEventCount:null,windowEventCount:null};
  expect(c.ListeningContextSnapshotSchema.parse(absent)).toEqual(absent);
  expect(c.ListeningContextSnapshotSchema.safeParse({...absent,fetchedAt:fresh.fetchedAt}).success).toBe(false);
 }
});
test('coverage rejects invented completeness, inconsistent counts, age and window bounds',()=>{
 for(const patch of [{completeHistory:true},{sampleLimit:100},{ageMs:0},{windowEventCount:4},{cachedEventCount:51},
  {status:'fresh',uniqueEventCount:null},{fetchedAt:'2026-11-08T03:00:00Z',ageMs:null},
  {windowStart:'2026-10-10T02:00:00Z'},{status:'stale'},
  {status:'provider_error',uniqueEventCount:3,windowEventCount:2}])expect(c.ListeningContextSnapshotSchema.safeParse({...fresh,...patch}).success).toBe(false);
});
test('unusable owner-matched envelopes preserve original cache provenance without usable-event counts',()=>{
 const stale={...fresh,status:'stale',fetchedAt:'2026-11-06T02:00:00.000Z',ageMs:172800000,uniqueEventCount:null,windowEventCount:null};
 expect(c.ListeningContextSnapshotSchema.parse(stale)).toEqual(stale);
 const future={...fresh,status:'future',fetchedAt:'2026-11-08T03:00:00.000Z',ageMs:null,uniqueEventCount:null,windowEventCount:null};
 expect(c.ListeningContextSnapshotSchema.parse(future)).toEqual(future);
});
