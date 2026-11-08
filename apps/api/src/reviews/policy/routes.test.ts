import {expect,test} from 'bun:test';
import Fastify from 'fastify';
import {CONTRACT_VERSION,type QueueResult} from '@sortfm/contracts';
import {createReviewQueueModule} from '../module';

test('policy queue implementation uses the existing authenticated route without a client algorithm switch',async()=>{
  const calls:unknown[][]=[];
  const result:QueueResult={contractVersion:CONTRACT_VERSION,mode:'spotify',items:[],remaining:0,nextCursor:null,fallbackReason:null};
  const queue={get:async(userId:string,query:{limit:number;policy:'balanced'|'discovery'|'certainty';mode:'spotify'|'demo'})=>{
    calls.push([userId,query]);return result;
  }};
  const app=Fastify();
  await app.register(createReviewQueueModule({queue,
    config:{secureCookies:false,webOrigin:'http://127.0.0.1:5173',apiOrigin:'http://127.0.0.1:3000'},
    auth:{session:async token=>token==='valid'?{user:{id:'spotify:owner'}}:null},
  }).registerRoutes);
  try {
    expect((await app.inject('/api/queue')).statusCode).toBe(401);
    for(const query of ['strategy=linucb','selectionPolicy=epsilon_greedy','userId=spotify:other']) {
      expect((await app.inject({url:`/api/queue?${query}`,headers:{cookie:'sortfm_session=valid'}})).statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const response=await app.inject({url:'/api/queue?limit=20&policy=discovery',headers:{cookie:'sortfm_session=valid'}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(calls).toEqual([['spotify:owner',{limit:20,policy:'discovery',mode:'spotify'}]]);
  } finally {await app.close();}
});
