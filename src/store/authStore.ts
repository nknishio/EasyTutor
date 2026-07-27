/**
 * Auth store. Owns the current account and gates access to the tutoring data.
 *
 * Logging in (or restoring the last session) reinitializes the DI container against the
 * account's own database, so all repositories/stores then read and write that account's
 * data. Store state is reset around every switch so no data leaks between accounts.
 */
import { create } from 'zustand';
import type { Account, Result } from '../domain/types';
import { reinitContainer } from '../app/di/container';
import * as accounts from '../auth/accountsDb';
import type { RegisterInput } from '../auth/accountsDb';
import { resetAllStores } from './reset';
import { useSyncStore } from './syncStore';
import { err } from '../shared/utils/result';

type AuthStatus = 'initializing' | 'unauthenticated' | 'authenticated';

/**
 * expo-sqlite's web VFS (OPFS) can only be held open by one tab at a time.
 * Opening/reinitializing the DB from a second tab throws this from the SQLite
 * worker instead of a friendly, catchable error, so we detect it by message.
 */
const isMultiTabVfsError = (e: unknown): boolean =>
  e instanceof Error && /VFS state/i.test(e.message);

const MULTI_TAB_MESSAGE =
  'TutorDisco is already open in another tab. Please only use one tab of this app at a time — switch to that tab, or close all tabs and open a new one.';

interface AuthState {
  status: AuthStatus;
  currentAccount: Account | null;
  error: string | null;

  /** Restore the last active account on app launch (no password re-prompt). */
  bootstrap: () => Promise<void>;
  register: (input: RegisterInput) => Promise<Result<Account>>;
  login: (username: string, password: string) => Promise<Result<Account>>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => {
  /** Point the data layer at an account's DB and mark it active. */
  const activate = async (account: Account): Promise<void> => {
    resetAllStores();
    await reinitContainer(account.dbName);
    await accounts.setActiveAccountId(account.id);
    // Sync config is per-account and lives outside resetAllStores (see store/reset.ts),
    // so re-point it at the incoming account rather than clearing it.
    await useSyncStore.getState().init(account.id);
    set({ status: 'authenticated', currentAccount: account, error: null });
  };

  return {
    status: 'initializing',
    currentAccount: null,
    error: null,

    bootstrap: async () => {
      try {
        const id = await accounts.getActiveAccountId();
        const account = id ? await accounts.getAccount(id) : null;
        if (account) {
          await activate(account);
        } else {
          set({ status: 'unauthenticated', currentAccount: null });
        }
      } catch (e) {
        set({
          status: 'unauthenticated',
          currentAccount: null,
          error: isMultiTabVfsError(e)
            ? MULTI_TAB_MESSAGE
            : e instanceof Error
              ? e.message
              : String(e),
        });
      }
    },

    register: async (input) => {
      const res = await accounts.createAccount(input);
      if (!res.ok) return res;
      try {
        await activate(res.value);
        return res;
      } catch (e) {
        if (isMultiTabVfsError(e)) return err('conflict', MULTI_TAB_MESSAGE, e);
        throw e;
      }
    },

    login: async (username, password) => {
      const res = await accounts.authenticate(username, password);
      if (!res.ok) return res;
      try {
        await activate(res.value);
        return res;
      } catch (e) {
        if (isMultiTabVfsError(e)) return err('conflict', MULTI_TAB_MESSAGE, e);
        throw e;
      }
    },

    logout: async () => {
      await accounts.setActiveAccountId(null);
      await useSyncStore.getState().init(null);
      resetAllStores();
      set({ status: 'unauthenticated', currentAccount: null, error: null });
    },
  };
});
