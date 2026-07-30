"""MERT-v1-95M utterance embedding (768-d), L2-normalized.

Matches the Kaggle 490k catalog dimensionality. We mean-pool over time and
average across transformer layers so the vector is robust without knowing
the exact layer the dataset author used.
"""

from __future__ import annotations

import io
from functools import lru_cache

import av
import numpy as np
import torch
import torchaudio
from transformers import AutoModel, Wav2Vec2FeatureExtractor

MODEL_ID = "m-a-p/MERT-v1-95M"
MAX_SECONDS = 30.0
EMBED_DIM = 768


@lru_cache(maxsize=1)
def _load_model() -> tuple[Wav2Vec2FeatureExtractor, AutoModel, torch.device]:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    processor = Wav2Vec2FeatureExtractor.from_pretrained(
        MODEL_ID, trust_remote_code=True
    )
    model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
    model.eval()
    model.to(device)
    return processor, model, device


def _load_mono_pcm(audio_bytes: bytes) -> tuple[torch.Tensor, int]:
    """Decode MP3/WAV/etc via PyAV (no TorchCodec required)."""
    container = av.open(io.BytesIO(audio_bytes))
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("No audio stream in upload")

        sample_rate = int(stream.rate or 0)
        chunks: list[np.ndarray] = []
        for frame in container.decode(stream):
            # layout: (channels, samples) float32 in [-1, 1]
            arr = frame.to_ndarray()
            if arr.dtype != np.float32:
                # Integer PCM → float
                info = np.iinfo(arr.dtype) if np.issubdtype(arr.dtype, np.integer) else None
                if info is not None:
                    arr = arr.astype(np.float32) / max(abs(info.min), info.max)
                else:
                    arr = arr.astype(np.float32)
            if arr.ndim == 1:
                arr = arr[np.newaxis, :]
            chunks.append(arr)
            if sample_rate and sum(c.shape[-1] for c in chunks) >= int(
                MAX_SECONDS * sample_rate * 1.1
            ):
                break

        if not chunks:
            raise ValueError("Could not decode any audio frames")

        pcm = np.concatenate(chunks, axis=1)
        if sample_rate <= 0:
            sample_rate = 44100
        mono = pcm.mean(axis=0) if pcm.shape[0] > 1 else pcm[0]
        return torch.from_numpy(np.ascontiguousarray(mono)), sample_rate
    finally:
        container.close()


def embed_audio_bytes(audio_bytes: bytes) -> np.ndarray:
    processor, model, device = _load_model()
    waveform, sample_rate = _load_mono_pcm(audio_bytes)

    target_rate = int(processor.sampling_rate)
    if sample_rate != target_rate:
        waveform = torchaudio.functional.resample(waveform, sample_rate, target_rate)

    max_samples = int(MAX_SECONDS * target_rate)
    if waveform.numel() > max_samples:
        waveform = waveform[:max_samples]
    if waveform.numel() < target_rate // 4:
        raise ValueError("Audio too short to embed (need ~0.25s+)")

    inputs = processor(
        waveform.numpy(),
        sampling_rate=target_rate,
        return_tensors="pt",
    )
    inputs = {k: v.to(device) for k, v in inputs.items()}

    with torch.no_grad():
        outputs = model(**inputs, output_hidden_states=True)

    # Stack layers → [layers, time, dim], mean over time then layers → [dim]
    layers = torch.stack(outputs.hidden_states).squeeze()
    if layers.dim() == 2:
        time_reduced = layers.mean(dim=0)
    else:
        time_reduced = layers.mean(dim=1).mean(dim=0)

    vec = time_reduced.detach().float().cpu().numpy().astype(np.float32)
    if vec.shape[0] != EMBED_DIM:
        raise RuntimeError(f"Unexpected embedding dim {vec.shape[0]}, expected {EMBED_DIM}")

    norm = np.linalg.norm(vec) + 1e-12
    return (vec / norm).astype(np.float32)
