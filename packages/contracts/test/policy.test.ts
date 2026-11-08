import {expect,test} from 'bun:test';
import {ExposureSchema,QueueItemSchema} from '../src';
import {demoQueue} from '../src/fixtures';

const telemetry={
 selectionMethod:'linucb',strategy:'explore',policyStateVersion:'c2-state-test',contextVersion:'context-test',rewardVersion:'review-utility-v1',
 modelFeedbackRevision:7,predictedReward:-0.2,selectionScore:1.8,uncertainty:2,explorationBonus:1,informationGain:0.8,
 candidateCount:8,availableCount:6,eligibleCount:5,trainedRewards:2,reasons:['Synthetic test selection'],
 reservation:{reservedAt:'2026-11-08T02:00:00.000Z',expiresAt:'2026-11-08T02:05:00.000Z',evaluatedAt:'2026-11-08T02:00:01.000Z',status:'active',closedAt:null,closureReason:null},
};
test('legacy exposure remains valid without policy telemetry',()=>{
 expect(ExposureSchema.parse(demoQueue.items[0]!.exposure)).toEqual(demoQueue.items[0]!.exposure);
});
test('policy telemetry preserves unbounded policy values separately from C1 uncertainty',()=>{
 const item=structuredClone(demoQueue.items[0]!);
 const result=QueueItemSchema.safeParse({...item,exposure:{...item.exposure,selectionMethod:'linucb',policyTelemetry:telemetry}});
 expect(result.success).toBe(true);
 if(result.success){expect(result.data.exposure.uncertainty).toBe(item.prediction.uncertainty);expect(result.data.exposure.policyTelemetry?.uncertainty).toBe(2);}
});
test('epsilon greedy is an explicit exposure method and zero telemetry is preserved',()=>{
 const result=ExposureSchema.safeParse({...demoQueue.items[0]!.exposure,selectionMethod:'epsilon_greedy',policyTelemetry:{...telemetry,selectionMethod:'epsilon_greedy',strategy:'exploit',predictedReward:0,selectionScore:0,uncertainty:0,explorationBonus:0,informationGain:0}});
 expect(result.success).toBe(true);
 if(result.success)expect(result.data.policyTelemetry?.predictedReward).toBe(0);
});
test('policy telemetry rejects incoherent counts and reservation state',()=>{
 const exposure={...demoQueue.items[0]!.exposure,selectionMethod:'linucb'};
 for(const override of [{eligibleCount:7},{availableCount:9},{uncertainty:-1},{selectionScore:Infinity},{reservation:{...telemetry.reservation,status:'expired'}},{reservation:{...telemetry.reservation,expiresAt:telemetry.reservation.reservedAt}},{reservation:{...telemetry.reservation,evaluatedAt:'2026-11-08T02:05:00.000Z'}}]){
  expect(ExposureSchema.safeParse({...exposure,policyTelemetry:{...telemetry,...override}}).success).toBe(false);
 }
});
test('a committed Skip closes its original reservation without claiming an Undo',()=>{
 const result=ExposureSchema.safeParse({...demoQueue.items[0]!.exposure,policyTelemetry:{...telemetry,reservation:{...telemetry.reservation,status:'released',closedAt:telemetry.reservation.evaluatedAt,closureReason:'skip'}}});
 expect(result.success).toBe(true);
});
