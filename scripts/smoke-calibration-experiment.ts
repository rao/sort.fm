/** Real local Python/API and disposable Postgres; synthetic controlled Spotify. */
import {fileURLToPath} from 'node:url';
if(!process.env.TEST_DATABASE_URL?.trim())throw Error('TEST_DATABASE_URL is required for the isolated Batch3 smoke; DATABASE_URL is never used.');
const child=Bun.spawn([process.execPath,'--no-env-file','test','apps/api/test/calibration-experiment-backend.integration.test.ts'],{
 cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env},stdout:'inherit',stderr:'inherit',
});
process.exit(await child.exited);
export {};
