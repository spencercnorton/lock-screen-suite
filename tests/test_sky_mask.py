from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]

# The sky classifier's contract: effects that belong in the sky (stars, the
# moon, clouds) may only appear where the wallpaper is actually sky. These
# synthetic landscapes run the real skyCore.js under node, the same way
# static-check.py parses every module with it. Each case is a wallpaper
# shape that a simpler rule gets wrong: a reflection the same colour as
# the sky, a canopy that touches the top edge, a night sky with no blue
# to key on, and a sky that must not leak across a monitor boundary.

RUNNER = """
import { skyMaskFromPixels, skyDensityAt } from './skyCore.mjs';
let failures = 0;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL ' + msg); failures++; } };
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
function image(w, h, paint, stridePad = 0) {
    const stride = w * 4 + stridePad;
    const data = new Uint8ClampedArray(stride * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const [r, g, b] = paint(x, y), i = y * stride + x * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
    return { data, stride };
}
const at = (res, w, x, y) => res.mask[y * w + x] === 1;

{   // blue gradient sky over textured land (padded rows, as GdkPixbuf gives)
    const W = 96, H = 64;
    const { data, stride } = image(W, H, (x, y) => y < 26
        ? [lerp(110, 185, y / 26), lerp(165, 205, y / 26), lerp(220, 238, y / 26)]
        : ((x + y) % 2 ? [28, 68, 34] : [44, 92, 48]), 8);
    const r = skyMaskFromPixels(data, W, H, [[0, W]], { stride, channels: 4 });
    assert(at(r, W, 48, 5), 'sky is sky');
    assert(!at(r, W, 48, 50), 'land is not sky');
    assert(r.skyFraction > 0.3 && r.skyFraction < 0.48, 'sky fraction');
    assert(r.horizon[48] >= 22 && r.horizon[48] <= 28, 'horizon at the treeline');
}
{   // sunset lake: the reflection is sky-coloured but not sky
    const W = 96, H = 64;
    const { data } = image(W, H, (x, y) => {
        if (y < 22) return [lerp(240, 250, y / 22), lerp(150, 180, y / 22), lerp(110, 150, y / 22)];
        if (y < 30) return [52, 46, 62];
        return [lerp(250, 240, (y - 30) / 34), lerp(180, 150, (y - 30) / 34), lerp(150, 110, (y - 30) / 34)];
    });
    const r = skyMaskFromPixels(data, W, H, [[0, W]]);
    assert(at(r, W, 48, 8), 'real sky detected');
    assert(!at(r, W, 48, 55), 'reflection is not sky');
}
{   // night desert: no blue heuristic to lean on
    const W = 96, H = 64;
    const { data } = image(W, H, (x, y) => y < 34
        ? [lerp(8, 26, y / 34), lerp(12, 30, y / 34), lerp(34, 58, y / 34)]
        : [lerp(150, 110, (y - 34) / 30), lerp(112, 82, (y - 34) / 30), 70]);
    const r = skyMaskFromPixels(data, W, H, [[0, W]]);
    assert(at(r, W, 48, 10), 'dark night sky detected');
    assert(!at(r, W, 48, 55), 'hills are not sky');
    assert(r.skyMeanLum < 0.16, 'night sky luminance is low');
}
{   // forest canopy roof + sky gap, across a monitor boundary
    const W = 96, H = 64;
    const { data } = image(W, H, (x, y) => {
        if (x < 48) return y < 40 ? [150, 185, 225] : [40, 80, 40];
        if (y < 14) return [12, 18, 14];
        return y < 40 ? [150, 185, 225] : [40, 80, 40];
    });
    const r = skyMaskFromPixels(data, W, H, [[0, 48], [48, W]]);
    assert(at(r, W, 20, 20), 'open sky on the left monitor');
    assert(!at(r, W, 72, 25), 'roofed gap is not sky, no cross-monitor leak');
    assert(!at(r, W, 72, 6), 'dark canopy is not sky');
}
{   // misty edgeless reflection: the horizon cap bounds the sky
    const W = 96, H = 64;
    const { data } = image(W, H, (x, y) => {
        const t = y < 30 ? y / 30 : 1 - (y - 30) / 34;
        return [lerp(120, 235, t), lerp(165, 195, t), lerp(215, 175, t)];
    });
    const r = skyMaskFromPixels(data, W, H, [[0, W]]);
    assert(!at(r, W, 48, 58), 'bottom reflection excluded by the horizon cap');
}
{   // star placement density
    const W = 32, H = 32, mask = new Uint8Array(W * H);
    mask[16 * W + 16] = 1;
    for (let y = 0; y < 12; y++) for (let x = 0; x < W; x++) mask[y * W + x] = 1;
    assert(skyDensityAt(mask, W, H, 16, 16, 3) < 0.2, 'isolated speckle has low density');
    assert(skyDensityAt(mask, W, H, 16, 6, 3) === 1, 'solid sky has density 1');
}
process.exit(failures ? 1 : 0);
"""


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class SkyMaskTests(unittest.TestCase):
    def test_sky_classifier_on_synthetic_landscapes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "skyCore.mjs").write_text((ROOT / "skyCore.js").read_text())
            (tmp / "runner.mjs").write_text(RUNNER)
            result = subprocess.run(
                ["node", str(tmp / "runner.mjs")],
                capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
