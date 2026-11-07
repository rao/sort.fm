import { useEffect, useState } from "react";
import type { DemoBootstrap, QueueResult } from "@sortfm/contracts";
import type { createApiClient } from "@sortfm/contracts/client";

type DemoContentProps = Pick<DemoBootstrap, "metrics" | "notice"> & { queue: QueueResult };
type ApiClient = Pick<ReturnType<typeof createApiClient>, "demoBootstrap" | "queue">;

export function DemoContent({ queue, metrics, notice }: DemoContentProps) {
  return (
    <>
      <section aria-labelledby="demo-heading" className="notice">
        <h2 id="demo-heading">Synthetic demo</h2>
        <p>{notice}</p>
      </section>

      <section aria-labelledby="queue-heading">
        <h2 id="queue-heading">Demo queue</h2>
        {queue.fallbackReason && <p className="muted">{queue.fallbackReason}</p>}
        {queue.items.length === 0 ? (
          <p>No demo tracks are available. Try loading the queue again.</p>
        ) : (
          <ol className="track-list">
            {queue.items.map(({ track }) => (
              <li key={track.trackId}>
                <article aria-labelledby={`title-${track.trackId}`}>
                  <h3 id={`title-${track.trackId}`}>{track.title}</h3>
                  <p>{track.artists.map((artist) => artist.name).join(", ")}</p>
                  <p>
                    Saved: <time dateTime={track.originalAddedAt}>{new Date(track.originalAddedAt).toUTCString()}</time>
                  </p>
                  <p className="muted">{track.source === "synthetic" ? "Synthetic track" : "Spotify track"}</p>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="model-heading">
        <h2 id="model-heading">Model status</h2>
        <p>{metrics.status === "available" ? "Evaluation supplied by API" : "Evaluation unavailable"}</p>
        {metrics.reason && <p>{metrics.reason}</p>}
        <p className="muted">Model: {metrics.modelVersion}. Dataset: {metrics.dataset}.</p>
      </section>
    </>
  );
}

export default function App({ client }: { client: ApiClient }) {
  const [bootstrap, setBootstrap] = useState<DemoBootstrap | null>(null);
  const [queue, setQueue] = useState<QueueResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupAttempt, setSetupAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    client.demoBootstrap()
      .then((data) => {
        if (!active) return;
        setBootstrap(data);
        setQueue(data.queue);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "The demo could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, setupAttempt]);

  async function loadQueue() {
    setLoading(true);
    setError(null);
    try {
      setQueue(await client.queue({ mode: "demo", limit: 20, policy: "balanced" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The demo queue could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header>
        <p className="muted">Foundation mode · Task 00</p>
        <h1>sort.fm</h1>
        <p>A foundation preview with fictional songs and saved dates. Spotify actions and model training are not enabled.</p>
      </header>

      <p role="status" aria-live="polite">
        {loading ? "Loading synthetic demo data…" : queue ? `${queue.items.length} demo tracks loaded.` : "Demo setup is unavailable."}
      </p>
      {error && <p role="alert" className="error">{error}</p>}
      <p>
        <button
          type="button"
          disabled={loading}
          onClick={bootstrap ? loadQueue : () => setSetupAttempt((attempt) => attempt + 1)}
        >
          {loading ? "Loading demo…" : bootstrap ? "Load demo queue" : "Retry demo setup"}
        </button>
      </p>

      {bootstrap && queue && <DemoContent queue={queue} metrics={bootstrap.metrics} notice={bootstrap.notice} />}
    </main>
  );
}
