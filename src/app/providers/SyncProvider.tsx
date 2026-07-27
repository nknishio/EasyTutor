/**
 * SyncProvider — the lifecycle half of device sync.
 *
 * Pushes are driven by the data-change bus inside syncStore; this component supplies the
 * pull side, which needs timers and app-state events that don't belong in a store:
 *
 *   - one sync when a configured account becomes active (catches up after launch)
 *   - a sync whenever the app returns to the foreground / the tab becomes visible
 *   - a cheap revision poll while active, which only syncs if the remote actually moved
 *
 * Renders its children untouched; it exists purely for the effects.
 */
import React, { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useSyncStore } from '../../store/syncStore';

/** ~2,900 metadata reads per device per day, against a 100k/day free tier. */
const POLL_INTERVAL_MS = 30_000;

export const SyncProvider = ({ children }: { children: ReactNode }) => {
  const active = useSyncStore((s) => s.enabled && s.config !== null);
  const accountId = useSyncStore((s) => s.accountId);
  const syncNow = useSyncStore((s) => s.syncNow);
  const checkRemote = useSyncStore((s) => s.checkRemote);

  // Catch up once per account activation.
  useEffect(() => {
    if (!active || accountId === null) return;
    void syncNow();
  }, [active, accountId, syncNow]);

  useEffect(() => {
    if (!active) return;

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkRemote();
    });
    const interval = setInterval(() => {
      if (AppState.currentState === 'active') void checkRemote();
    }, POLL_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [active, checkRemote]);

  return <>{children}</>;
};
