import {expect,test} from 'bun:test';
import type {CalibrationLabelInput,CalibrationUndoInput} from '@sortfm/contracts';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {CalibrationService} from './service';
import {fixture,now,owner,row} from './test-fixtures';
const request=()=>({trackId:row(1).track.trackId,exposureId:crypto.randomUUID(),label:1 as const,idempotencyKey:createIdempotencyKey()});

test('binary preference, retry and label Undo delegate atomically without advisory reads or cleanup work',async()=>{
 const f=fixture();let kicks=0;const service=new CalibrationService(f.store,{now:()=>now,feedback:{kick(){kicks++;}}});
 const input=request(),first=await service.label(owner,input),retry=await service.label(owner,input);
 expect(first).toEqual(retry);expect(kicks).toBe(2);
 const inputs=f.calls.filter(c=>c.method==='label').map(c=>c.value as CalibrationLabelInput);
 expect(inputs[0]!.requestFingerprint).toBe(inputs[1]!.requestFingerprint);
 expect(inputs[0]!.labelId).not.toBe(inputs[1]!.labelId);expect(inputs[0]!.userId).toBe(owner);
 expect(f.calls.every(c=>c.method==='label')).toBe(true);
 const undone=await service.undo(owner,first.labelId,{idempotencyKey:createIdempotencyKey()});
 expect(undone).toMatchObject({state:'revoked',label:null,submittedLabel:1,canUndo:false});expect(kicks).toBe(3);
 expect(f.calls.at(-1)?.value).toMatchObject({labelId:first.labelId,userId:owner});
 expect((await service.history(owner)).items[0]).toEqual(undone);
 expect(Object.hasOwn(undone,'liked')).toBe(false);expect(Object.hasOwn(undone,'archived')).toBe(false);
});

test('current replay state is authoritative; missing kick cannot undo a committed label',async()=>{
 const f=fixture(),service=new CalibrationService(f.store,{now:()=>now,feedback:{kick(){throw Error('worker unavailable');}}});
 const input=request(),first=await service.label(owner,input);
 await service.undo(owner,first.labelId,{idempotencyKey:createIdempotencyKey()});
 expect((await service.label(owner,input)).state).toBe('revoked');
});

test('fingerprints include full canonical request and Undo target; never trust client authority fields',async()=>{
 const f=fixture(),service=new CalibrationService(f.store,{now:()=>now});
 const a=await service.label(owner,request()),b=await service.label(owner,{...request(),label:0});
 const key=createIdempotencyKey();await service.undo(owner,a.labelId,{idempotencyKey:key});await service.undo(owner,b.labelId,{idempotencyKey:key});
 const undo=f.calls.filter(c=>c.method==='undo').map(c=>c.value as CalibrationUndoInput);
 expect(undo[0]!.requestFingerprint).not.toBe(undo[1]!.requestFingerprint);
 const count=f.calls.length;
 await expect(service.label(owner,{...request(),userId:'foreign'} as never)).rejects.toThrow();
 await expect(service.label(owner,{...request(),label:2} as never)).rejects.toThrow();
 await expect(service.undo(owner,'invalid',{idempotencyKey:key})).rejects.toThrow();expect(f.calls).toHaveLength(count);
});

test('failed persistence never kicks feedback; incoherent results never produce a successful response',async()=>{
 const f=fixture();let kicked=false;const service=new CalibrationService(f.store,{feedback:{kick(){kicked=true;}}});
 f.store.createCalibrationLabel=async()=>{throw Object.assign(Error('private db text'),{code:'EXPOSURE_PURPOSE_MISMATCH'});};
 await expect(service.label(owner,request())).rejects.toMatchObject({code:'EXPOSURE_PURPOSE_MISMATCH'});expect(kicked).toBe(false);
 const valid=fixture(),wrong=new CalibrationService(valid.store);
 const input=request(),first=await wrong.label(owner,input);
 valid.store.createCalibrationLabel=async()=>({...first,trackId:row(2).track.trackId});
 await expect(wrong.label(owner,input)).rejects.toMatchObject({code:'CALIBRATION_INVALID_RESPONSE'});
 valid.store.undoCalibrationLabel=async()=>first;
 await expect(wrong.undo(owner,first.labelId,{idempotencyKey:createIdempotencyKey()})).rejects.toMatchObject({code:'CALIBRATION_INVALID_RESPONSE'});
});

test('post-Skip Remove uses a canonical original command, independent generated IDs and durable current retry projection',async()=>{
 const f=fixture();let kicks=0;const received:any[]=[];let saved:any;
 f.store.correctSkippedPreference=async v=>{received.push(v);return saved??= {mode:'calibration',labelId:v.labelId,trackId:row(1).track.trackId,exposureId:v.exposureId,idempotencyKey:v.request.idempotencyKey,submittedLabel:1,label:1,state:'active',canUndo:true,feedbackRevision:1,createdAt:v.createdAt,updatedAt:v.createdAt};};
 const service=new CalibrationService(f.store,{now:()=>now,feedback:{kick(){kicks++;}}}),input={decisionId:crypto.randomUUID(),label:1 as const,idempotencyKey:createIdempotencyKey()};
 expect(await service.correct(owner,input)).toEqual(await service.correct(owner,input));expect(kicks).toBe(2);expect(received[0].requestFingerprint).toBe(received[1].requestFingerprint);expect(received[0].exposureId).not.toBe(received[1].exposureId);expect(received[0].request).toEqual(input);
 await expect(service.correct(owner,{...input,label:0} as never)).rejects.toThrow();expect(received).toHaveLength(2);
 saved={...saved,state:'revoked',label:null,canUndo:false};expect((await service.correct(owner,input)).state).toBe('revoked');
 delete f.store.correctSkippedPreference;await expect(service.correct(owner,input)).rejects.toMatchObject({code:'CALIBRATION_UNAVAILABLE'});
});
