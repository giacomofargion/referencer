#!/usr/bin/env python3
"""
Pack Kaggle MERT embeddings + songs.csv into a catalog npz, optionally upload to R2.

Dataset:
  https://www.kaggle.com/datasets/serkantysz/490k-spotify-song-audio-embeddings-and-metadata
  Files: songs.csv, mert_embeddings.npz

Usage (from workers/mert-embed, venv active):
  # Local pack (dev / worker MERT_CATALOG_PATH)
  python scripts/pack_catalog_r2.py \\
    --songs ../../archive/songs.csv \\
    --mert ../../archive/mert_embeddings.npz \\
    --out data/catalog.npz \\
    --limit 20000

  # Full catalog + upload to the same R2 bucket as the Next.js app
  python scripts/pack_catalog_r2.py \\
    --songs ../../archive/songs.csv \\
    --mert ../../archive/mert_embeddings.npz \\
    --out data/catalog.npz \\
    --upload

Env (from repo .env.local when --upload):
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
  optional R2_CATALOG_KEY (default catalog/mert-v1-95m.npz)
"""

from __future__ import annotations

import argparse
import ast
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

EMBED_DIM = 768
DEFAULT_R2_KEY = "catalog/mert-v1-95m.npz"
ROOT = Path(__file__).resolve().parents[3]  # referencer/


def load_dotenv_local() -> None:
    env_path = ROOT / ".env.local"
    if not env_path.is_file():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _parse_artists(value: object) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return ""
    if isinstance(value, list):
        return ", ".join(str(a) for a in value)
    text = str(value).strip()
    if text.startswith("["):
        try:
            parsed = ast.literal_eval(text)
            if isinstance(parsed, list):
                return ", ".join(str(a) for a in parsed)
        except (SyntaxError, ValueError):
            pass
    return text


def _l2_normalize(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True) + 1e-12
    return (mat / norms).astype(np.float32)


def load_mert_npz(path: Path) -> tuple[np.ndarray, np.ndarray]:
    data = np.load(path, allow_pickle=True)
    keys = set(data.files)
    id_key = "id" if "id" in keys else ("ids" if "ids" in keys else None)
    feat_key = (
        "features"
        if "features" in keys
        else ("embeddings" if "embeddings" in keys else None)
    )
    if not id_key or not feat_key:
        raise SystemExit(f"Unexpected npz keys {sorted(keys)}; expected id/features")

    ids = np.asarray([str(x) for x in data[id_key]])
    feats = np.asarray(data[feat_key], dtype=np.float32)
    if feats.ndim != 2 or feats.shape[1] != EMBED_DIM:
        raise SystemExit(f"Expected features [N, {EMBED_DIM}], got {feats.shape}")
    return ids, _l2_normalize(feats)


def upload_to_r2(local_path: Path, key: str) -> None:
    try:
        import boto3
    except ImportError as exc:
        raise SystemExit("pip install boto3 to upload") from exc

    account_id = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    bucket = os.environ.get("R2_BUCKET_NAME", "").strip()
    if not all([account_id, access_key, secret_key, bucket]):
        raise SystemExit("R2_* env vars required for --upload")

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )
    size_mb = local_path.stat().st_size / (1024 * 1024)
    print(f"Uploading {local_path} ({size_mb:.1f} MB) → s3://{bucket}/{key} …")
    client.upload_file(
        str(local_path),
        bucket,
        key,
        ExtraArgs={"ContentType": "application/octet-stream"},
    )
    print("Upload complete.")


def main() -> None:
    load_dotenv_local()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--songs", type=Path, required=True, help="Path to songs.csv")
    parser.add_argument("--mert", type=Path, required=True, help="Path to mert_embeddings.npz")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/catalog.npz"),
        help="Output catalog npz path",
    )
    parser.add_argument("--limit", type=int, default=0, help="Max tracks (0 = all)")
    parser.add_argument(
        "--upload",
        action="store_true",
        help="Upload the packed npz to R2 after writing",
    )
    parser.add_argument(
        "--r2-key",
        default=os.environ.get("R2_CATALOG_KEY", DEFAULT_R2_KEY),
        help=f"R2 object key (default {DEFAULT_R2_KEY})",
    )
    args = parser.parse_args()

    if not args.songs.is_file() or not args.mert.is_file():
        raise SystemExit("songs.csv or mert npz not found")

    print(f"Loading MERT npz from {args.mert} …")
    ids, feats = load_mert_npz(args.mert)
    print(f"  {len(ids):,} vectors")

    print(f"Loading songs.csv from {args.songs} …")
    songs = pd.read_csv(args.songs, low_memory=False)
    if "id" not in songs.columns:
        raise SystemExit("songs.csv missing 'id'")
    songs["id"] = songs["id"].astype(str)
    songs = songs.drop_duplicates(subset=["id"], keep="first")
    meta = songs.set_index("id")

    title_col = "name" if "name" in meta.columns else "title"
    album_col = "album_name" if "album_name" in meta.columns else "album"
    artists_col = "artists" if "artists" in meta.columns else "artist"

    # Prefer popular tracks when truncating (better hydrate hit-rate via iTunes).
    order: list[int] = []
    missing = 0
    scored: list[tuple[int, int]] = []
    for i, sid in enumerate(ids):
        if sid not in meta.index:
            missing += 1
            continue
        pop_raw = meta.loc[sid].get("popularity", 0)
        try:
            pop = int(pop_raw) if pd.notna(pop_raw) else 0
        except (TypeError, ValueError):
            pop = 0
        scored.append((pop, i))

    scored.sort(key=lambda t: (-t[0], t[1]))
    for _, i in scored:
        order.append(i)
        if args.limit and len(order) >= args.limit:
            break

    print(f"  matched {len(order):,} (missing meta {missing:,})")
    if not order:
        raise SystemExit("No tracks matched — check id alignment")

    emb = feats[order]
    spotify_id = np.asarray([ids[i] for i in order], dtype=object)
    title = np.empty(len(order), dtype=object)
    artist = np.empty(len(order), dtype=object)
    album = np.empty(len(order), dtype=object)
    genre = np.empty(len(order), dtype=object)

    for j, i in enumerate(order):
        row = meta.loc[ids[i]]
        title[j] = str(row.get(title_col, "") or "")
        artist[j] = _parse_artists(row.get(artists_col, ""))
        album[j] = str(row.get(album_col, "") or "")
        genre[j] = str(row.get("genre", "") or "")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Writing {args.out} …")
    np.savez_compressed(
        args.out,
        embeddings=emb,
        spotify_id=spotify_id,
        title=title,
        artist=artist,
        album=album,
        genre=genre,
    )
    size_mb = args.out.stat().st_size / (1024 * 1024)
    print(f"Done. {len(order):,} tracks, {size_mb:.1f} MB on disk.")

    if args.upload:
        upload_to_r2(args.out, args.r2_key.strip() or DEFAULT_R2_KEY)

    print(
        "Worker: set MERT_CATALOG_PATH to this file, or omit it to download from R2."
    )


if __name__ == "__main__":
    main()
