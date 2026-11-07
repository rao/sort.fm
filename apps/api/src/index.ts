import {buildRuntime} from './runtime';

const runtime=await buildRuntime({logger:true});
if(runtime.startupIssues.length)runtime.app.log.warn({codes:runtime.startupIssues},'Some live capabilities are unavailable; the isolated demo remains available when enabled.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
 void runtime.close().then(()=>process.exit(0),()=>process.exit(1));
});
try{await runtime.app.listen({port:runtime.config.port,host:runtime.config.host});}
catch{await runtime.close();console.error('API_START_FAILED');process.exitCode=1;}
