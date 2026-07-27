/**
 * Sync transport — talks to the `/sync/:space` endpoint in worker.js.
 *
 * Deliberately thin: GET the stored snapshot, PUT a new one. Errors come back as
 * `Result` values like everywhere else in the data layer, with 409 mapped to the
 * `conflict` code so the engine can recognise it and retry.
 */
import type { RemoteMeta, RemoteSnapshot, SyncConfig } from '../../domain/types/sync';
import type { BackupData } from '../../domain/types/backup';
import type { Result } from '../../domain/types/common';
import { isBackupData } from '../backup';
import { err, ok } from '../../shared/utils/result';

const REQUEST_TIMEOUT_MS = 20_000;

const endpointFor = (config: SyncConfig, query = ''): string =>
  `${config.url.replace(/\/+$/, '')}/${encodeURIComponent(config.space)}${query}`;

/**
 * `AbortSignal.timeout` isn't reliably present on React Native, so wire up the
 * controller by hand.
 */
const request = async (
  url: string,
  init: RequestInit & { readonly secret: string },
): Promise<Response> => {
  const { secret, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        ...(rest.headers ?? {}),
        Authorization: `Bearer ${secret}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
};

/** Pull the endpoint's own error message out of the body, falling back to the status. */
const describeFailure = async (response: Response): Promise<string> => {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const message = (body as Record<string, unknown>).error;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  } catch {
    // Non-JSON body (a proxy error page, say) — fall through to the generic message.
  }
  return `Sync failed (HTTP ${response.status}).`;
};

const failure = async (response: Response): Promise<Result<never>> => {
  const message = await describeFailure(response);
  if (response.status === 401) {
    return err('validation', 'Sync key was rejected. Check the key matches your deployment.');
  }
  if (response.status === 409) return err('conflict', message);
  if (response.status === 400 || response.status === 413 || response.status === 501) {
    return err('validation', message);
  }
  if (response.status === 404) {
    return err(
      'not_found',
      'No sync endpoint at that URL. Check the address ends in /sync and the app is deployed.',
    );
  }
  return err('unknown', message);
};

const asNetworkError = (e: unknown): Result<never> => {
  if (e instanceof Error && e.name === 'AbortError') {
    return err('unknown', 'Sync timed out. Check your connection and try again.');
  }
  return err('unknown', e instanceof Error ? `Could not reach sync: ${e.message}` : 'Could not reach sync.', e);
};

const asMeta = (body: unknown): RemoteMeta => {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const rev = Number(record.rev);
  return {
    rev: Number.isFinite(rev) ? rev : 0,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  };
};

/** Cheap revision check — no snapshot transferred. Used by the background poll. */
export const fetchMeta = async (config: SyncConfig): Promise<Result<RemoteMeta>> => {
  try {
    const response = await request(endpointFor(config, '?meta=1'), {
      method: 'GET',
      secret: config.secret,
    });
    if (!response.ok) return failure(response);
    return ok(asMeta(await response.json()));
  } catch (e) {
    return asNetworkError(e);
  }
};

export const pull = async (config: SyncConfig): Promise<Result<RemoteSnapshot>> => {
  try {
    const response = await request(endpointFor(config), { method: 'GET', secret: config.secret });
    if (!response.ok) return failure(response);

    const body: unknown = await response.json();
    const meta = asMeta(body);
    const data = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const snapshot = data.data;

    if (snapshot === null || snapshot === undefined) {
      return ok({ ...meta, data: null });
    }
    if (!isBackupData(snapshot)) {
      return err('validation', 'The stored sync snapshot is not in a format this app understands.');
    }
    return ok({ ...meta, data: snapshot });
  } catch (e) {
    return asNetworkError(e);
  }
};

/**
 * Replace the stored snapshot. `ifMatchRev` is the revision the snapshot was merged
 * against; the endpoint returns a `conflict` error if it has moved on since.
 */
export const push = async (
  config: SyncConfig,
  snapshot: BackupData,
  ifMatchRev: number,
): Promise<Result<RemoteMeta>> => {
  try {
    const response = await request(endpointFor(config), {
      method: 'PUT',
      secret: config.secret,
      headers: { 'content-type': 'application/json', 'If-Match': String(ifMatchRev) },
      body: JSON.stringify(snapshot),
    });
    if (!response.ok) return failure(response);
    return ok(asMeta(await response.json()));
  } catch (e) {
    return asNetworkError(e);
  }
};
