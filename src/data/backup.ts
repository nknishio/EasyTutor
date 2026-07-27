import type { DatabaseClient, BindValue } from './db/client';
import type { BackupData } from '../domain/types/backup';
import { BACKUP_FORMAT_VERSION, BACKUP_TABLES } from '../domain/types/backup';

export const exportBackup = async (
  db: DatabaseClient,
  schemaVersion: number,
): Promise<BackupData> => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    try {
      tables[table] = await db.getAll<Record<string, unknown>>(`SELECT * FROM "${table}"`);
    } catch {
      // Table may not exist yet (e.g. older schema). Export what we can.
      tables[table] = [];
    }
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    tables,
  };
};

export const restoreBackup = async (db: DatabaseClient, backup: BackupData): Promise<void> => {
  // Disable FK constraints so we can restore in our declared order without
  // worrying about inter-table reference order edge cases.
  await db.execute('PRAGMA foreign_keys = OFF');
  try {
    await db.transaction(async () => {
      for (const table of BACKUP_TABLES) {
        await db.run(`DELETE FROM "${table}"`);
        const rows = backup.tables[table] ?? [];
        for (const row of rows) {
          const keys = Object.keys(row);
          if (keys.length === 0) continue;
          const cols = keys.map((k) => `"${k}"`).join(', ');
          const placeholders = keys.map(() => '?').join(', ');
          const values: BindValue[] = keys.map((k) => {
            const v = row[k];
            if (v === null || v === undefined) return null;
            if (typeof v === 'string') return v;
            if (typeof v === 'number') return v;
            return String(v);
          });
          await db.run(`INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`, values);
        }
      }
    });
  } finally {
    await db.execute('PRAGMA foreign_keys = ON');
  }
};

export const isBackupData = (data: unknown): data is BackupData => {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.formatVersion === 'number' &&
    typeof d.schemaVersion === 'number' &&
    typeof d.exportedAt === 'string' &&
    typeof d.tables === 'object' &&
    d.tables !== null
  );
};

/** Returns a human-readable error string if the backup can't be restored, else null. */
export const validateBackupCompatibility = (
  backup: BackupData,
  currentSchemaVersion: number,
): string | null => {
  if (backup.formatVersion !== BACKUP_FORMAT_VERSION) {
    return `Unsupported backup format version (${backup.formatVersion}). Expected ${BACKUP_FORMAT_VERSION}.`;
  }
  if (backup.schemaVersion > currentSchemaVersion) {
    return 'This backup was created by a newer version of the app and cannot be restored here.';
  }
  return null;
};
