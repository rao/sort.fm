import {z} from 'zod';
import {LibraryImportStatusSchema, SavedTrackInputSchema, SpotifyTrackIdSchema, TimestampSchema, type LibraryImportStatus, type SavedTrackInput} from '@sortfm/contracts';
import type {A1Store, ImportJob, ImportObservation, TasteContext} from '../auth/store';
import {digest} from '../auth/crypto';
import {safeError, SpotifyError} from '../spotify/errors';
import {normalizeSavedTrack} from './normalize';

const pageSchema = z.object({items:z.array(z.unknown()).max(50), total:z.number().int().min(0).max(1_000_000), offset:z.number().int().nonnegative(), limit:z.number().int().min(1).max(50), next:z.string().nullable()});
const recentSchema = z.object({items:z.array(z.object({track:z.object({id:SpotifyTrackIdSchema}).nullable(), played_at:TimestampSchema})).max(50)});
export interface LibraryReader {get(userId: string, path: string): Promise<unknown>}
const idle = (): LibraryImportStatus => ({jobId:null, status:'idle', processed:0, total:null, failed:0, nextOffset:0, updatedAt:null, error:null});
const changed = () => new SpotifyError('LIBRARY_CHANGED', 'Liked Songs changed during pagination or returned inconsistent pages. Retry to reconcile the library.', 409, true);


export class LibraryImporter {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly running = new Map<string, Promise<void>>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(readonly store: A1Store, private readonly reader: LibraryReader, options: {now?: () => number; leaseDurationMs?: number; onError?: (error: SpotifyError) => void} = {}) {this.now = options.now ?? Date.now; this.leaseMs = options.leaseDurationMs ?? 300_000; if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 100) throw new Error("Import lease must be at least 100ms"); this.onError = options.onError ?? (() => {});}
  private readonly onError: (error: SpotifyError) => void;
  private timestamp() {return new Date(this.now()).toISOString();}
  async status(userId: string) {return LibraryImportStatusSchema.parse(await this.store.transaction(async tx => (await tx.getJob(userId))?.progress ?? idle()));}
  async summary(userId: string) {return this.store.transaction(tx => tx.getSummary(userId));}
  async requestSync(userId: string): Promise<LibraryImportStatus> {
    return this.store.transaction(async tx => {
      const existing = await tx.getJob(userId);
      if (existing && (existing.progress.status === 'pending' || existing.progress.status === 'running' || (existing.retryAt ?? 0) > this.now())) return existing.progress;
      if (existing && existing.progress.status === 'failed') {
        existing.progress = {...existing.progress, status:'pending', error:null, updatedAt:this.timestamp()};
        existing.lease = null; existing.retryAt = null; existing.restarts = 0;
        await tx.putJob(existing); return existing.progress;
      }
      const job: ImportJob = {userId, progress:{...idle(), jobId:crypto.randomUUID(), status:'pending', updatedAt:this.timestamp()}, lease:null, retryAt:null, restart:false, restarts:0, pass:0, seenIds:[], rejected:0, duplicates:0, firstPageHash:null, sourceTotal:null, membershipRevision:null};
      await tx.putJob(job); return job.progress;
    });
  }
  /** Called on startup and periodically; GET status/summary never schedules imports. */
  async recover() {
    if (this.closing) return;
    for (const userId of await this.store.resumableUserIds()) this.kick(userId);
  }
  start() {
    if (this.recoveryTimer || this.closing) return;
    this.recoveryTimer = setInterval(() => {void this.recover().catch(error => this.onError(safeError(error)));}, 30_000);
    this.recoveryTimer.unref();
    void this.recover().catch(error => this.onError(safeError(error)));
  }
  kick(userId: string) {
    if (this.closing || this.running.has(userId)) return;
    const task = this.run(userId).catch(error => this.onError(safeError(error))).finally(() => this.running.delete(userId));
    this.running.set(userId, task);
  }
  async close() {
    this.closing = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await Promise.all(this.running.values());
  }
  async run(userId: string) {
    const leaseId = crypto.randomUUID();
    let job = await this.store.transaction(async tx => {
      const row = await tx.getJob(userId);
      if (!row || row.progress.status === 'complete' || (row.retryAt ?? 0) > this.now() || (row.lease && row.lease.until > this.now()) || (row.progress.status === 'failed' && !row.progress.error?.retryable)) return null;
      if (row.progress.status === 'failed') row.restarts = 0;
      const revision = await tx.getMembershipRevision(userId);
      // A resumed scan cannot reuse pages collected before a review/Undo changed
      // membership. Legacy jobs have no baseline and must discard partial pages.
      if (row.membershipRevision !== revision && (row.membershipRevision != null || row.progress.nextOffset > 0 || row.seenIds.length > 0)) {
        row.pass++; row.seenIds=[]; row.rejected=0; row.duplicates=0;
        row.firstPageHash=null; row.sourceTotal=null; row.restart=false;
        row.progress={...row.progress,processed:0,failed:0,nextOffset:0,total:null};
      }
      row.membershipRevision = revision;
      row.lease = {id:leaseId, until:this.now() + this.leaseMs};
      row.progress = {...row.progress, status:'running', error:null, updatedAt:this.timestamp()};
      await tx.putJob(row); return row;
    });
    if (!job) return;
    // Keep a live worker's lease through long 429/401 recovery and optional context.
    // A paused/crashed worker cannot resurrect a lease that already expired or moved.
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.store.transaction(async tx => {
        const current = await tx.getJob(userId);
        if (current?.progress.jobId === job!.progress.jobId && current.lease?.id === leaseId && current.lease.until > this.now()) {
          await tx.putJob({...current, lease:{id:leaseId, until:this.now() + this.leaseMs}});
        }
      }).catch(error => this.onError(safeError(error))).finally(() => {renewing = false;});
    }, Math.min(30_000, Math.floor(this.leaseMs / 5)));
    heartbeat.unref();
    try {
      // Spotify provides offsets, not immutable snapshots. Check the head before resuming.
      if (job.progress.nextOffset > 0 && !job.restart) {
        const first = await this.page(userId, 0);
        if (job.firstPageHash !== this.fingerprint(first)) job = await this.restart(job, leaseId);
      }
      if (job.restart) job = await this.restart(job, leaseId);
      for (;;) {
        if (this.closing) {await this.release(job, leaseId); return;}
        const offset = job.progress.nextOffset;
        const page = await this.page(userId, offset);
        if (job.sourceTotal !== null && page.total !== job.sourceTotal) {job = await this.restart(job, leaseId); continue;}
        if (page.items.length === 0 && offset < page.total) throw changed();
        if (offset + page.items.length > page.total || (page.next === null && offset + page.items.length < page.total)) throw changed();
        const seen = new Set(job.seenIds), rows: SavedTrackInput[] = [], observations: ImportObservation[] = [];
        let rejected = job.rejected, duplicates = job.duplicates;
        for (let i = 0; i < page.items.length; i++) {
          const raw = page.items[i], normalized = normalizeSavedTrack(raw);
          observations.push({userId, jobId:job.progress.jobId!, pass:job.pass, offset:offset+i, raw, reason:normalized.reason, trackId:normalized.track?.trackId ?? null, observedAt:this.timestamp()});
          if (!normalized.track) {rejected++; continue;}
          if (seen.has(normalized.track.trackId)) duplicates++; else seen.add(normalized.track.trackId);
          rows.push(SavedTrackInputSchema.parse({userId, track:normalized.track, originalAddedAt:normalized.track.originalAddedAt, syncedAt:this.timestamp(), currentStatus:'saved'}));
        }
        const next: ImportJob = {...job, seenIds:[...seen], rejected, duplicates, sourceTotal:page.total, firstPageHash:offset === 0 ? this.fingerprint(page) : job.firstPageHash, lease:{id:leaseId, until:this.now() + this.leaseMs}, progress:{...job.progress, processed:seen.size, total:page.total, failed:rejected, nextOffset:offset+page.items.length, updatedAt:this.timestamp()}};
        // The only page-commit boundary: track rows, raw observations and cursor together.
        await this.store.transaction(async tx => {
          this.fence(await tx.getJob(userId), job!, leaseId);
          await tx.upsertSavedTracks(rows); await tx.putObservations(observations); await tx.putJob(next);
        });
        job = next;
        if (job.progress.nextOffset < page.total) continue;
        const first = await this.page(userId, 0);
        if (this.fingerprint(first) !== job.firstPageHash || seen.size + rejected !== page.total || duplicates > 0) {job = await this.restart(job, leaseId); continue;}
        // Context is optional and explicitly limited to the available recent 50 events.
        const context = await this.recentContext(userId);
        const complete: ImportJob = {...job, lease:null, retryAt:null, progress:{...job.progress, status:'complete', updatedAt:this.timestamp(), error:null}};
        await this.store.transaction(async tx => {this.fence(await tx.getJob(userId), job!, leaseId); await tx.completeImportMembership({userId, jobId:job!.progress.jobId!, pass:job!.pass, trackIds:job!.seenIds, sourceTotal:page.total, observedAt:this.timestamp(), expectedMembershipRevision:job!.membershipRevision!}); await tx.putTasteContext(context); await tx.putJob(complete);});
        return;
      }
    } catch (error) {
      const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
      const membershipChanged=['IMPORT_MEMBERSHIP_CHANGED','MEMBERSHIP_MUTATION_PENDING'].includes(code);
      const safe = membershipChanged ? new SpotifyError(code, 'Library membership changed during this import. A fresh scan will retry after pending reviews settle.', 409, true) : safeError(error);
      if (safe.code === 'IMPORT_LEASE_LOST') return;
      await this.store.transaction(async tx => {
        const current = await tx.getJob(userId);
        if (!current || current.lease?.id !== leaseId) return;
        current.lease = null;
        current.restart = current.restart || safe.code === 'LIBRARY_CHANGED' || membershipChanged;
        current.retryAt = safe.retryable ? safe.retryAt ?? this.now() + 30_000 : null;
        current.progress = {...current.progress, status:'failed', updatedAt:this.timestamp(), error:safe.envelope()};
        await tx.putJob(current);
      });
    } finally {clearInterval(heartbeat);}
  }
  private fence(current: ImportJob | null, expected: ImportJob, leaseId: string) {
    if (!current || current.progress.jobId !== expected.progress.jobId || current.pass !== expected.pass || current.progress.nextOffset !== expected.progress.nextOffset || current.lease?.id !== leaseId || current.lease.until <= this.now()) throw new SpotifyError('IMPORT_LEASE_LOST', 'Another worker is resuming this import.', 409, true);
  }
  private async release(job: ImportJob, leaseId: string) {
    await this.store.transaction(async tx => {const current = await tx.getJob(job.userId); if (current?.lease?.id === leaseId) await tx.putJob({...current, lease:null, progress:{...current.progress, status:'pending'}});});
  }
  private async restart(job: ImportJob, leaseId: string): Promise<ImportJob> {
    if (job.restarts >= 2) throw changed();
    const next: ImportJob = {...job, restart:false, restarts:job.restarts+1, pass:job.pass+1, seenIds:[], rejected:0, duplicates:0, sourceTotal:null, firstPageHash:null, lease:{id:leaseId, until:this.now() + this.leaseMs}, progress:{...job.progress, processed:0, failed:0, nextOffset:0, total:null, updatedAt:this.timestamp()}};
    await this.store.transaction(async tx => {this.fence(await tx.getJob(job.userId), job, leaseId); next.membershipRevision = await tx.getMembershipRevision(job.userId); await tx.putJob(next);});
    return next;
  }
  private async page(userId: string, offset: number) {
    const parsed = pageSchema.safeParse(await this.reader.get(userId, `/me/tracks?limit=50&offset=${offset}`));
    if (!parsed.success || parsed.data.offset !== offset) throw new SpotifyError('SPOTIFY_INVALID_PAGE', 'Spotify returned an invalid library page.', 502, true);
    return parsed.data;
  }
  private fingerprint(page: z.infer<typeof pageSchema>) {
    return digest(JSON.stringify({total:page.total, items:page.items.map(item => {
      if (typeof item !== 'object' || !item) return item;
      const raw = item as {added_at?:unknown; track?:{id?:unknown; uri?:unknown} | null};
      return {addedAt:raw.added_at, id:raw.track?.id, uri:raw.track?.uri};
    })}));
  }
  private async recentContext(userId: string): Promise<TasteContext> {
    const context: TasteContext = {userId, fetchedAt:this.timestamp(), source:'spotify-recently-played', completeHistory:false, events:[], error:null};
    try {
      const parsed = recentSchema.safeParse(await this.reader.get(userId, '/me/player/recently-played?limit=50'));
      if (!parsed.success) throw new SpotifyError('SPOTIFY_INVALID_RESPONSE', 'Spotify returned invalid recent listening context.', 502);
      const seen = new Set<string>();
      for (const event of parsed.data.items) if (event.track && !seen.has(`${event.track.id}/${event.played_at}`)) {seen.add(`${event.track.id}/${event.played_at}`); context.events.push({trackId:event.track.id, playedAt:event.played_at});}
    } catch (error) {context.error = safeError(error).envelope();}
    // The fetched sample may include plays that happened while the request was in flight.
    context.fetchedAt = this.timestamp();
    return context;
  }
}
