/**
 * Snapshot merge — the heart of device sync. Pure: no I/O, time passed in.
 *
 * Strategy is last-write-wins **per row**, keyed on `id` and ordered by `updated_at`.
 * Every synced table carries both columns (see migrations 0001/0002), and repositories
 * stamp `updated_at` on every write, so no extra bookkeeping is needed.
 *
 * Two properties worth keeping in mind:
 *
 * - Tombstones are ordinary rows. A newer `deleted_at` beats an older edit (the delete
 *   propagates), and a newer edit beats an older `deleted_at` (the row is un-deleted).
 *   This is why `data/backup.ts` dumps soft-deleted rows rather than filtering them.
 * - Last-write-wins is per row, not per field. Editing different fields of the *same*
 *   record on two devices between syncs keeps the newer record wholesale.
 *
 * Ties keep the local row so the result is deterministic and a no-op sync stays a no-op.
 */
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  type BackupData,
  type BackupRow,
} from '../types/backup';
import type { MergeStats, TableMergeStats } from '../types/sync';

/** Missing/!numeric `updated_at` sorts oldest, so a well-formed row always wins over it. */
const updatedAtOf = (row: BackupRow): number => {
  const value = row.updated_at;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const idOf = (row: BackupRow): string | null => {
  const value = row.id;
  return value === null || value === undefined ? null : String(value);
};

export interface MergeResult {
  readonly merged: BackupData;
  readonly stats: MergeStats;
}

/**
 * Combine our snapshot with one pulled from another device.
 *
 * `stats.fromRemote` counts rows this device is about to adopt — when it is 0 the local
 * database already contains everything in `remote`, so callers can skip the write.
 */
export const mergeSnapshots = (
  local: BackupData,
  remote: BackupData,
  nowIso: string,
): MergeResult => {
  const tables: Record<string, BackupRow[]> = {};
  const tableStats: TableMergeStats[] = [];
  let fromRemote = 0;
  let toRemote = 0;

  for (const table of BACKUP_TABLES) {
    const localRows = local.tables[table] ?? [];
    const remoteRows = remote.tables[table] ?? [];

    // Rows with no id can't be matched up. Only our own can be preserved verbatim;
    // this should never happen, since `id` is NOT NULL PRIMARY KEY in every table.
    const unkeyed: BackupRow[] = [];
    const byId = new Map<string, BackupRow>();
    for (const row of localRows) {
      const id = idOf(row);
      if (id === null) unkeyed.push(row);
      else byId.set(id, row);
    }

    const remoteById = new Map<string, BackupRow>();
    for (const row of remoteRows) {
      const id = idOf(row);
      if (id !== null) remoteById.set(id, row);
    }

    let pulled = 0;
    for (const [id, theirs] of remoteById) {
      const mine = byId.get(id);
      if (mine === undefined || updatedAtOf(theirs) > updatedAtOf(mine)) {
        byId.set(id, theirs);
        pulled += 1;
      }
    }

    let pushed = unkeyed.length;
    for (const row of localRows) {
      const id = idOf(row);
      if (id === null) continue;
      const theirs = remoteById.get(id);
      if (theirs === undefined || updatedAtOf(row) > updatedAtOf(theirs)) pushed += 1;
    }

    tables[table] = [...byId.values(), ...unkeyed];
    tableStats.push({ table, fromRemote: pulled, toRemote: pushed });
    fromRemote += pulled;
    toRemote += pushed;
  }

  return {
    merged: {
      formatVersion: BACKUP_FORMAT_VERSION,
      // Rows from an older device simply omit newer columns; the INSERT then falls back
      // to each column's SQL DEFAULT. Keep the higher version so the merged snapshot
      // isn't advertised as older than the schema that actually produced part of it.
      schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion),
      exportedAt: nowIso,
      tables,
    },
    stats: { fromRemote, toRemote, tables: tableStats },
  };
};
