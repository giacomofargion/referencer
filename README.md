# Referencer

Match an unmastered client track to commercially released references in a similar sonic ballpark — a fast A/B starting point for mastering engineers.

## Stack

- Next.js (App Router) + TypeScript + Tailwind v4
- shadcn/ui + Motion
- Clerk (auth)
- Neon Postgres (metadata + feature cache)
- Cloudflare R2 (optional client-audio storage)
- iTunes Search / RSS (commercial reference discovery)
- Essentia.js (WASM) for loudness, frequency balance, tempo, stereo width

## Setup

```bash
cp .env.example .env.local
# Fill Clerk keys (or run: clerk init --app <your-app-id>)
# DATABASE_URL is already needed for Neon
npm install
npm run dev
```

### Optional: Cloudflare R2

Without R2, analysis and matching still work — A/B playback uses a local blob URL for the uploaded file. To persist client audio:

1. Create an R2 bucket at [dash.cloudflare.com](https://dash.cloudflare.com) → R2
2. Create an API token with Object Read/Write
3. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` in `.env.local`

## Flow

1. Sign in → upload a client track → pick an Apple Music genre
2. Browser analyzes the file (Essentia.js worker): LUFS, LRA, 7-band balance, BPM, stereo width
3. `/api/match` loads genre-filtered references from Neon; if the cache is thin, it pulls iTunes top songs / search, analyzes 30s previews server-side, and caches them
4. Results show ranked matches with plain-English reasons, band meters, and A/B playback

## Design tokens

All colors live in `src/app/globals.css` (`@theme`). Use named utilities only:

| Token | Meaning |
| --- | --- |
| `surface-0/1/2` | Page / card / raised |
| `text-primary/secondary/muted` | Text hierarchy |
| `client` | Your track / primary actions (meter cyan) |
| `reference` | Reference track data (amber) |

Numeric readouts use `font-mono` (tabular figures).
