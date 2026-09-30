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

    def test_icon_timeline_lives_exactly_as_long_as_its_icon(self) -> None:
        body = WEATHER[WEATHER.index("function loopSeconds"):]
        body = body[: body.index("\n}\n")]

        # Starts only once the icon has a stage, pauses while it is unmapped.
        self.assertLess(body.index("if (actor.mapped && screenOn())"), body.index("timeline.start()"))
        self.assertIn("timeline.pause()", body)
        self.assertIn("actor.connect('notify::mapped'", body)
        # Stops when the icon is destroyed. A timeline left running ticks into
        # disposed St.Icons and floods the journal on every lock.
        destroy = body[body.index("actor.connect('destroy'"):]
        self.assertIn("timeline.stop()", destroy)
        self.assertIn("actor.disconnect(mappedId)", destroy)
        # Rooted on the actor, so GJS does not collect it mid-animation.
        self.assertIn("actor._lssTimeline = timeline", body)

    def test_icon_timeline_pauses_while_the_monitors_are_off(self) -> None:
        body = WEATHER[WEATHER.index("function loopSeconds"):]
        body = body[: body.index("\n}\n")]
        # The unlock dialog stays mapped while GNOME blanks the screen, so
        # `mapped` alone kept a timeline running flat out behind dark monitors.
        self.assertIn("if (actor.mapped && screenOn())", body)
        destroy = body[body.index("actor.connect('destroy'"):]
        self.assertIn("unwatchScreen()", destroy)
        watch = WEATHER[WEATHER.index("function watchScreen"):]
        watch = watch[: watch.index("\n}\n")]
        # Asynchronous only: a synchronous proxy would wait on this same process.
        self.assertIn("(proxy, error) =>", watch)
        self.assertIn("'g-properties-changed'", watch)
        self.assertNotIn("_sync(", watch)

    def test_a_fetch_restarts_the_refresh_interval(self) -> None:
        service = (ROOT / "weatherService.js").read_text()
        fetch = service[service.index("set_int64('weather-last-fetch'"):]
        self.assertLess(fetch.index("this._reschedule()"), fetch.index("this._emit(payload)"))

    def test_a_replaced_icon_is_destroyed(self) -> None:
        body = WEATHER[WEATHER.index("    _refreshIcon() {"):]
        body = body[: body.index("\n    }\n")]
        self.assertIn("old?.destroy()", body)

    def test_no_weather_row_until_a_place_is_chosen(self) -> None:
        body = WEATHER[WEATHER.index("    _onEnabledChanged() {"):]
        body = body[: body.index("\n    }\n")]
        self.assertIn("hasPlace()", body)
        self.assertIn("changed::weather-latitude", WEATHER)

    def test_a_rebuilt_widget_uses_a_fresh_cached_forecast(self) -> None:
        self.assertIn("requestRefresh({ifStale: true})", WEATHER)
        service = (ROOT / "weatherService.js").read_text()
        self.assertIn("if (ifStale && this._isFresh())", service)
        self.assertIn("cached.place !== this._placeKey()", service)
        lock = (ROOT / "lockScreen.js").read_text()
        self.assertNotIn("requestRefresh()", lock, "styling keys must not cost a request")

    def test_background_position_uses_st_default(self) -> None:
        lock = (ROOT / "lockScreen.js").read_text()
        self.assertNotIn("background-position", lock.replace("of background-position", ""))

if __name__ == "__main__":
    unittest.main()
