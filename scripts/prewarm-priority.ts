/** Explicit private operator export; it never enqueues or requests enrichment. */
import {constants} from 'node:fs';
import {lstat,mkdir,open} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,resolve} from 'node:path';
import {IdSchema} from '../packages/contracts/src/index';
import {readPrewarmPriority,type PrewarmPriorityOptions,type PrewarmPriorityPort} from '../apps/api/src/calibration/prewarm';
import {connectDatabase} from '../packages/db/src/client';
import {createDatabasePrewarmPort} from './prewarm-database';
async function exists(path:string){try{return await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function destination(output:string,create:boolean){
 if(!isAbsolute(output)||resolve(output)!==output)throw Error('ABSOLUTE_CANONICAL_OUTPUT_REQUIRED');
 const parent=dirname(output),root=parse(parent).root;
 let current=root;
 // Check every component; a symlink into another repository/private directory
 // must not turn a safe-looking operator path into a different destination.
 for(const component of parent.slice(root.length).split('/').filter(Boolean)){
  if(await exists(join(current,'.git')))throw Error('OUTPUT_INSIDE_GIT_REPOSITORY');
  current=join(current,component);let info=await exists(current);
  if(!info&&create){await mkdir(current,{mode:0o700});info=await lstat(current);}
  if(!info||!info.isDirectory()||info.isSymbolicLink())throw Error('UNSAFE_OUTPUT_DIRECTORY');
 }
 if(await exists(join(parent,'.git')))throw Error('OUTPUT_INSIDE_GIT_REPOSITORY');
 const info=await lstat(parent);
 if((info.mode&0o777)!==0o700||info.uid!==process.getuid?.())throw Error('PRIVATE_OUTPUT_DIRECTORY_REQUIRED');
 if(await exists(output))throw Error('OUTPUT_ALREADY_EXISTS');
 return info;
}
export async function exportPrewarmPriority(port:PrewarmPriorityPort,userId:string,output:string,options:PrewarmPriorityOptions={}):Promise<{count:number;path:string}>{
 IdSchema.parse(userId);const before=await destination(output,true);
 const ids=await readPrewarmPriority(port,userId,options);
 // Recheck after the async DB read, including directory replacement/symlinks.
 const after=await destination(output,false);
 if(before.dev!==after.dev||before.ino!==after.ino)throw Error('OUTPUT_DIRECTORY_CHANGED');
 const file=await open(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await file.chmod(0o600);await file.writeFile(JSON.stringify(ids)+'\n');await file.sync();}finally{await file.close();}
 return {count:ids.length,path:output};
}
export function parsePrewarmArguments(args:string[]):{userId:string;output:string;limit:number;recentWindowMs:number}{
 const fields=new Map<string,string>();
 for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if(!['--user-id','--output','--limit','--recent-minutes'].includes(key)||value===undefined||fields.has(key))throw Error('INVALID_PREWARM_ARGUMENTS');fields.set(key,value);}
 const userId=IdSchema.parse(fields.get('--user-id')),output=fields.get('--output');
 if(!output||!isAbsolute(output)||resolve(output)!==output)throw Error('ABSOLUTE_CANONICAL_OUTPUT_REQUIRED');
 function integer(key:string,fallback:number,max:number){const raw=fields.get(key)??String(fallback);if(!/^[1-9][0-9]*$/.test(raw))throw Error('INVALID_PREWARM_ARGUMENTS');const value=Number(raw);if(!Number.isSafeInteger(value)||value>max)throw Error('INVALID_PREWARM_ARGUMENTS');return value;}
 return {userId,output,limit:integer('--limit',25,25),recentWindowMs:integer('--recent-minutes',30,1440)*60000};
}
if(import.meta.main){
 let db:ReturnType<typeof connectDatabase>|undefined;
 try{
  const {userId,output,...options}=parsePrewarmArguments(process.argv.slice(2));
  await destination(output,true);const now=Date.now();db=connectDatabase();
  console.log(JSON.stringify(await exportPrewarmPriority(createDatabasePrewarmPort(db,now),userId,output,{...options,now})));
 }catch{console.error('PREWARM_EXPORT_FAILED: check arguments, private destination and database settings. No enrichment was requested.');process.exitCode=1;}
 finally{await db?.close();}
}
