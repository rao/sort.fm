// Bun loads root .env before starting the Python service; no secret enters Vite.
const child=Bun.spawn(['uv','run','--directory','services/ml','uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port','8000'],{env:process.env,stdout:'inherit',stderr:'inherit',stdin:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
process.exit(await child.exited);

export {};
