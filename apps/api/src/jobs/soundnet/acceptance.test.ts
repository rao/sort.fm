import {test,expect} from 'bun:test';
import {validateTitleAcceptance} from './acceptance';
const now=Date.now(),attemptId=crypto.randomUUID();
const candidate={id:attemptId,version:'soundnet.title-acceptance.v1',lookupMode:'title_artist',verifier:'soundnet.title-fingerprint.v1',createdAt:new Date(now-1000).toISOString(),samples:Array.from({length:5},(_,i)=>({trackId:String(i).repeat(22),primaryArtist:`Artist ${i}`,status:'success',identityVerified:true,endpoint:i===0?'cached':'title_artist',verifiedAt:new Date(now-1000).toISOString()}))};
const report={samples:candidate.samples.map(s=>({trackId:s.trackId,status:'failed'})),acceptanceAttempts:[candidate]};
test('approval selects explicit recent five-artist acceptance and retains original failed evidence',()=>{
 const approved=validateTitleAcceptance(report,attemptId,now);expect(approved.id).toBe(attemptId);expect(report.samples.every(s=>s.status==='failed')).toBe(true);
});
test.each(['wrong_id','duplicate_artist','duplicate_track','old','future','unverified','failed','wrong_mode','wrong_verifier','no_live_call','partial'] as const)('rejects %s acceptance',mutation=>{
 const copy=structuredClone(report);const a=copy.acceptanceAttempts[0]!;
 if(mutation==='wrong_id')a.samples[0]!.trackId='x'.repeat(22);
 if(mutation==='duplicate_artist')a.samples[1]!.primaryArtist=a.samples[0]!.primaryArtist;
 if(mutation==='duplicate_track')a.samples[1]!.trackId=a.samples[0]!.trackId;
 if(mutation==='old')a.createdAt=new Date(now-86400001).toISOString();
 if(mutation==='future')a.createdAt=new Date(now+1000).toISOString();
 if(mutation==='unverified')a.samples[0]!.identityVerified=false;
 if(mutation==='failed')a.samples[0]!.status='failed';
 if(mutation==='wrong_mode')a.lookupMode='spotify_id';
 if(mutation==='wrong_verifier')a.verifier='other';
 if(mutation==='no_live_call')a.samples.forEach(s=>s.endpoint='cached');
 if(mutation==='partial')a.samples.pop();
 expect(()=>validateTitleAcceptance(copy,attemptId,now)).toThrow();
});
test('unselected diagnostics and absent attempt never authorize title mode',()=>{expect(()=>validateTitleAcceptance({...report,acceptanceAttempts:undefined,diagnostics:candidate.samples},attemptId,now)).toThrow();expect(()=>validateTitleAcceptance(report,crypto.randomUUID(),now)).toThrow();});
