from hashlib import sha256
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
LICENSE = ROOT / "LICENSE"
NOTICE = ROOT / "NOTICE"
GPL3_CANONICAL_SHA256 = (
    "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"
)


class LicensingTests(unittest.TestCase):
    def test_license_is_the_canonical_gpl3_text(self) -> None:
        self.assertEqual(GPL3_CANONICAL_SHA256, sha256(LICENSE.read_bytes()).hexdigest())

    def test_notice_records_code_and_artwork_provenance(self) -> None:
        notice = NOTICE.read_text()
        self.assertIn("Original work", notice)
        self.assertIn("The eight weather glyphs", notice)
        self.assertIn("GPL-3.0-or-later", notice)
        for name in (
            "bolt",
            "cloud",
            "cloud-dark",
            "fog",
            "moon",
            "raindrop",
            "snowflake",
            "sun",
        ):
            self.assertIn(name, notice)


if __name__ == "__main__":
    unittest.main()
