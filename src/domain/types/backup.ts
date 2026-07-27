export const BACKUP_FORMAT_VERSION = 1;

/**
 * Every table carried in a backup/sync snapshot, in an order that respects FK
 * dependencies (parents before children) so a restore can insert them sequentially.
 *
 * Lives in the domain layer because both the pure merge service
 * (domain/services/syncMerge.ts) and the SQLite dump/restore (data/backup.ts) need it.
 */
export const BACKUP_TABLES = [
  'settings',
  'email_templates',
  'students',
  'sessions',
  'assignments',
  'checklist_items',
  'payments',
  'sat_scores',
  'sat_skill_performance',
  'calendar_links',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/** One row as SQLite returned it: snake_case keys, primitives only. */
export type BackupRow = Record<string, unknown>;

/**
 * JSON backup format. `tables` maps each table name to its rows as returned
 * by SQLite (snake_case column names, booleans as 0/1, timestamps as epoch ms,
 * JSON arrays as TEXT — same as the raw DB).
 *
 * Soft-deleted rows are included: tombstones are what let a delete on one device
 * propagate to another instead of the row simply reappearing on the next merge.
 */
export interface BackupData {
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, BackupRow[]>;
}
