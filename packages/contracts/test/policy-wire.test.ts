import {expect,test} from 'bun:test';
import * as contracts from '../src';

const c=contracts as unknown as Record<string,any>;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const features={featureVersion:contracts.FEATURE_VERSION,values:{energy:0},provenance:'synthetic',permittedForTraining:true};
const event={eventId:id(1),sequence:1,source:'cleanup',decisionId:id(2),exposureId:id(3),trackId:'demo:track',policyVersion:'c2-test',modelVersion:'c1-exposed',operation:'upsert',feedbackRevision:2,label:0,features,occurredAt:'2026-11-08T02:00:00Z'};
const fitReceipt={modelVersion:'c1-current',synchronizedFeedbackRevision:4};
test('association is a separate route and preserves source event versus current fit receipt',()=>{
 expect(c.PolicyAssociationRequestSchema).toBeDefined();
 const request={userId:'demo:owner',event,fitReceipt};
 expect(c.PolicyAssociationRequestSchema.parse(request)).toEqual(request);
 expect(c.INTERNAL_ROUTES.policyAssociate.path).toBe('/policy/associate');
 expect(c.INTERNAL_ROUTES.observe.path).toBe('/observe');
 expect(c.PolicyAssociationRequestSchema.safeParse({...request,fitReceipt:{...fitReceipt,synchronizedFeedbackRevision:1}}).success).toBe(false);
});
test('association rejects calibration, invented splits, invalid sequence and ratings for Skip or Undo',()=>{
 expect(c.PolicyAssociationRequestSchema).toBeDefined();
 for(const changed of [{source:'calibration'},{split:'train'},{sequence:0},{sequence:1.5},{operation:'revoke',label:1},{operation:'revoke',label:null,usefulness:1},{label:null,usefulness:0.5},{usefulness:1.1}]){
  expect(c.PolicyAssociationRequestSchema.safeParse({userId:'demo:owner',event:{...event,...changed},fitReceipt}).success).toBe(false);
 }
 for(const changed of [{label:null},{operation:'revoke',label:null},{usefulness:0}])expect(c.PolicyAssociationRequestSchema.safeParse({userId:'demo:owner',event:{...event,...changed},fitReceipt}).success).toBe(true);
});
test('selection supports all service policies but rejects duplicate track identities and unbounded configuration',()=>{
 expect(c.PolicySelectRequestSchema).toBeDefined();
 const candidate={trackId:'demo:track',features,artistIds:['demo:artist']};
 const request={userId:'demo:owner',featureVersion:contracts.FEATURE_VERSION,exposureId:id(3),modelVersion:'c1-current',feedbackRevision:4,seed:42,candidates:[candidate]};
 for(const strategy of ['c1','epsilon_greedy','linucb','random'])expect(c.PolicySelectRequestSchema.safeParse({...request,config:{strategy}}).success).toBe(true);
 expect(c.PolicySelectRequestSchema.safeParse({...request,config:{strategy:'linucb'},candidates:[candidate,candidate]}).success).toBe(false);
 expect(c.PolicySelectRequestSchema.safeParse({...request,config:{strategy:'linucb',alpha:11}}).success).toBe(false);
 expect(c.PolicySelectRequestSchema.safeParse({...request,config:{strategy:'epsilon_greedy',epsilon:-0.1}}).success).toBe(false);
});
test('policy release never accepts model feedback or client expiry controls',()=>{
 expect(c.PolicyReleaseRequestSchema).toBeDefined();
 const request={userId:'demo:owner',requestId:id(4),exposureId:id(3),reason:'skip'};
 expect(c.PolicyReleaseRequestSchema.parse(request)).toEqual(request);
 expect(c.PolicyReleaseRequestSchema.safeParse({...request,label:0}).success).toBe(false);
 expect(c.PolicyReleaseRequestSchema.safeParse({...request,expiresAt:'2026-11-09T00:00:00Z'}).success).toBe(false);
});
test('a revision-pinned selection requires its actual model while legacy unpinned requests remain valid',()=>{
 const request={userId:'demo:owner',featureVersion:contracts.FEATURE_VERSION,exposureId:id(3),candidates:[{trackId:'demo:track',features}]};
 expect(c.PolicySelectRequestSchema.safeParse(request).success).toBe(true);
 expect(c.PolicySelectRequestSchema.safeParse({...request,feedbackRevision:0}).success).toBe(false);
 expect(c.PolicySelectRequestSchema.safeParse({...request,feedbackRevision:4,modelVersion:null}).success).toBe(false);
 expect(c.PolicySelectRequestSchema.safeParse({...request,feedbackRevision:4,modelVersion:'c1-current'}).success).toBe(true);
});
