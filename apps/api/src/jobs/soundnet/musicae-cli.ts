import {connectDatabase} from '../../../../../packages/db/src/client';import {MusicaeQueue} from '../../../../../packages/db/src/musicae-queue';import {MusicaeClient} from './musicae-provider';import {MusicaeWorker} from './musicae-worker';
const usage='Usage: musicae-cli.ts <enqueue|status|smoke|run> --user USER_ID [--max-requests N] [--priority-file PATH]';
export async function main(args=process.argv.slice(2)){
 const command=args[0];if(!command||!['enqueue','status','smoke','run'].includes(command))throw Error(usage);
 const flags=new Map<string,string>();for(let i=1;i<args.length;i+=2){if(!['--user','--max-requests','--priority-file'].includes(args[i]!)||flags.has(args[i]!)||!args[i+1]||args[i+1]!.startsWith('--'))throw Error('INVALID_ARGUMENTS');flags.set(args[i]!,args[i+1]!);}
 const user=flags.get('--user');if(!user)throw Error('USER_REQUIRED');const maxRequests=command==='smoke'?1:Number(flags.get('--max-requests')??20);if(!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>1000)throw Error('INVALID_REQUEST_BUDGET');
 const db=connectDatabase(),queue=new MusicaeQueue(db),stop=new AbortController();const shutdown=()=>stop.abort();process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
 try{
  if(command==='status'){console.log(JSON.stringify(await queue.progress(user)));return;}
  if(command==='enqueue'||command==='smoke'){
   const file=flags.get('--priority-file');let ids:string[]=[];if(file){const parsed=await Bun.file(file).json();if(!Array.isArray(parsed)||parsed.some(id=>typeof id!=='string'))throw Error('INVALID_PRIORITY_IDS');ids=parsed;}
   console.log(JSON.stringify({enqueued:await queue.enqueueUser(user,ids)}));if(command==='enqueue')return;
  }
  const key=process.env.MUSICAE_RAPIDAPI_KEY??process.env.SOUNDNET_RAPIDAPI_KEY;if(!key)throw Error('MUSICAE_RAPIDAPI_KEY_REQUIRED');
  const worker=new MusicaeWorker(queue,new MusicaeClient(key,{timeoutMs:Number(process.env.MUSICAE_TIMEOUT_MS??30000)}),{rightsBasis:process.env.MUSICAE_RIGHTS_BASIS,log:event=>console.log(JSON.stringify(event))});
  const result=await worker.run({userId:user,maxRequests,requirePro:command!=='smoke'},stop.signal);console.log(JSON.stringify({result,progress:await queue.progress(user)}));if(!['COMPLETE','REQUEST_BUDGET','COOLDOWN','ABORTED'].includes(result.reason))process.exitCode=1;
 }finally{process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);await db.close();}
}
if(import.meta.main)main().catch(error=>{console.error(error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'MUSICAE_COMMAND_FAILED');process.exitCode=1;});
