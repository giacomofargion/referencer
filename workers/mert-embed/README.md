# Referencer MERT embed + catalog worker

Embeds audio with **MERT-v1-95M** (768-d) and runs **cosine ANN** over a shared
song catalog packed as an `.npz`. The catalog lives on **Cloudflare R2** (or a
local file for development). Neon is only for app data — not vectors.

```text
User → Next.js /api/match → this worker (/similar)
                         → embed + in-memory ANN
                         → iTunes + Essentia re-rank
```

## Setup

```bash
cd workers/mert-embed
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Pack catalog (once)

1. Download [490K Spotify Song Audio Embeddings](https://www.kaggle.com/datasets/serkantysz/490k-spotify-song-audio-embeddings-and-metadata)
2. Pack (subset first), then upload to the same R2 bucket as the Next.js app:

```bash
source .venv/bin/activate

# Dev subset → local file the worker can load immediately
python scripts/pack_catalog_r2.py \
  --songs ../../archive/songs.csv \
  --mert ../../archive/mert_embeddings.npz \
  --out data/catalog.npz \
  --limit 20000

# Full catalog + upload to R2 (uses R2_* from repo .env.local; ~1.3 GB, needs ~2 GB RAM in worker)
python scripts/pack_catalog_r2.py \
  --songs ../../archive/songs.csv \
  --mert ../../archive/mert_embeddings.npz \
  --out data/catalog.npz \
  --upload
```

After upload, restart the worker so it reloads `data/catalog.npz` (or delete the local cache and let it re-download from R2).

Match quality tips: the Next.js match route filters ANN hits to the **dominant catalog genre** (Rock / Pop / Electronic / …) before Essentia, and only hydrates strict iTunes artist+title matches.

Dataset license: **CC BY-NC-SA 4.0** (personal/research; not for commercial SaaS without a different corpus).

## Run the worker

```bash
source .venv/bin/activate

# Local catalog (preferred while iterating):
export MERT_CATALOG_PATH="$(pwd)/data/catalog.npz"

# Or omit MERT_CATALOG_PATH — worker downloads R2_CATALOG_KEY into data/catalog.npz
uvicorn app.main:app --host 127.0.0.1 --port 8091
```

In `.env.local`:

```bash
EMBED_WORKER_URL=http://127.0.0.1:8091
# Optional override (default catalog/mert-v1-95m.npz)
# R2_CATALOG_KEY=catalog/mert-v1-95m.npz
```

The worker also reads `R2_*` from the repo `.env.local` when downloading.

Health: `curl http://127.0.0.1:8091/health` — expect `"catalogReady": true`.

**RAM:** the full ~490k catalog needs roughly **1.5–2 GB** for embeddings in memory. A 20k subset is fine on a laptop.

## Discogs genre tagging

The worker also runs **Discogs-EffNet** on the upload and filters ANN hits to the
predicted catalog genre (Classical / Electronic / Rock / …). Download models once:

```bash
bash scripts/download_discogs_models.sh
```

Health should then report `"genreReady": true`.
