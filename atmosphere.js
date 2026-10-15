// Clock-stage weather atmosphere: one non-reactive bounded layer
// around the clock cluster on the primary monitor, between the blurred
// wallpaper and the clock/password prompt. The weather lives with the
// clock instead of posing as a small animated icon — and instead of
// spanning every monitor, which the first version did: three
// full-screen layers cost a whole-stage repaint per frame and lagged
// the wake-to-prompt transition, and at that size the effect read as
// wallpaper noise rather than part of the dialog.
//
// The clock cluster itself is an invisible box in the scene: rain
// splashes on its roof, rolls to a corner, and drips off; snow settles
// on the roof and melts; clouds and their shadows drift behind and
// above it; fog gathers at its base. The other monitors keep the
// graded wallpaper only.
//
// What goes where follows the wallpaper. Stars, the moon, sun glow, and
// clouds are placed only in sky detected in the wallpaper itself
// (skyCore.js, computed once per wallpaper and cached) inside the
// stage's own rectangle; a stage over land gets no stars, which is
// the point.
//
// Motion is deterministic in one looping 60-second timeline, like the
// icon animations this replaces: every particle derives its position
// from the elapsed seconds, sub-periods divide 60, and nothing jumps at
// the wrap or teleports when pools rebuild (placement is seeded).
// The timeline obeys the same rules the icon learned the hard way —
// rooted on its actor, running only while mapped with the monitors on,
// stopped on destroy, and drawing every frame it runs.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import GdkPixbuf from 'gi://GdkPixbuf';

import {describeWmoCode} from './weatherService.js';
import {screenOn, watchScreen} from './screen.js';
import {skyMaskFromPixels, skyDensityAt} from './skyCore.js';

// -- helpers --------------------------------------------------------------

const TAU = Math.PI * 2;
const LOOP_S = 60;

const pulse = (t, periodS, phase = 0) =>
    0.5 - 0.5 * Math.cos(((t / periodS + phase) % 1) * TAU);
const sway = (t, periodS, phase = 0) =>
    Math.sin(((t / periodS + phase) % 1) * TAU);
const frac = v => v - Math.floor(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function envelope(f, inEnd = 0.06, outStart = 0.94) {
    if (f < inEnd)
        return f / inEnd;
    if (f > outStart)
        return (1 - f) / (1 - outStart);
    return 1;
}

// Deterministic per-particle jitter: stable across pool rebuilds, so a
// settings change never reshuffles the weather mid-lock.
function jitter(i, salt) {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// One 60s looping timeline bound to `actor`'s lifetime. The invariants
// (rooted on the actor, mapped + monitors-on gating, stopped on destroy,
// a draw every frame) are the ones test_live_reconciliation.py pins;
// each was a measured bug in the icon this replaces. Position updates
// are applied at most every ~33ms: weather reads the same at 30fps,
// positions derive from absolute t so skipping an update loses nothing,
// and a 120Hz panel does not quadruple the JavaScript cost. The actor
// this is bound to is the bounded stage around the clock, so the
// per-frame redraw damages that rect only — binding it to a stage-wide
// group repainted three 4K monitors per frame and visibly lagged the
// wake-to-prompt transition. `_lssSetFrozen` pauses the loop outright
// while the password prompt is up: authenticating costs no particles.
function loopSeconds(actor, onTick) {
    const timeline = new Clutter.Timeline({
        actor,
        duration: LOOP_S * 1000,
        repeat_count: -1,
    });
    let lastApplied = -1;
    timeline.connect('new-frame', () => {
        const t = timeline.get_progress() * LOOP_S;
        if (lastApplied < 0 || t < lastApplied || t - lastApplied >= 0.033) {
            onTick(t);
            lastApplied = t;
        }
        actor.queue_redraw();
    });
    let frozen = false;
    const sync = () => {
        if (actor.mapped && screenOn() && !frozen)
            timeline.start();
        else
            timeline.pause();
    };
    timeline._lssSetFrozen = value => {
        frozen = !!value;
        sync();
    };
    const mappedId = actor.connect('notify::mapped', sync);
    const unwatchScreen = watchScreen(sync);
    sync();
    // Disposable as a whole: rebuilding layers on the same actor must
    // retire the previous timeline completely — its frame callback, its
    // mapped handler, and its screen watcher — or every rebuild adds
    // another running loop until the dialog is destroyed.
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        actor.disconnect(mappedId);
        unwatchScreen();
        timeline.stop();
    };
    timeline._lssDispose = dispose;
    actor.connect('destroy', dispose);
    actor._lssTimeline = timeline;
    return timeline;
}

// A soft radial-gradient ellipse: the only cloud, fog, glow, and shadow
// primitive. Gradient rectangles are not used; their hard side edges
// read as bars across the wallpaper.
function makeSoftEllipse(rx, ry, rgb, alpha) {
    const w = new St.Widget({width: Math.round(rx * 2), height: Math.round(ry * 2), reactive: false});
    w.set_pivot_point(0.5, 0.5);
    w.set_style(
        'background-gradient-direction: radial;' +
        `background-gradient-start: rgba(${rgb}, ${alpha});` +
        `background-gradient-end: rgba(${rgb}, 0);` +
        `border-radius: ${Math.round(Math.min(rx, ry))}px;`
    );
    return w;
}

function makeParticle(styleClass, w, h) {
    return new St.Widget({
        style_class: styleClass,
        width: Math.max(1, Math.round(w)),
        height: Math.max(1, Math.round(h)),
        reactive: false,
    });
}

// -- the moon, drawn at its real phase (carried over from the icon) -------

const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_EPOCH_MS = 947182440000;   // 2000-01-06T18:14Z, a known new moon

// 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. Mean
// synodic phase; good to roughly half a day, under a pixel of terminator.
export function moonPhase(when = new Date()) {
    const days = (when.getTime() - NEW_MOON_EPOCH_MS) / 86400000;
    return ((days / SYNODIC_DAYS) % 1 + 1) % 1;
}

const MARIA = [
    [-0.30, -0.34, 0.30, 1.30, 0.30],
    [ 0.13, -0.16, 0.22, 1.05, 0.26],
    [ 0.33,  0.13, 0.21, 0.90, 0.26],
    [ 0.00,  0.45, 0.17, 1.40, 0.20],
    [-0.52,  0.18, 0.27, 0.75, 0.24],
    [ 0.56, -0.28, 0.11, 1.00, 0.22],
];
const MOON_LIT = [0.96, 0.97, 1.00];
const MOON_DARK = [0.40, 0.44, 0.58];
const MOON_EDGE = [0.70, 0.75, 0.88];
const MOON_MARE = [0.56, 0.61, 0.76];
const rgba = (cr, [r, g, b], a) => cr.setSourceRGBA(r, g, b, a);

function litPath(cr, cx, cy, r, phase) {
    const lit = (1 - Math.cos(phase * TAU)) / 2;
    const s = phase < 0.5 ? 1 : -1;
    const rx = r * (1 - 2 * lit);
    const N = 192;
    cr.newPath();
    if (s > 0)
        cr.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
    else
        cr.arcNegative(cx, cy, r, -Math.PI / 2, -3 * Math.PI / 2);
    for (let i = N; i >= 0; i--) {
        const a = -Math.PI / 2 + (i / N) * Math.PI;
        cr.lineTo(cx + s * rx * Math.cos(a), cy + r * Math.sin(a));
    }
    cr.closePath();
}

function drawMoon(cr, size, phase) {
    const line = Math.max(1, size * 0.013);
    const r = size * 0.46 - line / 2;
    const cx = size / 2, cy = size / 2;
    cr.newPath();
    cr.arc(cx, cy, r, 0, TAU);
    rgba(cr, MOON_DARK, 0.14);
    cr.fill();
    litPath(cr, cx, cy, r, phase);
    const body = new Cairo.RadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r * 1.6);
    body.addColorStopRGBA(0, ...MOON_LIT, 1);
    body.addColorStopRGBA(1, 0.90, 0.92, 0.97, 1);
    cr.setSource(body);
    cr.fillPreserve();
    cr.save();
    cr.clip();
    for (const [mx, my, mr, sx, alpha] of MARIA) {
        cr.save();
        cr.translate(cx + mx * r, cy + my * r);
        cr.scale(sx, 1 / sx);
        const mare = new Cairo.RadialGradient(0, 0, 0, 0, 0, mr * r);
        mare.addColorStopRGBA(0.00, ...MOON_MARE, alpha);
        mare.addColorStopRGBA(0.72, ...MOON_MARE, alpha);
        mare.addColorStopRGBA(1.00, ...MOON_MARE, 0);
        cr.setSource(mare);
        cr.arc(0, 0, mr * r, 0, TAU);
        cr.fill();
        cr.restore();
    }
    cr.restore();
    cr.newPath();
    cr.arc(cx, cy, r, 0, TAU);
    cr.setLineWidth(line);
    rgba(cr, MOON_EDGE, 0.45);
    cr.stroke();
}

function makeMoon(size, phase = moonPhase()) {
    const area = new St.DrawingArea({width: size, height: size, reactive: false});
    area.connect('repaint', () => {
        const cr = area.get_context();
        try {
            drawMoon(cr, size, phase);
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

// -- sky detection over the lock wallpapers -------------------------------

const MASK_W_PER_MONITOR = 384;
const skyCache = new Map();

function fileCacheKey(file) {
    if (!file)
        return 'none';
    try {
        const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        return `${file.get_uri()}@${info.get_attribute_uint64('time::modified')}`;
    } catch {
        return file.get_uri();
    }
}

// One monitor's sky: its own classifier run over its own rectangle of
// the wallpaper actually on that monitor, so stacked or offset monitor
// layouts need no special case.
class MonitorSky {
    constructor(monitor, result, maskW, maskH) {
        this.monitor = monitor;
        this.mask = result?.mask ?? null;
        this.horizon = result?.horizon ?? null;
        this.fraction = result?.skyFraction ?? 0;
        this.meanLum = result?.skyMeanLum ?? 0;
        this.mw = maskW;
        this.mh = maskH;
    }

    // Solid-sky test in monitor-local pixels (see skyDensityAt).
    at(x, y) {
        if (!this.mask)
            return y < this.monitor.height * 0.3;
        const mx = Math.floor(x / this.monitor.width * this.mw);
        const my = Math.floor(y / this.monitor.height * this.mh);
        return skyDensityAt(this.mask, this.mw, this.mh, mx, my, 3) >= 0.9;
    }

    horizonAt(x) {
        if (!this.horizon)
            return this.monitor.height * 0.3;
        const mx = clamp(Math.floor(x / this.monitor.width * this.mw), 0, this.mw - 1);
        const hy = this.horizon[mx];
        return hy < 0 ? 0 : (hy + 1) / this.mh * this.monitor.height;
    }

    sample(rng) {
        const {width: W, height: H} = this.monitor;
        return this.sampleIn(rng, 8, 4, W - 8, 4 + H * 0.6);
    }

    // A sky point inside a monitor-local rect, top-weighted. The
    // clock-stage atmosphere samples only its own rect, so a sky that
    // exists elsewhere on the monitor never leaks a moon into a
    // stage that sits over land.
    sampleIn(rng, x0, y0, x1, y1) {
        for (let i = 0; i < 64; i++) {
            const x = x0 + rng() * (x1 - x0);
            const y = y0 + (y1 - y0) * Math.pow(rng(), 1.35);
            if (this.at(x, y))
                return {x, y};
        }
        return null;
    }
}

function pixbufSky(pixbuf, monitor) {
    if (pixbuf.get_colorspace() !== GdkPixbuf.Colorspace.RGB || pixbuf.get_bits_per_sample() !== 8)
        return new MonitorSky(monitor, null, 0, 0);
    const w = pixbuf.get_width(), h = pixbuf.get_height();
    const result = skyMaskFromPixels(pixbuf.get_pixels(), w, h, [[0, w]], {
        stride: pixbuf.get_rowstride(),
        channels: pixbuf.get_n_channels(),
    });
    return new MonitorSky(monitor, result, w, h);
}

// Compute sky for every monitor. Synchronous but small (a few hundred
// pixels per monitor); callers run it from an idle handler and cache by
// wallpaper identity, so a relock with the same wallpaper is free.
export function computeSky(monitors, fileForMonitor, fallbackFile) {
    const key = monitors.map((m, i) =>
        `${m.x},${m.y},${m.width}x${m.height}:${fileCacheKey(fileForMonitor(i) ?? fallbackFile)}`).join('|');
    if (skyCache.has(key))
        return skyCache.get(key);

    let fallbackPixbuf = null;
    const loadFallback = () => {
        if (fallbackPixbuf || !fallbackFile?.get_path())
            return fallbackPixbuf;
        const totalW = Math.max(...monitors.map(m => m.x + m.width));
        const totalH = Math.max(...monitors.map(m => m.y + m.height));
        const scale = MASK_W_PER_MONITOR / Math.max(...monitors.map(m => m.width));
        try {
            fallbackPixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                fallbackFile.get_path(), Math.round(totalW * scale), Math.round(totalH * scale), false);
        } catch {
            fallbackPixbuf = null;
        }
        return fallbackPixbuf;
    };

    const skies = monitors.map((monitor, i) => {
        const scale = MASK_W_PER_MONITOR / monitor.width;
        const mw = MASK_W_PER_MONITOR, mh = Math.max(24, Math.round(monitor.height * scale));
        const custom = fileForMonitor(i);
        try {
            if (custom?.get_path()) {
                return pixbufSky(
                    GdkPixbuf.Pixbuf.new_from_file_at_scale(custom.get_path(), mw, mh, false), monitor);
            }
            const full = loadFallback();
            if (full) {
                // Crop in the fallback image's OWN scale (it was scaled by
                // the widest monitor), then resize the crop to classifier
                // resolution. Cropping in each monitor's private scale
                // walks off the image on mixed-width layouts.
                const fs = MASK_W_PER_MONITOR / Math.max(...monitors.map(m => m.width));
                const crop = full.new_subpixbuf(
                    Math.round(monitor.x * fs), Math.round(monitor.y * fs),
                    Math.max(1, Math.round(monitor.width * fs)),
                    Math.max(1, Math.round(monitor.height * fs)));
                const sub = (crop.get_width() === mw && crop.get_height() === mh)
                    ? crop
                    : crop.scale_simple(mw, mh, GdkPixbuf.InterpType.BILINEAR);
                return pixbufSky(sub, monitor);
            }
        } catch (e) {
            console.warn(`[lock-screen-suite] sky detection failed for monitor ${i}: ${e}`);
        }
        return new MonitorSky(monitor, null, 0, 0);
    });

    skyCache.set(key, skies);
    if (skyCache.size > 4)
        skyCache.delete(skyCache.keys().next().value);
    return skies;
}

// -- scene parameters from a weather payload ------------------------------

// The payload fields the icon never used — precipitation, cloud cover,
// wind speed and direction — are the atmosphere's inputs. Curves are
// deliberately simple and documented here, the one place they live.
export function sceneForPayload(payload) {
    if (!payload)
        return null;
    const {category} = describeWmoCode(payload.weatherCode);
    const night = payload.isDay === false;
    const mph = payload.windUnit === 'kmh'
        ? (payload.windSpeed ?? 0) * 0.621371
        : (payload.windSpeed ?? 0);
    // Wind direction is where the wind comes FROM; drops move with the
    // toward-vector, whose screen-x component is -sin(direction).
    const dirRad = (payload.windDirection ?? NaN) * Math.PI / 180;
    const slantSign = Number.isFinite(dirRad) ? -Math.sin(dirRad) : 0.7;
    const base = {drizzle: 0.3, rain: 0.65, storm: 1.0, snow: 0.55}[category] ?? 0;
    const precip01 = clamp((payload.precipitation ?? 0) / 2.5, 0, 1);
    return {
        category,
        night,
        intensity: clamp(base * 0.7 + precip01 * 0.5, 0.12, 1.1),
        cloud01: clamp((payload.cloudCover ?? 0) / 100, 0, 1),
        windMph: mph,
        slant: clamp(mph / 60, 0, 0.55) * slantSign,
    };
}

// Wallpaper grading per condition, applied on top of the user's own blur
// and dim settings (never instead of them): a dim delta in percentage
// points, a blur radius multiplier, and the dim overlay's colour. Night
// scenes with stars dim adaptively toward a target sky luminance
// measured from this wallpaper's sky, so a bright day photo becomes a
// night scene and an already-dark photo barely moves.
export function conditionGrade(payload, skies) {
    const none = {dimDelta: 0, radiusMul: 1, tint: [0, 0, 0]};
    if (!payload)
        return none;
    const {category} = describeWmoCode(payload.weatherCode);
    const night = payload.isDay === false;
    const table = {
        'clear':         {dimDelta: night ? 8 : -6, radiusMul: 0.9, tint: night ? [6, 8, 20] : [24, 18, 6]},
        'mostly-clear':  {dimDelta: night ? 8 : -4, radiusMul: 0.95, tint: night ? [6, 8, 20] : [24, 18, 6]},
        'partly-cloudy': {dimDelta: night ? 6 : -2, radiusMul: 1, tint: night ? [6, 8, 20] : [20, 16, 8]},
        'overcast':      {dimDelta: 8, radiusMul: 1.05, tint: [14, 16, 22]},
        'fog':           {dimDelta: 2, radiusMul: 1.5, tint: [52, 58, 68]},
        'drizzle':       {dimDelta: 8, radiusMul: 1.1, tint: [10, 18, 34]},
        'rain':          {dimDelta: 10, radiusMul: 1.1, tint: [10, 18, 34]},
        'snow':          {dimDelta: -2, radiusMul: 1, tint: [30, 36, 52]},
        'storm':         {dimDelta: 14, radiusMul: 1.15, tint: [8, 12, 28]},
    };
    const grade = {...(table[category] ?? none)};
    if (night && (category === 'clear' || category === 'mostly-clear' || category === 'partly-cloudy') && skies) {
        let best = null;
        for (const s of skies) {
            if (s.fraction > 0.04 && (!best || s.fraction > best.fraction))
                best = s;
        }
        if (best) {
            const b = clamp(0.20 / (best.meanLum || 0.45), 0.32, 0.62);
            grade.dimDelta += Math.round((0.62 - b) * 60);
        }
    }
    return grade;
}

// -- the atmosphere group -------------------------------------------------

const STRIKES = [0.0, 0.16, 0.52, 1.9, 2.06, 7.4];
const STRIKE_CYCLE = 15;

export const AtmosphereGroup = GObject.registerClass(
class AtmosphereGroup extends Clutter.Actor {
    _init({settings, service, monitors, primaryIndex, clockBoxFor, fileForMonitor, fallbackFile, onGradeDirty}) {
        super._init({reactive: false});
        this._settings = settings;
        this._service = service;
        this._monitors = monitors;
        this._primaryIndexPref = primaryIndex ?? 0;
        this._clockBoxFor = clockBoxFor ?? null;
        this._fileForMonitor = fileForMonitor;
        this._fallbackFile = fallbackFile;
        this._onGradeDirty = onGradeDirty;
        this._skies = null;
        this._payload = service?.getCachedPayload() ?? null;
        this._sceneKey = null;
        this._layers = [];
        this._skyIdleId = 0;
        this._clockBox = null;
        this._clockBoxDirty = false;
        this._promptProgress = 0;

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const rebuild = () => this._rebuildScene();
        const rebuildAnimated = () => {
            this._buildLayers();
            this._sceneKey = null;
            this._rebuildScene();
        };
        this._settingsHandlers = [
            [this._settings, this._settings.connect('changed::weather-atmosphere', rebuild)],
            [this._settings, this._settings.connect('changed::weather-show-animation', rebuildAnimated)],
            [this._settings, this._settings.connect('changed::weather-atmosphere-density', rebuild)],
            [this._settings, this._settings.connect('changed::weather-lightning', rebuild)],
            [this._settings, this._settings.connect('changed::weather-enabled', rebuild)],
            [this._interfaceSettings, this._interfaceSettings.connect('changed::enable-animations', rebuildAnimated)],
        ];
        this._unsubscribe = service?.subscribe(p => {
            this._payload = p;
            this._rebuildScene();
            this._onGradeDirty?.();
        });

        this._buildLayers();
        this._scheduleSky();
        this._rebuildScene();

        this.connect('destroy', () => {
            if (this._skyIdleId)
                GLib.source_remove(this._skyIdleId);
            this._skyIdleId = 0;
            try { this._unsubscribe?.(); } catch {}
            for (const [obj, id] of this._settingsHandlers.splice(0)) {
                try { obj.disconnect(id); } catch {}
            }
        });
    }

    _animate() {
        return this._settings.get_boolean('weather-show-animation') &&
            this._interfaceSettings.get_boolean('enable-animations');
    }

    _primaryIndex() {
        const n = this._monitors.length;
        return n ? clamp(Math.floor(this._primaryIndexPref) || 0, 0, n - 1) : -1;
    }

    // The stage: a bounded rect around the clock cluster on the primary
    // monitor, plus the cluster's roof line precipitation collides
    // with. Everything is monitor-local here; pools convert to
    // stage-local. Before the clock has an allocation (or if it ever
    // reports one outside this monitor) fall back to the centred
    // upper-third box the unlock dialog uses, and let the first real
    // allocation rebuild the stage around the true clock.
    _stageFor(monitor) {
        const W = monitor.width, H = monitor.height;
        const scale = clamp(H / 1080, 0.75, 2.2);
        let cb = null;
        if (this._clockBox) {
            const c = {
                x: this._clockBox.x - monitor.x, y: this._clockBox.y - monitor.y,
                w: this._clockBox.width, h: this._clockBox.height,
            };
            if (c.w > 40 && c.h > 20 && c.x + c.w / 2 >= 0 && c.x + c.w / 2 <= W &&
                c.y + c.h / 2 >= 0 && c.y + c.h / 2 <= H)
                cb = c;
        }
        if (!cb) {
            const w = Math.min(W * 0.4, 560 * scale), h = H * 0.16;
            cb = {x: (W - w) / 2, y: H * 0.2, w, h};
        }
        const stageW = Math.min(W, clamp(cb.w * 2.15, 640 * scale, W * 0.62));
        const above = clamp(cb.h * 1.8, 230 * scale, H * 0.36);
        const below = clamp(cb.h * 0.85, 115 * scale, H * 0.24);
        const stageX = clamp(cb.x + cb.w / 2 - stageW / 2, 0, Math.max(0, W - stageW));
        const stageY = clamp(cb.y - above, 0, H);
        const stageBottom = clamp(cb.y + cb.h + below, stageY + 120 * scale, H);
        return {
            stage: {x: stageX, y: stageY, w: stageW, h: stageBottom - stageY},
            roof: {
                x0: cb.x - 16 * scale, x1: cb.x + cb.w + 16 * scale,
                y: cb.y - 4, bottom: cb.y + cb.h,
            },
        };
    }

    // The clock moved (first allocation, font settle, layout change):
    // rebuild the stage around it. Ignored while the prompt is up —
    // the dialog shifts the clock during that transition, the scene is
    // frozen anyway, and the pending box is applied when the clock
    // face returns.
    syncClockBox() {
        const rect = this._clockBoxFor?.() ?? null;
        if (!rect)
            return;
        const prev = this._clockBox;
        if (prev && Math.abs(prev.x - rect.x) < 6 && Math.abs(prev.y - rect.y) < 6 &&
            Math.abs(prev.width - rect.width) < 6 && Math.abs(prev.height - rect.height) < 6)
            return;
        this._clockBox = rect;
        if (this._promptProgress > 0.02) {
            this._clockBoxDirty = true;
            return;
        }
        this._clockBoxDirty = false;
        this._buildLayers();
        this._sceneKey = null;
        this._rebuildScene();
    }

    // One layer only: the primary monitor's clock stage. The other
    // monitors keep the graded wallpaper and nothing else — a weather
    // system spanning every panel cost three full-screen repaints per
    // frame and read as wallpaper noise; weather that lives around
    // the clock reads as part of the dialog.
    _buildLayers() {
        this._timeline?._lssDispose?.();
        this._timeline = null;
        this.destroy_all_children();
        this._layers = [];
        const index = this._primaryIndex();
        const monitor = index >= 0 ? this._monitors[index] : null;
        if (!monitor)
            return;
        const {stage, roof} = this._stageFor(monitor);
        const actor = new Clutter.Actor({
            x: Math.round(monitor.x + stage.x), y: Math.round(monitor.y + stage.y),
            width: Math.round(stage.w), height: Math.round(stage.h),
            clip_to_allocation: true,
            reactive: false,
        });
        this.add_child(actor);
        this._layers = [{monitor, index, actor, stage, roof, roofLocal: null,
            rain: [], snow: [], stars: [], clouds: [], shadows: [], lights: [],
            fogs: [], glow: null, moon: null, flash: null, snowCap: null}];
        if (this._animate()) {
            this._timeline = loopSeconds(actor, t => this._tick(t));
            if (this._promptProgress > 0.02)
                this._timeline._lssSetFrozen?.(true);
        }
    }

    _scheduleSky() {
        if (this._skyIdleId)
            GLib.source_remove(this._skyIdleId);
        this._skyIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._skyIdleId = 0;
            try {
                this._skies = computeSky(this._monitors, this._fileForMonitor, this._fallbackFile);
            } catch (e) {
                console.warn(`[lock-screen-suite] sky detection failed: ${e}`);
                this._skies = null;
            }
            this._sceneKey = null;
            this._rebuildScene();
            this._onGradeDirty?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    setFallbackFile(file) {
        this._fallbackFile = file;
    }

    // Monitors or wallpapers changed under a live dialog.
    rebuild(monitors, primaryIndex) {
        if (monitors)
            this._monitors = monitors;
        if (primaryIndex !== undefined && primaryIndex !== null)
            this._primaryIndexPref = primaryIndex;
        this._skies = null;
        this._buildLayers();
        this._scheduleSky();
        this._sceneKey = null;
        this._rebuildScene();
    }

    getSkies() {
        return this._skies;
    }

    getPayload() {
        return this._payload;
    }

    // The password prompt takes focus; the weather stays, quieter —
    // and still. Freezing the loop while the prompt is up gives the
    // shell its whole frame budget for the wake transition and for
    // typing, which is exactly where the full-screen version lagged.
    setPromptProgress(progress) {
        this.opacity = Math.round(255 * (1 - 0.55 * clamp(progress, 0, 1)));
        const wasFrozen = this._promptProgress > 0.02;
        this._promptProgress = clamp(progress, 0, 1);
        const frozen = this._promptProgress > 0.02;
        if (frozen !== wasFrozen)
            this._timeline?._lssSetFrozen?.(frozen);
        if (!frozen && wasFrozen && this._clockBoxDirty) {
            this._clockBoxDirty = false;
            this._buildLayers();
            this._sceneKey = null;
            this._rebuildScene();
        } else if (!frozen && wasFrozen) {
            this.syncClockBox();
        }
    }

    _sceneKeyFor(scene) {
        if (!scene)
            return 'none';
        return [scene.category, scene.night, Math.round(scene.intensity * 8),
            Math.round(scene.cloud01 * 5), Math.round(scene.windMph / 8),
            Math.round(scene.slant * 10),
            this._settings.get_int('weather-atmosphere-density'),
            this._settings.get_boolean('weather-lightning'),
            this._animate(), this._skies ? 'sky' : 'nosky',
            this._layers[0] ? `${Math.round(this._layers[0].stage.w)}x${Math.round(this._layers[0].stage.h)}@${Math.round(this._layers[0].roof.y / 8)}` : 'nostage',
            this._skies?.map(s => Math.round(s.fraction * 20)).join(',')].join('|');
    }

    _rebuildScene() {
        const enabled = this._settings.get_boolean('weather-enabled') &&
            this._settings.get_boolean('weather-atmosphere') &&
            (this._service?.hasPlace() ?? false);
        const scene = enabled ? sceneForPayload(this._payload) : null;
        this.visible = !!scene;
        if (!scene)
            return;
        const key = this._sceneKeyFor(scene);
        if (key === this._sceneKey)
            return;
        this._sceneKey = key;
        this._scene = scene;
        for (const layer of this._layers)
            this._buildLayerPools(layer, scene);
        if (!this._animate())
            this._tick(12);
    }

    _buildLayerPools(layer, scene) {
        const {monitor, actor, stage} = layer;
        const W = stage.w, H = stage.h;
        const sky = this._skies?.[layer.index] ?? new MonitorSky(monitor, null, 0, 0);
        const seedBase = layer.index * 10000;
        const sizeScale = clamp(monitor.height / 1080, 0.75, 2.2);
        const areaSqrt = Math.sqrt((W * H) / (1920 * 1080));
        const densityPref = this._settings.get_int('weather-atmosphere-density') / 100;
        actor.destroy_all_children();
        layer.rain = []; layer.snow = []; layer.stars = [];
        layer.clouds = []; layer.shadows = []; layer.lights = []; layer.fogs = [];
        layer.glow = null; layer.moon = null; layer.flash = null; layer.snowCap = null;
        const cat = scene.category;
        // The clock cluster is an invisible box inside the stage: rain
        // splashes on its roof, rolls to a corner and drips off; snow
        // settles on the roof and melts. Convert the monitor-local
        // roof into stage-local coordinates once, here.
        const roof = {
            x0: layer.roof.x0 - stage.x, x1: layer.roof.x1 - stage.x,
            y: layer.roof.y - stage.y, bottom: layer.roof.bottom - stage.y,
        };
        layer.roofLocal = roof;
        const horizonLocal = xLocal =>
            sky.horizonAt(clamp(xLocal + stage.x, 0, monitor.width - 1)) - stage.y;
        const hasSky = !sky.mask ||
            !!sky.sampleIn(mulberry32(7 + layer.index), stage.x, stage.y,
                stage.x + W, stage.y + H * 0.6);

        // Cloud shadows cross the stage (and so pass behind the clock);
        // overcast makes them strong, partly-cloudy days get a warm
        // break between decks.
        const shadowCount = {'partly-cloudy': 2, overcast: 3, drizzle: 2, rain: 2, storm: 3, snow: 1}[cat] ?? 0;
        for (let i = 0; i < shadowCount; i++) {
            const rx = W * (0.34 + 0.3 * jitter(i, 21)), ry = H * (0.2 + 0.16 * jitter(i, 22));
            const alpha = (cat === 'partly-cloudy' ? 0.12 + 0.08 * jitter(i, 23)
                : cat === 'overcast' ? 0.22 + 0.12 * jitter(i, 23)
                : 0.14 + 0.12 * jitter(i, 23)) * (0.4 + 0.6 * scene.cloud01);
            const a = makeSoftEllipse(rx, ry, '8, 12, 22', alpha.toFixed(3));
            actor.add_child(a);
            layer.shadows.push({a, x0: jitter(i, 24) * (W + 2 * rx) - rx, y: H * (0.15 + 0.6 * jitter(i, 25)), rx, ry, vx: (9 + 17 * jitter(i, 26)) * (0.5 + scene.windMph / 18) * sizeScale});
        }
        if (cat === 'partly-cloudy' && !scene.night) {
            const rx = W * (0.3 + 0.18 * jitter(0, 31)), ry = H * (0.18 + 0.1 * jitter(0, 32));
            const a = makeSoftEllipse(rx, ry, '255, 214, 140', (0.05 + 0.04 * jitter(0, 33)).toFixed(3));
            actor.add_child(a);
            layer.lights.push({a, x0: jitter(0, 34) * (W + 2 * rx) - rx, y: H * (0.25 + 0.5 * jitter(0, 35)), rx, ry, vx: (9 + 11 * jitter(0, 36)) * (0.5 + scene.windMph / 18) * sizeScale});
        }

        // Sky layer: glow, moon, stars, clouds — in detected sky
        // inside the stage only.
        if (cat === 'clear' || cat === 'mostly-clear' || cat === 'partly-cloudy' || cat === 'overcast') {
            if (cat !== 'overcast' && hasSky) {
                const rng = mulberry32(20261014 + layer.index);
                let spot = null;
                for (let i = 0; i < 24; i++) {
                    const p = sky.sampleIn(rng, stage.x, stage.y, stage.x + W, stage.y + H * 0.55);
                    if (!p)
                        break;
                    if (p.x > stage.x + W * 0.45) {
                        spot = p;
                        break;
                    }
                    if (!spot)
                        spot = p;
                }
                // No sky in the stage means no glow and no moon: a
                // fixed fallback position would put a moon over the
                // wallpaper's trees, which is the placement this
                // design exists to avoid. (When detection itself is
                // unavailable, at() falls back to the upper band and
                // a spot is found as before.)
                if (spot) {
                    const gx = spot.x - stage.x, gy = spot.y - stage.y;
                    const glowR = Math.min(W, H) * (scene.night ? 0.42 : 0.55);
                    const glow = makeSoftEllipse(glowR, glowR,
                        scene.night ? '196, 214, 245' : '255, 196, 92', scene.night ? '0.20' : '0.34');
                    glow.set_position(Math.round(gx - glowR), Math.round(gy - glowR));
                    actor.add_child(glow);
                    layer.glow = {a: glow, night: scene.night};
                    if (scene.night) {
                        const moonSize = Math.round(56 * sizeScale);
                        const mr = moonSize / 2;
                        // The disc's footprint, not just its centre, in sky.
                        const fits = !sky.mask ||
                            (sky.at(spot.x - mr * 0.7, spot.y) && sky.at(spot.x + mr * 0.7, spot.y) &&
                             sky.at(spot.x, spot.y - mr * 0.7) && sky.at(spot.x, spot.y + mr * 0.7));
                        if (fits) {
                            const moon = makeMoon(moonSize);
                            moon.set_position(Math.round(gx - mr), Math.round(gy - mr));
                            actor.add_child(moon);
                            layer.moon = moon;
                        }
                    }
                }
            }
            if (scene.night && sky.fraction > 0.03 && hasSky) {
                const density = Math.min(1, sky.fraction / 0.35) *
                    (cat === 'clear' ? 1 : 0.4) * (1 - scene.cloud01 * 0.7);
                const count = Math.min(70, Math.round(64 * density * densityPref));
                const rng = mulberry32(20261014 + layer.index * 7919);
                const minSep = 16 * sizeScale;
                const placed = [];
                for (let i = 0; i < count; i++) {
                    let spot = null;
                    for (let attempt = 0; attempt < 24 && !spot; attempt++) {
                        const p = sky.sampleIn(rng, stage.x, stage.y, stage.x + W, stage.y + H * 0.65);
                        if (!p || placed.some(q => Math.abs(q.x - p.x) < minSep && Math.abs(q.y - p.y) < minSep))
                            continue;
                        spot = p;
                    }
                    if (!spot)
                        continue;
                    const mag = Math.pow(rng(), 2.1);
                    const r = (0.8 + mag * 1.6) * sizeScale;
                    const a = makeParticle('lss-atmo-star', r * 2, r * 2);
                    a.set_position(Math.round(spot.x - stage.x - r), Math.round(spot.y - stage.y - r));
                    actor.add_child(a);
                    const star = {
                        a, x: spot.x, y: spot.y,
                        base: 0.3 + mag * 0.7,
                        fade: clamp((sky.horizonAt(spot.x) - spot.y) / (monitor.height * 0.16), 0.12, 1),
                        ph: rng(), per: [4, 5, 6][i % 3],
                    };
                    placed.push(star);
                    layer.stars.push(star);
                }
            }
            if ((cat === 'partly-cloudy' || cat === 'overcast') && hasSky) {
                const n = cat === 'partly-cloudy' ? Math.round(2 + scene.cloud01 * 3) : Math.round(3 + scene.cloud01 * 4);
                const rgb = cat === 'overcast'
                    ? (scene.night ? '86, 94, 116' : '122, 132, 152')
                    : (scene.night ? '150, 160, 184' : '244, 247, 252');
                for (let i = 0; i < n; i++) {
                    const rx = W * (0.16 + 0.18 * jitter(i + seedBase, 41));
                    const ry = rx * 0.3;
                    const holder = new Clutter.Actor({reactive: false});
                    for (const [dx, dy, s] of [[0, 0, 1], [-0.45, 0.1, 0.65], [0.45, -0.08, 0.55]]) {
                        const e = makeSoftEllipse(rx * s, ry * s, rgb,
                            (cat === 'partly-cloudy' ? 0.14 + 0.08 * jitter(i, 42) : 0.24 + 0.12 * jitter(i, 42)).toFixed(3));
                        e.set_position(Math.round(dx * rx), Math.round(dy * rx));
                        holder.add_child(e);
                    }
                    actor.add_child(holder);
                    const x0 = jitter(i + seedBase, 43) * (W + 3 * rx) - 1.5 * rx;
                    layer.clouds.push({
                        a: holder, x0, rx, ry,
                        y: Math.max(ry, horizonLocal(clamp(x0, 0, W - 1)) * (0.15 + 0.4 * jitter(i, 44))),
                        vx: (7 + 10 * jitter(i, 45)) * (0.5 + scene.windMph / 16) * sizeScale,
                    });
                }
            }
        }

        // Fog gathers at the base of the clock: a soft wash over the
        // stage plus puffs drifting through the cluster's foot.
        if (cat === 'fog') {
            const col = scene.night ? '188, 198, 218' : '226, 232, 242';
            const wash = new St.Widget({width: Math.round(W), height: Math.round(H), reactive: false});
            wash.set_style(
                'background-gradient-direction: vertical;' +
                `background-gradient-start: rgba(${col}, 0.04);` +
                `background-gradient-end: rgba(${col}, 0.20);`);
            actor.add_child(wash);
            for (let i = 0; i < 8; i++) {
                const rx = W * (0.2 + 0.24 * jitter(i, 51)), ry = H * (0.06 + 0.07 * jitter(i, 52));
                const a = makeSoftEllipse(rx, ry, col, (0.06 + 0.09 * jitter(i, 53)).toFixed(3));
                actor.add_child(a);
                layer.fogs.push({
                    a, rx, ry, x0: jitter(i, 54) * (W + 2 * rx) - rx,
                    y: clamp(roof.bottom + (jitter(i, 55) - 0.3) * H * 0.24, ry, H - ry * 0.3),
                    vx: (jitter(i, 56) < 0.5 ? -1 : 1) * (5 + 10 * jitter(i, 57)) * sizeScale,
                });
            }
        }

        // Precipitation, with the clock box as an obstacle. Paths are
        // measured in fall-equivalent pixels s: fall to the roof,
        // (rain) roll along it at 0.45x fall speed, then drip off the
        // corner; (snow) stick on the roof and melt. Drops that miss
        // the box fall the full stage beside the clock.
        if (cat === 'drizzle' || cat === 'rain' || cat === 'storm') {
            const count = Math.min(170, Math.round(
                150 * areaSqrt * scene.intensity * densityPref * (cat === 'drizzle' ? 0.5 : 1)));
            for (let i = 0; i < count; i++) {
                const depth = jitter(i + seedBase, 61);
                const len = (10 + 12 * jitter(i, 62)) * (1.25 - 0.55 * depth) * sizeScale;
                const a = makeParticle('lss-atmo-drop', depth < 0.33 ? 2 : 1.4, len);
                a.set_pivot_point(0.5, 0.5);
                a.opacity = 0;
                actor.add_child(a);
                // Storm gusts vary per drop, baked in here: the tick
                // must draw the same slant the roof intersection below
                // was computed from, or a drop jumps sideways when its
                // roll begins.
                const dSlant = scene.slant * (cat === 'storm' ? 0.75 + 0.5 * jitter(i, 66) : 1);
                const dAngle = Math.atan(dSlant) * 180 / Math.PI;
                a.rotation_angle_z = dAngle;
                const x0 = jitter(i, 63) * (W + H * 0.5) - H * 0.25;
                const fallToRoof = roof.y + len;
                const xAtRoof = x0 + dSlant * fallToRoof;
                const hit = roof.y > 10 && xAtRoof >= roof.x0 && xAtRoof <= roof.x1;
                let s1 = 0, s2 = 0, total = H + 2 * len, cornerX = 0, rollDir = 1;
                if (hit) {
                    rollDir = scene.slant > 0.04 ? 1 : scene.slant < -0.04 ? -1
                        : (xAtRoof < (roof.x0 + roof.x1) / 2 ? -1 : 1);
                    cornerX = rollDir > 0 ? roof.x1 : roof.x0;
                    const rollPx = Math.max(10, Math.abs(cornerX - xAtRoof));
                    s1 = fallToRoof;
                    s2 = s1 + rollPx / 0.45;
                    total = s2 + (H - roof.y) + len;
                }
                const speed = (780 + 320 * jitter(i, 65)) * (1.25 - 0.45 * depth) * sizeScale;
                layer.rain.push({
                    a, len, depth, x0, hit, s1, s2, total, cornerX, rollDir, xAtRoof,
                    slant: dSlant, angleDeg: dAngle,
                    rate: speed * LOOP_S / total,
                    phase: jitter(i, 64),
                    peak: Math.round(255 - 90 * depth),
                    _sq: false,
                });
            }
        }
        if (cat === 'snow') {
            const count = Math.min(110, Math.round(95 * areaSqrt * scene.intensity * densityPref));
            // A settled cap along the roof sells the accumulation the
            // sticking flakes imply.
            if (roof.x1 - roof.x0 > 80 && roof.y > 10) {
                const capRx = (roof.x1 - roof.x0) / 2 * 0.98;
                const capRy = Math.max(4, 6 * sizeScale);
                const cap = makeSoftEllipse(capRx, capRy, '240, 246, 255',
                    (0.3 + 0.3 * clamp(scene.intensity, 0, 1)).toFixed(3));
                cap.set_position(Math.round((roof.x0 + roof.x1) / 2 - capRx),
                    Math.round(roof.y - capRy * 0.6));
                actor.add_child(cap);
                layer.snowCap = cap;
            }
            for (let i = 0; i < count; i++) {
                const depth = jitter(i + seedBase, 71);
                const r = (1.1 + 2.3 * jitter(i, 72)) * (1.3 - 0.6 * depth) * sizeScale;
                const a = makeParticle('lss-atmo-flake', r * 2, r * 2);
                a.set_pivot_point(0.5, 0.5);
                a.opacity = 0;
                actor.add_child(a);
                const x0 = jitter(i, 73) * W;
                const swayAmp = (14 + 28 * jitter(i, 77)) * sizeScale;
                const phase = jitter(i, 74);
                const s1 = roof.y + 2 * r;
                const swayAt = s => Math.sin(s / (140 * sizeScale) + phase * TAU) * swayAmp;
                const xAtRoof = x0 + swayAt(s1) + scene.slant * s1 * 0.35;
                const fSlant = scene.slant;
                const hit = roof.y > 10 && xAtRoof >= roof.x0 && xAtRoof <= roof.x1;
                const stickS = hit ? (120 + 180 * jitter(i, 78)) * sizeScale : 0;
                const total = hit ? s1 + stickS : H + 4 * r;
                const speed = (150 + 80 * jitter(i, 79)) * (1.25 - 0.5 * depth) * sizeScale;
                layer.snow.push({
                    a, r, depth, x0, hit, s1: hit ? s1 : 0, stickS, total,
                    stickX: xAtRoof, slant: fSlant,
                    rate: speed * LOOP_S / total,
                    phase,
                    spin: (jitter(i, 75) < 0.5 ? -1 : 1) * (1 + Math.round(jitter(i, 76) * 2)),
                    swayAmp,
                    peak: Math.round(235 - 70 * depth),
                });
            }
        }
        if (cat === 'storm' && this._settings.get_boolean('weather-lightning')) {
            // Lightning lights the stage behind the clock, not the
            // whole room: a soft flash, never a full-screen white.
            const flash = makeSoftEllipse(W * 0.55, H * 0.42, '234, 240, 255', '0.55');
            flash.set_position(Math.round(W * 0.5 - W * 0.55), Math.round(H * 0.26 - H * 0.42));
            flash.opacity = 0;
            actor.add_child(flash);
            layer.flash = flash;
        }
    }

    _tick(t) {
        const scene = this._scene;
        if (!scene)
            return;
        const gust = scene.category === 'storm'
            ? 0.75 + 0.45 * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1.7) : 1;
        for (const layer of this._layers) {
            const {stage, roofLocal: roof} = layer;
            const W = stage.w, H = stage.h;
            const wrapX = (x, rx) => ((x + rx) % (W + 2 * rx) + W + 2 * rx) % (W + 2 * rx) - rx;
            for (const s of layer.shadows)
                s.a.set_position(Math.round(wrapX(s.x0 + t * s.vx * gust, s.rx) - s.rx), Math.round(s.y - s.ry));
            for (const s of layer.lights)
                s.a.set_position(Math.round(wrapX(s.x0 + t * s.vx, s.rx) - s.rx), Math.round(s.y - s.ry));
            if (layer.glow) {
                const halo = pulse(t, 10);
                layer.glow.a.set_scale(1 + 0.1 * halo, 1 + 0.1 * halo);
                layer.glow.a.opacity = layer.glow.night
                    ? Math.round(150 + 60 * halo) : Math.round(180 + 75 * halo);
            }
            for (const s of layer.stars)
                s.a.opacity = Math.round(255 * (0.35 + 0.65 * pulse(t, s.per, s.ph)) * s.base * s.fade);
            const sky = this._skies?.[layer.index];
            for (const c of layer.clouds) {
                const x = wrapX(c.x0 + t * c.vx, c.rx * 1.8);
                const horizon = sky
                    ? sky.horizonAt(clamp(x + stage.x, 0, layer.monitor.width - 1)) - stage.y
                    : H * 0.3;
                const maxY = horizon - c.ry * 0.7;
                c.a.set_position(Math.round(x - c.rx), Math.round(Math.min(c.y, Math.max(c.ry, maxY)) - c.ry));
            }
            for (const f of layer.fogs)
                f.a.set_position(Math.round(wrapX(f.x0 + t * f.vx, f.rx) - f.rx), Math.round(f.y - f.ry));
            if (roof) {
                for (const d of layer.rain) {
                    const f = frac(t / LOOP_S * d.rate + d.phase);
                    const s = f * d.total;
                    let x, y, rot = d.angleDeg;
                    if (!d.hit || s < d.s1) {
                        y = -d.len + s;
                        x = d.x0 + d.slant * s;
                    } else if (s < d.s2) {
                        // Splash flat, then roll along the roof.
                        x = d.xAtRoof + d.rollDir * (s - d.s1) * 0.45;
                        y = roof.y - 1;
                        rot = 90;
                    } else {
                        const ds = s - d.s2;
                        y = roof.y + ds;
                        x = d.cornerX + d.rollDir * 3 + d.slant * ds * 0.5;
                    }
                    const squash = d.hit && s >= d.s1 && s < d.s1 + 14;
                    if (squash !== d._sq) {
                        d.a.set_scale(squash ? 1.6 : 1, squash ? 0.35 : 1);
                        d._sq = squash;
                    }
                    d.a.rotation_angle_z = rot;
                    d.a.set_position(Math.round((((x + 40) % (W + 80)) + W + 80) % (W + 80) - 40), Math.round(y));
                    d.a.opacity = Math.round(d.peak * envelope(f));
                }
                for (const fl of layer.snow) {
                    const f = frac(t / LOOP_S * fl.rate + fl.phase);
                    const s = f * fl.total;
                    if (fl.hit && s >= fl.s1) {
                        // Settled on the roof: sit, then melt away.
                        const melt = clamp((s - fl.s1) / fl.stickS, 0, 1);
                        fl.a.set_position(Math.round(fl.stickX), Math.round(roof.y - fl.r * 0.6));
                        fl.a.opacity = Math.round(fl.peak * (1 - 0.9 * melt));
                    } else {
                        const y = -fl.r * 2 + s;
                        const x = fl.x0 +
                            Math.sin(s / (140 * clamp(layer.monitor.height / 1080, 0.75, 2.2)) + fl.phase * TAU) * fl.swayAmp +
                            fl.slant * s * 0.35;
                        fl.a.set_position(Math.round((((x + 20) % (W + 40)) + W + 40) % (W + 40) - 20), Math.round(y));
                        fl.a.rotation_angle_z = f * 360 * fl.spin;
                        fl.a.opacity = Math.round(fl.peak * envelope(f, 0.08, 0.9));
                    }
                }
            }
            if (layer.flash) {
                const c = t % STRIKE_CYCLE;
                let level = 0;
                for (const s of STRIKES) {
                    const dt = c - s;
                    if (dt >= 0 && dt < 1.2)
                        level = Math.max(level, Math.exp(-dt * 9));
                }
                layer.flash.opacity = Math.round(150 * level);
            }
        }
    }
});
