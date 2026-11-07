/** Loopback-only, explicitly labeled QA fixture. Never contacts Spotify/ML or loads secrets. */
import { resolve, sep } from "node:path";
import { calibrationFixture } from "../src/test-support/calibration-fixture";
if (process.env.SORTFM_TEST_FIXTURE !== "1")
	throw new Error("Set SORTFM_TEST_FIXTURE=1 for controlled QA.");
let fixture = calibrationFixture();
const root = resolve(import.meta.dir, "../dist");
const port = Number(process.env.SORTFM_FIXTURE_PORT ?? 5197);
let playback: {
	paused: boolean;
	position: number;
	duration: number;
	track_window: { current_track: { uri: string } };
} | null = null;
const playbackCalls: { path: string; body: unknown }[] = [];
let playbackFailure = false;
const sdk = `<script>
// Explicit local fixture: no Spotify SDK or real audio is loaded.
window.Spotify={Player:class {
 constructor(options){this.options=options;this.events={};this.state=null;window.fixturePlayer=this;}
 addListener(name,fn){this.events[name]=fn;return true;}
 removeListener(name){delete this.events[name];return true;}
 async connect(){this.options.getOAuthToken(()=>this.events.ready?.({device_id:'fixture-device'}));return true;}
 disconnect(){this.events={};}
 async activateElement(){}
 async getCurrentState(){this.state=await fetch('/__fixture/player').then(r=>r.json());return this.state;}
 async write(patch){await fetch('/__fixture/player',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});this.events.player_state_changed?.(await this.getCurrentState());}
 async pause(){await this.write({paused:true});}
 async resume(){await this.write({paused:false});}
 async seek(position){await this.write({position});}
 async setVolume(volume){this.volume=volume;}
}};
</script>`;
const panel = `<aside style="position:fixed;bottom:8px;left:8px;z-index:10000;background:#362722;color:#fff;padding:8px;border:1px solid #b98964;border-radius:8px;font:11px sans-serif"><details><summary>PLAYBACK FIXTURE · SIMULATED, NO AUDIO</summary><nav style="display:flex;gap:10px;flex-wrap:wrap"><button onclick="window.fixturePlayer?.events.not_ready?.({device_id:'fixture-device'})">Disconnect device</button><button onclick="window.fixturePlayer?.events.autoplay_failed?.()">Block autoplay</button><a href="/__fixture/play-fail">Fail play</a><a href="/__fixture/reset">Reset</a><a href="/__fixture/lose">Lose next response</a><a href="/__fixture/offline">Disable calibration</a><a href="/__fixture/queue-fail">Fail queue</a><a href="/__fixture/recover">Recover service</a><a href="/__fixture/fit-fail">Fail fit</a><a href="/__fixture/audit">Request audit</a></nav></details></aside>`;
Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__fixture/player") {
			if (request.method === "POST" && playback)
				Object.assign(playback, await request.json());
			return Response.json(playback);
		}
		if (url.pathname.startsWith("/__fixture/")) {
			if (url.pathname.endsWith("/play-fail")) playbackFailure = true;
			if (
				url.pathname.endsWith("/recover") ||
				url.pathname.endsWith("/reset")
			) {
				playbackFailure = false;
				playback = null;
			}
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
					playbackCalls,
					calls: fixture.calls.map((call) => ({
						path: call.url,
						method: call.init?.method,
						body: call.init?.body,
					})),
					labels: fixture.history,
				});
			return Response.redirect(`${url.origin}/#/calibrate`);
		}
		if (url.pathname.startsWith("/api/player/")) {
			const body = request.method === "POST" ? await request.json() : null;
			playbackCalls.push({ path: url.pathname, body });
			if (url.pathname.endsWith("/connection"))
				return Response.json({
					status: "ready",
					sdkReady: true,
					controlReady: true,
					reason: null,
				});
			if (url.pathname.endsWith("/token"))
				return Response.json({
					ownerId: "owner",
					accessToken: "fixture-only-sdk-token",
					tokenType: "Bearer",
					expiresAt: new Date(Date.now() + 600000).toISOString(),
					scopes: ["streaming", "user-read-email", "user-read-private"],
				});
			if (url.pathname.endsWith("/sdk/play")) {
				if (playbackFailure)
					return Response.json(
						{
							code: "PLAYBACK_DEVICE_UNAVAILABLE",
							message: "Fixture device failed",
							retryable: false,
						},
						{ status: 409 },
					);
				playback = {
					paused: false,
					position: 0,
					duration: 200000,
					track_window: {
						current_track: { uri: (body as { trackUri: string }).trackUri },
					},
				};
				return Response.json({ ok: true });
			}
			return Response.json(
				{
					code: "NOT_IMPLEMENTED",
					message: "Not a fixture route",
					retryable: false,
				},
				{ status: 501 },
			);
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
				(await file.text())
					.replace("<head>", "<head>" + sdk)
					.replace("</body>", panel + "</body>"),
				{ headers: { "Content-Type": "text/html" } },
			);
		return new Response(file);
	},
});
console.log(`Playback fixture http://127.0.0.1:${port}/#/calibrate`);
