"""Shared MERT song catalog: load from local path or R2, ANN via dense matmul.

Embeddings are L2-normalized float32 [N, 768], so cosine similarity = dot product
and cosine distance = 1 - similarity (same convention as pgvector <=>).
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

EMBED_DIM = 768

# Default object key inside the app's R2 bucket.
DEFAULT_R2_CATALOG_KEY = "catalog/mert-v1-95m.npz"


@dataclass(frozen=True)
class CatalogHit:
    spotify_id: str
    title: str
    artist: str
    album: str | None
    genre: str | None
    distance: float


class CatalogStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._embeddings: np.ndarray | None = None
        self._spotify_ids: np.ndarray | None = None
        self._titles: np.ndarray | None = None
        self._artists: np.ndarray | None = None
        self._albums: np.ndarray | None = None
        self._genres: np.ndarray | None = None
        self._source: str | None = None

    @property
    def ready(self) -> bool:
        return self._embeddings is not None

    @property
    def size(self) -> int:
        if self._embeddings is None:
            return 0
        return int(self._embeddings.shape[0])

    @property
    def source(self) -> str | None:
        return self._source

    def load_npz(self, path: Path, *, source: str | None = None) -> None:
        data = np.load(path, allow_pickle=True)
        required = ("embeddings", "spotify_id", "title", "artist")
        missing = [k for k in required if k not in data.files]
        if missing:
            raise ValueError(f"Catalog npz missing keys {missing}; got {sorted(data.files)}")

        embeddings = np.asarray(data["embeddings"], dtype=np.float32)
        if embeddings.ndim != 2 or embeddings.shape[1] != EMBED_DIM:
            raise ValueError(f"Expected embeddings [N, {EMBED_DIM}], got {embeddings.shape}")

        # Ensure L2-normalized (pack script already does this; cheap safety).
        norms = np.linalg.norm(embeddings, axis=1, keepdims=True) + 1e-12
        embeddings = embeddings / norms

        albums = (
            np.asarray(data["album"], dtype=object)
            if "album" in data.files
            else np.array([""] * len(embeddings), dtype=object)
        )
        genres = (
            np.asarray(data["genre"], dtype=object)
            if "genre" in data.files
            else np.array([""] * len(embeddings), dtype=object)
        )

        with self._lock:
            self._embeddings = embeddings
            self._spotify_ids = np.asarray(data["spotify_id"], dtype=object)
            self._titles = np.asarray(data["title"], dtype=object)
            self._artists = np.asarray(data["artist"], dtype=object)
            self._albums = albums
            self._genres = genres
            self._source = source or str(path)

    def search(self, query: np.ndarray, *, limit: int = 40) -> list[CatalogHit]:
        with self._lock:
            if self._embeddings is None:
                raise RuntimeError("Catalog not loaded")
            embeddings = self._embeddings
            spotify_ids = self._spotify_ids
            titles = self._titles
            artists = self._artists
            albums = self._albums
            genres = self._genres

        assert spotify_ids is not None
        assert titles is not None
        assert artists is not None
        assert albums is not None
        assert genres is not None

        q = np.asarray(query, dtype=np.float32).reshape(-1)
        if q.shape[0] != EMBED_DIM:
            raise ValueError(f"Expected {EMBED_DIM}-d query, got {q.shape[0]}")
        q = q / (np.linalg.norm(q) + 1e-12)

        top_k = max(1, min(int(limit), embeddings.shape[0]))
        # Cosine similarity for unit vectors; take top-k without full argsort.
        scores = embeddings @ q
        if top_k >= scores.shape[0]:
            idx = np.argsort(-scores)
        else:
            # argpartition is O(n); then sort the small slice.
            part = np.argpartition(-scores, top_k - 1)[:top_k]
            idx = part[np.argsort(-scores[part])]

        hits: list[CatalogHit] = []
        for i in idx:
            album = str(albums[i] or "")
            genre = str(genres[i] or "")
            hits.append(
                CatalogHit(
                    spotify_id=str(spotify_ids[i]),
                    title=str(titles[i] or ""),
                    artist=str(artists[i] or ""),
                    album=album or None,
                    genre=genre or None,
                    distance=float(1.0 - scores[i]),
                )
            )
        return hits


catalog = CatalogStore()


def resolve_catalog_path() -> Path | None:
    """Prefer an explicit local path; else the default cache under data/."""
    raw = os.environ.get("MERT_CATALOG_PATH", "").strip()
    if raw:
        path = Path(raw).expanduser()
        return path if path.is_file() else None

    default = Path(__file__).resolve().parents[1] / "data" / "catalog.npz"
    return default if default.is_file() else None


def download_catalog_from_r2(dest: Path) -> Path:
    """Download catalog object from Cloudflare R2 into dest."""
    try:
        import boto3
    except ImportError as exc:
        raise RuntimeError(
            "boto3 is required to download the catalog from R2 — pip install boto3"
        ) from exc

    account_id = os.environ.get("R2_ACCOUNT_ID", "").strip()
    access_key = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    bucket = os.environ.get("R2_BUCKET_NAME", "").strip()
    key = (
        os.environ.get("R2_CATALOG_KEY", DEFAULT_R2_CATALOG_KEY).strip()
        or DEFAULT_R2_CATALOG_KEY
    )

    if not all([account_id, access_key, secret_key, bucket]):
        raise RuntimeError(
            "R2 credentials missing — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, "
            "R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME (or set MERT_CATALOG_PATH)"
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")

    client = boto3.client(
        "s3",
        endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
    )
    print(f"Downloading s3://{bucket}/{key} → {dest} …")
    client.download_file(bucket, key, str(tmp))
    tmp.replace(dest)
    return dest


def load_dotenv_local() -> None:
    """Pull R2 keys from the Next.js .env.local when running the worker locally."""
    root = Path(__file__).resolve().parents[3]
    env_path = root / ".env.local"
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


def ensure_catalog_loaded() -> None:
    """Load catalog once at startup: local path first, else download from R2."""
    if catalog.ready:
        return

    load_dotenv_local()

    path = resolve_catalog_path()
    source: str
    if path is not None:
        source = f"file:{path}"
    else:
        cache = Path(__file__).resolve().parents[1] / "data" / "catalog.npz"
        # Re-download if missing; keep cache across restarts.
        if not cache.is_file():
            download_catalog_from_r2(cache)
        path = cache
        key = os.environ.get("R2_CATALOG_KEY", DEFAULT_R2_CATALOG_KEY).strip()
        source = f"r2:{key}"

    print(f"Loading MERT catalog from {path} …")
    catalog.load_npz(path, source=source)
    print(f"Catalog ready: {catalog.size:,} tracks ({catalog.source})")
