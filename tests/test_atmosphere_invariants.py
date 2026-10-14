from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
ATMOSPHERE = (ROOT / "atmosphere.js").read_text()
LOCK = (ROOT / "lockScreen.js").read_text()


class AtmosphereInvariantTests(unittest.TestCase):
    """The load-bearing safety properties of the atmosphere layer, in the
    same source-assertion style as the rest of this suite. Each one is a
    way a full-screen lock-screen effect can hurt its host."""

    def test_the_atmosphere_sits_above_wallpapers_and_never_intercepts(self) -> None:
        # Above the blurred backgrounds so weather stays crisp, below
        # everything else in the dialog, and reactive: false so clicks,
        # swipes and keys reach the unlock dialog untouched.
        self.assertIn("insert_child_above(atmosphere, dialog._backgroundGroup)", LOCK)
        self.assertIn("super._init({reactive: false})", ATMOSPHERE)

    def test_sky_detection_is_cached_and_off_the_frame_path(self) -> None:
        # Segmentation runs per wallpaper from an idle handler, cached —
        # never inside the per-frame tick.
        self.assertIn("GLib.idle_add", ATMOSPHERE)
        self.assertIn("skyCache", ATMOSPHERE)
        tick = ATMOSPHERE[ATMOSPHERE.index("    _tick(t) {"):]
        tick = tick[: tick.index("\n    }\n")]
        self.assertNotIn("computeSky", tick)
        self.assertNotIn("Pixbuf", tick)

    def test_particle_counts_are_capped(self) -> None:
        # Hundreds of actors in the shell process is the design; an
        # unbounded count scaled by area and density prefs is not.
        self.assertIn("Math.min(520,", ATMOSPHERE)
        self.assertIn("Math.min(300,", ATMOSPHERE)
        self.assertIn("Math.min(170,", ATMOSPHERE)

    def test_every_category_name_matches_the_service_vocabulary(self) -> None:
        # describeWmoCode says 'partly-cloudy'; a bare 'partly' comparison
        # silently produced an empty atmosphere for a common condition.
        self.assertNotIn("=== 'partly'", ATMOSPHERE)
        self.assertNotIn("{partly:", ATMOSPHERE)

    def test_wind_direction_changes_rebuild_the_scene(self) -> None:
        body = ATMOSPHERE[ATMOSPHERE.index("    _sceneKeyFor(scene) {"):]
        body = body[: body.index("\n    }\n")]
        self.assertIn("scene.slant", body)

    def test_no_sky_means_no_moon(self) -> None:
        # A fixed fallback position put a moon over a forest wallpaper.
        self.assertNotIn("?? W * 0.79", ATMOSPHERE)
        self.assertIn("if (spot) {", ATMOSPHERE)

    def test_the_prompt_quiets_but_keeps_the_atmosphere(self) -> None:
        self.assertIn("setPromptProgress(progress)", LOCK)
        self.assertIn("1 - 0.55 * clamp(progress, 0, 1)", ATMOSPHERE)


if __name__ == "__main__":
    unittest.main()
