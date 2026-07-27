/**
 * Cloudflare Worker — static asset passthrough plus the device-sync endpoint.
 *
 * Two jobs:
 *
 * 1. `/sync/:space` — a tiny KV-backed blob store holding one JSON snapshot per space,
 *    so a Mac and a phone can converge without a real backend. Not a database: it only
 *    ever stores and returns the whole snapshot, and all merge logic lives in the client
 *    (src/domain/services/syncMerge.ts). See docs/DEPLOYMENT.md for setup.
 *
 * 2. Everything else — static assets, with cross-origin isolation headers.
 *    expo-sqlite on web uses a WASM build that requires SharedArrayBuffer, which browsers
 *    only expose on cross-origin isolated pages. The two headers below enable isolation:
 *      COOP  — prevents other origins from keeping a reference to this window
 *      COEP  — blocks sub-resources that don't opt in to being embedded cross-origin
 *
 *    Without these headers the SQLite WASM fails to initialize, so all DB operations
 *    silently do nothing and the app is permanently stuck on the login screen.
 */

/** Sync spaces are used directly as KV key suffixes, so keep them boring. */
const SPACE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** KV values cap at 25 MiB; refuse well before that so we fail with a clear message. */
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * Compare without leaking the match position through timing. Length still leaks,
 * which is fine for a high-entropy shared key.
 */
const secretsMatch = (a, b) => {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};

/**
 * Read just the revision metadata. `list` returns metadata without values, so the poll
 * the clients run every 30s never transfers the whole snapshot.
 */
const readMeta = async (kv, key) => {
  const { keys } = await kv.list({ prefix: key, limit: 10 });
  const entry = keys.find((k) => k.name === key);
  const meta = entry?.metadata ?? null;
  return {
    rev: Number(meta?.rev ?? 0) || 0,
    updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : null,
  };
};

/** Cheap shape check so a stray PUT can't poison a space with unusable content. */
const looksLikeSnapshot = (value) =>
  typeof value === 'object' &&
  value !== null &&
  typeof value.formatVersion === 'number' &&
  typeof value.tables === 'object' &&
  value.tables !== null;

const handleSync = async (request, env, space) => {
  const kv = env.SYNC_KV;
  const secret = env.SYNC_SECRET;
  if (!kv || !secret) {
    return json(
      {
        error:
          'Sync is not configured on this deployment (missing SYNC_KV binding or SYNC_SECRET). See docs/DEPLOYMENT.md.',
      },
      501,
    );
  }

  const header = request.headers.get('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secretsMatch(presented, secret)) {
    return json({ error: 'Sync key was rejected.' }, 401);
  }

  if (!SPACE_PATTERN.test(space)) {
    return json({ error: 'Sync space must be 1-64 letters, digits, hyphens or underscores.' }, 400);
  }

  const key = `snapshot:${space}`;

  if (request.method === 'GET') {
    if (new URL(request.url).searchParams.get('meta') === '1') {
      return json(await readMeta(kv, key));
    }
    const { value, metadata } = await kv.getWithMetadata(key, { type: 'text' });
    if (value === null) {
      return json({ rev: 0, updatedAt: null, data: null });
    }
    // Splice the stored JSON in as-is rather than parse-then-restringify a large blob.
    const rev = Number(metadata?.rev ?? 0) || 0;
    const updatedAt = JSON.stringify(metadata?.updatedAt ?? null);
    return new Response(`{"rev":${rev},"updatedAt":${updatedAt},"data":${value}}`, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX_SNAPSHOT_BYTES) {
      return json({ error: 'Snapshot is too large to sync.' }, 413);
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json({ error: 'Request body must be JSON.' }, 400);
    }
    if (!looksLikeSnapshot(parsed)) {
      return json({ error: 'Request body is not a TutorDisco snapshot.' }, 400);
    }

    // Optimistic concurrency: the client sends the revision it merged against. KV is
    // eventually consistent, so this narrows but does not close the lost-update window
    // — which is safe because clients always push a FULL snapshot and therefore
    // re-contribute anything a stale writer dropped on their next sync.
    const current = await readMeta(kv, key);
    const ifMatch = request.headers.get('If-Match');
    if (ifMatch !== null && ifMatch !== '*' && Number(ifMatch) !== current.rev) {
      return json({ error: 'Someone else synced first — retrying.', rev: current.rev }, 409);
    }

    const next = { rev: current.rev + 1, updatedAt: new Date().toISOString() };
    await kv.put(key, body, { metadata: next });
    return json(next);
  }

  if (request.method === 'DELETE') {
    await kv.delete(key);
    return json({ rev: 0, updatedAt: null });
  }

  return json({ error: `Method ${request.method} is not allowed on /sync.` }, 405);
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // `/sync` (no space) falls through to the space validator, which gives a clearer
    // error than a 404 asset lookup would.
    if (pathname === '/sync' || pathname.startsWith('/sync/')) {
      return handleSync(request, env, pathname.slice('/sync/'.length));
    }

    const response = await env.ASSETS.fetch(request);
    const modified = new Response(response.body, response);
    modified.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    modified.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    return modified;
  },
};
