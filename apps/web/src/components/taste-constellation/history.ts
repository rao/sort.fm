import { audioFields } from "./audio";
import type { Library, Track } from "./data";
import type { Graph } from "./graph";
export type MusicView = "history" | "current";
// No feedback, membership, titles, model scores or timestamps enter the key.
export function geometryKey(tracks: Track[]) {
	return JSON.stringify(
		[...tracks]
			.sort((a, b) => a.id.localeCompare(b.id, "en"))
			.map((t) => ({
				id: t.id,
				audio: Object.fromEntries(
					audioFields.map(([key]) => [key, t.audio[key] ?? null]),
				),
			})),
	);
}
export class ProjectionCache {
	private entries = new Map<Library["mode"], { key: string; graph: Graph }>();
	read(mode: Library["mode"], key: string) {
		const entry = this.entries.get(mode);
		return entry?.key === key ? entry.graph : null;
	}
	write(mode: Library["mode"], key: string, graph: Graph) {
		this.entries.set(mode, { key, graph });
	}
	clear() {
		this.entries.clear();
	}
}
export function filterGraph(
	graph: Graph,
	tracks: Track[],
	view: MusicView,
): Graph {
	if (view === "history") return graph;
	const visible = new Set(tracks.filter((t) => t.isLiked).map((t) => t.id));
	return {
		...graph,
		nodes: graph.nodes
			.filter((n) => visible.has(n.id))
			.map((n) => ({
				...n,
				neighbors: n.neighbors.filter((other) => visible.has(other.id)),
			})),
		edges: graph.edges.filter(([a, b]) => visible.has(a) && visible.has(b)),
		unplaced: graph.unplaced.filter((id) => visible.has(id)),
	};
}
