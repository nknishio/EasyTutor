/**
 * A one-signal event bus: "some repository wrote something".
 *
 * Exists so the data layer can tell the sync store that a push is due without either
 * importing the other. A direct edge would be circular — the sync store reaches the
 * database through the DI container, and the container builds the data layer.
 *
 * Emitted by the repository decorator (data/repositories/withWriteNotifications.ts), so
 * every store action that creates, updates or deletes is covered by construction and no
 * individual call site has to remember to fire it.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe; returns an unsubscribe function. */
export const onDataChange = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const emitDataChange = (): void => {
  // Copy first: a listener may unsubscribe during dispatch.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A broken listener must not fail the write that triggered it.
    }
  }
};
