import {expect,test} from 'bun:test';
import Fastify from 'fastify';
import {ReviewRequestSchema,type ReviewResult} from '@sortfm/contracts';
import {createReviewMutationModule} from './module';
import {ReviewService} from './service';
import type {ReviewRepository} from './store';

const origin='http://127.0.0.1:5173';
const request=ReviewRequestSchema.parse({trackId:'0000000000000000000001',action:'UNLIKE',exposureId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()});
const decision:ReviewResult={...request,decisionId:crypto.randomUUID(),status:'PENDING',mutationStep:'PENDING',mode:'spotify',liked:null,archived:null,canUndo:false,label:null,labelState:'inactive',feedbackRevision:0,error:null,createdAt:'2026-11-07T00:00:00Z',updatedAt:'2026-11-07T00:00:00Z'};

async function setup() {
  const app=Fastify();let reads=0,kicks=0;
  const repo={
    getDecisionByIdempotencyKey:async(user:string)=>{reads++;return user==='spotify:owner'?decision:null;},
    getDecision:async(user:string)=>{reads++;return user==='spotify:owner'?decision:null;},
    getUndoByIdempotencyKey:async()=>null,
    history:async(user:string)=>{reads++;return user==='spotify:owner'?[decision]:[];},
  } as unknown as ReviewRepository;
  const service=new ReviewService(repo,{auth:{requireScopes:async()=>{}},worker:{kick:()=>{kicks++;}}});
  await createReviewMutationModule({
    auth:{session:async(token)=>token==='valid'?{user:{id:'spotify:owner'}}:token==='other'?{user:{id:'spotify:other'}}:null},
    config:{secureCookies:false,webOrigin:origin,apiOrigin:'http://127.0.0.1:3000'},
    service,worker:{start:()=>{},close:async()=>{}},enableWrites:()=>{},
  }).registerRoutes(app);
  return {app,reads:()=>reads,kicks:()=>kicks};
}

test('all mutation/history endpoints reject absent, expired and ambiguous sessions before repository access',async()=>{
  const s=await setup();
  try {
    for(const cookie of ['', 'sortfm_session=expired', 'sortfm_session=valid; sortfm_session=other', 'sortfm_session=%ZZ']) {
      for(const [method,url,payload] of [
        ['POST','/api/decisions',request],
        ['POST',`/api/decisions/${decision.decisionId}/undo`,{idempotencyKey:crypto.randomUUID()}],
        ['GET','/api/decisions/history',undefined],
      ] as const) {
        const response=await s.app.inject({method,url,headers:{origin,cookie},...(payload?{payload}:{})});
        expect(response.statusCode).toBe(401);expect(response.json()).toMatchObject({code:'AUTHENTICATION_REQUIRED',retryable:false});
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    expect(s.reads()).toBe(0);expect(s.kicks()).toBe(0);
  } finally {await s.app.close();}
});

test('mutation routes reject cross-site requests and forged identity fields before service side effects',async()=>{
  const s=await setup();
  try {
    for(const headers of [{cookie:'sortfm_session=valid'},{cookie:'sortfm_session=valid',origin:'https://foreign.test'},{cookie:'sortfm_session=valid',origin,'sec-fetch-site':'cross-site'}]) {
      const response=await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:request});expect(response.statusCode).toBe(403);
    }
    const headers={origin,cookie:'sortfm_session=valid'};
    expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,userId:'spotify:other'}})).statusCode).toBe(400);
    expect((await s.app.inject({method:'POST',url:`/api/decisions/${decision.decisionId}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID(),userId:'spotify:other'}})).statusCode).toBe(400);
    expect((await s.app.inject({url:'/api/decisions/history?userId=spotify:other',headers})).statusCode).toBe(400);
    expect(s.reads()).toBe(0);expect(s.kicks()).toBe(0);
  } finally {await s.app.close();}
});

test('pending replay remains 202 and owner-scoped history and Undo cannot expose another account decision',async()=>{
  const s=await setup();
  try {
    const headers={origin,cookie:'sortfm_session=valid'};
    const replay=await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:request});
    expect(replay.statusCode).toBe(202);expect(replay.json()).toMatchObject({status:'PENDING',label:null,canUndo:false});expect(s.kicks()).toBe(1);
    const foreign={origin,cookie:'sortfm_session=other'};
    expect((await s.app.inject({url:'/api/decisions/history',headers:foreign})).json()).toEqual({items:[],nextCursor:null});
    const undo=await s.app.inject({method:'POST',url:`/api/decisions/${decision.decisionId}/undo`,headers:foreign,payload:{idempotencyKey:crypto.randomUUID()}});
    expect(undo.statusCode).toBe(404);expect(undo.json().code).toBe('DECISION_NOT_FOUND');expect(s.kicks()).toBe(1);
  } finally {await s.app.close();}
});
