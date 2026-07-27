/**
 * Sync engine — one round trip: pull, merge, write locally, push the result back.
 *
 * Pushing the FULL merged snapshot (never a delta) is what makes this safe over an
 * eventually-consistent store: if a device pushes over a snapshot it hadn't seen yet,
 * the other device still holds those rows locally and re-contributes them on its next
 * sync. Deltas could not recover from that.
 */
import type { DatabaseClient } from '../db/client';
import type { BackupData } from '../../domain/types/backup';
import type { Result } from '../../domain/types/common';
import type { SyncConfig, SyncOutcome } from '../../domain/types/sync';
import { mergeSnapshots } from '../../domain/services/syncMerge';
import { exportBackup, restoreBackup, validateBackupCompatibility } from '../backup';
import { err, ok } from '../../shared/utils/result';
import { pull, push } from './transport';

/** A racing device can only win so many times before something is actually wrong. */
const MAX_ATTEMPTS = 3;

export interface SyncEngineDeps {
  readonly db: DatabaseClient;
  readonly schemaVersion: number;
  readonly config: SyncConfig;
  /** ISO timestamp stamped on the merged snapshot. Passed in to keep merging pure. */
  readonly nowIso: string;
}

/**
 * Reconcile this device with the shared snapshot.
 *
 * Returns how many rows moved in each direction; `stats.fromRemote > 0` means the local
 * database changed and any cached UI state needs reloading.
 */
export const runSync = async ({
  db,
  schemaVersion,
  config,
  nowIso,
}: SyncEngineDeps): Promise<Result<SyncOutcome>> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remote = await pull(config);
    if (!remote.ok) return remote;

    // Re-exported every attempt: a previous attempt may already have merged rows in.
    const local = await exportBackup(db, schemaVersion);

    if (remote.value.data !== null) {
      const incompatible = validateBackupCompatibility(remote.value.data, schemaVersion);
      if (incompatible !== null) {
        return err(
          'validation',
          `${incompatible} Update TutorDisco on this device, then sync again.`,
        );
      }
    }

    const { merged, stats } =
      remote.value.data === null
        ? { merged: { ...local, exportedAt: nowIso } as BackupData, stats: emptyStats(local) }
        : mergeSnapshots(local, remote.value.data, nowIso);

    if (stats.fromRemote > 0) {
      await restoreBackup(db, merged);
    }

    // Nothing to contribute and nothing pulled: already in step, so skip the write.
    // (KV writes are the scarce resource on the free tier.)
    if (stats.fromRemote === 0 && stats.toRemote === 0 && remote.value.data !== null) {
      return ok({ rev: remote.value.rev, stats });
    }

    const pushed = await push(config, merged, remote.value.rev);
    if (pushed.ok) return ok({ rev: pushed.value.rev, stats });
    if (pushed.error.code !== 'conflict' || attempt === MAX_ATTEMPTS) return pushed;
    // Conflict: another device pushed between our pull and push. Loop to re-merge.
  }

  return err('conflict', 'Sync kept being overtaken by another device. Try again in a moment.');
};

/** Stats for a first push into an empty space: everything we hold is new to the remote. */
const emptyStats = (local: BackupData): SyncOutcome['stats'] => {
  const tables = Object.entries(local.tables).map(([table, rows]) => ({
    table,
    fromRemote: 0,
    toRemote: rows.length,
  }));
  return {
    fromRemote: 0,
    toRemote: tables.reduce((sum, t) => sum + t.toRemote, 0),
    tables,
  };
};
