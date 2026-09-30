from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schemas" / "org.gnome.shell.extensions.lock-screen-suite.gschema.xml"
SERVICE = (ROOT / "weatherService.js").read_text()

# A gschema <default> ships inside the package, so it is public the moment the
# package is. Any key whose name reads like a credential must default to empty.
CREDENTIAL_NAME = re.compile(r"key|token|secret|password|credential", re.IGNORECASE)
EMPTY_DEFAULTS = ('""', "''")


class NoCommittedCredentialTests(unittest.TestCase):
    def test_no_schema_default_carries_a_credential(self) -> None:
        for key in ET.parse(SCHEMA).getroot().iter("key"):
            name = key.get("name", "")
            if not CREDENTIAL_NAME.search(name):
                continue
            default = (key.findtext("default") or "").strip()
            self.assertIn(
                default,
                EMPTY_DEFAULTS,
                f"{name} ships a credential as its packaged default",
            )

    def test_weather_uses_the_keyless_free_endpoint(self) -> None:
        self.assertIn("https://api.open-meteo.com/v1/forecast", SERVICE)
        for banned in ("customer-api.open-meteo.com", "apikey", "weather-api-key"):
            self.assertFalse(
                banned in SERVICE,
                f"weatherService.js still references {banned}",
            )


if __name__ == "__main__":
    unittest.main()
