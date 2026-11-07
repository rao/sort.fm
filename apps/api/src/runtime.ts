import {connectDatabase, PostgresA1Store, Repository, type Database} from '@sortfm/db';
import {PUBLIC_ROUTES} from '@sortfm/contracts';
import {createDemoQueue} from '@sortfm/contracts/fixtures';
import {QueueService} from './reviews/queue';
import {createReviewQueueModule} from './reviews/module';
import {buildApp} from './app';
import {loadConfig} from './config';
import {loadSpotifyConfig} from './auth/config';
import {createSpotifyModule} from './auth/module';
import type {SpotifyHttp} from './spotify/http';

/** Integration bootstrap. Missing external services leave the isolated demo usable. */
export async function buildRuntime(options: {
 env?: Record<string,string|undefined>;
 logger?: boolean;
 spotifyHttp?: SpotifyHttp;
} = {}) {
 const env=options.env??process.env;
 const config=loadConfig(env);
 const startupIssues:string[]=[];
 let database:Database|null=null;
 if(env.DATABASE_URL?.trim()) {
  try {
   database=connectDatabase(env.DATABASE_URL,env.DATABASE_SCHEMA??'sortfm');
   // Startup is read-only: migrations are an explicit operator step.
   await database.transaction(async tx=>{
    await tx`SELECT id FROM users LIMIT 0`;
    await tx`SELECT user_id FROM library_membership LIMIT 0`;
    await tx`SELECT feedback_revision FROM users LIMIT 0`;
   });
  } catch {
   await database?.close().catch(()=>{});
   database=null;
   startupIssues.push('DATABASE_UNAVAILABLE');
  }
 } else startupIssues.push('DATABASE_URL_REQUIRED');

 let spotify:ReturnType<typeof createSpotifyModule>|null=null;
 const required=['SPOTIFY_CLIENT_ID','SPOTIFY_ALLOWED_USER_IDS','TOKEN_ENCRYPTION_KEY','SESSION_SECRET'] as const;
 const missing=required.filter(key=>!env[key]?.trim());
 startupIssues.push(...missing.map(key=>`${key}_REQUIRED`));
 if(database&&missing.length===0) {
  try {
   spotify=createSpotifyModule({config:loadSpotifyConfig(env),store:new PostgresA1Store(database),...(options.spotifyHttp?{http:options.spotifyHttp}:{})});
  } catch {startupIssues.push('SPOTIFY_CONFIG_INVALID');}
 }

 const reviews=spotify&&database?createReviewQueueModule({
  queue:new QueueService(new Repository(database)),auth:spotify.auth,
  config:{...config,secureCookies:config.apiOrigin.startsWith('https:')},
  ...(config.demoEnabled?{demoQueue:(query:Parameters<QueueService['get']>[1])=>createDemoQueue({...query,servedAt:new Date().toISOString(),exposureId:()=>crypto.randomUUID()})}:{}),
 }):null;

 try {
  const app=await buildApp({config,logger:options.logger,capabilities:{database:database!==null,spotify:spotify!==null,ml:false},registerRoutes:async app=>{
   if(spotify) {await spotify.registerRoutes(app);await reviews?.registerRoutes(app);}
   else for(const path of [PUBLIC_ROUTES.authStart.path,PUBLIC_ROUTES.authCallback.path]) {
    app.get(path,async(_request,reply)=>reply.code(503).send({code:'SPOTIFY_NOT_CONFIGURED',message:'Spotify connection is unavailable until server configuration and database readiness are complete.',retryable:false}));
   }
  }});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{try{await app.close();}finally{await database?.close();}})();
  return {app,config,startupIssues,close};
 } catch(error) {await database?.close();throw error;}
}
