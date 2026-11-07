import {z, ZodError} from 'zod';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {AccountSessionSchema, LibraryImportStatusSchema, LibrarySummarySchema, PUBLIC_ROUTES} from '@sortfm/contracts';
import type {A1Store, Account} from './store';
import type {SpotifyConfig} from './config';
import {AuthService} from './service';
import {SpotifyHttp} from '../spotify/http';
import {SpotifyClient} from '../spotify/client';
import {authenticationRequired, safeError, SpotifyError} from '../spotify/errors';
import {LibraryImporter} from '../library/importer';

function cookieValue(request: FastifyRequest, name: string) {
  const cookies = (request.headers.cookie ?? '').split(';').map(part => part.trim());
  const matches = cookies.filter(part => part.slice(0, part.indexOf('=')) === name);
  if (matches.length !== 1) return undefined;
  try {return decodeURIComponent(matches[0]!.slice(name.length + 1));} catch {return undefined;}
}

/** Instantiate once per API process. D supplies the production store. No memory fallback. */
export function createSpotifyModule(options: {config: SpotifyConfig; store: A1Store; http?: SpotifyHttp}) {
  const {config, store} = options;
  const http = options.http ?? new SpotifyHttp({timeoutMs:config.requestTimeoutMs});
  const auth = new AuthService(config, store, http);
  const client = new SpotifyClient(auth, http);
  const importer = new LibraryImporter(store, client, {now:http.now});
  const sessionName = config.secureCookies ? '__Host-sortfm_session' : 'sortfm_session';
  const oauthName = config.secureCookies ? '__Host-sortfm_oauth' : 'sortfm_oauth';
  const cookie = (name: string, value: string, maxAge: number) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secureCookies ? '; Secure' : ''}`;
  const sessionToken = (req: FastifyRequest) => cookieValue(req, sessionName);
  async function owner(req: FastifyRequest): Promise<Account> {const account = await auth.session(sessionToken(req)); if (!account) throw authenticationRequired(); return account;}
  function csrf(req: FastifyRequest) {
    if (!req.headers.origin || ![config.webOrigin, config.apiOrigin].includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new SpotifyError('CSRF_REJECTED', 'This request must originate from sort.fm.', 403);
  }
  const empty = z.strictObject({});
  function noInput(req: FastifyRequest, body = false) {empty.parse(req.query); if (body) empty.parse(req.body ?? {});}
  type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  function safe(handler: Handler): Handler {
    return async (request, reply) => {
      reply.header('Cache-Control', 'no-store'); reply.header('Referrer-Policy', 'no-referrer'); reply.header('X-Content-Type-Options', 'nosniff');
      try {
        if (request.headers.origin && ![config.webOrigin, config.apiOrigin].includes(request.headers.origin)) throw new SpotifyError('ORIGIN_NOT_ALLOWED', 'Origin is not allowed.', 403);
        return await handler(request, reply);
      } catch (error) {
        const safe = error instanceof ZodError ? new SpotifyError('VALIDATION_ERROR', 'Request does not match the shared contract.', 400) : safeError(error);
        if (safe.retryAt) reply.header('Retry-After', String(Math.max(1, Math.ceil((safe.retryAt - http.now()) / 1000))));
        if (!(error instanceof SpotifyError) && !(error instanceof ZodError)) request.log.error({code:safe.code}, 'A1 operation failed');
        return reply.code(safe.statusCode).send(safe.envelope());
      }
    };
  }
  const registerRoutes = async (app: FastifyInstance) => {
    app.get(PUBLIC_ROUTES.authStart.path, safe(async (req, reply) => {
      noInput(req);
      const start = await auth.start();
      reply.header('Set-Cookie', cookie(oauthName, start.browserToken, config.oauthTtlMs / 1000));
      return reply.redirect(start.url);
    }));
    app.get(PUBLIC_ROUTES.authCallback.path, safe(async (req, reply) => {
      reply.header('Set-Cookie', cookie(oauthName, '', 0));
      const query = z.strictObject({state:z.string().max(128).optional(), code:z.string().max(4096).optional(), error:z.string().max(256).optional()}).parse(req.query);
      const result = await auth.callback(query, cookieValue(req, oauthName));
      reply.header('Set-Cookie', [cookie(oauthName, '', 0), cookie(sessionName, result.sessionToken, config.sessionTtlMs / 1000)]);
      return reply.redirect(config.webOrigin);
    }));
    app.post(PUBLIC_ROUTES.logout.path, safe(async (req, reply) => {
      csrf(req); noInput(req, true); await owner(req); await auth.logout(sessionToken(req));
      reply.header('Set-Cookie', cookie(sessionName, '', 0)); return {ok:true};
    }));
    app.get(PUBLIC_ROUTES.me.path, safe(async (req) => {noInput(req); return AccountSessionSchema.parse(auth.publicSession(await auth.session(sessionToken(req))));}));
    app.post(PUBLIC_ROUTES.sync.path, safe(async (req, reply) => {
      csrf(req); noInput(req, true); const account = await owner(req);
      const progress = await importer.requestSync(account.user.id);
      importer.kick(account.user.id);
      return reply.code(202).send(LibraryImportStatusSchema.parse(progress));
    }));
    app.get(PUBLIC_ROUTES.syncStatus.path, safe(async req => {noInput(req); const account = await owner(req); return importer.status(account.user.id);}));
    app.get(PUBLIC_ROUTES.librarySummary.path, safe(async req => {noInput(req); const account = await owner(req); return LibrarySummarySchema.parse(await importer.summary(account.user.id));}));
    app.addHook('onReady', async () => {importer.start();});
    app.addHook('onClose', async () => {await importer.close();});
  };
  return {registerRoutes, auth, client, importer};
}
