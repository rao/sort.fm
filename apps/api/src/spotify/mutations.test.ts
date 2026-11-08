import {expect,test} from 'bun:test';
import {SpotifyMutations, MutationRequestError} from './mutations';
import {SpotifyHttp} from './http';
const trackId='0000000000000000000001',playlistId='0000000000000000000002';
function setup(fetcher:(url:string,init?:RequestInit)=>Promise<Response>) {
  const auth={requireScopes:async()=>{},accessToken:async(_id:string,rejected?:string)=>({token:rejected?'refreshed':'secret',version:rejected?'v2':'v1'}),revoke:async()=>true};
  const reads=new SpotifyHttp({fetch:fetcher,sleep:async()=>{}});
  return new SpotifyMutations(auth,reads,{fetch:fetcher,timeoutMs:10});
}
test('library writes use current URI endpoint and accept empty200; reads verify boolean state',async()=>{
  const calls:{url:string;method:string}[]=[];
  const client=setup(async(url,init)=>{calls.push({url,method:init?.method??'GET'}); return (init?.method??'GET')==='GET'?Response.json([false]):new Response(null,{status:200});});
  await client.setLiked('spotify:owner',trackId,false);await client.setLiked('spotify:owner',trackId,true);
  expect(await client.isLiked('spotify:owner',trackId)).toBe(false);
  expect(calls.map(x=>x.method)).toEqual(['DELETE','PUT','GET']);
  expect(calls[0]!.url).toBe(`https://api.spotify.com/v1/me/library?uris=spotify%3Atrack%3A${trackId}`);
});
test('non-idempotent writes never blindly retry network failure or5xx',async()=>{
  for(const fail of [async()=>{throw new Error('secret provider body');},async()=>new Response('secret body',{status:500})]) {
    let calls=0; const client=setup(async()=>{calls++;return fail();});
    try {await client.addArchive('spotify:owner',playlistId,trackId);throw new Error('expected failure');}
    catch(error) {expect(error).toBeInstanceOf(MutationRequestError);expect((error as MutationRequestError).outcome).toBe('unknown');expect(String(error)).not.toContain('secret');}
    expect(calls).toBe(1);
  }
});
test('429 preserves retry deadline and tells journal request was rejected;401 refreshes once',async()=>{
  const rate=setup(async()=>new Response(null,{status:429,headers:{'retry-after':'120'}}));
  try {await rate.addArchive('spotify:owner',playlistId,trackId);}catch(error) {expect(error).toMatchObject({statusCode:429,outcome:'rejected',retryable:true});expect((error as MutationRequestError).retryAt).toBeGreaterThan(Date.now()+119000);}
  let calls=0;const client=setup(async(_url,init)=>{calls++;if(calls===1)return new Response(null,{status:401});expect(new Headers(init?.headers).get('authorization')).toBe('Bearer refreshed');return Response.json({snapshot_id:'snapshot'});});
  await client.addArchive('spotify:owner',playlistId,trackId);expect(calls).toBe(2);
});
test('private archive creation has stable marker and owner verification; no arbitrary URLs accepted',async()=>{
  const client=setup(async(url,init)=>{
    expect(url).toBe('https://api.spotify.com/v1/me/playlists');const body=JSON.parse(init!.body as string);
    expect(body).toMatchObject({name:'sort.fm Archive',public:false,description:'sort.fm archive [sortfm:owner]'});
    return Response.json({id:playlistId,public:false,owner:{id:'owner'},description:body.description});
  });
  expect(await client.createArchive('spotify:owner')).toBe(playlistId);
  await expect(client.addArchive('spotify:owner','https://evil.test',trackId)).rejects.toThrow();
});
test('archive membership paginates current item field and rejects premature or malformed pages',async()=>{
  let calls=0;const client=setup(async(url)=>{calls++;const offset=Number(new URL(url).searchParams.get('offset'));return Response.json({offset,total:2,items:offset?[{item:{id:trackId,type:'track'}}]:[{item:null}]});});
  expect(await client.archiveContains('spotify:owner',playlistId,trackId)).toBe(true);expect(calls).toBe(2);
  const malformed=setup(async()=>Response.json({offset:0,total:2,items:[]}));
  await expect(malformed.archiveContains('spotify:owner',playlistId,trackId)).rejects.toThrow('invalid');
});
test('lease guard runs immediately before every write; timeout is ambiguous',async()=>{
  let calls=0;const client=setup(async()=>{calls++;return new Promise(()=>{});});
  await expect(client.setLiked('spotify:owner',trackId,false,async()=>{throw new Error('lease lost');})).rejects.toThrow('lease lost');expect(calls).toBe(0);
  try {await client.setLiked('spotify:owner',trackId,false);}catch(error){expect(error).toMatchObject({outcome:'unknown',retryable:true});}
  expect(calls).toBe(1);
});


test('malformed reconciliation data is never treated as confirmed absence',async()=>{
  const malformed=setup(async()=>Response.json({offset:0,total:1,items:[{id:playlistId,owner:{id:'owner'},description:'sort.fm archive [sortfm:owner]'}]}));
  await expect(malformed.findArchive('spotify:owner')).rejects.toMatchObject({code:'SPOTIFY_INVALID_RESPONSE'});
  const missing=setup(async()=>Response.json({offset:0,total:1,items:[{}]}));
  await expect(missing.archiveContains('spotify:owner',playlistId,trackId)).rejects.toMatchObject({code:'SPOTIFY_INVALID_RESPONSE'});
});

test('archive reconciliation marker supports canonical dotted Spotify usernames',()=>{
  const client=setup(async()=>{throw new Error('No network needed');});
  // Authored placeholder account; catalog fixtures remain public test data.
  expect(client.marker('spotify:example.listener')).toBe('sort.fm archive [sortfm:example.listener]');
});

test('archive verification rejects a response identifying a different playlist',async()=>{
  const client=setup(async()=>Response.json({id:trackId,public:false,owner:{id:'owner'}}));
  await expect(client.verifyArchive('spotify:owner',playlistId)).rejects.toMatchObject({code:'SPOTIFY_INVALID_RESPONSE'});
});

test('unidentifiable or contradictory playlist items cannot confirm absence or a backup',async()=>{
  for(const item of [{},{id:null},{id:trackId,uri:`spotify:track:${playlistId}`},{id:trackId,type:'track',uri:`spotify:episode:${trackId}`}]) {
    const client=setup(async()=>Response.json({offset:0,total:1,items:[{item}]}));
    await expect(client.archiveContains('spotify:owner',playlistId,trackId)).rejects.toMatchObject({code:'SPOTIFY_INVALID_RESPONSE'});
  }
});

test('an episode with the same identifier is not an archived track',async()=>{
  const client=setup(async()=>Response.json({offset:0,total:1,items:[{item:{id:trackId,type:'episode',uri:`spotify:episode:${trackId}`}}]}));
  expect(await client.archiveContains('spotify:owner',playlistId,trackId)).toBe(false);
});

test('valid playlist identities retain local, unavailable, legacy and relinked compatibility',async()=>{
  const client=setup(async()=>Response.json({offset:0,total:4,items:[
    {item:null},
    {item:{id:null,type:'track',uri:'spotify:local:artist:album:title:120',is_local:true}},
    {item:{id:playlistId,type:'episode',uri:`spotify:episode:${playlistId}`}},
    {track:{id:playlistId,type:'track',uri:`spotify:track:${playlistId}`,linked_from:{id:trackId}}},
  ]}));
  expect(await client.archiveContains('spotify:owner',playlistId,trackId)).toBe(true);
});

test.each([
  {id:trackId},
  {id:playlistId,type:'track',uri:`spotify:track:${playlistId}`,linked_from:{id:trackId,type:'episode',uri:`spotify:episode:${playlistId}`}},
  {id:playlistId,type:'track',linked_from:{id:trackId,type:'track',uri:`spotify:track:${playlistId}`}},
])('ambiguous types and contradictory relinked identities cannot prove a backup: %j',async(item)=>{
  const client=setup(async()=>Response.json({offset:0,total:1,items:[{item}]}));
  await expect(client.archiveContains('spotify:owner',playlistId,trackId)).rejects.toMatchObject({code:'SPOTIFY_INVALID_RESPONSE'});
});

test('an explicit track URI resolves identity when other optional fields are missing',async()=>{
  const client=setup(async()=>Response.json({offset:0,total:1,items:[{item:{uri:`spotify:track:${trackId}`}}]}));
  expect(await client.archiveContains('spotify:owner',playlistId,trackId)).toBe(true);
});
