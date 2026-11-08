import { expect, test } from "bun:test";
import { createSyntheticLibrary } from "./data";
import { buildGraph } from "./graph";
import { geometryKey, filterGraph, ProjectionCache } from "./history";

test("membership, explicit feedback and Undo redraw the same acoustic embedding", () => {
	const library = createSyntheticLibrary(30),
		key = geometryKey(library.tracks),
		cache = new ProjectionCache();
	const graph = buildGraph(library.tracks);
	cache.write(library.mode, key, graph);
	const changed = structuredClone(library);
	changed.tracks[0]!.label = "remove";
	changed.tracks[0]!.isLiked = true; // Teach Remove keeps membership.
	expect(geometryKey(changed.tracks)).toBe(key);
	changed.tracks[0]!.isLiked = false; // Confirmed Review removal.
	expect(cache.read(changed.mode, geometryKey(changed.tracks))).toBe(graph);
	changed.tracks[0]!.label = null;
	changed.tracks[0]!.isLiked = true; // Confirmed Undo.
	expect(cache.read(changed.mode, geometryKey(changed.tracks))).toBe(graph);
	expect(geometryKey([...changed.tracks].reverse())).toBe(key);
	changed.tracks[0]!.audio.energy = 0;
	expect(cache.read(changed.mode, geometryKey(changed.tracks))).toBeNull();
});
test("current view removes historical nodes, neighbors and edges without moving any surviving song", () => {
	const data = createSyntheticLibrary(40);
	data.tracks[0]!.isLiked = false;
	const graph = buildGraph(data.tracks),
		current = filterGraph(graph, data.tracks, "current");
	const ids = new Set(data.tracks.filter((t) => t.isLiked).map((t) => t.id));
	expect(current.nodes.length).toBeLessThan(graph.nodes.length);
	for (const node of current.nodes) {
		const original = graph.nodes.find((n) => n.id === node.id)!;
		expect([node.x, node.y]).toEqual([original.x, original.y]);
		expect(node.neighbors.every((n) => ids.has(n.id))).toBe(true);
	}
	expect(current.edges.every(([a, b]) => ids.has(a) && ids.has(b))).toBe(true);
	expect(filterGraph(graph, data.tracks, "history")).toBe(graph);
	expect(filterGraph(graph, [], "current").nodes).toHaveLength(0);
});
test("cached geometry is scoped by data provenance and can be cleared on account disposal", () => {
	const data = createSyntheticLibrary(10),
		cache = new ProjectionCache(),
		key = geometryKey(data.tracks);
	cache.write("synthetic", key, buildGraph(data.tracks));
	expect(cache.read("live", key)).toBeNull();
	cache.clear();
	expect(cache.read("synthetic", key)).toBeNull();
});
