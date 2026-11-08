import {test,expect} from 'bun:test';
import {createApiClient,ApiError} from '../src/client';
import {PUBLIC_ROUTES} from '../src/routes';
import {CALIBRATION_BATCH3_EXPERIMENT,CalibrationExperimentSchema,CalibrationExperimentSkipSchema} from '../src/calibration-experiment';

const reserved=CalibrationExperimentSchema.parse({batchId:'00000000-0000-4000-8000-000000000001',experiment:CALIBRATION_BATCH3_EXPERIMENT,phase:'reserved',reservedAt:'2026-11-08T03:00:00.000Z',target:60,groups:[{group:'A',target:40,reserved:40},{group:'B',target:20,reserved:20},{group:'C',target:0,reserved:0}]});

test('experiment client resumes a hidden reservation with credentials and no cache, without any create or seal interface',async()=>{
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const client=createApiClient({baseUrl:'https://api.example.test/',fetch:(async(input,init)=>{calls.push({url:String(input),init});return Response.json({batch:reserved});}) as typeof fetch});
 expect(await client.calibrationExperiment()).toEqual({batch:reserved});
 expect(calls).toHaveLength(1);
 expect(calls[0]!.url).toBe('https://api.example.test/api/calibration/experiments/calibration-batch3-v1');
 expect(calls[0]!.init).toMatchObject({method:'GET',credentials:'include',cache:'no-store'});
 expect(calls[0]!.init?.body).toBeUndefined();
 expect(Object.keys(client).filter(key=>key.startsWith('calibrationExperiment')).sort()).toEqual(['calibrationExperiment','calibrationExperimentSkip']);
 expect(Object.entries(PUBLIC_ROUTES).filter(([key])=>key.startsWith('calibrationExperiment')).map(([,route])=>[route.method,route.auth])).toEqual([['GET','owner'],['POST','owner']]);
 expect(()=>client.calibrationExperiment('untrusted-experiment')).toThrow();
 expect(calls).toHaveLength(1);
});

test('experiment skip preserves its command identity and rejects a reserved response as success',async()=>{
 const body=CalibrationExperimentSkipSchema.parse({exposureId:'00000000-0000-4000-8000-000000000002',idempotencyKey:'00000000-0000-4000-8000-000000000003'});
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const client=createApiClient({fetch:(async(input,init)=>{calls.push({url:String(input),init});return Response.json(reserved);}) as typeof fetch});
 let error:unknown;
 try{await client.calibrationExperimentSkip(body);}catch(caught){error=caught;}
 expect(error).toBeInstanceOf(ApiError);
 expect((error as ApiError).error.code).toBe('INVALID_API_RESPONSE');
 expect(calls).toHaveLength(1);
 expect(calls[0]!.url).toBe('/api/calibration/experiments/calibration-batch3-v1/skip');
 expect(calls[0]!.init).toMatchObject({method:'POST',credentials:'include',cache:'no-store',body:JSON.stringify(body)});
 expect(()=>client.calibrationExperimentSkip({...body,userId:'injected'} as typeof body)).toThrow();
 expect(calls).toHaveLength(1);
});
