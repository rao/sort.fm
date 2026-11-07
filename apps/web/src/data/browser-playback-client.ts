import type { AccountSession } from "@sortfm/contracts";
import type { LiveApi } from "./live-client";

// No cleanup capability or library credential is used by this boundary.
export function createBrowserPlaybackClient(
	api: LiveApi,
	session: AccountSession,
) {
	const ownerId = session.user?.id;
	if (session.mode !== "spotify" || !ownerId)
		throw new Error("Connect Spotify before playback.");
	async function authorize() {
		const current = await api.session();
		if (current.mode !== "spotify" || current.user?.id !== ownerId)
			throw new Error("Your account changed. Reconnect playback.");
	}
	return {
		authorize,
		async token() {
			await authorize();
			const result = await api.playbackToken(ownerId);
			await authorize();
			if (Date.parse(result.expiresAt) <= Date.now())
				throw new Error("Playback authorization expired. Reconnect playback.");
			return result.accessToken;
		},
		async play(trackUri: string, deviceId: string, isCurrent = () => true) {
			await authorize();
			// The card or owning player can change while the session check is pending.
			if (!isCurrent()) return;
			await api.playOnDevice({ trackUri, deviceId });
			await authorize();
		},
		async connection() {
			await authorize();
			const result = await api.playbackConnection();
			await authorize();
			return result;
		},
		async connect(returnTo: "review" | "calibration") {
			await authorize();
			const result = await api.connectPlayback({ returnTo });
			await authorize();
			return result.authorizationUrl;
		},
	};
}
