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
        # A couple of hundred actors in the shell process is the design;
        # an unbounded count scaled by area and density prefs is not.
        # The caps are for the one clock stage — the full-screen version
        # allowed 520 drops per monitor and lagged the wake transition.
        self.assertIn("Math.min(170,", ATMOSPHERE)
        self.assertIn("Math.min(110,", ATMOSPHERE)
        self.assertIn("Math.min(70,", ATMOSPHERE)

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

    def test_only_the_primary_monitor_gets_a_stage(self) -> None:
        # One bounded stage around the clock; other monitors keep the
        # graded wallpaper only. Layers for every monitor tripled the
        # per-frame repaint and read as wallpaper noise.
        self.assertIn("primaryIndex: Main.layoutManager.primaryIndex", LOCK)
        build = ATMOSPHERE[ATMOSPHERE.index("    _buildLayers() {"):]
        build = build[: build.index("\n    }\n")]
        self.assertIn("this._monitors[index]", build)
        self.assertNotIn(".map(", build)

    def test_the_clock_is_an_obstacle_precipitation_collides_with(self) -> None:
        # Rain splashes on the cluster roof, rolls to a corner, drips;
        # snow sticks and melts. The roof comes from the clock's live
        # allocation, fed from the dialog, never a guessed rectangle
        # once the real one exists.
        self.assertIn("clockBoxFor", ATMOSPHERE)
        self.assertIn("get_transformed_position", LOCK)
        self.assertIn("syncClockBox()", ATMOSPHERE)
        self.assertIn("xAtRoof", ATMOSPHERE)
        self.assertIn("cornerX", ATMOSPHERE)
        self.assertIn("stickS", ATMOSPHERE)
        # Rendered positions must be the collision positions: the wrap
        # is the identity inside the stage, and each drop falls at the
        # slant its roof intersection was computed from (storm gusts
        # are per-drop, never a tick-time multiplier).
        self.assertIn("((x + 40) % (W + 80)", ATMOSPHERE)
        self.assertIn("const dSlant", ATMOSPHERE)
        self.assertIn("d.x0 + d.slant * s", ATMOSPHERE)
        self.assertNotIn("slantPx", ATMOSPHERE)

    def test_the_prompt_freezes_the_animation_loop(self) -> None:
        # Authenticating must cost no particles: while the prompt is
        # up the timeline is paused outright, not merely dimmed.
        body = ATMOSPHERE[ATMOSPHERE.index("    setPromptProgress(progress) {"):]
        body = body[: body.index("\n    }\n")]
        self.assertIn("_lssSetFrozen", body)
        timeline = ATMOSPHERE[ATMOSPHERE.index("function loopSeconds"):]
        timeline = timeline[: timeline.index("\n}\n")]
        self.assertIn("timeline._lssSetFrozen", timeline)

    def test_sky_sampling_stays_inside_the_stage(self) -> None:
        # A sky elsewhere on the monitor must not leak a moon into a
        # stage that sits over land.
        self.assertIn("sampleIn(rng", ATMOSPHERE)
        pools = ATMOSPHERE[ATMOSPHERE.index("    _buildLayerPools(layer, scene) {"):]
        pools = pools[: pools.index("\n    _tick(t) {")]
        self.assertIn("sky.sampleIn(", pools)
        self.assertNotIn("sky.sample(", pools)


if __name__ == "__main__":
    unittest.main()
