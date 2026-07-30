#!/usr/bin/env bash
# Download Discogs-EffNet models for genre tagging in the MERT worker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/models"
mkdir -p "$DEST"
curl -fsL -o "$DEST/discogs-effnet-bs64-1.pb" \
  "https://essentia.upf.edu/models/music-style-classification/discogs-effnet/discogs-effnet-bs64-1.pb"
curl -fsL -o "$DEST/genre_discogs400-discogs-effnet-1.pb" \
  "https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb"
curl -fsL -o "$DEST/genre_discogs400-discogs-effnet-1.json" \
  "https://essentia.upf.edu/models/classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json"
ls -lh "$DEST"
echo "Done. Restart the worker to load genre tagging."
