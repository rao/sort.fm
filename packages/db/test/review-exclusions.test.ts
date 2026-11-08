import {test,expect} from 'bun:test';import {createHash} from 'node:crypto';import {createReviewExclusionPolicy} from '../src/review-exclusions';
const schema='pilot_c2_0123456789abcdef01234567',owner='spotify:pilot.owner',id=(n:number)=>String(n).padStart(22,'0');
function manifest(){const payload={ownerId:owner,pilotSchema:schema,sortedTrackIds:[id(1),id(2)]};return {...payload,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};}
test('pilot exclusion policy validates schema, owner, exact sorted IDs and canonical digest before use',()=>{
 const p=createReviewExclusionPolicy(schema,manifest());expect(p.denies(owner,id(1))).toBe(true);expect(p.denies(owner,id(3))).toBe(false);expect(()=>p.denies('spotify:other',id(3))).toThrow('REVIEW_OWNER_MISMATCH');
 for(const bad of [{...manifest(),sha256:'a'.repeat(64)},{...manifest(),sortedTrackIds:[id(2),id(1)]},{...manifest(),sortedTrackIds:[id(1),id(1)]},{...manifest(),ownerId:''},{...manifest(),extra:true}])expect(()=>createReviewExclusionPolicy(schema,bad)).toThrow('INVALID_REVIEW_EXCLUSIONS');
 expect(()=>createReviewExclusionPolicy('sortfm',manifest())).toThrow('INVALID_REVIEW_EXCLUSIONS');expect(()=>createReviewExclusionPolicy('pilot_c2_ffffffffffffffffffffffff',manifest())).toThrow('INVALID_REVIEW_EXCLUSIONS');
});
test('caller mutation or exposed property replacement cannot alter the fixed policy',()=>{
 const input=manifest(),p=createReviewExclusionPolicy(schema,input);input.sortedTrackIds.length=0;input.ownerId='other';expect(p.denies(owner,id(1))).toBe(true);expect(Object.isFrozen(p)).toBe(true);expect(()=>{(p as any).denies=()=>false;}).toThrow();expect(p.sha256).toBe(manifest().sha256);
});
import {Database} from '../src/client';
test('Database accepts an optional pinned policy, defaults absent, and rejects replacing the installed fence',async()=>{
 const url='postgres://synthetic:synthetic@127.0.0.1:1/test';
 const plain=new Database(url),pilot=new Database(url,schema,{reviewExclusions:manifest()} as any);
 try{expect((plain as any).reviewExclusions).toBeUndefined();expect((pilot as any).reviewExclusions?.sha256).toBe(manifest().sha256);expect(()=>{(pilot as any).reviewExclusions=undefined;}).toThrow();}finally{await plain.close();await pilot.close();}
});
