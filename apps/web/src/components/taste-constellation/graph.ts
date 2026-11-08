import { audioFields, type AudioKey } from "./audio";
import type { Audio } from "./data";

export type GraphInput = { id: string; audio: Audio };
export type Neighbor = { id: string; distance: number; shared: number };
export type GraphNode = {
	id: string;
	x: number;
	y: number;
	observed: number;
	neighbors: Neighbor[];
};
export type Graph = {
	nodes: GraphNode[];
	unplaced: string[];
	edges: [string, string][];
	activeFeatures: AudioKey[];
	minShared: number;
	variance: [number, number];
};

export function sharedDistance(
	a: (number | null)[],
	b: (number | null)[],
	minimum: number,
) {
	let squared = 0,
		shared = 0;
	for (let i = 0; i < a.length; i++) {
		if (a[i] == null || b[i] == null) continue;
		squared += (a[i]! - b[i]!) ** 2;
		shared++;
	}
	return shared >= minimum
		? { distance: Math.sqrt(squared / shared), shared }
		: null;
}

// Jacobi eigendecomposition of a small symmetric covariance matrix. No random
// initialization; fix eigenvector signs for reproducibility. Columns -> vectors.
export function principalComponents(covariance: number[][]) {
	const n = covariance.length;
	const a = covariance.map((row) => [...row]);
	const v: number[][] = Array.from({ length: n }, (_, i) =>
		Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
	);
	for (let step = 0; step < 100 * n * n; step++) {
		let p = 0,
			q = 0,
			largest = 0;
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++) {
				if (Math.abs(a[i]![j]!) > largest) {
					largest = Math.abs(a[i]![j]!);
					p = i;
					q = j;
				}
			}
		if (largest < 1e-10) break;
		const angle = 0.5 * Math.atan2(2 * a[p]![q]!, a[q]![q]! - a[p]![p]!);
		const c = Math.cos(angle),
			s = Math.sin(angle);
		const pp = a[p]![p]!,
			qq = a[q]![q]!,
			pq = a[p]![q]!;
		for (let k = 0; k < n; k++) {
			if (k !== p && k !== q) {
				const kp = a[k]![p]!,
					kq = a[k]![q]!;
				a[k]![p] = a[p]![k] = c * kp - s * kq;
				a[k]![q] = a[q]![k] = s * kp + c * kq;
			}
			const vp = v[k]![p]!,
				vq = v[k]![q]!;
			v[k]![p] = c * vp - s * vq;
			v[k]![q] = s * vp + c * vq;
		}
		a[p]![p] = c * c * pp - 2 * s * c * pq + s * s * qq;
		a[q]![q] = s * s * pp + 2 * s * c * pq + c * c * qq;
		a[p]![q] = a[q]![p] = 0;
	}
	const order = Array.from({ length: n }, (_, i) => i).sort(
		(i, j) => a[j]![j]! - a[i]![i]! || i - j,
	);
	return {
		values: order.map((i) => Math.max(0, a[i]![i]!)),
		vectors: order.map((i) => {
			const vector = v.map((row) => row[i]!);
			const max = vector.reduce(
				(best, x, j) => (Math.abs(x) > Math.abs(vector[best]!) ? j : best),
				0,
			);
			return vector.map((x) => (vector[max]! < 0 ? -x : x));
		}),
	};
}

export function buildGraph(input: readonly GraphInput[]): Graph {
	const tracks = [...input].sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	const stats = audioFields.flatMap(([key]) => {
		const values = tracks
			.map((t) => t.audio[key])
			.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
		if (values.length < 3) return [];
		const mean = values.reduce((sum, x) => sum + x, 0) / values.length;
		const sd = Math.sqrt(
			values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / values.length,
		);
		return sd > 1e-8 ? [{ key, mean, sd }] : [];
	});
	const dim = stats.length,
		minShared = Math.max(3, Math.ceil(dim / 2));
	const graph: Graph = {
		nodes: [],
		unplaced: [],
		edges: [],
		activeFeatures: stats.map((s) => s.key),
		minShared,
		variance: [0, 0],
	};
	const rows: { id: string; vector: (number | null)[]; observed: number }[] =
		[];
	for (const track of tracks) {
		const vector = stats.map(({ key, mean, sd }) => {
			const value = track.audio[key];
			return typeof value === "number" && Number.isFinite(value)
				? (value - mean) / sd
				: null;
		});
		const observed = vector.filter((x) => x !== null).length;
		if (observed < minShared) graph.unplaced.push(track.id);
		else rows.push({ id: track.id, vector, observed });
	}
	if (rows.length < 3) {
		graph.unplaced = tracks.map((t) => t.id);
		return graph;
	}
	// Mean-impute ONLY for PCA; re-center the placed subset. Pairwise distances
	// below retain nulls and never use imputed observations.
	const mean = stats.map(
		(_, j) =>
			rows.reduce((sum, r) => sum + (r.vector[j] ?? 0), 0) / rows.length,
	);
	const matrix = rows.map((r) => r.vector.map((x, j) => (x ?? 0) - mean[j]!));
	const covariance = stats.map((_, i) =>
		stats.map(
			(__, j) =>
				matrix.reduce((sum, r) => sum + r[i]! * r[j]!, 0) / (rows.length - 1),
		),
	);
	const fit = principalComponents(covariance);
	const total = fit.values.reduce((a, b) => a + b, 0);
	if (total < 1e-10) {
		graph.unplaced = tracks.map((t) => t.id);
		return graph;
	}
	graph.variance = [fit.values[0]! / total, fit.values[1]! / total];
	graph.nodes = rows.map((r, i) => ({
		id: r.id,
		observed: r.observed,
		neighbors: [],
		x: matrix[i]!.reduce((sum, x, j) => sum + x * fit.vectors[0]![j]!, 0),
		y: matrix[i]!.reduce((sum, x, j) => sum + x * fit.vectors[1]![j]!, 0),
	}));
	const add = (node: GraphNode, neighbor: Neighbor) => {
		const list = node.neighbors;
		if (list.length === 6 && list[5]!.distance <= neighbor.distance) return;
		const index = list.findIndex(
			(n) =>
				n.distance > neighbor.distance ||
				(n.distance === neighbor.distance && n.id > neighbor.id),
		);
		list.splice(index < 0 ? list.length : index, 0, neighbor);
		if (list.length > 6) list.pop();
	};
	for (let i = 0; i < rows.length; i++)
		for (let j = i + 1; j < rows.length; j++) {
			const distance = sharedDistance(
				rows[i]!.vector,
				rows[j]!.vector,
				minShared,
			);
			if (!distance) continue;
			add(graph.nodes[i]!, { id: rows[j]!.id, ...distance });
			add(graph.nodes[j]!, { id: rows[i]!.id, ...distance });
		}
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	for (const node of graph.nodes)
		for (const neighbor of node.neighbors.slice(0, 3)) {
			if (
				node.id < neighbor.id &&
				byId
					.get(neighbor.id)!
					.neighbors.slice(0, 3)
					.some((n) => n.id === node.id)
			)
				graph.edges.push([node.id, neighbor.id]);
		}
	return graph;
}
