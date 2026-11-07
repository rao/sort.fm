/** Real Tiger + local C1, with controlled Spotify transport and a disposable schema. */
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
if(!url)throw new Error('DATABASE_URL or TEST_DATABASE_URL is required for the isolated backend smoke.');
const child=Bun.spawn([process.execPath,'test','apps/api/test/backend.integration.test.ts'],{
 env:{...process.env,TEST_DATABASE_URL:url},stdout:'inherit',stderr:'inherit',
});
process.exit(await child.exited);
export {};
