import { buildGraph, type GraphInput } from "./graph";

self.onmessage = (event: MessageEvent<GraphInput[]>) => {
	try {
		self.postMessage({ ok: true, graph: buildGraph(event.data) });
	} catch {
		self.postMessage({ ok: false });
	}
};
