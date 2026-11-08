// Explicit test database only; all Spotify traffic uses authored in-process transport.
if (!process.env.TEST_DATABASE_URL?.trim()) throw new Error('TEST_DATABASE_URL is required; DATABASE_URL is never used');
const child=Bun.spawn([process.execPath,'--no-env-file','test','apps/api/test/pilot-four-action.integration.test.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env},stdout:'inherit',stderr:'inherit'});
process.exit(await child.exited);
export {};
