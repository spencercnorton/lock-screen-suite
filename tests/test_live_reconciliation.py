from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLOCK = (ROOT / "clockWidget.js").read_text()
WEATHER = (ROOT / "weatherWidget.js").read_text()


class LiveReconciliationTests(unittest.TestCase):
    def test_self_sized_labels_never_ellipsize(self) -> None:
        self.assertIn("import Pango from 'gi://Pango';", CLOCK)
        self.assertIn("import Pango from 'gi://Pango';", WEATHER)

        for source, labels in (
            (CLOCK, ("_time", "_date")),
            (WEATHER, ("_tempLabel", "_labelLabel")),
        ):
            for label in labels:
                self.assertIn(
                    f"this.{label}.clutter_text.ellipsize = "
                    "Pango.EllipsizeMode.NONE;",
                    source,
                    f"{label} can regress to truncating its final glyph",
                )

    def test_icon_timeline_waits_until_the_actor_is_mapped(self) -> None:
        body = WEATHER[WEATHER.index("function loopAdjustment"):]
        body = body[: body.index("// -- icon factories")]

        mapped_guard = body.index("if (actor.mapped)")
        first_start = body.index("timeline.start()")
        self.assertLess(
            mapped_guard,
            first_start,
            "the timeline must not start before its actor has a stage",
        )
        self.assertIn("actor.connect('notify::mapped'", body)
        self.assertIn("actor.disconnect(id)", body)
        self.assertEqual(
            body.count("timeline.start()"),
            2,
            "both the already-mapped and deferred paths must start exactly once",
        )


if __name__ == "__main__":
    unittest.main()
