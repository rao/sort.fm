import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ConstellationExplorer,
	TrackDetails,
	TasteConstellation,
} from "./TasteConstellation";
import { ConstellationCanvas } from "./ConstellationCanvas";
import { buildGraph } from "./graph";
import {
	ModelGuide,
	MetricGuide,
	EvidenceGuide,
	FeedbackComparison,
	PolicySelection,
} from "./LabExplanations";
import { createSyntheticLibrary } from "./data";
import { demoQueue } from "@sortfm/contracts/fixtures";

test("the expandable map keeps one accessible canvas and a named dialog trigger", () => {
	const library = createSyntheticLibrary(8);
	const graph = buildGraph(library.tracks.map((track) => ({
		id: track.id,
		audio: track.audio,
	})));
	const html = renderToStaticMarkup(
		<ConstellationExplorer source={library.mode}>
			<ConstellationCanvas
				graph={graph}
				visibleGraph={graph}
				tracks={new Map(library.tracks.map((track) => [track.id, track]))}
				selected={null}
				onSelect={() => {}}
			/>
		</ConstellationExplorer>,
	);
	expect(html.match(/<canvas\b/g)).toHaveLength(1);
	expect(html).toContain('aria-label="Interactive acoustic constellation"');
	expect(html).toContain('aria-haspopup="dialog"');
	expect(html).toContain('aria-expanded="false"');
	expect(html).toContain("Expand map");
	expect(html).toContain('aria-label="Close expanded map"');
	const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
	expect(controls).toBeDefined();
	expect(html).toContain(`id="${controls}"`);
	expect(html).toContain('<dialog');
	expect(html).toContain('aria-label="Taste constellation map"');
	expect(html).not.toContain('aria-modal="true"');
});

test.each([
	["synthetic", "SYNTHETIC DEMO · NOT YOUR LIBRARY", "YOUR LIBRARY · READ ONLY"],
	["live", "YOUR LIBRARY · READ ONLY", "SYNTHETIC DEMO · NOT YOUR LIBRARY"],
] as const)(
	"the expanded map identifies its %s source inside the dialog",
	(source, label, otherLabel) => {
		const html = renderToStaticMarkup(
			<ConstellationExplorer source={source}>
				<span>Map content</span>
			</ConstellationExplorer>,
		);
		const dialog = html.slice(html.indexOf("<dialog"), html.indexOf("</dialog>"));
		expect(dialog).toContain(label);
		expect(dialog).not.toContain(otherLabel);
	},
);

test("real data is the initial path and demo requires an explicit choice", () => {
	const disconnected = renderToStaticMarkup(
		<TasteConstellation connected={false} />,
	);
	expect(disconnected).toContain("Your library belongs here");
	expect(disconnected).toContain("Explore synthetic demo");
	expect(disconnected).not.toContain("Velvet Circuit");
	const connected = renderToStaticMarkup(<TasteConstellation connected />);
	expect(connected).toContain("Loading your library");
	expect(connected).not.toContain("SYNTHETIC DEMO · NOT YOUR LIBRARY");
});

test("details preserve zero observations, missing values and score version attribution", () => {
	const library = createSyntheticLibrary(1);
	library.mode = "live";
	library.modelVersion = "current-c1";
	const track = library.tracks[0]!;
	track.audio.energy = 0;
	track.audio.happiness = null;
	track.prediction = {
		modelVersion: "old-c1",
		scoredAt: "2026-11-08T00:00:00Z",
		removalProbability: 0,
		calibrated: false,
		explanations: [
			{
				feature: "energy",
				contribution: 0,
				description: "Recorded zero contribution.",
			},
		],
	};
	const render = () =>
		renderToStaticMarkup(
			<TrackDetails
				track={track}
				library={library}
				node={undefined}
				tracks={new Map([[track.id, track]])}
				onSelect={() => {}}
				onClose={() => {}}
			/>,
		);
	const stored = render();
	expect(stored).toContain("0.00");
	expect(stored).toContain("Unavailable");
	expect(stored).toContain("0.0%");
	expect(stored).toContain("Stored prediction · current version not confirmed");
	expect(stored).toContain("No comparable neighbors available");
	track.prediction.modelVersion = "current-c1";
	expect(render()).toContain("Current C1 removal estimate");
	track.prediction = null;
	expect(render()).toContain("No current score supplied");
});

test("model and metric guides distinguish missing listening data and evidence types", () => {
	const html = renderToStaticMarkup(
		<>
			<ModelGuide />
			<MetricGuide />
			<EvidenceGuide />
		</>,
	);
	for (const text of [
		"E1",
		"E2",
		"E3",
		"C1",
		"C2",
		"All listening fields were missing",
		"Cross-validation",
		"Frozen holdout",
		"Synthetic simulation",
		"Live behavior",
		"Brier",
		"Log loss",
		"Average precision",
		"training variation",
	])
		expect(html).toContain(text);
});

test("feedback plot uses supplied paired probabilities and no track identities or labels", () => {
	const html = renderToStaticMarkup(
		<FeedbackComparison
			selected={0}
			onSelect={() => {}}
			feedback={{
				beforeTrain: 52,
				afterTrain: 159,
				sample: 1,
				meanAbsoluteChange: 0.2,
				cases: [{ alias: "A01", before: 0.2, after: 0.4 }],
				explanation: {
					alias: "A01",
					interceptBefore: 0,
					interceptAfter: 0,
					terms: [],
				},
			}}
		/>,
	);
	expect(html).toContain("20.0% before, 40.0% after");
	expect(html).toContain("52");
	expect(html).toContain("159");
	expect(html).toContain("no live training");
	expect(html).toContain("not evidence of improved generalization");
});

test("policy visualization has no fallback inference or fabricated telemetry", () => {
	expect(renderToStaticMarkup(<PolicySelection item={undefined} />)).toBe("");
	expect(
		renderToStaticMarkup(<PolicySelection item={demoQueue.items[0]} />),
	).toBe("");
});
