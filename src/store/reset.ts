/**
 * Store-wide reset and reload.
 *
 * `resetAllStores` clears every tutoring store back to its initial data state; called
 * when switching the active account (login/logout) so one user's cached data never bleeds
 * into another's. Uses Zustand's merge setState, so the stores' action methods are
 * preserved; only the data fields are reset.
 *
 * `reloadAllStores` re-reads from the database instead, for when the rows changed
 * underneath us (a sync pulled in another device's edits).
 *
 * NOTE: `useSyncStore` is deliberately absent from `resetAllStores`. Like authStore and
 * backupStore it holds infrastructure state, not account data — and its config is
 * per-account, so wiping it on a switch would lose the pointer rather than protect it.
 * The account switch calls `useSyncStore.getState().init(accountId)` instead
 * (see store/authStore.ts), which re-reads the incoming account's own config.
 */
import type { SessionId } from '../domain/types/common';
import { useStudentsStore } from './studentsStore';
import { useSessionsStore } from './sessionsStore';
import { usePaymentsStore } from './paymentsStore';
import { useSettingsStore } from './settingsStore';
import { useCalendarStore } from './calendarStore';
import { useAssignmentsStore } from './assignmentsStore';
import { useChecklistStore } from './checklistStore';
import { useTemplatesStore } from './templatesStore';

export const resetAllStores = (): void => {
  useStudentsStore.setState({ byId: {}, order: [], query: '', status: 'idle', error: null });
  useSessionsStore.setState({ byId: {}, byStudent: {}, loadingStudentId: null, allLoaded: false });
  usePaymentsStore.setState({ byId: {}, order: [], status: 'idle', error: null });
  useAssignmentsStore.setState({ byId: {}, bySession: {} });
  useChecklistStore.setState({ byId: {}, bySession: {} });
  useTemplatesStore.setState({ byId: {}, order: [], status: 'idle', error: null });
  useCalendarStore.setState({ linksBySession: {}, permission: null, busySessionId: null, error: null });
  useSettingsStore.setState({
    settings: null,
    satMode: false,
    theme: 'system',
    defaultChecklistItems: [],
    defaultCalendarAlerts: [],
    studentSortKey: 'custom',
    studentSortDir: 'asc',
    studentCustomOrder: [],
    emailTemplateOrder: [],
    status: 'idle',
    error: null,
  });
};

/**
 * Re-read every loaded collection from the database.
 *
 * Used after a sync pulls in remote changes. Deliberately does NOT reset first: the
 * top-level loaders rebuild their indexes wholesale (so deleted rows drop out anyway),
 * and clearing would blank the UI mid-refresh and discard incidental state like the
 * students search query.
 *
 * The session-keyed caches (assignments, checklist, calendar links) are populated lazily
 * per screen, so we refresh exactly the sessions already in cache — otherwise an open
 * SessionDetail would keep showing pre-sync data until it happened to remount.
 */
export const reloadAllStores = async (): Promise<void> => {
  const assignmentSessionIds = Object.keys(useAssignmentsStore.getState().bySession) as SessionId[];
  const checklistSessionIds = Object.keys(useChecklistStore.getState().bySession) as SessionId[];
  const calendarSessionIds = Object.keys(useCalendarStore.getState().linksBySession) as SessionId[];

  await Promise.all([
    useStudentsStore.getState().load(),
    useSessionsStore.getState().loadAll(),
    usePaymentsStore.getState().loadAll(),
    useTemplatesStore.getState().load(),
    useSettingsStore.getState().load(),
    useAssignmentsStore.getState().loadForSessions(assignmentSessionIds),
    ...checklistSessionIds.map((id) => useChecklistStore.getState().loadBySession(id)),
    ...calendarSessionIds.map((id) => useCalendarStore.getState().loadLink(id)),
  ]);
};
