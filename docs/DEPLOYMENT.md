# Deployment guide

EasyTutor ships to three targets from one codebase: the **App Store** (iOS), the
**Play Store** (Android), and the **web**. Mobile builds use [EAS Build](https://docs.expo.dev/build/introduction/);
the web build is a static export you can host anywhere.

> Versioning: bump `expo.version` in `app.json` for user-facing releases. For native
> stores also bump `ios.buildNumber` and `android.versionCode` (add them to `app.json`
> when you cut your first store build).

---

## 1. One-time prerequisites

```bash
npm install -g eas-cli
eas login
```

- **Apple**: a paid Apple Developer account; an App Store Connect app record.
- **Google**: a Google Play Console account; a service-account JSON key for automated submission.
- Run `eas build:configure` once to generate `eas.json` and register the project (it is
  not committed yet — this creates it).

A typical `eas.json` to start from:

```json
{
  "cli": { "version": ">= 5.0.0" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal" },
    "production": { "autoIncrement": true }
  },
  "submit": { "production": {} }
}
```

---

## 2. Mobile builds (EAS)

### Internal preview (testers, no store)

```bash
eas build --profile preview --platform ios       # installable on registered devices / TestFlight
eas build --profile preview --platform android    # APK for direct install
```

### Production

```bash
eas build --profile production --platform all
```

EAS produces a signed `.ipa` and `.aab`. Credentials (certificates, keystore) are managed
by EAS by default; let it generate and store them on first run.

### Submit to the stores

```bash
eas submit --platform ios       # uploads the .ipa to App Store Connect / TestFlight
eas submit --platform android   # uploads the .aab to Play (uses the service-account key)
```

Then finish review/rollout in App Store Connect and the Play Console.

### Store listing checklist

- App name **EasyTutor**, icon, and screenshots for each device class.
- **Calendar permission** copy is already declared in `app.json`
  (`NSCalendarsUsageDescription` / `NSCalendarsFullAccessUsageDescription` and the
  Android `expo-calendar` plugin string). Keep the privacy questionnaire consistent:
  EasyTutor stores data **on-device only** and makes **no network calls**, so the data
  collection answers are "no data collected."
- Privacy policy URL (host a short policy reflecting the local-only model).

---

## 3. Web deployment

The web target is configured for a single-file static export (`web.output: "single"` in
`app.json`).

```bash
npx expo export --platform web      # outputs to dist/
```

Host the contents of `dist/` on any static host:

- **Vercel / Netlify**: point the project at the repo, set the build command to
  `npx expo export --platform web` and the output directory to `dist`.
- **GitHub Pages / S3 / Cloudflare Pages**: upload `dist/` as static assets.

Because it's a single-page app, configure the host to **rewrite all routes to
`index.html`** so deep links (e.g. `/students/:id`) resolve. The app's link scheme and
route config live in `src/app/navigation`.

> ⚠️ **Web SQLite needs cross-origin isolation headers.** `expo-sqlite` on web (WASM/OPFS)
> generally requires `Cross-Origin-Opener-Policy: same-origin` and
> `Cross-Origin-Embedder-Policy: require-corp`. **GitHub Pages can't set custom headers, so
> it's not a good fit.** Use a host that can — **Cloudflare Pages** or **Netlify** (both
> free) — and add a headers config (e.g. a `public/_headers` file) setting both. Verify the
> app loads and the local database initializes before relying on a host.

> Note: on web, SQLite runs in the browser; each browser/origin has its own databases
> (accounts + per-account data). Accounts never carry across browsers or devices. Tutoring
> **data** can, via device sync — see the next section.

### The bundled Cloudflare Worker

`worker.js` + `wrangler.jsonc` in the repo root deploy the web build to Cloudflare Workers
and are the recommended host, because the Worker does two things a plain static host can't:

- adds the COOP/COEP headers `expo-sqlite`'s WASM needs, and
- serves the `/sync` endpoint (below).

```bash
npm run preview   # expo export -p web && wrangler dev  → local worker on :8787
npm run deploy    # expo export -p web && wrangler deploy
```

Three settings in `wrangler.jsonc` are load-bearing and easy to break:
`assets.binding` (creates `env.ASSETS`), `assets.run_worker_first` (without it, static
assets are served *before* the Worker, so the isolation headers never get applied and the
app hangs on the login screen), and `assets.not_found_handling` (SPA fallback for deep
links like `/settings`).

---

## 4. Device sync (`/sync`)

Optional. Lets a Mac and a phone converge on the same tutoring data with no database
backend — the Worker stores one JSON snapshot per *space* in Workers KV, and each client
merges it row by row (last write wins per record, `deleted_at` tombstones included). See
`src/domain/services/syncMerge.ts` and `src/data/sync/`.

### Set it up once, on the deployment

```bash
npx wrangler kv namespace create TUTORDISCO_SYNC
# paste the returned id into wrangler.jsonc → kv_namespaces[0].id

npx wrangler secret put SYNC_SECRET   # a long random string; the clients present this
npm run deploy
```

Until both exist, `/sync` returns **501** and the rest of the app is unaffected.

### Then, on each device

Settings → **Device Sync** → *Set up sync…*

| Field | Value |
| --- | --- |
| Sync URL | `https://<your-worker>.workers.dev/sync` (prefilled on web) |
| Space | any `[A-Za-z0-9_-]{1,64}` label; devices sharing a space share data |
| Sync key | the same value you set as `SYNC_SECRET` |

The **Generate a key** button produces a suitable random key and copies it, so you can
paste the same value into `wrangler secret put`. To avoid typing a 64-character key into a
phone, configure one device, hit **Copy setup code**, and use **Paste setup code from
clipboard** on the other.

Once configured it is automatic: a push a couple of seconds after any change, and a
revision poll every 30s (plus one on app foreground) that only pulls when the remote
actually moved.

### Testing the endpoint directly

```bash
SECRET=...   # matches SYNC_SECRET
BASE=http://localhost:8787/sync/test

curl -s $BASE -H "Authorization: Bearer $SECRET"            # {"rev":0,...,"data":null}
curl -s $BASE                                               # 401
curl -s -X PUT $BASE -H "Authorization: Bearer $SECRET" \
  -d '{"formatVersion":1,"schemaVersion":7,"exportedAt":"x","tables":{}}'
curl -s "$BASE?meta=1" -H "Authorization: Bearer $SECRET"    # {"rev":1,...} — no payload
curl -s -X PUT $BASE -H "Authorization: Bearer $SECRET" -H 'If-Match: 0' -d '{...}'  # 409
```

For local runs, `npx wrangler dev --var SYNC_SECRET:localtestsecret` avoids needing a
real secret.

### What to know before relying on it

- **Anyone with the key can read and overwrite the synced data.** It is stored in transit
  over HTTPS but sits unencrypted at rest in your KV namespace. This is tutoring data
  (names, payments) that was previously on-device only — a deliberate trade for automatic
  sync. Client-side encryption was considered and left out.
- **Last write wins per row, not per field.** Editing different fields of the *same*
  record on two devices between syncs keeps the newer record wholesale.
- **KV is eventually consistent** (up to ~60s). A sync can land one round trip behind.
  It is not lossy: clients always push a *full* snapshot, so anything a stale writer
  dropped is re-contributed on the next sync. Moving the endpoint to D1 or a Durable
  Object would make it strongly consistent.
- Ordering relies on device clocks, which is fine for devices on network time.
- The free tier allows 1,000 KV writes and 100,000 reads per day; the 30s poll costs
  roughly 2,900 reads per device per day.
- Sync config is **per account** and **per device** — it lives in the accounts registry
  (`meta` table), never in the tutoring database, which would otherwise sync the config
  across along with the data.
- Accounts and passwords are never synced, only tutoring data.

---

## 5. Over-the-air (OTA) updates

For JS-only changes (no native module/permission changes) you can ship via
[EAS Update](https://docs.expo.dev/eas-update/introduction/) without a store review:

```bash
eas update --branch production --message "Fix payment rounding"
```

Anything that changes native modules, permissions, or `app.json` plugins requires a new
store build.

---

## 6. Release flow (suggested)

1. `npm run typecheck` is green; manual smoke test on web + one native platform.
2. Bump `expo.version` (and native build numbers for store builds).
3. Tag the release in git.
4. `eas build --profile production --platform all` → `eas submit`.
5. `npx expo export --platform web` → deploy `dist/`.
6. For hotfixes that are JS-only, prefer `eas update`.
