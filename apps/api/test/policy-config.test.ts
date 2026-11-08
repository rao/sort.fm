import {expect,test} from 'bun:test';
import {loadConfig} from '../src/config';

test('C1 remains the default even when the C2 capability flag is enabled',()=>{
 for(const env of [{},{NODE_ENV:'production'},{C2_POLICY_ENABLED:'true'}]){
  const config=loadConfig(env) as any;
  expect(config.reviewSelectionPolicy).toBe('c1');
  expect(config.effectiveReviewSelectionPolicy).toBe('c1');
 }
 expect((loadConfig({}) as any).c2PolicyEnabled).toBe(false);
});
test('both an explicit policy and the enable flag are required for adaptive selection',()=>{
 for(const policy of ['epsilon_greedy','linucb']){
  const disabled=loadConfig({REVIEW_SELECTION_POLICY:policy}) as any;
  expect(disabled.reviewSelectionPolicy).toBe(policy);
  expect(disabled.effectiveReviewSelectionPolicy).toBe('c1');
  const enabled=loadConfig({REVIEW_SELECTION_POLICY:policy,C2_POLICY_ENABLED:'true'}) as any;
  expect(enabled.effectiveReviewSelectionPolicy).toBe(policy);
 }
});
test('invalid flags or unsupported selectors fail configuration instead of silently enabling a policy',()=>{
 for(const env of [{C2_POLICY_ENABLED:'yes'},{C2_POLICY_ENABLED:'1'},{REVIEW_SELECTION_POLICY:'random'},{REVIEW_SELECTION_POLICY:'thompson'},{REVIEW_SELECTION_POLICY:'LinUCB'}])expect(()=>loadConfig(env)).toThrow();
});
