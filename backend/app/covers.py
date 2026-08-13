import hashlib
import math
from typing import Sequence


COVER_VERSION = 10
MOTIF_COUNT = 12
MOTIF_MIN_COUNT = 8
MOTIF_SIZE = 13.5
MOTIF_SHAPES = (
    "steps",
    "quad",
    "nested",
    "crosshair-box",
    "link",
    "target",
    "triple-dot",
    "constellation",
    "folder",
    "stack",
    "arch",
    "lines",
    "corners",
    "diagonal",
    "pill",
    "brackets",
    "bars",
    "crosshair",
)
# Slots hug the border band; the middle of the cover stays clear for the mark.
MOTIF_LAYOUT = (
    (12.0, 13.0),
    (38.0, 10.0),
    (64.0, 10.0),
    (88.0, 13.0),
    (90.0, 38.0),
    (90.0, 62.0),
    (88.0, 87.0),
    (64.0, 90.0),
    (38.0, 90.0),
    (12.0, 87.0),
    (10.0, 62.0),
    (10.0, 38.0),
)
PATTERNS = ("orbit", "grid", "ladder", "shelf")
PALETTES = (
    {
        "accent": "coral",
        "color": "#c96f5f",
        "soft_color": "#f0d5cc",
        "background": "#fbf1eb",
    },
    {
        "accent": "sky",
        "color": "#4e91a8",
        "soft_color": "#d7e8ed",
        "background": "#eef7f8",
    },
    {
        "accent": "lavender",
        "color": "#8068a4",
        "soft_color": "#e4dced",
        "background": "#f5f0f8",
    },
    {
        "accent": "mint",
        "color": "#4d9b8e",
        "soft_color": "#d7ebe5",
        "background": "#eef8f4",
    },
)


def _unit_value(digest: str, offset: int) -> float:
    start = offset % (len(digest) - 8)
    return int(digest[start : start + 8], 16) / 0xFFFFFFFF


def _chunk_average(values: Sequence[float], index: int, count: int = 8) -> float:
    start = index * len(values) // count
    end = max(start + 1, (index + 1) * len(values) // count)
    chunk = values[start:end]
    return sum(chunk) / len(chunk)


def _chunk_features(values: Sequence[float], index: int, count: int = MOTIF_COUNT) -> tuple[float, float, float]:
    start = index * len(values) // count
    end = max(start + 1, (index + 1) * len(values) // count)
    chunk = values[start:end]
    average = sum(chunk) / len(chunk)
    energy = math.sqrt(sum(value * value for value in chunk) / len(chunk))
    variation = sum(abs(next_value - value) for value, next_value in zip(chunk, chunk[1:])) / max(1, len(chunk) - 1)
    return average, energy, variation


def build_cover(embedding: Sequence[float]) -> dict[str, object]:
    """Create a stable visual fingerprint from an embedding."""
    to_list = getattr(embedding, "to_list", None)
    raw_values = to_list() if callable(to_list) else embedding
    values = [float(value) for value in raw_values]
    if not values:
        raise ValueError("Cannot build a cover from an empty embedding")

    normalized = math.sqrt(sum(value * value for value in values)) or 1.0
    stable_values = [value / normalized for value in values]
    fingerprint = ",".join(f"{value:.8f}" for value in stable_values).encode("utf-8")
    digest = hashlib.sha256(fingerprint).hexdigest()
    chunks = [_chunk_average(stable_values, index) for index in range(8)]
    features = [_chunk_features(stable_values, index) for index in range(MOTIF_COUNT)]
    max_average = max(abs(average) for average, _, _ in features) or 1.0
    max_energy = max(energy for _, energy, _ in features) or 1.0
    max_variation = max(variation for _, _, variation in features) or 1.0

    pattern = PATTERNS[int(_unit_value(digest, 0) * len(PATTERNS)) % len(PATTERNS)]
    palette = PALETTES[
        int((abs(chunks[0]) + _unit_value(digest, 12)) * len(PALETTES)) % len(PALETTES)
    ]
    # 8–12 glyphs per cover: sparser cards read as calmer, denser ones as busier.
    motif_count = MOTIF_MIN_COUNT + int(_unit_value(digest, 52) * (MOTIF_COUNT - MOTIF_MIN_COUNT + 1))
    motif_count = min(motif_count, MOTIF_COUNT)
    slot_order = sorted(
        range(MOTIF_COUNT),
        key=lambda index: _unit_value(digest, 60 + index * 3),
    )
    kept_slots = sorted(slot_order[:motif_count])

    motifs = []
    for index in kept_slots:
        average, energy, variation = features[index]
        average_ratio = (average / max_average + 1) / 2
        energy_ratio = energy / max_energy
        variation_ratio = variation / max_variation
        x, y = MOTIF_LAYOUT[index]
        shape_index = int(
            (
                average_ratio * 2.1
                + energy_ratio * 3.4
                + variation_ratio * 4.7
                + _unit_value(digest, 44 + index * 5)
            )
            * len(MOTIF_SHAPES)
        ) % len(MOTIF_SHAPES)
        motifs.append(
            {
                "shape": MOTIF_SHAPES[shape_index],
                "x": round(x + (variation_ratio - 0.5) * 4, 2),
                "y": round(y + (average_ratio - 0.5) * 4, 2),
                "size": MOTIF_SIZE,
                "opacity": round(0.42 + energy_ratio * 0.38, 3),
                "weight": round(energy_ratio, 3),
            }
        )

    return {
        "version": COVER_VERSION,
        "seed": digest[:16],
        "pattern": pattern,
        "accent": palette["accent"],
        "color": palette["color"],
        "soft_color": palette["soft_color"],
        "background": palette["background"],
        "density": round(0.55 + abs(chunks[3]) * 0.45, 3),
        "orbit": round(abs(chunks[5]) * 0.9 + _unit_value(digest, 36) * 0.1, 3),
        "motifs": motifs,
    }
