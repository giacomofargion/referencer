#!/usr/bin/env bash
# Download browser Discogs-EffNet TF.js weights (gitignored; needed for genre tagging).
# Normal installs use the pinned remote model + SHA-256 digests in
# scripts/discogs-tfjs.SHA256SUMS. Live demo discovery is only for --refresh-pins.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/models/discogs-genre"
PINS="$ROOT/scripts/discogs-tfjs.SHA256SUMS"
BASE="https://essentia.upf.edu/essentiajs-discogs/assets"
DEMO="https://essentia.upf.edu/essentiajs-discogs/"
mkdir -p "$OUT"

REFRESH_PINS=0
case "${1:-}" in
  --refresh-pins) REFRESH_PINS=1 ;;
  "") ;;
  *)
    echo "Usage: $0 [--refresh-pins]" >&2
    exit 2
    ;;
esac

discover_model_remote() {
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
}

read_pinned_model_remote() {
  if [[ ! -f "$PINS" ]]; then
    echo "Missing pinned digests at $PINS — run: $0 --refresh-pins" >&2
    exit 1
  fi
  local remote
  remote="$(
    python3 - "$PINS" <<'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text()
match = re.search(r"(?m)^#\s*model_remote:\s*(\S+)\s*$", text)
if not match:
    raise SystemExit("pins file missing '# model_remote: <name>' line")
print(match.group(1))
PY
  )"
  printf '%s\n' "$remote"
}

if [[ "$REFRESH_PINS" -eq 1 ]]; then
  MODEL_REMOTE="$(discover_model_remote)"
  echo "Refreshing pins from live demo → remote model $MODEL_REMOTE"
else
  MODEL_REMOTE="$(read_pinned_model_remote)"
  echo "Using pinned remote model $MODEL_REMOTE"
fi

curl -fsSL -o "$OUT/model.json" "$BASE/$MODEL_REMOTE"

# Fetch shards via original remote paths, write them as local basenames, then
# rewrite the manifest so TF.js loads from this folder. Integrity comes from
# checked-in pins (or --refresh-pins rewriting those pins after download).
python3 - "$OUT" "$BASE/$MODEL_REMOTE" "$PINS" "$REFRESH_PINS" <<'PY'
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

out = Path(sys.argv[1])
model_url = sys.argv[2]
pins_path = Path(sys.argv[3])
refresh_pins = sys.argv[4] == "1"
# Resolve shard paths relative to the remote model.json location (TF.js semantics).
model_dir_url = model_url.rsplit("/", 1)[0] + "/"
model_remote = Path(urllib.parse.urlparse(model_url).path).name
manifest_path = out / "model.json"
data = json.loads(manifest_path.read_text())

# Keep (remote_path, local_basename) so fetch uses the original path.
shards: list[tuple[str, str]] = []
seen: set[str] = set()
for entry in data.get("weightsManifest", []):
    for path in entry.get("paths", []):
        name = Path(path).name
        if name not in seen:
            seen.add(name)
            shards.append((path, name))

if not shards:
    raise SystemExit("weightsManifest listed no shard paths")

shard_names = [name for _, name in shards]
integrity: dict[str, dict[str, object]] = {}
ordered = ["model.json", *shard_names]


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_expected_digests(path: Path) -> dict[str, str]:
    expected: dict[str, str] = {}
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        digest, name = stripped.split(None, 1)
        expected[name] = digest.lower()
    return expected


def download_and_verify(remote_path: str, name: str) -> None:
    url = urllib.parse.urljoin(model_dir_url, remote_path)
    print(f"Fetching {name}…")
    dest = out / name
    with urllib.request.urlopen(url, timeout=300) as resp:
        body = resp.read()
        etag = resp.headers.get("ETag")
        header_len = resp.headers.get("Content-Length")

    # Trust the downloaded body; header Content-Length can disagree upstream.
    reported = int(header_len) if header_len is not None else None
    dest.write_bytes(body)
    integrity[name] = {
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "etag": etag,
        "contentLength": reported if reported is not None else len(body),
    }


for remote_path, name in shards:
    download_and_verify(remote_path, name)

# Local TF.js loads sibling files; rewrite paths to basenames only after download.
for entry in data.get("weightsManifest", []):
    entry["paths"] = [Path(path).name for path in entry.get("paths", [])]
manifest_path.write_text(json.dumps(data))

model_bytes = manifest_path.read_bytes()
integrity["model.json"] = {
    "sha256": hashlib.sha256(model_bytes).hexdigest(),
    "bytes": len(model_bytes),
}

# Re-read files and confirm local hashes match what we just recorded.
for name in ordered:
    path = out / name
    digest = file_sha256(path)
    if digest != integrity[name]["sha256"]:
        raise SystemExit(f"post-download hash mismatch for {name}")

if refresh_pins:
    lines = [
        "# Expected SHA-256 digests for Discogs-EffNet TF.js assets (local basenames).",
        f"# model_remote: {model_remote}",
        "# Refresh with: bash scripts/download-discogs-tfjs.sh --refresh-pins",
    ]
    lines.extend(f"{integrity[name]['sha256']}  {name}" for name in ordered)
    pins_path.write_text("\n".join(lines) + "\n")
    print(f"Wrote pinned digests → {pins_path}")
else:
    if not pins_path.is_file():
        raise SystemExit(
            f"Missing pinned digests at {pins_path} — run with --refresh-pins"
        )
    expected = load_expected_digests(pins_path)
    if not expected:
        raise SystemExit(
            f"Pinned digests at {pins_path} are empty — run with --refresh-pins"
        )
    for name in ordered:
        digest = integrity[name]["sha256"]
        want = expected.get(name)
        if want is None:
            raise SystemExit(f"no pinned digest for {name} in {pins_path}")
        if digest != want:
            raise SystemExit(
                f"pinned digest mismatch for {name}: got {digest}, expected {want}"
            )
    unexpected = sorted(set(expected) - set(ordered))
    if unexpected:
        raise SystemExit(
            "pinned digests include files not downloaded: " + ", ".join(unexpected)
        )
    print(f"Matched pinned digests in {pins_path}")

checksums_path = out / "SHA256SUMS"
checksums_path.write_text(
    "".join(f"{integrity[name]['sha256']}  {name}\n" for name in ordered)
)
(out / "integrity.json").write_text(json.dumps(integrity, indent=2) + "\n")
print(f"Verified {len(shard_names)} shards + model.json → {checksums_path}")
PY

echo "Discogs TF.js model ready in $OUT"
