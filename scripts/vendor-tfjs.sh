#!/usr/bin/env bash
# Vendor browser TF.js UMD for the genre worker (same-origin; no CDN at runtime).
# Pinned to match the previous jsDelivr import in public/workers/genre-worker.js.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/public/vendor"
OUT="$OUT_DIR/tf.min.js"
VERSION="4.22.0"
NPM_DIST="$ROOT/node_modules/@tensorflow/tfjs/dist/tf.min.js"
mkdir -p "$OUT_DIR"

fetch() {
  local url="$1"
  # Some CDNs reject bare curl; send a normal UA.
  curl -fsSL -A "referencer-vendor-tfjs/1.0" -o "$OUT" "$url"
}

if [[ -f "$NPM_DIST" ]]; then
  echo "Copying TensorFlow.js ${VERSION} from node_modules → $OUT"
  cp "$NPM_DIST" "$OUT"
else
  echo "Fetching TensorFlow.js ${VERSION} UMD → $OUT"
  if ! fetch "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@${VERSION}/dist/tf.min.js"; then
    echo "jsDelivr failed; trying unpkg…"
    if ! fetch "https://unpkg.com/@tensorflow/tfjs@${VERSION}/dist/tf.min.js"; then
      # Last resort: extract dist/tf.min.js from the npm tarball.
      echo "CDN fetch failed; extracting from npm pack…"
      TMP="$(mktemp -d)"
      cleanup() { rm -rf "$TMP"; }
      trap cleanup EXIT
      (
        cd "$TMP"
        npm pack "@tensorflow/tfjs@${VERSION}" --silent >/dev/null
        tar -xzf "tensorflow-tfjs-${VERSION}.tgz"
        cp package/dist/tf.min.js "$OUT"
      )
      trap - EXIT
      cleanup
    fi
  fi
fi

# Sanity: non-empty UMD that mentions tf (used as global by EssentiaModel / genre worker).
BYTES="$(wc -c < "$OUT" | tr -d ' ')"
if [[ "$BYTES" -lt 100000 ]] || ! grep -q 'tf' "$OUT"; then
  echo "vendor-tfjs: downloaded file does not look like TF.js (${BYTES} bytes)" >&2
  exit 1
fi

echo "TensorFlow.js ready (${BYTES} bytes) in $OUT"
