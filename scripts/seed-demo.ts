import { demoBootstrap } from "../packages/contracts/src/fixtures";
// Deterministic synthetic JSON to stdout; redirect if a file is wanted. No DB/Spotify writes.
console.log(JSON.stringify(demoBootstrap, null, 2));
