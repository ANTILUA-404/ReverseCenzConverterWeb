<div align="center">

# CENZ STUDIO — Reverse-Engineered Clone

**A 1:1 functional clone of `beta.cenzstudio.com`: the Roblox audio bypass pipeline, rebuilt from the shipped front-end bundle.**

[![Node](https://img.shields.io/badge/node-%3E%3D%2018-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/express-4.x-000000?logo=express&logoColor=white)](https://expressjs.com)
[![ffmpeg](https://img.shields.io/badge/ffmpeg-required-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org)
[![License](https://img.shields.io/badge/license-MIT-fafafa)](./LICENSE)

</div>

---

## What this is

This repository is a **reverse-engineered rebuild** of the CENZ STUDIO web app. The marketing site,
legal pages, design system and copy are reproduced from the shipped Next.js output; the entire
pipeline behind it (auth, conversion, Roblox upload, moderation tracking, library, billing) is
re-implemented from scratch as a working Node service.

Nothing here is a mock. Every button hits a real endpoint, and every endpoint does real work.

### Fidelity report

| Surface | Method | Status |
|---|---|---|
| Landing page (EN) | SSR HTML captured, Next.js runtime swapped for local assets | **Byte-identical markup** |
| Landing page (ID) | Same, Indonesian locale | **Byte-identical markup** |
| `/en/privacy`, `/en/terms` | SSR HTML | **Byte-identical markup** |
| `/id/privacy`, `/id/terms` | SSR HTML | **Byte-identical markup** |
| Design system | Original `99c8105494c5bd1e.css` shipped as-is (97,962 bytes) | **Original file** |
| Typography | All 16 `woff2` files from the original build | **Original files** |
| Logo / favicon | `/logo.png`, `/favicon.ico` | **Original files** |
| Spotlight, tilt, beam, typing, reveal | Re-implemented in `public/js/landing.js` | Behavioural parity |
| Locale switch | `data-locale-switch` handler | Parity |
| Pricing CTAs | Wired to `/checkout?plan=` | Parity + working |
| Dashboard | Rebuilt from the product's own feature copy | Full implementation |
| Auth | Discord OAuth2 + PKCE, `identify email guilds` | Parity |
| Conversion | yt-dlp + ffmpeg, speed presets, derived gain | Full implementation |
| Auto-Split | 7-minute segmentation for Roblox | Full implementation |
| Upload | Roblox Open Cloud Assets API | Full implementation |
| Moderation | Live `Pending / Accepted / Rejected` polling | Full implementation |
| Library | Albums, tracks, playback speed, DataStore push | Full implementation |
| Billing | Midtrans Snap + manual fallback | Full implementation |

---

## Architecture

The reference is a Next.js App Router application. Its HTML already contains the fully rendered
markup, so the most faithful possible clone keeps that markup **verbatim** and replaces only the
Next.js runtime. That is what `scripts/build-pages.js` does:

```
reference SSR HTML  ──▶  strip Next.js scripts & flight data
                    ──▶  rewrite /_next/image → /assets/logo.png
                    ──▶  point the stylesheet at the original CSS
                    ──▶  turn server-action forms into real links
                    ──▶  inject the local interaction script
                    ──▶  public/{en,id}/*.html
```

The result is a static page that renders pixel-for-pixel like the original, with no React in the
bundle. Everything dynamic runs through the Express API.

```
cenz-clone/
├── server.js                 Express app: auth, jobs, Roblox, billing, admin
├── config.js                 .env loader, plan catalogue, speed presets
├── lib/
│   ├── auth.js               Discord OAuth2 + PKCE, signed cookie sessions
│   ├── crypto.js             AES-256-GCM vault for Open Cloud keys
│   ├── store.js              JSON store: users, sessions, assets, library, payments
│   ├── convert.js            ffmpeg/ffprobe: probe, convert, split, yt-dlp extract
│   └── roblox.js             Open Cloud: upload, operations, moderation, DataStore
├── scripts/
│   └── build-pages.js        Regenerates the static pages from .ref/
├── public/
│   ├── en/ id/               Landing + legal pages (both locales)
│   ├── dashboard.html        Workspace shell
│   ├── checkout.html         Midtrans checkout
│   ├── assets/
│   │   ├── cenz.css          Original stylesheet, unmodified
│   │   ├── app.css           Dashboard layer on the same tokens
│   │   ├── logo.png favicon.ico
│   ├── media/                16 original woff2 files
│   └── js/
│       ├── landing.js        Spotlight, tilt, locale switch, reveal fallback
│       └── dashboard.js      Router + all workspace views
└── data/                     Runtime store (git-ignored)
```

---

## Requirements

| | |
|---|---|
| **Node.js** | 18 or newer |
| **ffmpeg + ffprobe** | on `PATH`, in `./bin`, or via `@ffmpeg-installer` |
| **yt-dlp** | on `PATH` (extraction for YouTube / SoundCloud) |

```bash
# Windows
winget install Gyan.FFmpeg
pip install -U yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Linux
sudo apt install ffmpeg && pipx install yt-dlp
```

Binary lookup order for ffmpeg: `FFMPEG_PATH` → `./bin` → `@ffmpeg-installer` → `PATH`.

---

## Quick start

```bash
git clone https://github.com/ANTILUA-404/ReverseCenzConverterWeb.git
cd ReverseCenzConverterWeb
npm install
cp .env.example .env      # optional — dev login works without it
npm start                 # → http://localhost:3000
```

Or double-click **`start.bat`** on Windows (`./start.sh` on macOS/Linux) — it installs dependencies on
first run and then boots the server.

> The server must stay running in its own terminal window. Closing the terminal stops it; the data in
> `data/db.json` survives.

Open <http://localhost:3000> — you are redirected to `/en` (or `/id` if your browser prefers
Indonesian). Click **Login with Discord**.

Until `DISCORD_CLIENT_SECRET` is set, the server runs in **dev-login mode**: the login dialog
offers a local sign-in by Discord user ID so the workspace is fully testable before the OAuth
redirect URI is registered. It disables itself the moment a secret exists.

### Regenerating the static pages

The captured reference markup lives in `.ref/` (git-ignored). If you want to rebuild the pages:

```bash
# put the captured files in .ref/ first, then:
npm run build:pages
```

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | `http://localhost:3000` | Public origin, used to build the OAuth redirect |
| `SESSION_SECRET` | dev fallback | HMAC key for session cookies — **change in production** |
| `KEY_SECRET` | falls back to `SESSION_SECRET` | scrypt input for the AES-256-GCM vault |
| `DISCORD_CLIENT_ID` | `1476632255244931162` | Discord application client ID |
| `DISCORD_CLIENT_SECRET` | *(empty)* | Optional — PKCE works without it |
| `DISCORD_REDIRECT_URI` | `${BASE_URL}/api/auth/callback/discord` | Must match the Discord dashboard exactly |
| `DISCORD_SCOPES` | `identify email guilds` | Space-separated OAuth scopes |
| `ADMIN_USER_IDS` | `1044986769331998780` | Comma-separated Discord IDs with admin access |
| `ALLOW_DEV_LOGIN` | on while no secret | `1` forces on, `0` forces off |
| `ROBLOX_API_KEY` | *(empty)* | Optional server-wide fallback key |
| `MIDTRANS_SERVER_KEY` | *(empty)* | Enables real Snap checkout |
| `MIDTRANS_CLIENT_KEY` | *(empty)* | Snap client key |
| `MIDTRANS_PRODUCTION` | `0` | `1` switches to the production Snap endpoint |
| `FFMPEG_PATH` / `FFPROBE_PATH` / `YTDLP_PATH` | auto | Override binary paths |

---

## Discord setup (step by step)

1. Open <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2 → General → Redirects**, add:
   - `http://localhost:3000/api/auth/callback/discord`
   - `https://your-domain.com/api/auth/callback/discord`
3. Copy **Client ID** and **Client Secret** into `.env`:

```bash
DISCORD_CLIENT_ID=1476632255244931162
DISCORD_CLIENT_SECRET=your-secret
BASE_URL=https://your-domain.com
SESSION_SECRET=$(openssl rand -hex 32)
ADMIN_USER_IDS=your-discord-id
ALLOW_DEV_LOGIN=0
```

4. Restart. The authorize URL produced is exactly:

```
https://discord.com/api/oauth2/authorize
  ?scope=identify+email+guilds
  &response_type=code
  &client_id=1476632255244931162
  &redirect_uri=<BASE_URL>/api/auth/callback/discord
  &code_challenge=<sha256(verifier)>
  &code_challenge_method=S256
  &state=<csrf>
```

The verifier and state live in short-lived signed HTTP-only cookies; the token exchange sends
`code_verifier` and only adds `client_secret` when one is configured.

---

## Roblox Open Cloud setup

Users link their own key from **Dashboard → Roblox**.

1. Go to <https://create.roblox.com/dashboard/credentials>.
2. **Create API key**, add the IP allow-list (or leave open for local testing).
3. Grant these scopes:

```
asset:read
asset:write
universe-datastores.objects:read
universe-datastores.objects:create
universe-datastores.objects:update
universe-messaging-service:publish
```

> `universe-datastores.objects:delete` is deliberately **not** requested — the reference advertises
> the same restraint, and this clone enforces it.

4. Paste the key plus your creator ID (user ID or group ID) into the dashboard. The server probes
   `GET /assets/v1/assets/1` to validate it, then stores it encrypted.

### How the key is stored

```
plaintext ──scrypt(KEY_SECRET)──▶ 32-byte key
          ──AES-256-GCM, random 12-byte IV──▶ { ciphertext, iv, tag }
```

`GET /api/roblox` returns only a masked hint (`abcd••••••••wxyz`). No endpoint ever returns the key
or its ciphertext. **Unlink** deletes the record outright.

---

## Conversion pipeline

```
URL ──yt-dlp──▶ source audio ──ffmpeg──▶ OGG/Vorbis ──segment──▶ parts ──Open Cloud──▶ asset IDs
```

### Speed presets

| Preset | Speed | Derived gain |
|---|---|---|
| Slow | 0.70× | +3.1 dB |
| Default | 1.00× | 0 dB |
| Fast | 1.50× | −3.5 dB |
| Faster | 2.30× | −7.2 dB |
| Ultra | 3.00× | −9.5 dB |

Gain is derived, not chosen: `amplify = −20 · log₁₀(speed)`, clamped to ±20 dB. That is exactly what
the reference means by *"amplification is derived for you"*.

### Auto-Split

Roblox caps a single audio asset at **seven minutes**. `lib/convert.js` probes the duration and, when
it exceeds the cap, runs the segment muxer:

```bash
ffmpeg -i in.ogg -f segment -segment_time 420 -reset_timestamps 1 -c copy out-part%03d.ogg
```

Stream-copy keeps the cut on packet boundaries, so no part is re-encoded and no audio is lost at the
joins. Each part is then uploaded separately and reported with its own asset ID.

### Upload and moderation

1. `POST /assets/v1/assets` (multipart: `request` JSON + `fileContent`).
2. Poll `GET /assets/v1/operations/{id}` until Roblox returns an asset ID.
3. Store the asset with `moderation: pending`.
4. **Assets → Refresh moderation** calls `GET /assets/v1/assets/{id}` and maps
   `moderationResult.moderationState` to `accepted` / `rejected` / `pending`.

---

## API reference

### Auth

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/auth/discord` | — | Start PKCE authorization |
| `GET` | `/api/auth/callback/discord` | — | Exchange code, create session |
| `POST` | `/auth/dev-login` | — | Local sign-in (only when enabled) |
| `POST` | `/auth/logout` | user | Destroy session |
| `GET` | `/api/auth/me` | — | Session, plan, quota, Roblox link, features |

### Conversion

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/detect` | user | Metadata + estimated part count |
| `POST` | `/api/convert` | user + quota | Start a URL job → `jobId` |
| `POST` | `/api/convert-upload` | user + quota | Start an upload job (multipart) |
| `GET` | `/api/jobs/:id` | owner | Job snapshot |
| `GET` | `/api/jobs/:id/stream` | owner | **SSE** live progress |
| `GET` | `/api/file/:name` | user | Download a converted part |

### Roblox

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/roblox` | user | Link state, masked key, scopes |
| `POST` | `/api/roblox/link` | user | Validate + store key (AES-256-GCM) |
| `POST` | `/api/roblox/unlink` | user | Delete the stored key |
| `POST` | `/api/roblox/validate-user` | user | Resolve a user ID |
| `POST` | `/api/roblox/validate-group` | user | Resolve a group ID |
| `POST` | `/api/roblox/upload` | user | Upload converted parts → asset IDs |
| `POST` | `/api/roblox/moderation` | user | Refresh moderation states |
| `POST` | `/api/roblox/grant` | user | Grant `Use` permission |
| `POST` | `/api/roblox/push-library` | user | Push the library to a DataStore |

### Library & assets

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/library` | user | Albums, tracks, assets |
| `POST` | `/api/library/albums` | user | Create album |
| `PATCH` | `/api/library/albums/:id` | user | Rename / cover |
| `DELETE` | `/api/library/albums/:id` | user | Delete album |
| `POST` | `/api/library/tracks` | user | Add track |
| `PATCH` | `/api/library/tracks/:id` | user | Rename / move / playback speed |
| `DELETE` | `/api/library/tracks/:id` | user | Delete track |
| `GET` | `/api/assets` | user | Uploaded assets |
| `DELETE` | `/api/assets/:id` | user | Remove from the list |

### Billing & admin

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/plans` | — | Plan catalogue |
| `POST` | `/api/checkout` | user | Create a Midtrans transaction |
| `POST` | `/api/midtrans/notification` | — | Payment webhook |
| `GET` | `/api/payments` | user | Payment history |
| `GET` | `/api/stats` | — | Public counters |
| `GET` | `/api/activity` | user | Activity feed |
| `GET` | `/api/admin/overview` | admin | Users, payments, settings |
| `POST` | `/api/admin/user` | admin | Set plan / block |
| `POST` | `/api/admin/features` | admin | Global feature flags |
| `POST` | `/api/admin/announcement` | admin | Site announcement |

---

## Plans

Mirrors the pricing section of the reference exactly.

| Plan | Price | Duration | Conversions | Batch | Speed control |
|---|---|---|---|---|---|
| Free | Rp 0 | forever | 2 / 24h | 1 | — |
| 7 Days | Rp 85,000 | 7 days | unlimited | 1 | ✓ |
| 30 Days | Rp 180,000 | 30 days | unlimited | 5 | ✓ |
| 3 Months | Rp 450,000 | 90 days | unlimited | 5 | ✓ |

Quota is counted per UTC day in `users[].usage` and enforced server-side on both
`/api/convert` and `/api/convert-upload`.

---

## Data model

`data/db.json`:

```jsonc
{
  "users": {
    "<discord-id>": {
      "id": "…", "username": "…", "global_name": "…", "avatar": "…",
      "plan": "30d", "planUntil": "2026-11-24T…",
      "usage": { "day": "2026-10-25", "conversions": 3 },
      "roblox": {
        "key": { "ciphertext": "…", "iv": "…", "tag": "…" },
        "creatorType": "user", "creatorId": "7412093",
        "keyValid": true, "creatorValid": true
      },
      "library": { "albums": [], "tracks": [] }
    }
  },
  "sessions": { "<sid>": { "userId": "…", "createdAt": "…" } },
  "assets": { "<discord-id>": [{ "assetId": "…", "moderation": "pending" }] },
  "payments": { "<id>": { "orderId": "…", "status": "pending" } },
  "activity": [],
  "settings": { "features": { "convert": true, "upload": true, "library": true } }
}
```

`data/db.json` holds encrypted keys and live session ids — it is git-ignored. Keep it that way.

---

## Security notes

- **Sessions** are HMAC-signed HTTP-only cookies; `SameSite=Lax`, `Secure` when `BASE_URL` is HTTPS.
- **OAuth** uses PKCE (S256) with a per-attempt verifier and a CSRF `state`, both in short-lived
  signed cookies.
- **Roblox keys** are encrypted with AES-256-GCM before they touch disk. The key never leaves the
  server except inside an `x-api-key` header to Roblox.
- **Quota and plan checks** run server-side on every conversion and upload — the UI is not the
  boundary.
- **Admin routes** are gated by `requireAdmin`, which resolves the Discord id against `ADMIN_USER_IDS`.
- **Uploads** are capped by plan (`maxFileMb`), and filenames are passed through `path.basename`.

---

## Differences from the reference

These are deliberate, and documented rather than hidden:

1. **No React runtime.** The clone ships the rendered markup plus a ~4 kB interaction script. Same
   pixels, ~300 kB less JavaScript.
2. **No `.ROBLOSECURITY` collection.** This build only accepts Open Cloud keys. Session cookies are
   full account credentials and should never be collected by a third-party site.
3. **Manual payment fallback.** Without a Midtrans server key, orders are queued with
   `status: pending` instead of failing.
4. **In-memory jobs.** Restarting mid-conversion loses the job; finished parts survive in `data/out`.
5. **Music System flag.** `/api/roblox/push-library` returns `501 MUSIC_SYSTEM_REQUIRED` until an
   admin enables the `musicSystem` feature — matching the reference's own "sold separately" note.

---

## Legal

This repository exists for interoperability and study. It reproduces the public marketing copy,
layout and design assets of `cenzstudio.com` for the purpose of a faithful technical reconstruction.

- The original design, copy, logo and fonts belong to **CENZ STUDIO**.
- The backend in `lib/` and `server.js` is an independent implementation, MIT licensed.
- Do not deploy this as your own competing service, and do not use it to process audio you do not
  have the rights to.

If you are the rights holder and want the captured assets removed, open an issue.

## Credits

- Original product: [cenzstudio.com](https://cenzstudio.com)
- Fonts: Inter, Space Grotesk, JetBrains Mono (SIL OFL)
- Built on [Express](https://expressjs.com), [ffmpeg](https://ffmpeg.org), [yt-dlp](https://github.com/yt-dlp/yt-dlp)

## License

[MIT](./LICENSE) — for the code. The design assets remain the property of their owner.
