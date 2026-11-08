/** Read-only constellation boundary. Privacy filtering belongs to D's projection. */
import type {FastifyInstance} from 'fastify';
import {ConstellationProjectionSchema,IdSchema,PUBLIC_ROUTES,type ConstellationReadPort,type TasteConstellationLive} from '@sortfm/contracts';
import {reviewRouteSecurity,type ReviewRouteOptions} from '../reviews/module';
import {SpotifyError} from '../spotify/errors';

export interface TasteConstellationOptions extends ReviewRouteOptions {
 projection:ConstellationReadPort|null;
 now?:()=>number;
 /** Bounds each authentication/projection read; adapters own I/O cancellation. */
 readTimeoutMs?:number;
}
const unavailable=()=>new SpotifyError('CONSTELLATION_UNAVAILABLE','Taste Constellation is temporarily unavailable. Retry later.',503,true);

export function createTasteConstellationModule(options:TasteConstellationOptions) {
 const security=reviewRouteSecurity(options),route=PUBLIC_ROUTES.constellation,now=options.now??Date.now;
 const timeout=options.readTimeoutMs??2000;
 if(!Number.isInteger(timeout)||timeout<=0||timeout>15000)throw new RangeError('Invalid constellation read deadline');
 async function bounded<T>(read:()=>Promise<T>):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(read),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable()),timeout);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
 }
 async function get(userId:string):Promise<TasteConstellationLive> {
  try {
   IdSchema.parse(userId);
   if(!options.projection)throw unavailable();
   const projection=ConstellationProjectionSchema.parse(await bounded(()=>options.projection!.constellation(userId)));
   if(projection.userId!==userId)throw unavailable();
   // Validate the whole snapshot before exposing any tracks. No cache, sampling,
   // inferred labels, imputation, rescoring or exposure allocation occurs here.
   return route.response.parse({schema:'sortfm.constellation.v1',mode:'live',privacy:'evaluation-excluded',
    generatedAt:new Date(now()).toISOString(),modelVersion:null,
    tracks:projection.tracks.map(track=>({...track,prediction:null})),
   });
  }catch{throw unavailable();}
 }
 const registerRoutes=async(app:FastifyInstance)=>{
  app.get(route.path,security.safe(async request=>{
   route.query.parse(request.query);
   if(request.body!==undefined||request.headers['transfer-encoding']!==undefined
    ||(request.headers['content-length']!==undefined&&request.headers['content-length']!=='0'))
    throw new SpotifyError('VALIDATION_ERROR','This endpoint does not accept a request body.',400);
   return get(await bounded(()=>security.owner(request)));
  }));
 };
 return {get,registerRoutes};
}
