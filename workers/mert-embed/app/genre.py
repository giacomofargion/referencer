"""Discogs-EffNet genre tagging (400 Discogs styles → catalog genre).

Two-stage Essentia pipeline:
  1) discogs-effnet-bs64-1.pb — mel patches [64, 128, 96] → embeddings [64, 1280]
     (PartitionedCall:1)
  2) genre_discogs400-discogs-effnet-1.pb — embeddings → 400-class sigmoid
     (serving_default_model_Placeholder → PartitionedCall:0)
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import tensorflow as tf

MODELS_DIR = Path(__file__).resolve().parents[1] / "models"
EFFNET_PB = MODELS_DIR / "discogs-effnet-bs64-1.pb"
HEAD_PB = MODELS_DIR / "genre_discogs400-discogs-effnet-1.pb"
LABELS_JSON = MODELS_DIR / "genre_discogs400-discogs-effnet-1.json"

SAMPLE_RATE = 16_000
N_FFT = 512
HOP = 256
N_MELS = 96
PATCH_FRAMES = 128
BATCH_SIZE = 64
EMBED_DIM = 1280
# Max seconds of audio to classify (centered) — keeps inference snappy.
MAX_SECONDS = 45.0

# Kaggle catalog genres in mert catalog.npz
CATALOG_GENRES = (
    "Rock",
    "Pop",
    "Electronic",
    "Folk",
    "Country",
    "Hip-Hop",
    "R&B",
    "Jazz",
    "Blues",
    "Classical",
)


@dataclass(frozen=True)
class GenrePrediction:
    catalog_genre: str
    confidence: float
    discogs_label: str
    top_discogs: list[tuple[str, float]]


def _discogs_parent_to_catalog(parent: str) -> str | None:
    p = parent.strip().lower()
    mapping = {
        "blues": "Blues",
        "classical": "Classical",
        "electronic": "Electronic",
        "folk, world, & country": "Folk",  # refined below for country
        "funk / soul": "R&B",
        "hip hop": "Hip-Hop",
        "jazz": "Jazz",
        "pop": "Pop",
        "rock": "Rock",
        "reggae": "Pop",
        "latin": "Pop",
        "stage & screen": "Classical",
        "brass & military": "Classical",
        "children's": "Pop",
        "non-music": None,
    }
    if p.startswith("folk") and "country" in p:
        # Discogs parent is shared; prefer Folk unless style says Country.
        return "Folk"
    return mapping.get(p)


def discogs_label_to_catalog(label: str) -> str | None:
    """Map `Parent---Style` Discogs tag onto the Kaggle catalog genre."""
    if "---" not in label:
        return _discogs_parent_to_catalog(label)
    parent, style = label.split("---", 1)
    style_l = style.strip().lower()
    parent_l = parent.strip().lower()

    if parent_l.startswith("folk") and "country" in style_l:
        return "Country"
    if parent_l.startswith("folk"):
        return "Folk"
    if "drum n bass" in style_l or "jungle" in style_l or "breakbeat" in style_l:
        return "Electronic"
    if "r&b" in style_l or "rhythm & blues" in style_l or "soul" in style_l:
        return "R&B"
    if "hip hop" in style_l or "trap" in style_l:
        return "Hip-Hop"

    return _discogs_parent_to_catalog(parent)


def _load_graph_session(pb_path: Path) -> tuple[tf.Graph, tf.compat.v1.Session]:
    graph_def = tf.compat.v1.GraphDef()
    graph_def.ParseFromString(pb_path.read_bytes())
    graph = tf.Graph()
    with graph.as_default():
        tf.import_graph_def(graph_def, name="")
        session = tf.compat.v1.Session(graph=graph)
    return graph, session


class DiscogsGenreClassifier:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._effnet_session: tf.compat.v1.Session | None = None
        self._effnet_input = None
        self._effnet_embed = None
        self._head_session: tf.compat.v1.Session | None = None
        self._head_input = None
        self._head_output = None
        self._labels: list[str] = []

    @property
    def ready(self) -> bool:
        return (
            self._effnet_session is not None
            and self._head_session is not None
            and bool(self._labels)
        )

    def load(self) -> None:
        # Serialize init so concurrent predict/health callers share one pair of sessions.
        with self._lock:
            if self.ready:
                return
            missing = [
                path.name
                for path in (EFFNET_PB, HEAD_PB, LABELS_JSON)
                if not path.is_file()
            ]
            if missing:
                raise FileNotFoundError(
                    f"Discogs models missing under {MODELS_DIR}: {', '.join(missing)} — "
                    "run scripts/download_discogs_models.sh"
                )

            meta = json.loads(LABELS_JSON.read_text())
            self._labels = list(meta["classes"])

            effnet_graph, self._effnet_session = _load_graph_session(EFFNET_PB)
            self._effnet_input = effnet_graph.get_tensor_by_name(
                "serving_default_melspectrogram:0"
            )
            # Embedding output — do not use PartitionedCall:0 on this graph for labels.
            self._effnet_embed = effnet_graph.get_tensor_by_name("PartitionedCall:1")

            head_graph, self._head_session = _load_graph_session(HEAD_PB)
            self._head_input = head_graph.get_tensor_by_name(
                "serving_default_model_Placeholder:0"
            )
            self._head_output = head_graph.get_tensor_by_name("PartitionedCall:0")

            # Warmup both stages
            mel_zeros = np.zeros(
                (BATCH_SIZE, PATCH_FRAMES, N_MELS), dtype=np.float32
            )
            embed_zeros = np.zeros((BATCH_SIZE, EMBED_DIM), dtype=np.float32)
            assert self._effnet_session is not None and self._head_session is not None
            self._effnet_session.run(self._effnet_embed, {self._effnet_input: mel_zeros})
            self._head_session.run(self._head_output, {self._head_input: embed_zeros})

    def predict_bytes(self, audio_bytes: bytes) -> GenrePrediction:
        self.load()
        assert (
            self._effnet_session is not None
            and self._effnet_input is not None
            and self._effnet_embed is not None
            and self._head_session is not None
            and self._head_input is not None
            and self._head_output is not None
        )

        y, _ = librosa.load(io_bytes_to_pathlike(audio_bytes), sr=SAMPLE_RATE, mono=True)
        if y.size < SAMPLE_RATE // 4:
            raise ValueError("Audio too short for genre classification")

        max_samples = int(MAX_SECONDS * SAMPLE_RATE)
        if y.size > max_samples:
            start = (y.size - max_samples) // 2
            y = y[start : start + max_samples]

        patches = mel_patches(y)
        if patches.shape[0] == 0:
            raise ValueError("Could not build mel patches for genre classification")

        scores = np.zeros(len(self._labels), dtype=np.float64)
        n_batches = 0
        for i in range(0, patches.shape[0], BATCH_SIZE):
            batch = patches[i : i + BATCH_SIZE]
            if batch.shape[0] < BATCH_SIZE:
                pad = np.zeros(
                    (BATCH_SIZE - batch.shape[0], PATCH_FRAMES, N_MELS),
                    dtype=np.float32,
                )
                valid = batch.shape[0]
                batch = np.concatenate([batch, pad], axis=0)
            else:
                valid = BATCH_SIZE
            embeddings = self._effnet_session.run(
                self._effnet_embed, {self._effnet_input: batch}
            )
            # Head accepts dynamic batch — only the real patches, not EffNet padding.
            out = self._head_session.run(
                self._head_output,
                {self._head_input: embeddings[:valid]},
            )
            scores += out.sum(axis=0)
            n_batches += valid

        scores /= max(1, n_batches)
        top_idx = np.argsort(-scores)[:8]
        top = [(self._labels[i], float(scores[i])) for i in top_idx]

        # Aggregate parent/catalog scores from all Discogs classes.
        catalog_scores: dict[str, float] = {g: 0.0 for g in CATALOG_GENRES}
        for label, score in zip(self._labels, scores):
            catalog = discogs_label_to_catalog(label)
            if catalog:
                catalog_scores[catalog] += float(score)

        catalog_genre = max(catalog_scores.items(), key=lambda kv: kv[1])[0]
        confidence = float(catalog_scores[catalog_genre])
        # Normalize confidence roughly into [0,1] vs sum of catalog mass.
        mass = sum(catalog_scores.values()) + 1e-9
        confidence = confidence / mass

        return GenrePrediction(
            catalog_genre=catalog_genre,
            confidence=confidence,
            discogs_label=top[0][0],
            top_discogs=top,
        )


def io_bytes_to_pathlike(audio_bytes: bytes):
    """librosa.load accepts file-like objects via pathlib/BytesIO."""
    import io

    return io.BytesIO(audio_bytes)


def mel_patches(y: np.ndarray) -> np.ndarray:
    """Build log-mel patches shaped [N, 128, 96] approximating TensorflowInputMusiCNN."""
    mel = librosa.feature.melspectrogram(
        y=y,
        sr=SAMPLE_RATE,
        n_fft=N_FFT,
        hop_length=HOP,
        win_length=N_FFT,
        window="hann",
        n_mels=N_MELS,
        fmin=0.0,
        fmax=SAMPLE_RATE / 2,
        power=2.0,
    )
    # Essentia MusiCNN path uses log10 mel bands.
    logmel = np.log10(1.0 + mel).T.astype(np.float32)  # [frames, 96]
    if logmel.shape[0] < PATCH_FRAMES:
        pad = np.zeros((PATCH_FRAMES - logmel.shape[0], N_MELS), dtype=np.float32)
        logmel = np.concatenate([logmel, pad], axis=0)

    # Hop patches by half window (same idea as the Discogs JS demo).
    step = PATCH_FRAMES // 2
    patches = []
    for start in range(0, logmel.shape[0] - PATCH_FRAMES + 1, step):
        patches.append(logmel[start : start + PATCH_FRAMES])
    if not patches:
        patches.append(logmel[:PATCH_FRAMES])
    return np.stack(patches, axis=0)


_classifier: DiscogsGenreClassifier | None = None
_classifier_lock = threading.Lock()


def get_classifier() -> DiscogsGenreClassifier:
    global _classifier
    with _classifier_lock:
        if _classifier is None:
            _classifier = DiscogsGenreClassifier()
        return _classifier
