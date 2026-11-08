import {describe, expect, test} from "bun:test";
import * as contracts from "../src/index";
import {createApiClient} from "../src/client";
import {demoQueue} from "../src/fixtures";

// Authored format-valid placeholder; never sent to a provider.
const trackId = "0000000000000000000000";
const exposureId = "00000000-0000-4000-8000-000000000001";
const idempotencyKey = "00000000-0000-4000-8000-000000000002";
const labelId = "00000000-0000-4000-8000-000000000003";
const timestamp = "2026-11-07T22:00:00.000Z";
const request = {trackId, exposureId, label: 1, idempotencyKey};
const result = {mode: "calibration", labelId, trackId, exposureId, idempotencyKey,
  submittedLabel: 1, label: 1, state: "active", canUndo: true,
  feedbackRevision: 1, createdAt: timestamp, updatedAt: timestamp};
const fixture = demoQueue.items[0]!;
const item = {...fixture, track: {...fixture.track, trackId, source: "spotify", spotifyUri: `spotify:track:${trackId}`},
  exposure: {...fixture.exposure, trackId, exposureId, selectionMethod: "deterministic_baseline", policyVersion: "calibration:metadata-strata:v1"}};
const queue = {contractVersion: contracts.CONTRACT_VERSION, mode: "calibration", items: [item], remaining: 1, nextCursor: null, fallbackReason: null};

describe("calibration boundaries", () => {
  test("exports a separate owner-only calibration surface", () => {
    expect("CalibrationLabelRequestSchema" in contracts).toBe(true);
    expect("CalibrationLabelResultSchema" in contracts).toBe(true);
    expect("CalibrationQueueResultSchema" in contracts).toBe(true);
    expect("CalibrationHistorySchema" in contracts).toBe(true);
    for (const name of ["calibrationQueue", "calibrationLabel", "calibrationUndo", "calibrationHistory"] as const) {
      expect(contracts.PUBLIC_ROUTES[name].auth).toBe("owner");
      expect(contracts.PUBLIC_ROUTES[name].path.startsWith("/api/calibration/")).toBe(true);
    }
  });
  test("accepts only binary human labels on real tracks with UUID command identity", () => {
    for (const label of [0, 1]) expect(contracts.CalibrationLabelRequestSchema.safeParse({...request, label}).success).toBe(true);
    for (const patch of [{label: null}, {label: 2}, {label: "1"}, {trackId: "demo:001"}, {idempotencyKey: "retry"}, {exposureId: "bad"}, {exposureId: undefined}]) {
      expect(contracts.CalibrationLabelRequestSchema.safeParse({...request, ...patch}).success).toBe(false);
    }
  });
  test("rejects client authority over provenance, identities, features and model state", () => {
    for (const patch of [{userId: "other"}, {labelId}, {purpose: "review"}, {mode: "calibration"}, {feedbackRevision: 10},
      {features: {}}, {split: "train"}, {evaluationSeed: 42}, {modelVersion: "new"}, {state: "active"}, {action: "ARCHIVE"}, {liked: false}]) {
      expect(contracts.CalibrationLabelRequestSchema.safeParse({...request, ...patch}).success).toBe(false);
    }
    expect(contracts.PUBLIC_ROUTES.calibrationUndo.body).toBe(contracts.UndoRequestSchema);
    expect(contracts.PUBLIC_ROUTES.calibrationUndo.body.safeParse({idempotencyKey, labelId}).success).toBe(false);
  });
  test("active, revoked and superseded results cannot invent model labels or Spotify effects", () => {
    expect(contracts.CalibrationLabelResultSchema.safeParse(result).success).toBe(true);
    expect(contracts.CalibrationLabelResultSchema.safeParse({...result, canUndo: false}).success).toBe(true);
    for (const state of ["revoked", "superseded"]) {
      expect(contracts.CalibrationLabelResultSchema.safeParse({...result, state, label: null, canUndo: false}).success).toBe(true);
      expect(contracts.CalibrationLabelResultSchema.safeParse({...result, state}).success).toBe(false);
    }
    for (const patch of [{label: null}, {label: 0}, {feedbackRevision: 0}, {liked: true}, {archived: false}, {mode: "spotify"}, {updatedAt: "2026-11-06T22:00:00.000Z"}]) {
      expect(contracts.CalibrationLabelResultSchema.safeParse({...result, ...patch}).success).toBe(false);
    }
  });
  test("calibration queue is distinct from cleanup and excludes synthetic or duplicate identities", () => {
    expect(contracts.CalibrationQueueResultSchema.safeParse(queue).success).toBe(true);
    expect(contracts.QueueResultSchema.safeParse(queue).success).toBe(false);
    for (const patch of [{mode: "spotify"}, {items: [fixture]}, {items: [item, item]}, {remaining: 0}]) {
      expect(contracts.CalibrationQueueResultSchema.safeParse({...queue, ...patch}).success).toBe(false);
    }
    expect(contracts.CalibrationQueueQuerySchema.parse({})).toEqual({limit: 20});
    for (const patch of [{mode: "demo"}, {policy: "balanced"}, {userId: "other"}, {limit: 101}, {limit: 0}]) {
      expect(contracts.CalibrationQueueQuerySchema.safeParse(patch).success).toBe(false);
    }
  });
});

test("browser client keeps calibration commands on their own endpoints and preserves retry keys", async () => {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({url, init});
    return Response.json(url.includes("/queue") ? queue : url.endsWith("/history") ? {items: [result], nextCursor: null} : result);
  }) as typeof fetch;
  const client = createApiClient({baseUrl: "https://api.example.test/", fetch: transport});
  await client.calibrationQueue({limit: 7});
  const parsed = contracts.CalibrationLabelRequestSchema.parse(request);
  await client.calibrationLabel(parsed);
  await client.calibrationLabel(parsed);
  await client.calibrationUndo(labelId, contracts.UndoRequestSchema.parse({idempotencyKey}));
  await client.calibrationHistory();
  expect(calls.map(call => [call.url, call.init?.method])).toEqual([
    ["https://api.example.test/api/calibration/queue?limit=7", "GET"],
    ["https://api.example.test/api/calibration/labels", "POST"],
    ["https://api.example.test/api/calibration/labels", "POST"],
    [`https://api.example.test/api/calibration/labels/${labelId}/undo`, "POST"],
    ["https://api.example.test/api/calibration/history", "GET"],
  ]);
  for (const call of calls) expect(call.init?.credentials).toBe("include");
  expect(JSON.parse(calls[1]!.init!.body as string)).toEqual(request);
  expect(calls[2]!.init!.body).toBe(calls[1]!.init!.body);
  expect(JSON.parse(calls[3]!.init!.body as string)).toEqual({idempotencyKey});
  expect(() => client.calibrationLabel({...parsed, userId: "other"} as typeof parsed)).toThrow();
  expect(() => client.calibrationUndo("../decisions", contracts.UndoRequestSchema.parse({idempotencyKey}))).toThrow();
  expect(calls).toHaveLength(5);
});

test("browser client rejects a cleanup result returned from a calibration endpoint", async () => {
  const client = createApiClient({fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({...result, liked: true})) as typeof fetch});
  await expect(client.calibrationLabel(contracts.CalibrationLabelRequestSchema.parse(request))).rejects.toMatchObject({status: 502, error: {code: "INVALID_API_RESPONSE"}});
});
