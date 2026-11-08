import {expect,test} from 'bun:test';
import {createApiClient} from '../src/client';
import {TeachingStatusSchema,TasteConstellationHistoryLiveSchema,TasteConstellationLiveSchema,PUBLIC_ROUTES} from '../src';
const track={id:'0000000000000000000001',title:'Authored song',artist:'Authored artist',imageUrl:null,label:null,audio:{},prediction:null,isLiked:false};
const graph={schema:'sortfm.constellation.v2',mode:'live',privacy:'evaluation-excluded',generatedAt:'2026-11-08T15:00:00Z',modelVersion:null,membershipSyncedAt:'2026-11-08T14:00:00Z',tracks:[track]};
test('history graph requires explicit membership and keeps v1 separate',()=>{
 expect(TasteConstellationHistoryLiveSchema.safeParse(graph).success).toBe(true);
 expect(TasteConstellationLiveSchema.safeParse(graph).success).toBe(false);
 for(const tracks of [[{...track,isLiked:undefined}],[{...track,isLiked:null}],[{...track,id:'demo:constellation:1'}],[track,track]])expect(TasteConstellationHistoryLiveSchema.safeParse({...graph,tracks}).success).toBe(false);
 expect(PUBLIC_ROUTES.constellation.path).toBe('/api/ml/constellation');
 expect(PUBLIC_ROUTES.constellationHistory.path).toBe('/api/ml/constellation/history');
});
test('teaching status distinguishes pending feedback from unknown model acknowledgement',()=>{
 const pending={trainingFeedbackCount:3,feedbackRevision:5,synchronizedFeedbackRevision:4,modelVersion:'authored-c1'};
 expect(TeachingStatusSchema.safeParse(pending).success).toBe(true);
 expect(TeachingStatusSchema.safeParse({...pending,synchronizedFeedbackRevision:null,modelVersion:null}).success).toBe(true);
 for(const patch of [{synchronizedFeedbackRevision:6},{synchronizedFeedbackRevision:null},{modelVersion:null},{trainingFeedbackCount:-1},{progress:1}])expect(TeachingStatusSchema.safeParse({...pending,...patch}).success).toBe(false);
});
test('ordinary Teach reads and historical graph use separate owner-only non-cached GET routes',async()=>{
 const calls:Array<{url:string,init?:RequestInit}>=[];
 const client=createApiClient({fetch:(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);calls.push({url,init});return Response.json(url.endsWith('/status')?{trainingFeedbackCount:0,feedbackRevision:0,synchronizedFeedbackRevision:null,modelVersion:null}:url.includes('/ml/')?graph:{items:[],nextCursor:null});}) as typeof fetch});
 await client.teachHistory();await client.teachingStatus();await client.constellationHistory();
 expect(calls.map(c=>c.url)).toEqual(['/api/calibration/teach/history','/api/calibration/status','/api/ml/constellation/history']);
 for(const c of calls){expect(c.init?.method).toBe('GET');expect(c.init?.cache).toBe('no-store');expect(c.init?.body).toBeUndefined();}
 for(const route of [PUBLIC_ROUTES.teachHistory,PUBLIC_ROUTES.teachingStatus,PUBLIC_ROUTES.constellationHistory])expect(route.auth).toBe('owner');
});
