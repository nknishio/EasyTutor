/**
 * Device-sync types.
 *
 * Sync moves one whole JSON snapshot (the same `BackupData` the backup feature produces)
 * through a shared blob store, and merges it row-by-row on arrival. There is no server
 * logic beyond get/put — see worker.js and docs/DEPLOYMENT.md.
 */
import type { BackupData } from './backup';

/** Where to sync and how to authenticate. Device-local; never stored in the tutoring DB. */
export interface SyncConfig {
  /** Base endpoint, e.g. `https://tutordisco.example.workers.dev/sync`. */
  readonly url: string;
  /** Names the snapshot slot. Two devices sync when they share a space. */
  readonly space: string;
  /** Shared key matching the deployment's `SYNC_SECRET`. */
  readonly secret: string;
}

/** Revision info without the payload — what the cheap poll returns. */
export interface RemoteMeta {
  /** Monotonic counter, bumped on every successful push. 0 means "nothing stored yet". */
  readonly rev: number;
  readonly updatedAt: string | null;
}

export interface RemoteSnapshot extends RemoteMeta {
  readonly data: BackupData | null;
}

export interface TableMergeStats {
  readonly table: string;
  /** Rows where the remote copy was newer, or that only the remote had. */
  readonly fromRemote: number;
  /** Rows where our copy was newer, or that only we had. */
  readonly toRemote: number;
}

export interface MergeStats {
  readonly fromRemote: number;
  readonly toRemote: number;
  readonly tables: readonly TableMergeStats[];
}

export type SyncPhase = 'unconfigured' | 'idle' | 'syncing' | 'error';

export interface SyncOutcome {
  /** Revision now stored remotely. */
  readonly rev: number;
  readonly stats: MergeStats;
}
