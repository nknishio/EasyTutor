/**
 * Sync store — owns the device-sync config and drives sync round trips.
 *
 * Push side: subscribes to the data-change bus (emitted by every repository write) and
 * debounces into a single sync, so a burst of edits costs one round trip.
 *
 * Pull side: `checkRemote` compares the remote revision against the last one we saw and
 * only syncs when it moved. The timers that call it live in app/providers/SyncProvider.tsx
 * so this store stays free of lifecycle concerns.
 *
 * Config is per-account and device-local — it lives in the accounts registry's `meta`
 * table, never in the tutoring DB, which would otherwise sync the config itself across.
 */
import { create } from 'zustand';
import { getDb, getSchemaVersion, hasContainer } from '../app/di/container';
import * as accounts from '../auth/accountsDb';
import { runSync } from '../data/sync/syncEngine';
import { fetchMeta } from '../data/sync/transport';
import type { Result } from '../domain/types/common';
import type { MergeStats, RemoteMeta, SyncConfig, SyncPhase } from '../domain/types/sync';
import { onDataChange } from '../shared/utils/dataChangeBus';
import { err, ok } from '../shared/utils/result';
import { nowMillis } from '../shared/utils/time';
import { reloadAllStores } from './reset';

/** Long enough to collapse a burst of edits, short enough to feel immediate. */
const PUSH_DEBOUNCE_MS = 2_000;

const metaKey = (accountId: string, field: string): string => `sync:${accountId}:${field}`;

interface SyncState {
  /** Account the loaded config belongs to; null before init or when signed out. */
  accountId: string | null;
  config: SyncConfig | null;
  /** Whether writes automatically push and the poll automatically pulls. */
  enabled: boolean;
  phase: SyncPhase;
  lastSyncedAt: number | null;
  /** Highest remote revision this device has merged. */
  lastRev: number;
  lastStats: MergeStats | null;
  error: string | null;

  /** Load the account's config and start listening for writes. Pass null on sign-out. */
  init: (accountId: string | null) => Promise<void>;
  saveConfig: (config: SyncConfig) => Promise<Result<void>>;
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Verify the endpoint and key without moving any data. */
  testConnection: () => Promise<Result<RemoteMeta>>;
  syncNow: () => Promise<Result<void>>;
  /** Cheap revision poll; syncs only if the remote moved ahead of us. */
  checkRemote: () => Promise<void>;
  /** Note that local data changed; schedules a debounced push. */
  markDirty: () => void;
  /** Forget this device's config. Leaves the remote snapshot and local data alone. */
  disconnect: () => Promise<void>;
  clearError: () => void;
}

export const useSyncStore = create<SyncState>((set, get) => {
  // Module-scoped rather than in state: changing these must never re-render, and the
  // debounce timer would be meaningless as a rendered value.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let syncing = false;
  let dirtyAgain = false;

  const clearTimer = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const schedulePush = (): void => {
    clearTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void get().syncNow();
    }, PUSH_DEBOUNCE_MS);
  };

  return {
    accountId: null,
    config: null,
    enabled: false,
    phase: 'unconfigured',
    lastSyncedAt: null,
    lastRev: 0,
    lastStats: null,
    error: null,

    init: async (accountId) => {
      clearTimer();
      unsubscribe?.();
      unsubscribe = null;

      if (accountId === null) {
        set({
          accountId: null,
          config: null,
          enabled: false,
          phase: 'unconfigured',
          lastSyncedAt: null,
          lastRev: 0,
          lastStats: null,
          error: null,
        });
        return;
      }

      const [url, space, secret, enabled] = await Promise.all([
        accounts.getMeta(metaKey(accountId, 'url')),
        accounts.getMeta(metaKey(accountId, 'space')),
        accounts.getMeta(metaKey(accountId, 'secret')),
        accounts.getMeta(metaKey(accountId, 'enabled')),
      ]);

      const config =
        url !== null && space !== null && secret !== null ? { url, space, secret } : null;

      set({
        accountId,
        config,
        enabled: config !== null && enabled !== '0',
        phase: config === null ? 'unconfigured' : 'idle',
        // Revision is intentionally not persisted: starting at 0 makes the first sync
        // after launch a real merge rather than a poll that decides nothing changed.
        lastRev: 0,
        lastSyncedAt: null,
        lastStats: null,
        error: null,
      });

      unsubscribe = onDataChange(() => get().markDirty());
    },

    saveConfig: async (config) => {
      const { accountId } = get();
      if (accountId === null) return err('validation', 'Sign in before configuring sync.');

      const trimmed: SyncConfig = {
        url: config.url.trim(),
        space: config.space.trim(),
        secret: config.secret.trim(),
      };
      if (!trimmed.url) return err('validation', 'Enter the sync URL.');
      if (!/^https?:\/\//i.test(trimmed.url)) {
        return err('validation', 'The sync URL must start with http:// or https://');
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed.space)) {
        return err(
          'validation',
          'Sync space must be 1-64 letters, digits, hyphens or underscores.',
        );
      }
      if (!trimmed.secret) return err('validation', 'Enter the sync key.');

      await Promise.all([
        accounts.setMeta(metaKey(accountId, 'url'), trimmed.url),
        accounts.setMeta(metaKey(accountId, 'space'), trimmed.space),
        accounts.setMeta(metaKey(accountId, 'secret'), trimmed.secret),
      ]);

      set({ config: trimmed, phase: 'idle', error: null, lastRev: 0 });
      return ok(undefined);
    },

    setEnabled: async (enabled) => {
      const { accountId } = get();
      if (accountId !== null) {
        await accounts.setMeta(metaKey(accountId, 'enabled'), enabled ? '1' : '0');
      }
      if (!enabled) clearTimer();
      set({ enabled });
    },

    testConnection: async () => {
      const { config } = get();
      if (config === null) return err('validation', 'Save the sync settings first.');
      const result = await fetchMeta(config);
      if (!result.ok) {
        set({ phase: 'error', error: result.error.message });
        return result;
      }
      set({ phase: 'idle', error: null });
      return result;
    },

    syncNow: async () => {
      const { config } = get();
      if (config === null) return err('validation', 'Sync is not set up on this device yet.');
      if (!hasContainer()) return err('validation', 'Sign in before syncing.');

      // Collapse overlapping runs; remember that more work arrived so nothing is dropped.
      if (syncing) {
        dirtyAgain = true;
        return ok(undefined);
      }
      syncing = true;
      clearTimer();
      set({ phase: 'syncing', error: null });

      try {
        const result = await runSync({
          db: getDb(),
          schemaVersion: getSchemaVersion(),
          config,
          nowIso: new Date().toISOString(),
        });

        if (!result.ok) {
          set({ phase: 'error', error: result.error.message });
          return err(result.error.code, result.error.message, result.error.cause);
        }

        set({
          phase: 'idle',
          error: null,
          lastRev: result.value.rev,
          lastSyncedAt: nowMillis(),
          lastStats: result.value.stats,
        });

        // Rows arrived from the other device — the stores' caches are now stale.
        if (result.value.stats.fromRemote > 0) {
          await reloadAllStores();
        }
        return ok(undefined);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Sync failed.';
        set({ phase: 'error', error: message });
        return err('unknown', message, e);
      } finally {
        syncing = false;
        if (dirtyAgain) {
          dirtyAgain = false;
          schedulePush();
        }
      }
    },

    checkRemote: async () => {
      const { config, enabled, lastRev } = get();
      if (config === null || !enabled || syncing) return;

      const meta = await fetchMeta(config);
      if (!meta.ok) {
        // A failed poll is routine (offline, asleep). Don't nag with an error banner.
        return;
      }
      if (meta.value.rev !== lastRev) {
        await get().syncNow();
      }
    },

    markDirty: () => {
      const { config, enabled } = get();
      if (config === null || !enabled) return;
      schedulePush();
    },

    disconnect: async () => {
      const { accountId } = get();
      clearTimer();
      if (accountId !== null) {
        await Promise.all(
          ['url', 'space', 'secret', 'enabled'].map((field) =>
            accounts.setMeta(metaKey(accountId, field), null),
          ),
        );
      }
      set({
        config: null,
        enabled: false,
        phase: 'unconfigured',
        lastSyncedAt: null,
        lastRev: 0,
        lastStats: null,
        error: null,
      });
    },

    clearError: () => set({ error: null }),
  };
});
