import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";
import { LabEvidenceSchema } from "./src/data/model-lab";

// Development-only, same-origin loopback reader. Never part of a built site.
export function modelLabDev(): Plugin {
	return {
		name: "local-model-lab",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use("/__local/model-lab", async (req, res) => {
				res.setHeader("Cache-Control", "no-store");
				const remote = req.socket.remoteAddress;
				const origin = req.headers.origin;
				const host = req.headers.host;
				if (
					req.method !== "GET" ||
					!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "") ||
					!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host ?? "") ||
					(origin && origin !== `http://${host}`) ||
					req.headers["sec-fetch-site"] === "cross-site"
				) {
					res.statusCode = 403;
					res.end();
					return;
				}
				try {
					const evidence = LabEvidenceSchema.parse(
						JSON.parse(
							await readFile(
								new URL("./.local/model-lab-evidence.json", import.meta.url),
								"utf8",
							),
						),
					);
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify(evidence));
				} catch {
					res.statusCode = 404;
					res.end();
				}
			});
		},
	};
}
