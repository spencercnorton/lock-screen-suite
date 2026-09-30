from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SERVICE = (ROOT / "weatherService.js").read_text()
PREFS = (ROOT / "prefs.js").read_text()
METADATA = (ROOT / "metadata.json").read_text()
SCHEMA = ROOT / "schemas" / "org.gnome.shell.extensions.lock-screen-suite.gschema.xml"

# The location comes only from the user: a place search in preferences through
# Open-Meteo's geocoding API, or latitude and longitude typed in. The extension
# never looks a location up by itself. It runs behind the lock screen
# (metadata.json declares the unlock-dialog session mode), and the IP lookup it
# used to make wrote the result into dconf, which that provider's terms forbid.


class LocationTests(unittest.TestCase):
    def test_no_ip_geolocation_anywhere(self) -> None:
        for name, source in (("weatherService.js", SERVICE), ("prefs.js", PREFS)):
            for banned in ("ipapi", "curl", "IP_LOCATION", "public IP"):
                self.assertNotIn(banned, source, f"{name} still geolocates by IP ({banned})")

    def test_unset_coordinates_fetch_nothing(self) -> None:
        loop = SERVICE[SERVICE.index("async _runFetchLoop"):]
        loop = loop[: loop.index("\n    }\n")]
        unset = loop.index("if (this._coordinatesUnset())")
        self.assertLess(unset, loop.index("this._fetch("), "the loop must not fetch before a location exists")
        self.assertIn("return;", loop[unset:loop.index("this._fetch(")])

    def test_the_lock_screen_service_never_geocodes(self) -> None:
        self.assertIn("unlock-dialog", METADATA)
        self.assertNotIn("geocoding-api", SERVICE, "place search belongs in preferences, not behind the lock screen")
        self.assertIn("https://geocoding-api.open-meteo.com/v1/search", PREFS)

    def test_open_meteo_is_credited_in_preferences(self) -> None:
        self.assertIn("Weather data by Open-Meteo.com", PREFS)
        self.assertIn("CC BY 4.0", PREFS)

    def test_schema_drops_auto_locate_and_keeps_the_place_name(self) -> None:
        names = {key.get("name") for key in ET.parse(SCHEMA).getroot().iter("key")}
        self.assertNotIn("weather-auto-locate", names)
        self.assertIn("weather-location-name", names)


if __name__ == "__main__":
    unittest.main()
