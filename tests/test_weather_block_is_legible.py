from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schemas" / "org.gnome.shell.extensions.lock-screen-suite.gschema.xml"

# The clock is the reference: it is the one element on this lock screen whose
# size was ever chosen against a real display. Every other packaged size is
# judged against it, because a lock screen is read from across a room and an
# absolute pixel count says nothing about that on its own.
#
# Shipped 22px against a 112px clock -- the same size as the date line, but
# carrying four glyphs instead of seventeen -- the temperature measured 46x27px
# on a 3840x2160 panel and read as a smudge.
MIN_TEXT_FRACTION_OF_CLOCK = 1 / 3
# The icon rule changed with the atmosphere: it used to demand an
# illustration at least twice the text, because the illustration carried
# the condition. The atmosphere carries it now, and the row's icon is a
# symbolic glyph whose job is to sit at text scale — neither a smudge
# nor a second illustration.
MIN_ICON_FRACTION_OF_TEXT = 1 / 2
MAX_ICON_MULTIPLE_OF_TEXT = 3 / 2


def default_int(name: str) -> int:
    for key in ET.parse(SCHEMA).getroot().iter("key"):
        if key.get("name") == name:
            return int((key.findtext("default") or "").strip())
    raise AssertionError(f"{name} is not in the schema")


class WeatherBlockIsLegibleTests(unittest.TestCase):
    def test_weather_text_is_proportionate_to_the_clock(self) -> None:
        clock = default_int("clock-font-size")
        text = default_int("weather-font-size")
        self.assertGreaterEqual(
            text,
            clock * MIN_TEXT_FRACTION_OF_CLOCK,
            f"weather-font-size {text} is a footnote beside a {clock}px clock",
        )

    def test_the_symbolic_icon_sits_at_text_scale(self) -> None:
        text = default_int("weather-font-size")
        icon = default_int("weather-icon-size")
        self.assertGreaterEqual(
            icon,
            text * MIN_ICON_FRACTION_OF_TEXT,
            f"weather-icon-size {icon} shrank below legibility beside {text}px text",
        )
        self.assertLessEqual(
            icon,
            text * MAX_ICON_MULTIPLE_OF_TEXT,
            f"weather-icon-size {icon} grew back into an illustration beside {text}px text",
        )

    def test_the_defaults_are_inside_their_own_ranges(self) -> None:
        # A default outside its <range> is silently clamped by GSettings, so a
        # raise here would otherwise ship as a size nobody chose.
        root = ET.parse(SCHEMA).getroot()
        for key in root.iter("key"):
            rng = key.find("range")
            default = key.findtext("default")
            if rng is None or default is None or key.get("type") != "i":
                continue
            value = int(default.strip())
            self.assertGreaterEqual(value, int(rng.get("min")), key.get("name"))
            self.assertLessEqual(value, int(rng.get("max")), key.get("name"))


if __name__ == "__main__":
    unittest.main()
