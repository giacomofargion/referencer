#!/usr/bin/env bash
# Download browser Discogs-EffNet TF.js weights (gitignored; needed for genre tagging).
# Discovers the current hashed model.json from the live demo, then downloads every
# shard listed in weightsManifest (no hardcoded hash / shard count).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/models/discogs-genre"
BASE="https://essentia.upf.edu/essentiajs-discogs/assets"
DEMO="https://essentia.upf.edu/essentiajs-discogs/"
mkdir -p "$OUT"

MODEL_REMOTE="$(
  curl -fsSL "$DEMO" | python3 -c '
import re, sys, urllib.request

ORIGIN = "https://essentia.upf.edu"
html = sys.stdin.read()
entry_scripts = re.findall(r"src=\"(/essentiajs-discogs/assets/[^\"]+)\"", html)
entry_scripts += re.findall(
    r"src=\"(https://essentia\.upf\.edu/essentiajs-discogs/assets/[^\"]+)\"",
    html,
)

# Follow Vite-hashed imports from the entry bundle (model lives in a nested chunk).
to_scan: list[str] = []
seen: set[str] = set()
for src in entry_scripts:
    url = src if src.startswith("http") else f"{ORIGIN}{src}"
    if url not in seen:
        seen.add(url)
        to_scan.append(url)

found = None
for url in to_scan:
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            data = resp.read().decode("utf-8", "replace")
    except Exception:
        continue
    match = re.search(r"model\.[a-f0-9]+\.json", data)
    if match:
        found = match.group(0)
        break
    for name in re.findall(r"assets/([A-Za-z0-9._-]+\.js)", data):
        nested = f"{ORIGIN}/essentiajs-discogs/assets/{name}"
        if nested not in seen:
            seen.add(nested)
            to_scan.append(nested)

if not found:
    raise SystemExit("Could not discover Discogs TF.js model.json from demo assets")
print(found)
'
)"

echo "Using remote model $MODEL_REMOTE"
curl -fsSL -o "$OUT/model.json" "$BASE/$MODEL_REMOTE"

# Normalize shard paths to basenames so TF.js loads from the local folder.
python3 - "$OUT/model.json" <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
data = json.loads(manifest_path.read_text())
for entry in data.get("weightsManifest", []):
    entry["paths"] = [Path(path).name for path in entry.get("paths", [])]
manifest_path.write_text(json.dumps(data))
PY

# Download every shard from the manifest; verify size vs Content-Length; write SHA256SUMS.
python3 - "$OUT" "$BASE" <<'PY'
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

out = Path(sys.argv[1])
base = sys.argv[2].rstrip("/")
manifest_path = out / "model.json"
data = json.loads(manifest_path.read_text())

shard_names: list[str] = []
for entry in data.get("weightsManifest", []):
    for path in entry.get("paths", []):
        name = Path(path).name
        if name not in shard_names:
            shard_names.append(name)

if not shard_names:
    raise SystemExit("weightsManifest listed no shard paths")

integrity: dict[str, dict[str, object]] = {}
ordered = ["model.json", *shard_names]


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download_and_verify(name: str) -> None:
    url = f"{base}/{name}"
    print(f"Fetching {name}…")
    head_req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(head_req, timeout=60) as head:
        expected_len = head.headers.get("Content-Length")
        etag = head.headers.get("ETag")

    dest = out / name
    with urllib.request.urlopen(url, timeout=300) as resp:
        body = resp.read()

    if expected_len is not None and len(body) != int(expected_len):
        raise SystemExit(
            f"{name}: size mismatch (got {len(body)}, Content-Length {expected_len})"
        )

    dest.write_bytes(body)
    integrity[name] = {
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "etag": etag,
        "contentLength": int(expected_len) if expected_len is not None else len(body),
    }


model_bytes = manifest_path.read_bytes()
integrity["model.json"] = {
    "sha256": hashlib.sha256(model_bytes).hexdigest(),
    "bytes": len(model_bytes),
}

for shard in shard_names:
    download_and_verify(shard)

# Re-read files and confirm local hashes match what we just recorded.
for name in ordered:
    path = out / name
    digest = file_sha256(path)
    if digest != integrity[name]["sha256"]:
        raise SystemExit(f"post-download hash mismatch for {name}")

checksums_path = out / "SHA256SUMS"
checksums_path.write_text(
    "".join(f"{integrity[name]['sha256']}  {name}\n" for name in ordered)
)
(out / "integrity.json").write_text(json.dumps(integrity, indent=2) + "\n")
print(f"Verified {len(shard_names)} shards + model.json → {checksums_path}")
PY

echo "Discogs TF.js model ready in $OUT"
