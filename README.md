# Referencer (Tonemap)

**Find commercial reference tracks that actually match an unmastered mix.**

Upload a client track, get a ranked shortlist of released songs in a similar sonic ballpark — loudness, frequency balance, dynamics, tempo, and stereo width — with plain-English reasons and instant A/B playback.

Live: [tonemap.online](https://tonemap.online)

---

## Why it exists

Picking reference tracks is slow and subjective. Engineers often jump between streaming apps, playlists, and memory. Referencer turns that into a measurable pipeline:

1. Analyze the upload (client-side Essentia WASM)
2. Embed + ANN over a shared MERT catalog (Python worker)
3. Tag genre with Discogs-EffNet and filter neighbors
4. Hydrate strict iTunes matches (metadata + 30s previews)
5. Re-rank with Essentia metering and present A/B on the loudest section

---

## What this project demonstrates

| Area | Implementation |
| --- | --- |
| **Client audio ML** | Essentia.js (WASM) in a Web Worker — LUFS, LRA, 7-band balance, BPM, stereo width |
| **Discovery** | MERT-v1-95M embeddings + in-worker cosine ANN over ~490k tracks (R2 / local `.npz`) |
| **Genre filter** | Essentia Discogs-EffNet (embedding graph + 400-class head) → catalog genre |
| **Hydration** | iTunes Search with strict artist/title matching (no weak “first hit” fallback) |
| **Similarity ranking** | Essentia re-rank with tone / loudness / balanced presets; optional MERT-only order |
| **Backend** | Next.js Route Handlers, Clerk auth, Neon Postgres (app data only), Cloudflare R2 |
| **Payments** | Stripe Checkout credit packs; 1 credit = 1 similarity search |
| **UX** | Upload → match carousel, EQ meters, loudest-window A/B, projects + history |

---

## Stack

- **Framework:** Next.js (App Router) · React 19 · TypeScript
- **UI:** Tailwind CSS v4 · shadcn/ui · Motion
- **Auth:** Clerk
- **Data:** Neon Postgres (sessions, credits, shortlist) · Cloudflare R2 (clips + MERT catalog)
- **Audio:** Essentia.js (WASM) · server-side preview analysis
- **Discovery worker:** FastAPI · MERT-v1-95M · TensorFlow Discogs-EffNet · NumPy ANN
- **Previews:** iTunes Search API
- **Payments:** Stripe Checkout (one-time credits)

---

## Architecture

```
┌─────────────┐   Essentia WASM    ┌──────────────────┐
│  Browser    │ ─────────────────► │  Feature vector  │
│  Upload UI  │                    └────────┬─────────┘
└──────┬──────┘                             │
       │ clip + features                    │
       ▼                                    ▼
┌─────────────┐   /similar (embed+ANN)   ┌──────────────────────┐
│  /api/match │ ───────────────────────► │  MERT worker         │
└──────┬──────┘                          │  + Discogs genre     │
       │                                 └──────────┬───────────┘
       │ iTunes hydrate (strict)                    │
       │ Essentia re-rank                           │
       ▼                                            ▼
┌─────────────┐                          ┌──────────────────────┐
│ Neon        │  app data only           │ Ranked matches       │
│ (no vectors)│                          │ → lightbox + A/B     │
└─────────────┘                          └──────────────────────┘
```

**Pipeline in practice**

1. Sign in → optionally pick or create a **project** (client job)
2. Upload an unmastered track — browser runs Essentia off the main thread and encodes a short MP3 clip
3. `/api/match` debits 1 credit, then calls the MERT worker (`EMBED_WORKER_URL`)
4. Worker: Discogs genre → MERT embed → ANN on the packed catalog → genre-filtered neighbors
5. Next.js hydrates strict iTunes matches, analyzes previews, re-ranks with Essentia (unless `MATCH_SKIP_ESSENTIA_RERANK=true`)
6. Results open in the references lightbox; star keepers onto the project shortlist
7. Reopen past runs from **History**, or browse **Projects** for sessions + saved references

Catalog vectors live in **R2** (or a local `.npz` for dev), not Neon. Dataset license for the public MERT corpus: **CC BY-NC-SA 4.0** (see `workers/mert-embed/README.md`).

**Client audio storage (optional R2):** with `R2_*` set, each session stores a ~60s 128kbps MP3 clip (~1MB) for reopen A/B. Live sessions always A/B the local file at full quality. Consider an R2 lifecycle rule to cap growth.

---

## Local development

```bash
# App
cp .env.example .env.local   # fill Clerk, Neon, Stripe test keys, R2, EMBED_WORKER_URL
npm install
npm run dev

# MERT worker (separate terminal) — see workers/mert-embed/README.md
cd workers/mert-embed
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
bash scripts/download_discogs_models.sh
export MERT_CATALOG_PATH="$(pwd)/data/catalog.npz"   # after packing a catalog
uvicorn app.main:app --host 127.0.0.1 --port 8091
```

In `.env.local`:

```bash
EMBED_WORKER_URL=http://127.0.0.1:8091
R2_CATALOG_KEY=catalog/mert-v1-95m.npz   # worker downloads if no local catalog
```

Health: `curl http://127.0.0.1:8091/health` — expect `catalogReady` and `genreReady`.

### Cloudflare R2 setup

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **R2** → create a bucket (e.g. `referencer-audio`).
2. Create an Account API token with Object Read & Write on that bucket.
3. Put `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` in `.env.local`.
4. **CORS (required for browser uploads):**

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://tonemap.online"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

### Database migrations

```
scripts/migrations/001_projects_history.sql
scripts/migrations/002_credits.sql
scripts/migrations/003_catalog_tracks_pgvector.sql   # legacy; catalog no longer in Neon
scripts/migrations/004_preview_start_sec.sql         # loudest-window A/B offsets
```

### Credits & Stripe

Each similarity search spends **1 credit** before the match runs. Failed matches refund. New users get a one-time starter grant (`FREE_STARTER_CREDITS`, default 5). Owner Clerk IDs (`OWNER_CLERK_USER_IDS`) skip the debit.

Money goes to **whatever Stripe account owns `STRIPE_SECRET_KEY`**.

1. [Stripe API keys](https://dashboard.stripe.com/apikeys) — toggle **Test** vs **Live**.
2. **Local:** `sk_test_` / `pk_test_` in `.env.local`, plus:

```bash
stripe listen --forward-to localhost:3000/api/credits/webhook
```

3. **Production (e.g. Vercel):** `sk_live_` / `pk_live_` and a **Live** webhook  
   `https://YOUR_DOMAIN/api/credits/webhook` → `checkout.session.completed`.
4. Base price `CREDIT_PRICE_CENTS` (default `49`). Packs: 5 @ 49p, 20 @ 39p, 50 @ 35p, 100 @ 29p.

Buy UI: header **Buy** → pack dialog → Stripe Checkout.

---

## Project structure

```
src/
  app/                 # home, history, projects, session reopen
  app/api/             # uploads, match, projects, sessions, credits, webhooks
  components/          # upload flow, lightbox, A/B player, EQ graphs, credits
  lib/                 # analysis, ranking, MERT client, credits, Stripe, iTunes, R2
workers/mert-embed/    # FastAPI: MERT embed, ANN catalog, Discogs genre
scripts/migrations/    # Neon SQL migrations
public/
  essentia/            # WASM runtime
  workers/             # analysis Web Worker
```

Worker details (catalog pack, R2 upload, Discogs models, RAM): **`workers/mert-embed/README.md`**.
