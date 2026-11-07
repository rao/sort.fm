import Fastify, {type FastifyInstance} from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { AccountSessionSchema, CONTRACT_VERSION, DemoBootstrapSchema, ErrorEnvelopeSchema, PUBLIC_ROUTES, QueueQuerySchema, UuidSchema } from "@sortfm/contracts";
import { createDemoQueue, demoBootstrap } from "@sortfm/contracts/fixtures";
import { loadConfig, type ApiConfig } from "./config";

export async function buildApp(options: {config?: ApiConfig; logger?: boolean; registerRoutes?: (app: FastifyInstance) => void | Promise<void>} = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: options.logger ? {
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
      serializers: {req: (req) => ({method: req.method, url: String(req.url).split("?")[0], id: req.id})},
    } : false,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({code: "VALIDATION_ERROR", message: "Request does not match the shared contract.", retryable: false});
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({code: "BAD_REQUEST", message: "Invalid request.", retryable: false});
    app.log.error({code: "INTERNAL_ERROR"}, "Unhandled request error");
    return reply.code(500).send({code: "INTERNAL_ERROR", message: "An internal error occurred.", retryable: true});
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({code: "NOT_FOUND", message: "Route not found.", retryable: false}));
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const origin = request.headers.origin;
    if (origin && origin !== config.webOrigin && origin !== config.apiOrigin) return reply.code(403).send({code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed.", retryable: false});
  });
  await app.register(cors, {origin: [config.webOrigin, config.apiOrigin], credentials: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Accept"]});

  app.get(PUBLIC_ROUTES.health.path, async () => PUBLIC_ROUTES.health.response.parse({status: "ok", service: "api", contractVersion: CONTRACT_VERSION, capabilities: {demo: config.demoEnabled, spotify: false, database: false, ml: false}}));
  app.get(PUBLIC_ROUTES.me.path, async () => AccountSessionSchema.parse({mode: "anonymous", user: null, capabilities: {spotifyRead: false, spotifyWrite: false, playback: false}}));
  app.get(PUBLIC_ROUTES.demoBootstrap.path, async (_request, reply) => {
    if (!config.demoEnabled) return reply.code(404).send({code: "DEMO_DISABLED", message: "Demo mode is disabled.", retryable: false});
    return DemoBootstrapSchema.parse({...demoBootstrap, queue: createDemoQueue({servedAt: new Date().toISOString(), exposureId: () => crypto.randomUUID()})});
  });
  app.get(PUBLIC_ROUTES.queue.path, async (request, reply) => {
    const query = QueueQuerySchema.parse(request.query);
    if (query.mode !== "demo") return reply.code(401).send({code: "AUTHENTICATION_REQUIRED", message: "Connect an authorized account, or explicitly request demo mode.", retryable: false});
    if (!config.demoEnabled) return reply.code(404).send({code: "DEMO_DISABLED", message: "Demo mode is disabled.", retryable: false});
    return createDemoQueue({...query, servedAt: new Date().toISOString(), exposureId: () => crypto.randomUUID()});
  });

  // A/B/C/D can register their modules here; unowned features remain explicit 501s.
  await options.registerRoutes?.(app);
  for (const route of Object.values(PUBLIC_ROUTES)) {
    if (app.hasRoute({method: route.method, url: route.path})) continue;
    app.route({method: route.method, url: route.path, handler: async (request, reply) => {
      if ("body" in route) route.body.parse(request.body);
      if (route.path === PUBLIC_ROUTES.undo.path) UuidSchema.parse((request.params as {id: string}).id);
      return reply.code(501).send(ErrorEnvelopeSchema.parse({code: "NOT_IMPLEMENTED", message: "This capability is not implemented in the foundation. No changes were made.", retryable: false}));
    }});
  }
  await app.ready();
  return app;
}
