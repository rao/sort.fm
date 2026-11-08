import { z } from "zod";

const origin = z.url({protocol: /^https?$/}).refine(value => {
  const url = new URL(value);
  return url.origin === value && !url.username && !url.password;
}, "Expected a plain HTTP(S) origin without path, credentials, or trailing slash");
export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const mode = z.enum(["development", "test", "production"]).parse(env.NODE_ENV ?? "development");
  const webOrigin = origin.parse(env.PUBLIC_WEB_ORIGIN ?? (mode === "production" ? "https://sort.fm" : "http://127.0.0.1:5173"));
  const apiOrigin = origin.parse(env.PUBLIC_API_ORIGIN ?? (mode === "production" ? "https://api.sort.fm" : "http://127.0.0.1:3001"));
  if (mode === "production" && (!webOrigin.startsWith("https://") || !apiOrigin.startsWith("https://"))) throw new Error("Production origins must use HTTPS");
  const c2PolicyEnabled=z.enum(['true','false']).parse(env.C2_POLICY_ENABLED??'false')==='true';
  const reviewSelectionPolicy=z.enum(['c1','epsilon_greedy','linucb']).parse(env.REVIEW_SELECTION_POLICY??'c1');
  return {
    mode, webOrigin, apiOrigin,
    c2PolicyEnabled,reviewSelectionPolicy,
    effectiveReviewSelectionPolicy:c2PolicyEnabled?reviewSelectionPolicy:'c1' as const,
    host: env.HOST ?? (mode === "production" ? "0.0.0.0" : "127.0.0.1"),
    port: z.coerce.number().int().min(0).max(65535).parse(env.PORT ?? "3001"),
    demoEnabled: z.enum(["true", "false"]).parse(env.DEMO_MODE_ENABLED ?? "true") === "true",
  };
}
export type ApiConfig = ReturnType<typeof loadConfig>;
