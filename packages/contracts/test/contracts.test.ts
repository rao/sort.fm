import { describe, expect, test } from "bun:test";
import { AccountSessionSchema, ExposureInputSchema, FeatureVectorSchema, ModelMetricsSchema, PredictionSchema, ReviewRequestSchema, ReviewResultSchema, TrackCardSchema, labelForAction } from "../src/index";
import { demoQueue, demoTracks, emptyMetrics } from "../src/fixtures";
import { UndoCommandInputSchema } from "../src/index";
import { ScoreRequestSchema, TrainingExampleSchema } from "../src/index";

const decision = {trackId: "demo:001", action: "ARCHIVE", exposureId: "00000000-0000-4000-8000-000000000001", idempotencyKey: "00000000-0000-4000-8000-000000000002"};
describe("public review boundary", () => {
  test("requires known action, exposure and UUID idempotency, rejects client-controlled identity", () => {
    expect(ReviewRequestSchema.safeParse(decision).success).toBe(true);
    for (const patch of [{action: "DELETE"}, {action: "UNDO"}, {userId: "victim"}, {idempotencyKey: ""}, {exposureId: undefined}]) {
      expect(ReviewRequestSchema.safeParse({...decision, ...patch}).success).toBe(false);
    }
  });
  test("skip has no supervised label and keep means no removal", () => {
    expect(labelForAction("KEEP")).toBe(0);
    expect(labelForAction("ARCHIVE")).toBe(1);
    expect(labelForAction("UNLIKE")).toBe(1);
    expect(labelForAction("SKIP")).toBeNull();
  });
});
test("synthetic tracks cannot carry a real Spotify URI", () => {
  expect(demoTracks.length).toBeGreaterThanOrEqual(8);
  for (const track of demoTracks) expect(TrackCardSchema.safeParse(track).success).toBe(true);
  expect(TrackCardSchema.safeParse({...demoTracks[0], spotifyUri: "spotify:track:0123456789ABCDEFGHIJKL"}).success).toBe(false);
});
test("untrained demo has no invented probability or evaluation", () => {
  expect(demoQueue.items[0]?.prediction.removalProbability).toBeNull();
  expect(emptyMetrics.status).toBe("insufficient_data");
  expect(ModelMetricsSchema.safeParse({...emptyMetrics, rocAuc: 0.93}).success).toBe(false);
  expect(PredictionSchema.safeParse({...demoQueue.items[0]?.prediction, removalProbability: Number.NaN}).success).toBe(false);
});
test("feature vector rejects unknown keys, infinities and out-of-range audio, retains zero", () => {
  const vector = {featureVersion: "sortfm.features.v1", values: {energy: 0, saved_age_days: null}, provenance: "synthetic", permittedForTraining: true};
  expect(FeatureVectorSchema.parse(vector).values.energy).toBe(0);
  for (const values of [{energy: 1.1}, {energy: Infinity}, {fake_plays: 42}]) expect(FeatureVectorSchema.safeParse({...vector, values}).success).toBe(false);
});
test("public session rejects tokens", () => {
  expect(AccountSessionSchema.safeParse({mode: "anonymous", user: null, capabilities: {spotifyRead: false, spotifyWrite: false, playback: false}, accessToken: "secret"}).success).toBe(false);
});

const completedArchive = {
  ...decision, decisionId: "00000000-0000-4000-8000-000000000003", status: "COMPLETE", mutationStep: "UNLIKED",
  mode: "demo", liked: false, archived: true, canUndo: true, label: 1, labelState: "active", feedbackRevision: 1,
  error: null, createdAt: "2026-11-07T16:00:00.000Z", updatedAt: "2026-11-07T16:00:00.000Z",
};
test("pending review cannot advertise undo and successful removal activates its label", () => {
  expect(ReviewResultSchema.safeParse(completedArchive).success).toBe(true);
  expect(ReviewResultSchema.safeParse({...completedArchive, status: "PENDING", mutationStep: "PENDING", liked: null, archived: null, label: null, labelState: "inactive"}).success).toBe(false);
  expect(ReviewResultSchema.safeParse({...completedArchive, label: null, labelState: "inactive"}).success).toBe(false);
});
test("undo requires confirmed restoration and completed mutation step cannot be reconciling", () => {
  const undone = {...completedArchive, status: "UNDONE", mutationStep: "RESTORED", liked: true, canUndo: false, label: null, labelState: "revoked"};
  expect(ReviewResultSchema.safeParse(undone).success).toBe(true);
  expect(ReviewResultSchema.safeParse({...undone, liked: false}).success).toBe(false);
  expect(ReviewResultSchema.safeParse({...completedArchive, mutationStep: "RECONCILING"}).success).toBe(false);
});
test("stored exposure retains full original prediction and matching feature snapshot", () => {
  const item = demoQueue.items[0]!;
  const input = {userId: "demo:guest", exposure: item.exposure, features: {featureVersion: "sortfm.features.v1", values: {}, provenance: "synthetic", permittedForTraining: true}};
  expect(ExposureInputSchema.safeParse(input).success).toBe(false);
  expect(ExposureInputSchema.safeParse({...input, prediction: item.prediction}).success).toBe(true);
  expect(ExposureInputSchema.safeParse({...input, prediction: {...item.prediction, modelVersion: "new-model"}}).success).toBe(false);
});
test("undo persistence has a separate command identity and stable original target", () => {
  const schema = UndoCommandInputSchema;
  const input = {userId: "demo:guest", commandId: "00000000-0000-4000-8000-000000000004", decisionId: completedArchive.decisionId, request: {idempotencyKey: decision.idempotencyKey}, requestFingerprint: "undo:original-decision", createdAt: completedArchive.createdAt};
  expect(schema.safeParse(input).success).toBe(true);
  expect(schema.safeParse({...input, decisionId: undefined}).success).toBe(false);
  expect(schema.safeParse({...input, request: decision}).success).toBe(false);
});
test("available metrics cannot invent counts or omit calculated measurements", () => {
  const metrics = {...emptyMetrics, status: "available", reason: null, evaluationMethod: "fixed_holdout", labeledExamples: 50, trainedExamples: 30, heldOutExamples: 20, heldOutPositive: 10, heldOutNegative: 10, baseRate: 0.5, balancedAccuracy: 0.6, rocAuc: 0.6, prAuc: 0.6, logLoss: 0.7, brierScore: 0.24, evaluatedAt: "2026-11-07T16:00:00.000Z"};
  expect(ModelMetricsSchema.safeParse(metrics).success).toBe(true);
  expect(ModelMetricsSchema.safeParse({...metrics, labeledExamples: 0}).success).toBe(false);
  expect(ModelMetricsSchema.safeParse({...metrics, baseRate: null, rocAuc: null}).success).toBe(false);
  expect(ModelMetricsSchema.safeParse({...metrics, baseRate: 0.9}).success).toBe(false);
});
test("scoring optionally registers a caller-owned exposure without changing training inputs", () => {
  const candidate = {trackId: "demo:001", features: {featureVersion: "sortfm.features.v1", values: {energy: 0}, provenance: "synthetic", permittedForTraining: true}};
  const request = {userId: "demo:guest", featureVersion: "sortfm.features.v1", modelVersion: null, candidates: [candidate]};
  expect(ScoreRequestSchema.safeParse(request).success).toBe(true);
  expect(ScoreRequestSchema.safeParse({...request, candidates: [{...candidate, exposureId: decision.exposureId}]}).success).toBe(true);
  expect(ScoreRequestSchema.safeParse({...request, candidates: [{...candidate, exposureId: "not-a-uuid"}]}).success).toBe(false);
  expect(TrainingExampleSchema.safeParse({...candidate, decisionId: completedArchive.decisionId, label: 1, split: "train", labeledAt: completedArchive.createdAt, exposureId: decision.exposureId}).success).toBe(false);
});

test('dotted Spotify usernames survive session and internal model boundaries',()=>{
 const session={mode:'spotify',user:{id:'spotify:ram.in',spotifyId:'ram.in',displayName:'Owner',avatarUrl:null},capabilities:{spotifyRead:true,spotifyWrite:false,playback:false}};
 expect(AccountSessionSchema.safeParse(session).success).toBe(true);
 expect(ScoreRequestSchema.safeParse({userId:'spotify:ram.in',featureVersion:'sortfm.features.v1',candidates:[],modelVersion:null}).success).toBe(true);
 for(const id of ['../owner','owner/child','owner\\child','owner?token=secret','owner user']) {
  expect(AccountSessionSchema.safeParse({...session,user:{...session.user,id}}).success).toBe(false);
 }
});
