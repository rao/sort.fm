/** Real local Python + API + disposable Postgres schema; Spotify is a controlled transport. */
import {fileURLToPath} from 'node:url';
if(!process.env.TEST_DATABASE_URL?.trim())throw new Error('TEST_DATABASE_URL is required for the isolated policy backend smoke; DATABASE_URL is never used.');
const child=Bun.spawn([process.execPath,'--no-env-file','test','apps/api/test/policy-backend.integration.test.ts'],{
  cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env},stdout:'inherit',stderr:'inherit',
});
process.exit(await child.exited);
export {};
