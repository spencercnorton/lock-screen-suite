// Sky segmentation for a wallpaper, with no GNOME Shell dependencies so it
// can be unit-tested outside the shell (tests/test_sky_mask.py).
//
// Sky is the smooth region connected to the TOP edge of a monitor. Three
// plausibility gates keep that flood out of places that merely touch the
// top or happen to be smooth: ratio-green is vegetation, warm dark is
// earth or a trunk, and near-black counts only when it is blue-black
// (a night sky, not canopy shadow). A horizon cap at 65% of the height
// bounds the one case connectivity cannot decide: a misty sky that
// blends into its own reflection with no horizon edge at all.
//
// The caller runs this once per wallpaper on a downscaled copy (a few
// hundred pixels wide per monitor) and caches the mask. Nothing here
// runs per frame.

/**
 * Classify sky in an image.
 *
 * @param {Uint8Array|Uint8ClampedArray} data pixel bytes
 * @param {number} w image width in pixels
 * @param {number} h image height in pixels
 * @param {Array<[number, number]>} panels [x0, x1) column ranges, one per
 *   monitor, so sky cannot leak across a monitor boundary
 * @param {{stride?: number, channels?: number}} [format] row stride in
 *   bytes and bytes per pixel (GdkPixbuf rows may be padded)
 * @returns {{mask: Uint8Array, horizon: Int16Array, skyFraction: number,
 *   skyMeanLum: number}} mask is w*h (1 = sky); horizon[x] is the lowest
 *   sky row in column x (median-smoothed), or -1 for no sky
 */
export function skyMaskFromPixels(data, w, h, panels, format = {}) {
    const channels = format.channels ?? 4;
    const stride = format.stride ?? w * channels;
    const mask = new Uint8Array(w * h);
    const horizon = new Int16Array(w).fill(-1);
    const px = (x, y) => y * stride + x * channels;
    const dist = (i, j) => {
        const dr = data[i] - data[j], dg = data[i + 1] - data[j + 1], db = data[i + 2] - data[j + 2];
        return Math.sqrt(dr * dr + dg * dg + db * db);
    };
    const lumAt = i => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const isSkyLike = i => {
        const r = data[i], g = data[i + 1], b = data[i + 2], lum = lumAt(i);
        if (g > r * 1.18 && g > b * 1.08)
            return false;
        if (r >= g && g >= b && lum < 0.32 && r - b > 6)
            return false;
        if (lum < 0.07 && b <= r + 12)
            return false;
        return true;
    };
    const capY = Math.floor(h * 0.65);

    // Local texture: sky is smooth, foliage and rock are not, even scaled down.
    const tex = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = px(x, y);
            let t = 0;
            if (x + 1 < w)
                t = Math.max(t, dist(i, px(x + 1, y)));
            if (y + 1 < h)
                t = Math.max(t, dist(i, px(x, y + 1)));
            tex[y * w + x] = t;
        }
    }

    const STEP = 30, TEXMAX = 38;
    let skyCount = 0, lumSum = 0;
    for (const [x0, x1] of panels) {
        const stack = [];
        const claim = (x, y) => {
            mask[y * w + x] = 1;
            stack.push(y * w + x);
        };
        for (let x = x0; x < x1; x++) {
            if (isSkyLike(px(x, 0)))
                claim(x, 0);
        }
        while (stack.length) {
            const p = stack.pop(), x = p % w, y = (p / w) | 0, pi = px(x, y);
            for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
                if (nx < x0 || nx >= x1 || ny < 0 || ny > capY || mask[ny * w + nx])
                    continue;
                const qi = px(nx, ny);
                if (!isSkyLike(qi) || tex[ny * w + nx] > TEXMAX || dist(pi, qi) > STEP)
                    continue;
                claim(nx, ny);
            }
        }
    }

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x])
                continue;
            skyCount++;
            horizon[x] = y;
            lumSum += lumAt(px(x, y));
        }
    }

    // Median-smooth the horizon so one leaky column cannot spike it.
    const raw = Int16Array.from(horizon);
    for (let x = 0; x < w; x++) {
        const vals = [];
        for (let dx = -3; dx <= 3; dx++) {
            const v = raw[Math.max(0, Math.min(w - 1, x + dx))];
            if (v >= 0)
                vals.push(v);
        }
        if (vals.length) {
            vals.sort((a, b) => a - b);
            horizon[x] = vals[vals.length >> 1];
        }
    }

    return {
        mask,
        horizon,
        skyFraction: skyCount / (w * h),
        skyMeanLum: skyCount ? lumSum / skyCount : 0,
    };
}

/**
 * Fraction of sky in the (2r+1)^2 neighbourhood of a mask pixel. Star
 * placement requires high density, so isolated mask speckles inside
 * land never host a star.
 */
export function skyDensityAt(mask, w, h, x, y, r) {
    let on = 0, total = 0;
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h)
                continue;
            total++;
            if (mask[yy * w + xx])
                on++;
        }
    }
    return total ? on / total : 0;
}
