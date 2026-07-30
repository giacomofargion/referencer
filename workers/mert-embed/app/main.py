"""FastAPI worker: MERT embed + in-process ANN over an R2/local catalog.

The song catalog is a packed npz (vectors + metadata) stored on Cloudflare R2
(or a local path for dev). Neon stays for app data only — not vectors.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.catalog import catalog, ensure_catalog_loaded
from app.embedder import EMBED_DIM, embed_audio_bytes
from app.genre import get_classifier


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    try:
        ensure_catalog_loaded()
    except Exception as exc:  # noqa: BLE001
        # Start anyway so /health can report the failure; /similar will 503.
        print(f"WARNING: catalog not loaded at startup: {exc}")
    try:
        get_classifier().load()
        print("Discogs genre classifier ready")
    except Exception as exc:  # noqa: BLE001
        print(f"WARNING: Discogs genre classifier not loaded: {exc}")
    yield


app = FastAPI(
    title="Referencer MERT embed worker",
    description="MERT-v1-95M embed + cosine ANN over shared R2 catalog",
    version="0.3.0",
    lifespan=lifespan,
)


class EmbedResponse(BaseModel):
    embedding: list[float] = Field(..., min_length=EMBED_DIM, max_length=EMBED_DIM)
    dim: int = EMBED_DIM


class SimilarHit(BaseModel):
    spotifyId: str
    title: str
    artist: str
    album: str | None = None
    genre: str | None = None
    distance: float


class SimilarResponse(BaseModel):
    hits: list[SimilarHit]
    catalogSize: int
    predictedGenre: str | None = None
    genreConfidence: float | None = None
    discogsLabel: str | None = None


class HealthResponse(BaseModel):
    ok: bool
    model: str = "m-a-p/MERT-v1-95M"
    embedDim: int = EMBED_DIM
    catalogReady: bool = False
    catalogSize: int = 0
    catalogSource: str | None = None
    genreReady: bool = False


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    genre_ready = False
    try:
        genre_ready = get_classifier().ready
    except Exception:  # noqa: BLE001
        genre_ready = False
    return HealthResponse(
        ok=True,
        catalogReady=catalog.ready,
        catalogSize=catalog.size,
        catalogSource=catalog.source,
        genreReady=genre_ready,
    )


@app.post("/embed", response_model=EmbedResponse)
async def embed(audio: UploadFile = File(...)) -> EmbedResponse:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")

    try:
        vector = embed_audio_bytes(data)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Embed failed: {exc}") from exc

    return EmbedResponse(embedding=vector.tolist())


@app.post("/similar", response_model=SimilarResponse)
async def similar(
    audio: UploadFile = File(...),
    limit: int = Query(40, ge=1, le=100),
) -> SimilarResponse:
    if not catalog.ready:
        # Lazy retry if startup download failed (e.g. R2 momentarily down).
        try:
            ensure_catalog_loaded()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=503,
                detail=f"Catalog unavailable: {exc}",
            ) from exc

    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio upload")

    predicted_genre: str | None = None
    genre_confidence: float | None = None
    discogs_label: str | None = None
    try:
        genre_pred = get_classifier().predict_bytes(data)
        predicted_genre = genre_pred.catalog_genre
        genre_confidence = genre_pred.confidence
        discogs_label = genre_pred.discogs_label
    except Exception as exc:  # noqa: BLE001
        print(f"Genre classification failed (continuing without filter): {exc}")

    try:
        vector = embed_audio_bytes(data)
        # Over-fetch when we can genre-filter, so we still return `limit` hits.
        fetch_limit = min(100, limit * 3) if predicted_genre else limit
        hits = catalog.search(vector, limit=fetch_limit)
        if predicted_genre:
            filtered = [h for h in hits if (h.genre or "").strip() == predicted_genre]
            # Keep filter only when it still leaves a usable pool.
            if len(filtered) >= max(4, limit // 2):
                hits = filtered[:limit]
            else:
                hits = hits[:limit]
        else:
            hits = hits[:limit]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Similar failed: {exc}") from exc

    return SimilarResponse(
        hits=[
            SimilarHit(
                spotifyId=h.spotify_id,
                title=h.title,
                artist=h.artist,
                album=h.album,
                genre=h.genre,
                distance=h.distance,
            )
            for h in hits
        ],
        catalogSize=catalog.size,
        predictedGenre=predicted_genre,
        genreConfidence=genre_confidence,
        discogsLabel=discogs_label,
    )


def main() -> None:
    import uvicorn

    host = os.environ.get("MERT_HOST", "127.0.0.1")
    port = int(os.environ.get("MERT_PORT", "8091"))
    uvicorn.run("app.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
