import type {SavedTrackInput} from '@sortfm/contracts';
import type {A1Store, A1Transaction, Account, Session, OAuthAttempt, ImportJob, ImportObservation, TasteContext, CompleteImportMembershipInput} from '../store';

/** Transactional dependency double, never used by a production entry point. */
export class TestStore implements A1Store {
  data = {accounts:new Map<string, Account>(), sessions:new Map<string, Session>(), oauth:new Map<string, OAuthAttempt>(), jobs:new Map<string, ImportJob>(), saved:new Map<string, SavedTrackInput>(), observations:new Map<string, ImportObservation>(), taste:new Map<string, TasteContext>(), membership:new Map<string, CompleteImportMembershipInput>()};
  private tail: Promise<unknown> = Promise.resolve();
  failNextPage = false;
  async transaction<T>(work: (tx: A1Transaction) => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const d = structuredClone(this.data);
      const result = await work({
        getAccount:async id => d.accounts.get(id) ?? null, putAccount:async a => {d.accounts.set(a.user.id, a);},
        getSession:async id => d.sessions.get(id) ?? null, putSession:async s => {d.sessions.set(s.hash, s);},
        deleteSession:async id => {d.sessions.delete(id);}, deleteSessions:async user => {for (const [id, s] of d.sessions) if (s.userId === user) d.sessions.delete(id);},
        getOAuth:async id => d.oauth.get(id) ?? null, putOAuth:async o => {d.oauth.set(o.stateHash, o);}, deleteOAuth:async id => {d.oauth.delete(id);},
        getJob:async id => d.jobs.get(id) ?? null, putJob:async j => {d.jobs.set(j.userId, j);},
        upsertSavedTracks:async rows => {
          for (const row of rows) {
            const key = `${row.userId}/${row.track.trackId}`, old = d.saved.get(key);
            d.saved.set(key, {...row, originalAddedAt:old?.originalAddedAt ?? row.originalAddedAt, currentStatus:old?.currentStatus ?? row.currentStatus, track:{...row.track, originalAddedAt:old?.originalAddedAt ?? row.originalAddedAt}});
          }
          if (this.failNextPage) {this.failNextPage = false; throw new Error('simulated commit failure');}
        },
        putObservations:async rows => {for (const r of rows) d.observations.set(`${r.userId}/${r.jobId}/${r.pass}/${r.offset}`, r);},
        completeImportMembership:async input => {d.membership.set(input.userId, input);},
        getSummary:async user => {
          const rows = [...d.saved.values()].filter(x => x.userId === user);
          const count = (s: string) => rows.filter(x => x.currentStatus === s).length;
          const kept = count('kept'), archived = count('archived'), unliked = count('unliked'), skipped = count('deferred');
          const membership = d.membership.get(user), ids = new Set(membership?.trackIds);
          const remaining = rows.filter(r => ids.has(r.track.trackId) && ['saved', 'deferred'].includes(r.currentStatus)).length;
          return {total:membership?.sourceTotal ?? 0, reviewed:kept + archived + unliked, remaining, kept, archived, unliked, skipped};
        },
        putTasteContext:async c => {d.taste.set(c.userId, c);},
      });
      this.data = structuredClone(d);
      return structuredClone(result);
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async resumableUserIds() {return [...this.data.jobs.values()].filter(j => ['pending', 'running'].includes(j.progress.status) || (j.progress.status === 'failed' && j.progress.error?.retryable)).map(j => j.userId);}
}
