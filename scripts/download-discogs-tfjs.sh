#!/usr/bin/env bash
# Download browser Discogs-EffNet TF.js weights (gitignored; needed for genre tagging).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/models/discogs-genre"
BASE="https://essentia.upf.edu/essentiajs-discogs/assets"
mkdir -p "$OUT"
curl -fsSL -o "$OUT/model.json" "$BASE/model.9b2e8494.json"
python3 - <<PY
import json
from pathlib import Path
p = Path("$OUT/model.json")
data = json.loads(p.read_text())
for entry in data.get("weightsManifest", []):
    entry["paths"] = [Path(x).name for x in entry.get("paths", [])]
p.write_text(json.dumps(data))
PY
for i in $(seq 1 11); do
  shard="group1-shard${i}of11.bin"
  echo "Fetching $shard…"
  curl -fsSL -o "$OUT/$shard" "$BASE/$shard"
done
echo "Discogs TF.js model ready in $OUT"
