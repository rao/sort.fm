/** Loopback-only, explicitly labeled QA fixture. Never contacts Spotify/ML or loads secrets. */
import { resolve, sep } from "node:path";
import { calibrationFixture } from "../src/test-support/calibration-fixture";
if (process.env.SORTFM_TEST_FIXTURE !== "1")
	throw new Error("Set SORTFM_TEST_FIXTURE=1 for controlled QA.");
let fixture = calibrationFixture();
const root = resolve(import.meta.dir, "../dist");
const port = Number(process.env.SORTFM_FIXTURE_PORT ?? 5196);
const panel = `<aside style="position:fixed;bottom:8px;left:8px;z-index:10000;background:#362722;color:#fff;padding:8px;border:1px solid #b98964;border-radius:8px;font:11px sans-serif"><details><summary>CALIBRATION TEST FIXTURE · NO SPOTIFY CONNECTION</summary><nav style="display:flex;gap:10px;flex-wrap:wrap"><a href="/__fixture/reset">Reset</a><a href="/__fixture/lose">Lose next response</a><a href="/__fixture/offline">Disable calibration</a><a href="/__fixture/queue-fail">Fail queue</a><a href="/__fixture/recover">Recover service</a><a href="/__fixture/fit-fail">Fail fit</a><a href="/__fixture/audit">Request audit</a></nav></details></aside>`;
Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/__fixture/")) {
			if (url.pathname.endsWith("/reset")) fixture = calibrationFixture();
			if (url.pathname.endsWith("/lose")) fixture.loseResponse();
			if (url.pathname.endsWith("/offline")) fixture.unavailable(true);
			if (url.pathname.endsWith("/queue-fail")) fixture.failQueue(true);
			if (url.pathname.endsWith("/recover")) {
				fixture.unavailable(false);
				fixture.failQueue(false);
				fixture.failHistory(false);
				fixture.failFit(false);
			}
			if (url.pathname.endsWith("/fit-fail")) fixture.failFit(true);
			if (url.pathname.endsWith("/audit"))
				return Response.json({
					calls: fixture.calls.map((call) => ({
						path: call.url,
						method: call.init?.method,
						body: call.init?.body,
					})),
					labels: fixture.history,
				});
			return Response.redirect(`${url.origin}/#/calibrate`);
		}
		if (url.pathname.startsWith("/api/")) {
			try {
				return await fixture.transport(url.pathname + url.search, {
					method: request.method,
					credentials: "include",
					...(request.method === "POST" ? { body: await request.text() } : {}),
				});
			} catch (error) {
				return Response.json(
					{
						code: "FIXTURE_FAILURE",
						message: error instanceof Error ? error.message : "Fixture error",
						retryable: true,
					},
					{ status: 503 },
				);
			}
		}
		const path = resolve(
			root,
			`.${url.pathname === "/" ? "/index.html" : url.pathname}`,
		);
		if (!path.startsWith(root + sep))
			return new Response("Not found", { status: 404 });
		const file = Bun.file(path);
		if (!(await file.exists()))
			return new Response("Not found", { status: 404 });
		if (path.endsWith("index.html"))
			return new Response(
				(await file.text()).replace("</body>", panel + "</body>"),
				{ headers: { "Content-Type": "text/html" } },
			);
		return new Response(file);
	},
});
console.log(`Calibration fixture http://127.0.0.1:${port}/#/calibrate`);
