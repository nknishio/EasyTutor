/**
 * Repository decorator that reports successful writes.
 *
 * Applied once, where the repository set is built (data/index.ts), so every mutating
 * store action is covered without touching any of them. That matters: there are ~34
 * write call sites across the stores and any one of them forgetting to signal would
 * mean a change that silently never syncs.
 *
 * Only successful `Result`s notify — a failed create shouldn't schedule a push.
 */
import type { Repositories } from '../../domain/repositories';
import { emitDataChange } from '../../shared/utils/dataChangeBus';

/** Mutating methods across the generic CRUD surface and the bespoke settings repo. */
const WRITE_METHODS = new Set(['create', 'update', 'softDelete', 'hardDelete']);

const succeeded = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;

const wrapRepo = <T extends object>(repo: T, notify: () => void): T =>
  new Proxy(repo, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;

      const method = value as (...args: unknown[]) => unknown;
      if (typeof prop !== 'string' || !WRITE_METHODS.has(prop)) {
        return method.bind(target);
      }

      return async (...args: unknown[]): Promise<unknown> => {
        const result = await method.apply(target, args);
        if (succeeded(result)) notify();
        return result;
      };
    },
  });

/**
 * Wrap every repository so writes emit on the data-change bus.
 *
 * Note that raw-SQL paths deliberately bypass this — `restoreBackup` writes through the
 * `DatabaseClient` directly, so applying a merged snapshot cannot re-trigger a sync.
 */
export const withWriteNotifications = (
  repos: Repositories,
  notify: () => void = emitDataChange,
): Repositories => ({
  students: wrapRepo(repos.students, notify),
  sessions: wrapRepo(repos.sessions, notify),
  assignments: wrapRepo(repos.assignments, notify),
  checklistItems: wrapRepo(repos.checklistItems, notify),
  payments: wrapRepo(repos.payments, notify),
  calendarLinks: wrapRepo(repos.calendarLinks, notify),
  settings: wrapRepo(repos.settings, notify),
  emailTemplates: wrapRepo(repos.emailTemplates, notify),
  satScores: wrapRepo(repos.satScores, notify),
  satSkillPerformance: wrapRepo(repos.satSkillPerformance, notify),
});
