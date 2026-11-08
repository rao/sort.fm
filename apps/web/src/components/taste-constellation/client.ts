import { parseLibrary, type Library } from "./data";

export class ConstellationError extends Error {
	constructor(public kind: "auth" | "unavailable" | "invalid" | "network") {
		super(
			{
				auth: "Connect your Spotify account to view your library.",
				unavailable:
					"Your library map is not available yet. Try again after the read-only graph service is connected.",
				invalid:
					"The graph response could not be verified. No library data was displayed.",
				network: "The library map could not be loaded. Please try again.",
			}[kind],
		);
	}
}

// Integration-owned proposed read-only route. Never fall back to queue,
// calibration, research exports or synthetic data on failure.
export async function loadLibrary(options: {
	signal: AbortSignal;
	baseUrl?: string;
	transport?: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<Library> {
	try {
		const response = await (options.transport ?? fetch)(
			`${(options.baseUrl ?? "").trim().replace(/\/$/, "")}/api/ml/constellation/history`,
			{
				method: "GET",
				credentials: "include",
				cache: "no-store",
				redirect: "error",
				signal: options.signal,
				headers: { Accept: "application/json" },
			},
		);
		if (response.status === 401 || response.status === 403)
			throw new ConstellationError("auth");
		if ([404, 501, 503].includes(response.status))
			throw new ConstellationError("unavailable");
		if (!response.ok) throw new ConstellationError("network");
		const result = parseLibrary(await response.json());
		if (!result.ok || result.data.mode !== "live")
			throw new ConstellationError("invalid");
		return result.data;
	} catch (error) {
		if (options.signal.aborted) throw error;
		throw error instanceof ConstellationError
			? error
			: new ConstellationError("network");
	}
}
