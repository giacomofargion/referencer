# Referencer (Tonemap)

**Find commercial reference tracks that actually match an unmastered mix.**

Upload a client track, get a ranked shortlist of released songs in a similar sonic ballpark — loudness, frequency balance, dynamics, tempo, and stereo width — with plain-English reasons and instant A/B playback.

Live: [tonemap.online](https://tonemap.online)

---

## Why it exists

Picking reference tracks is slow and subjective. Engineers often jump between streaming apps, playlists, and memory. Referencer turns that into a measurable pipeline:

1. Tag the mix with **Discogs-EffNet in the browser** (genre / style)
2. Search **Deezer + iTunes** with style-first queries (+ instrument hints from the style)
3. **Hard-filter** candidates to the genre neighborhood (no Pop refs for Deep House just because LUFS matches)
4. Analyze previews with Essentia and **re-rank by metering** inside that gated pool
5. A/B on the loudest section of each preview

No paid music-AI API and no always-on Python worker required for the live path.

---

## What this project demonstrates

| Area | Implementation |
| --- | --- |
| **Client audio ML** | Essentia.js (WASM) — metering + MFCC, spectral, HPCP, multi-window fingerprints |
| **Genre tagging** | Discogs-EffNet (TF.js) — 400 styles + optional 512-d penultimate embedding |
| **Discovery** | Style-first Deezer/iTunes search + hard genre neighborhood gate |
| **Hydration cache** | Neon `reference_tracks` stores analyzed previews (not the search index) |
| **Similarity ranking** | Z-score + weighted cosine (balanced); Euclidean tone/loudness presets; click-learned weights |
| **Backend** | Next.js Route Handlers, Clerk auth, Neon Postgres, Cloudflare R2 |
| **Payments** | Stripe Checkout credit packs; 1 credit = 1 similarity search |
| **UX** | Upload → match carousel, EQ meters, loudest-window A/B, projects + history |

---

## Stack

- **Framework:** Next.js (App Router) · React 19 · TypeScript
- **UI:** Tailwind CSS v4 · shadcn/ui · Motion
- **Auth:** Clerk
- **Data:** Neon Postgres · Cloudflare R2 (session clips)
- **Audio:** Essentia.js (WASM + TF.js Discogs model)
- **Previews:** Deezer Search API · iTunes Search API
- **Payments:** Stripe Checkout (one-time credits)

---

## Architecture

```
┌─────────────┐  Discogs-EffNet (browser)  ┌─────────────────┐
│  Browser    │ ─────────────────────────► │ Genre + embed   │
│  Upload UI  │  Essentia multi-window     └────────┬────────┘
└──────┬──────┘                                     │
       │ fingerprint + genre + instruments          │ style-first queries
       ▼                                            ▼
┌─────────────┐   Deezer + iTunes          ┌─────────────────┐
│  /api/match │ ◄─────────────────────────│ Preview shortlist│
└──────┬──────┘   hard genre gate + cache  └─────────────────┘
       │ Cosine / Euclidean re-rank (+ learned weights)
       ▼
┌─────────────┐
│ Ranked refs │ → lightbox + A/B
└─────────────┘
```

**Pipeline in practice**

1. Sign in → optionally pick or create a **project**
2. Upload an unmastered track — browser tags genre (Discogs) + analyzes metering (Essentia)
3. `/api/match` debits 1 credit, searches Deezer/iTunes, hydrates/analyzes previews, re-ranks
4. Results open in the references lightbox; star keepers onto the project shortlist
5. Reopen past runs from **History**, or browse **Projects**

**Optional local MERT worker** (`workers/mert-embed/`) remains in the repo for experiments but is **not** on the production match path.

**Client audio storage (optional R2):** with `R2_*` set, each session stores a ~60s 128kbps MP3 clip for reopen A/B.

---

## Local development

```bash
cp .env.example .env.local   # Clerk, Neon, Stripe test keys, R2
npm install
npm run models:discogs       # Discogs TF.js weights → public/models/discogs-genre/
npm run dev
```

`npm run build` also downloads Discogs weights via `prebuild` (needed for Vercel).

### Cloudflare R2 setup

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → create a bucket (e.g. `referencer-audio`).
2. Create an Account API token with Object Read & Write on that bucket.
3. Put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` in `.env.local`.
4. **CORS (required for browser uploads):** R2 → bucket → **Settings** → **CORS policy**. Example:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://tonemap.online"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Without this, the browser PUT is blocked and session clips won’t store (matching still runs).

### Owner unlimited matches

```bash
OWNER_CLERK_USER_ID=user_xxx
# or
OWNER_CLERK_USER_IDS=user_xxx,user_yyy
```

---

## Repo layout

```
src/                   # Next.js app
public/workers/        # Essentia analysis + Discogs genre workers
public/models/         # Discogs TF.js (gitignored bins; download script)
workers/mert-embed/    # Optional local MERT ANN experiments
scripts/               # migrations + model download
```

Worker details for the unused MERT path: **`workers/mert-embed/README.md`**.
