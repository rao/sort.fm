import {afterEach, expect, test} from 'bun:test';
import {buildRuntime} from '../src/runtime';

const runtimes: Awaited<ReturnType<typeof buildRuntime>>[]=[];
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();});

test('unconfigured runtime preserves demo and refuses live OAuth without opening a database',async()=>{
 const runtime=await buildRuntime({env:{NODE_ENV:'test'}});runtimes.push(runtime);
 const health=await runtime.app.inject({url:'/api/health'});
 expect(health.json().capabilities).toEqual({demo:true,spotify:false,database:false,ml:false});
 expect((await runtime.app.inject({url:'/api/demo/bootstrap'})).statusCode).toBe(200);
 expect((await runtime.app.inject({url:'/api/me'})).json().mode).toBe('anonymous');
 const auth=await runtime.app.inject({url:'/api/auth/spotify/start'});
 expect(auth.statusCode).toBe(503);
 expect(auth.json().code).toBe('SPOTIFY_NOT_CONFIGURED');
 expect(auth.body).not.toContain('undefined');
 expect(runtime.startupIssues).toContain('DATABASE_URL_REQUIRED');
});

test('invalid database configuration is isolated from the demo without disclosing credentials',async()=>{
 const secret='should-never-appear';
 const runtime=await buildRuntime({env:{NODE_ENV:'test',DATABASE_URL:`invalid://${secret}`}});runtimes.push(runtime);
 expect(runtime.startupIssues).toContain('DATABASE_UNAVAILABLE');
 expect(JSON.stringify(runtime.startupIssues)).not.toContain(secret);
 expect((await runtime.app.inject({url:'/api/demo/bootstrap'})).statusCode).toBe(200);
 expect((await runtime.app.inject({url:'/api/health'})).json().capabilities.database).toBe(false);
});
