import { AccountSessionSchema, CONTRACT_VERSION, DemoBootstrapSchema, FEATURE_VERSION, ModelMetricsSchema, PredictionSchema, QueueResultSchema, TrackCardSchema, type QueuePolicy, type QueueResult } from "./schemas";

// Fictional names and deterministic dates. No real user or provider data.
export const FIXTURE_TIME = "2026-11-07T16:00:00.000Z";
const names = [
  ["After the Rain", "Paper Satellites", "Window Seat"], ["Copper Moon", "The Quiet Circuits", "Night Bus"],
  ["Small Hours", "Mira Field", "Pocket Weather"], ["Blue Arcade", "Soft Geometry", "New Shapes"],
  ["Porch Light", "Sunday Static", "Almost Home"], ["Glass Orchard", "Northbound Echo", "Slow Bloom"],
  ["Half a Summer", "Velvet Transit", "Moving Day"], ["Signal Coast", "Juniper Lines", "Low Tide"],
  ["Two Stops Away", "The Quiet Circuits", "Night Bus"], ["Distant Kitchen", "Mira Field", "Pocket Weather"],
  ["Late Snow", "Paper Satellites", "Window Seat"], ["Amber Room", "Soft Geometry", "New Shapes"],
] as const;
export const demoTracks = names.map(([title, artist, album], i) => TrackCardSchema.parse({
  trackId: `demo:${String(i + 1).padStart(3, "0")}`, source: "synthetic", spotifyUri: null, title,
  artists: [{id: `demo:artist-${artist.toLowerCase().replaceAll(" ", "-")}`, name: artist}], album, imageUrl: null,
  durationMs: 180000 + i * 7000, explicit: false, originalAddedAt: new Date(Date.UTC(2020 + i % 6, i % 12, 7)).toISOString(),
  releaseDate: String(2018 + i % 8), isPlayable: false,
}));
export const emptyMetrics = ModelMetricsSchema.parse({
  status: "insufficient_data", reason: "No labeled feedback has been collected. These are synthetic fixtures, not a trained model.",
  modelVersion: "untrained-v0", dataset: "synthetic", evaluationMethod: "none", labeledExamples: 0, trainedExamples: 0,
  heldOutExamples: 0, heldOutPositive: 0, heldOutNegative: 0, baseRate: null, balancedAccuracy: null,
  rocAuc: null, prAuc: null, logLoss: null, brierScore: null, precisionAtK: null, evaluatedAt: null,
});
export const untrainedPrediction = PredictionSchema.parse({
  modelKind: "untrained", modelVersion: "untrained-v0", featureVersion: FEATURE_VERSION, trainedExamples: 0,
  removalProbability: null, heuristicScore: null, uncertainty: null, uncertaintyMethod: "none", calibrated: false, explanations: [],
});
export const demoSession = AccountSessionSchema.parse({
  mode: "demo", user: {id: "demo:guest", spotifyId: null, displayName: "Demo listener", avatarUrl: null},
  capabilities: {spotifyRead: false, spotifyWrite: false, playback: false},
});
export function createDemoQueue(options: {limit?: number; policy?: QueuePolicy; servedAt?: string; exposureId?: () => string} = {}): QueueResult {
  return QueueResultSchema.parse({
    contractVersion: CONTRACT_VERSION, mode: "demo", remaining: demoTracks.length, nextCursor: null,
    fallbackReason: "Synthetic fixture order. Personalized ranking is not implemented in the foundation.",
    items: demoTracks.slice(0, options.limit ?? 20).map((track, i) => ({track, prediction: untrainedPrediction, exposure: {
      exposureId: options.exposureId?.() ?? `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      trackId: track.trackId, policy: options.policy ?? "balanced", selectionMethod: "fixture", policyVersion: "fixture-v1",
      explorationCoefficient: 0, propensityEstimate: null, modelVersion: "untrained-v0", featureVersion: FEATURE_VERSION,
      removalScore: null, heuristicScore: null, uncertainty: null, position: i, servedAt: options.servedAt ?? FIXTURE_TIME,
    }})),
  });
}
export const demoQueue = createDemoQueue();
export const demoBootstrap = DemoBootstrapSchema.parse({session: demoSession, queue: demoQueue, metrics: emptyMetrics, notice: "Demo mode: fictional songs, no Spotify account or writes. Foundation preview; review actions and model training arrive in the next handoffs."});
