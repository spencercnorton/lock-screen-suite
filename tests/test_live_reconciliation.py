from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLOCK = (ROOT / "clockWidget.js").read_text()
WEATHER = (ROOT / "weatherWidget.js").read_text()
ATMOSPHERE = (ROOT / "atmosphere.js").read_text()


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

    def test_atmosphere_timeline_lives_exactly_as_long_as_its_actor(self) -> None:
        body = ATMOSPHERE[ATMOSPHERE.index("function loopSeconds"):]
        body = body[: body.index("\n}\n")]

        # Starts only once the actor has a stage, pauses while it is unmapped.
        self.assertLess(body.index("if (actor.mapped && screenOn())"), body.index("timeline.start()"))
        self.assertIn("timeline.pause()", body)
        self.assertIn("actor.connect('notify::mapped'", body)
        # Stops when the actor is destroyed. A timeline left running ticks into
        # disposed actors and floods the journal on every lock.
        destroy = body[body.index("actor.connect('destroy'"):]
        self.assertIn("timeline.stop()", destroy)
        self.assertIn("actor.disconnect(mappedId)", destroy)
        # Rooted on the actor, so GJS does not collect it mid-animation.
        self.assertIn("actor._lssTimeline = timeline", body)

    def test_atmosphere_timeline_pauses_while_the_monitors_are_off(self) -> None:
        body = ATMOSPHERE[ATMOSPHERE.index("function loopSeconds"):]
        body = body[: body.index("\n}\n")]
        # The unlock dialog stays mapped while GNOME blanks the screen, so
        # `mapped` alone kept a timeline running flat out behind dark monitors.
        self.assertIn("if (actor.mapped && screenOn())", body)
        destroy = body[body.index("actor.connect('destroy'"):]
        self.assertIn("unwatchScreen()", destroy)
        screen = (ROOT / "screen.js").read_text()
        watch = screen[screen.index("export function watchScreen"):]
        watch = watch[: watch.index("\n}\n")]
        # Asynchronous only: a synchronous proxy would wait on this same process.
        self.assertIn("(proxy, error) =>", watch)
        self.assertIn("'g-properties-changed'", watch)
        self.assertNotIn("_sync(", watch)

    def test_every_running_frame_is_drawn(self) -> None:
        body = ATMOSPHERE[ATMOSPHERE.index("function loopSeconds"):]
        body = body[: body.index("\n}\n")]
        frame = body[body.index("timeline.connect('new-frame'"):]
        frame = frame[: frame.index("});")]
        # A frame with nothing drawn is not paced by the display, so a slow
        # particle that rounds to the same pixel would spin the main loop
        # at a full core. Positions may be applied at a capped rate, but a
        # redraw must still be queued every frame.
        self.assertIn("actor.queue_redraw()", frame)

    def test_the_clock_does_not_redraw_behind_dark_monitors(self) -> None:
        tick = CLOCK[CLOCK.index("    _scheduleNextTick() {"):]
        tick = tick[: tick.index("\n    }\n")]
        self.assertIn("if (screenOn())", tick)
        self.assertIn("this._unwatchScreen?.()", CLOCK)

    def test_a_place_change_costs_one_request(self) -> None:
        service = (ROOT / "weatherService.js").read_text()
        for key in ("weather-latitude", "weather-longitude", "weather-units"):
            self.assertIn(f"changed::{key}', () => this._refreshSoon()", service)
        destroy = service[service.index("    destroy() {"):]
        self.assertIn("GLib.source_remove(this._soonId)", destroy[: destroy.index("\n    }\n")])
        soon = service[service.index("    _refreshSoon() {"):]
        soon = soon[: soon.index("\n    }\n")]
        # A coordinate written back rounded to the displayed decimals is the
        # same place: only a changed place or units may fetch.
        self.assertIn("this.requestRefresh({ifStale: true})", soon)

    def test_the_clock_is_right_on_the_first_frame_after_wake(self) -> None:
        self.assertIn("'power-save-mode-changed', () => this._refresh(), this", CLOCK)

    def test_a_fetch_restarts_the_refresh_interval(self) -> None:
        service = (ROOT / "weatherService.js").read_text()
        fetch = service[service.index("set_int64('weather-last-fetch'"):]
        self.assertLess(fetch.index("this._reschedule()"), fetch.index("this._emit(payload)"))

    def test_the_icon_updates_in_place(self) -> None:
        # The animated icon swapped a whole subtree per condition, and a
        # replaced child that was not destroyed stayed mapped with a live
        # timeline. The symbolic icon cannot leak either way.
        body = WEATHER[WEATHER.index("    _refreshIcon() {"):]
        body = body[: body.index("\n    }\n")]
        self.assertIn("this._icon.icon_name =", body)
        self.assertNotIn("set_child", body)
        self.assertNotIn("add_child", body)

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
