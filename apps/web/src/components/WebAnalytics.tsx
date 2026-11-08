import { Analytics, type BeforeSendEvent } from "@vercel/analytics/react";
import { useSyncExternalStore } from "react";

// Only fixed page names enter analytics; never forward arbitrary URL fragments.
const pagePaths = new Set([
	"/",
	"/library",
	"/calibrate",
	"/calibrate/research",
	"/review",
	"/history",
	"/insights",
	"/model",
	"/dashboard",
]);

export function analyticsPath(hash: string): string {
	const path = hash.slice(1);
	return pagePaths.has(path) ? path : "/";
}

export function sanitizePageview(event: BeforeSendEvent): BeforeSendEvent | null {
	if (event.type !== "pageview") return null;
	try {
		const url = new URL(event.url);
		const path = pagePaths.has(url.pathname) ? url.pathname : "/";
		// OAuth parameters, user-supplied queries, and fragments are never collected.
		return { type: "pageview", url: `${url.origin}${path}` };
	} catch {
		return null;
	}
}

function subscribe(onChange: () => void) {
	window.addEventListener("hashchange", onChange);
	return () => window.removeEventListener("hashchange", onChange);
}

const currentPath = () => analyticsPath(window.location.hash);

export function WebAnalytics() {
	const path = useSyncExternalStore(subscribe, currentPath, () => "/");
	return (
		<Analytics
			mode={import.meta.env.PROD ? "production" : "development"}
			route={path}
			path={path}
			beforeSend={sanitizePageview}
		/>
	);
}
