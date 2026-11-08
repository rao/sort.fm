import { expect, test } from "bun:test";
import { buildGraph, sharedDistance, principalComponents } from "./graph";
import { createSyntheticLibrary, parseLibrary } from "./data";

test("adapter fails closed on private/unknown fields, mixed provenance and duplicate identities", () => {
	const fixture = createSyntheticLibrary(20);
	expect(parseLibrary(fixture).ok).toBe(true);
	expect(parseLibrary({ ...fixture, privacy: "holdout" }).ok).toBe(false);
	expect(parseLibrary({ ...fixture, sealedIds: ["private"] }).ok).toBe(false);
	expect(parseLibrary({ ...fixture, mode: "live" }).ok).toBe(false);
	expect(
		parseLibrary({ ...fixture, tracks: [...fixture.tracks, fixture.tracks[0]] })
			.ok,
	).toBe(false);
	const bad = structuredClone(fixture);
	Object.assign(bad.tracks[0]!, { split: "holdout", label: "remove" });
	expect(parseLibrary(bad).ok).toBe(false);
});

test("invalid audio stays unavailable, valid zeros stay observed", () => {
	const data = createSyntheticLibrary(20);
	data.tracks[0]!.audio.energy = 0;
	expect(parseLibrary(data).ok).toBe(true);
	data.tracks[0]!.audio.energy = Number.NaN;
	expect(parseLibrary(data).ok).toBe(false);
});

test("distances require overlap and never turn missing values into observed zeros", () => {
	expect(sharedDistance([0, 1, null], [0, 2, 99], 2)).toEqual({
		distance: Math.sqrt(0.5),
		shared: 2,
	});
	expect(sharedDistance([0, null, null], [0, 2, 99], 2)).toBeNull();
});

test("PCA recovers known covariance eigenvectors and explained variance", () => {
	const fit = principalComponents([
		[2, 1],
		[1, 2],
	]);
	expect(fit.values[0]).toBeCloseTo(3, 8);
	expect(fit.values[1]).toBeCloseTo(1, 8);
	expect(Math.abs(fit.vectors[0]![0]!)).toBeCloseTo(Math.SQRT1_2, 8);
	expect(Math.abs(fit.vectors[0]![1]!)).toBeCloseTo(Math.SQRT1_2, 8);
});

test("projection and nearest neighbors are reproducible, independent of labels and input order", () => {
	const data = createSyntheticLibrary(100);
	const a = buildGraph(data.tracks);
	const b = buildGraph(
		[...data.tracks].reverse().map((t) => ({ ...t, label: "keep" as const })),
	);
	expect(a).toEqual(b);
	expect(
		a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
	).toBe(true);
	expect(a.edges.length).toBeLessThanOrEqual(a.nodes.length * 3);
	expect(
		a.nodes.every(
			(n) => n.neighbors.length <= 6 && n.neighbors.every((v) => v.id !== n.id),
		),
	).toBe(true);
});

test("nearest neighbors rank in full observed feature space and include identical descriptors", () => {
	const data = createSyntheticLibrary(30);
	data.tracks[1]!.audio = { ...data.tracks[0]!.audio };
	const graph = buildGraph(data.tracks);
	const node = graph.nodes.find((n) => n.id === data.tracks[0]!.id)!;
	expect(node.neighbors[0]!.id).toBe(data.tracks[1]!.id);
	expect(node.neighbors[0]!.distance).toBe(0);
});

test("missing and constant descriptors never create decorative positions or edges", () => {
	const data = createSyntheticLibrary(10);
	data.tracks.forEach((t) => {
		t.audio = { energy: 0, danceability: 0, acousticness: 0 };
	});
	const graph = buildGraph(data.tracks);
	expect(graph.nodes).toHaveLength(0);
	expect(graph.unplaced).toHaveLength(10);
	expect(graph.edges).toHaveLength(0);
	expect(buildGraph([]).nodes).toHaveLength(0);
});

test("2700-track fixture yields a bounded sparse graph with missing rows unplaced", () => {
	const data = createSyntheticLibrary(2700);
	const graph = buildGraph(data.tracks);
	expect(graph.nodes.length + graph.unplaced.length).toBe(2700);
	expect(graph.nodes.length).toBeGreaterThan(2600);
	expect(graph.unplaced.length).toBeGreaterThan(0);
	expect(graph.edges.length).toBeLessThanOrEqual(8100);
	expect(graph.variance[0] + graph.variance[1]).toBeLessThanOrEqual(1.000001);
}, 15000);
