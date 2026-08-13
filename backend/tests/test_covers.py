"""Cover generation contract.

A cover is a card's visual fingerprint, so the properties that matter are
determinism (the same embedding always draws the same card) and staying inside
the bounds the front-end assumes when it lays glyphs out.

Run with:  python -m unittest discover -s backend/tests
"""

import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.covers import (  # noqa: E402
    COVER_VERSION,
    MOTIF_COUNT,
    MOTIF_MIN_COUNT,
    MOTIF_SHAPES,
    MOTIF_SIZE,
    PALETTES,
    PATTERNS,
    build_cover,
)


def embedding(seed: int, dimensions: int = 64) -> list[float]:
    rng = random.Random(seed)
    return [rng.gauss(0, 1) for _ in range(dimensions)]


class BuildCoverTests(unittest.TestCase):
    def test_is_deterministic(self):
        first = build_cover(embedding(1))
        second = build_cover(embedding(1))
        self.assertEqual(first, second)

    def test_differs_between_embeddings(self):
        seeds = {build_cover(embedding(i))["seed"] for i in range(12)}
        self.assertEqual(len(seeds), 12, "distinct embeddings should draw distinct cards")

    def test_is_scale_invariant(self):
        """Embeddings are normalised, so magnitude must not change the cover."""
        base = embedding(7)
        scaled = [value * 3.5 for value in base]
        self.assertEqual(build_cover(base)["seed"], build_cover(scaled)["seed"])

    def test_rejects_empty_embedding(self):
        with self.assertRaises(ValueError):
            build_cover([])

    def test_motif_count_stays_in_the_designed_range(self):
        for index in range(60):
            motifs = build_cover(embedding(index))["motifs"]
            self.assertGreaterEqual(len(motifs), MOTIF_MIN_COUNT)
            self.assertLessEqual(len(motifs), MOTIF_COUNT)

    def test_motifs_stay_inside_the_border_band(self):
        """x/y are percentages the front-end positions glyphs with; a glyph is
        MOTIF_SIZE wide and centred, so it must not run off the cover."""
        half = MOTIF_SIZE / 2
        for index in range(40):
            for motif in build_cover(embedding(index))["motifs"]:
                self.assertGreaterEqual(motif["x"] - half, 0, motif)
                self.assertLessEqual(motif["x"] + half, 100, motif)
                self.assertGreaterEqual(motif["y"] - half, 0, motif)
                self.assertLessEqual(motif["y"] + half, 100, motif)

    def test_motifs_leave_the_middle_clear_for_the_mark(self):
        """The design reserves the central 50% for the logo."""
        for index in range(40):
            for motif in build_cover(embedding(index))["motifs"]:
                in_middle = 25 < motif["x"] < 75 and 25 < motif["y"] < 75
                self.assertFalse(in_middle, f"motif sits over the mark: {motif}")

    def test_motifs_never_share_a_slot(self):
        for index in range(30):
            motifs = build_cover(embedding(index))["motifs"]
            slots = {(round(m["x"] / 10), round(m["y"] / 10)) for m in motifs}
            self.assertEqual(len(slots), len(motifs), "two glyphs landed on one slot")

    def test_shapes_and_opacity_are_renderable(self):
        for index in range(30):
            for motif in build_cover(embedding(index))["motifs"]:
                self.assertIn(motif["shape"], MOTIF_SHAPES)
                self.assertGreater(motif["opacity"], 0)
                self.assertLessEqual(motif["opacity"], 1)
                self.assertGreaterEqual(motif["weight"], 0)
                self.assertLessEqual(motif["weight"], 1)
                self.assertEqual(motif["size"], MOTIF_SIZE)

    def test_palette_and_pattern_come_from_the_known_sets(self):
        accents = {palette["accent"] for palette in PALETTES}
        for index in range(30):
            cover = build_cover(embedding(index))
            self.assertIn(cover["accent"], accents)
            self.assertIn(cover["pattern"], PATTERNS)
            self.assertEqual(cover["version"], COVER_VERSION)

    def test_colour_matches_its_accent(self):
        """The relation canvas colours nodes from cover.color and falls back to
        the accent class, so the two must never disagree."""
        by_accent = {palette["accent"]: palette for palette in PALETTES}
        for index in range(30):
            cover = build_cover(embedding(index))
            palette = by_accent[cover["accent"]]
            self.assertEqual(cover["color"], palette["color"])
            self.assertEqual(cover["soft_color"], palette["soft_color"])
            self.assertEqual(cover["background"], palette["background"])

    def test_focus_inputs_stay_normalised(self):
        """density and orbit feed CSS percentages; out-of-range values would
        push the cover's focal gradient off the card."""
        for index in range(30):
            cover = build_cover(embedding(index))
            self.assertTrue(0 <= cover["density"] <= 1, cover["density"])
            self.assertTrue(0 <= cover["orbit"] <= 1, cover["orbit"])

    def test_drops_the_fields_the_front_end_no_longer_reads(self):
        cover = build_cover(embedding(3))
        for gone in ("rotation", "scale"):
            self.assertNotIn(gone, cover)
        self.assertNotIn("rotation", cover["motifs"][0])

    def test_handles_a_zero_vector_without_dividing_by_zero(self):
        cover = build_cover([0.0] * 32)
        self.assertEqual(len(cover["seed"]), 16)
        self.assertTrue(all(math.isfinite(m["x"]) for m in cover["motifs"]))


if __name__ == "__main__":
    unittest.main()
