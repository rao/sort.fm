export {};

const children = [
  Bun.spawn([process.execPath, "--env-file=.env", "apps/api/src/index.ts"], {stdout: "inherit", stderr: "inherit", stdin: "inherit"}),
  Bun.spawn([process.execPath, "node_modules/vite/bin/vite.js", "--host", "127.0.0.1"], {cwd: new URL("../apps/web/", import.meta.url).pathname, stdout: "inherit", stderr: "inherit", stdin: "inherit"}),
];
const stop = () => { for (const child of children) child.kill("SIGTERM"); };
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
const code = await Promise.race(children.map(child => child.exited));
stop();
await Promise.all(children.map(child => child.exited));
process.exit(code);
