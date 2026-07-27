/**
 * Accounts registry — a small SQLite database (`tutordisco-accounts.db`) holding the
 * cross-account list and the active-account pointer. It is intentionally SEPARATE from
 * the per-user tutoring databases: a per-user DB can't hold the global account registry.
 *
 * The first account created adopts the existing default tutoring DB (`tutor.db`) so data
 * created before logins existed is preserved; later accounts get their own `tutor-<id>.db`.
 */
import * as Crypto from 'expo-crypto';
import { ExpoSqliteClient, type DatabaseClient } from '../data/db/client';
import type { Account } from '../domain/types';
import type { EpochMillis, Result, Row } from '../domain/types/common';
import { err, ok } from '../shared/utils/result';
import { nowMillis } from '../shared/utils/time';
import { hashPassword, verifyPassword } from './crypto';

const ACCOUNTS_DB_NAME = 'tutordisco-accounts.db';
/** The first account adopts the pre-login default tutoring database. */
const ADOPT_DB_NAME = 'tutor.db';
const ACTIVE_KEY = 'active_account_id';
const MIN_PASSWORD_LENGTH = 4;

let db: DatabaseClient | null = null;

const ensureDb = async (): Promise<DatabaseClient> => {
  if (db) return db;
  const client = await ExpoSqliteClient.open(ACCOUNTS_DB_NAME);
  await client.execute(
    `CREATE TABLE IF NOT EXISTS accounts (
      id            TEXT PRIMARY KEY NOT NULL,
      username      TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      salt          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      db_name       TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );`,
  );
  await client.execute(
    `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT);`,
  );
  db = client;
  return db;
};

const rowToAccount = (r: Row): Account => ({
  id: String(r.id),
  username: String(r.username),
  displayName: String(r.display_name),
  dbName: String(r.db_name),
  createdAt: Number(r.created_at) as EpochMillis,
});

const normalize = (username: string): string => username.trim().toLowerCase();

export const listAccounts = async (): Promise<Account[]> => {
  const d = await ensureDb();
  const rows = await d.getAll<Row>(`SELECT * FROM accounts ORDER BY created_at ASC`);
  return rows.map(rowToAccount);
};

export const countAccounts = async (): Promise<number> => {
  const d = await ensureDb();
  const r = await d.getFirst<{ n: number }>(`SELECT COUNT(*) AS n FROM accounts`);
  return r?.n ?? 0;
};

export const getAccount = async (id: string): Promise<Account | null> => {
  const d = await ensureDb();
  const row = await d.getFirst<Row>(`SELECT * FROM accounts WHERE id = ?`, [id]);
  return row ? rowToAccount(row) : null;
};

export interface RegisterInput {
  username: string;
  displayName: string;
  password: string;
}

export const createAccount = async (input: RegisterInput): Promise<Result<Account>> => {
  const d = await ensureDb();
  const username = normalize(input.username);
  if (!username) return err('validation', 'Username is required.');
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return err('validation', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const existing = await d.getFirst<Row>(`SELECT id FROM accounts WHERE username = ?`, [username]);
  if (existing) return err('conflict', 'That username is already taken.');

  const { salt, hash } = await hashPassword(input.password);
  const isFirst = (await countAccounts()) === 0;
  const id = Crypto.randomUUID();
  const account: Account = {
    id,
    username,
    displayName: input.displayName.trim() || username,
    dbName: isFirst ? ADOPT_DB_NAME : `tutor-${id}.db`,
    createdAt: nowMillis(),
  };

  try {
    await d.run(
      `INSERT INTO accounts (id, username, display_name, salt, password_hash, db_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [account.id, account.username, account.displayName, salt, hash, account.dbName, account.createdAt],
    );
    return ok(account);
  } catch (e) {
    return err('db', 'Failed to create the account.', e);
  }
};

export const authenticate = async (username: string, password: string): Promise<Result<Account>> => {
  const d = await ensureDb();
  const row = await d.getFirst<Row>(`SELECT * FROM accounts WHERE username = ?`, [normalize(username)]);
  if (!row) return err('not_found', 'No account with that username.');
  const valid = await verifyPassword(password, String(row.salt), String(row.password_hash));
  if (!valid) return err('validation', 'Incorrect password.');
  return ok(rowToAccount(row));
};

/**
 * Read a device-local key/value setting.
 *
 * The `meta` table is the right home for anything that must NOT travel between devices:
 * this database is never exported or synced, unlike the per-account tutoring DBs. Device
 * sync keeps its endpoint and key here for exactly that reason — storing them in the
 * tutoring DB would sync the config to the other device along with the data.
 */
export const getMeta = async (key: string): Promise<string | null> => {
  const d = await ensureDb();
  const row = await d.getFirst<{ value: string | null }>(
    `SELECT value FROM meta WHERE key = ?`,
    [key],
  );
  return row?.value ?? null;
};

/** Write a device-local setting; `null` removes it. */
export const setMeta = async (key: string, value: string | null): Promise<void> => {
  const d = await ensureDb();
  if (value == null) {
    await d.run(`DELETE FROM meta WHERE key = ?`, [key]);
    return;
  }
  await d.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
};

export const getActiveAccountId = (): Promise<string | null> => getMeta(ACTIVE_KEY);

export const setActiveAccountId = (id: string | null): Promise<void> => setMeta(ACTIVE_KEY, id);
