// Full-screen weather atmosphere: one non-reactive layer per monitor,
// between the blurred wallpaper and the clock/password prompt, so the
// lock screen itself is raining, snowing, foggy, or starlit instead of
// carrying a small animated icon of the weather in its centre.
//
// What goes where follows the wallpaper. Stars, the moon, sun glow, and
// clouds are placed only in sky detected in the wallpaper itself
// (skyCore.js, computed once per wallpaper and cached); rain, snow, fog,
// and cloud shadows fall in front of everything, as weather does. A
// wallpaper with no visible sky gets no stars, which is the point.
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
// are applied at most every ~14ms: positions derive from absolute t, so
// skipping an update loses nothing, and a 120Hz panel does not double
// the JavaScript cost of a 60Hz one.
function loopSeconds(actor, onTick) {
    const timeline = new Clutter.Timeline({
        actor,
        duration: LOOP_S * 1000,
        repeat_count: -1,
    });
    let lastApplied = -1;
    timeline.connect('new-frame', () => {
        const t = timeline.get_progress() * LOOP_S;
        if (lastApplied < 0 || t < lastApplied || t - lastApplied >= 0.014) {
            onTick(t);
            lastApplied = t;
        }
        actor.queue_redraw();
    });
    const sync = () => {
        if (actor.mapped && screenOn())
            timeline.start();
        else
            timeline.pause();
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
        for (let i = 0; i < 64; i++) {
            const x = 8 + rng() * (W - 16);
            const y = 4 + H * 0.6 * Math.pow(rng(), 1.35);
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
    _init({settings, service, monitors, fileForMonitor, fallbackFile, onGradeDirty}) {
        super._init({reactive: false});
        this._settings = settings;
        this._service = service;
        this._monitors = monitors;
        this._fileForMonitor = fileForMonitor;
        this._fallbackFile = fallbackFile;
        this._onGradeDirty = onGradeDirty;
        this._skies = null;
        this._payload = service?.getCachedPayload() ?? null;
        this._sceneKey = null;
        this._layers = [];
        this._skyIdleId = 0;

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

    _buildLayers() {
        this._timeline?._lssDispose?.();
        this._timeline = null;
        if (this._lssTimeline) {
            this._lssTimeline._lssDispose?.();
            this._lssTimeline = null;
        }
        this.destroy_all_children();
        this._layers = this._monitors.map((monitor, i) => {
            const actor = new Clutter.Actor({
                x: monitor.x, y: monitor.y,
                width: monitor.width, height: monitor.height,
                clip_to_allocation: true,
                reactive: false,
            });
            this.add_child(actor);
            return {monitor, index: i, actor, rain: [], snow: [], stars: [], clouds: [], shadows: [], lights: [], fogs: [], glow: null, moon: null, flash: null};
        });
        this._timeline = null;
        if (this._animate())
            this._timeline = loopSeconds(this, t => this._tick(t));
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
    rebuild(monitors) {
        if (monitors)
            this._monitors = monitors;
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

    // The password prompt takes focus; the weather stays, quieter.
    setPromptProgress(progress) {
        this.opacity = Math.round(255 * (1 - 0.55 * clamp(progress, 0, 1)));
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
        const {monitor, actor} = layer;
        const W = monitor.width, H = monitor.height;
        const sky = this._skies?.[layer.index] ?? new MonitorSky(monitor, null, 0, 0);
        const seedBase = layer.index * 10000;
        const sizeScale = clamp(H / 1080, 0.75, 2.2);
        const areaSqrt = Math.sqrt((W * H) / (1920 * 1080));
        const densityPref = this._settings.get_int('weather-atmosphere-density') / 100;
        actor.destroy_all_children();
        layer.rain = []; layer.snow = []; layer.stars = [];
        layer.clouds = []; layer.shadows = []; layer.lights = []; layer.fogs = [];
        layer.glow = null; layer.moon = null; layer.flash = null;
        const cat = scene.category;

        // Cloud shadows cross the land; overcast makes them strong, and
        // partly-cloudy days get warm breaks between decks.
        const shadowCount = {'partly-cloudy': 3, overcast: 6, drizzle: 3, rain: 4, storm: 5, snow: 2}[cat] ?? 0;
        for (let i = 0; i < shadowCount; i++) {
            const rx = W * (0.28 + 0.27 * jitter(i, 21)), ry = H * (0.16 + 0.14 * jitter(i, 22));
            const alpha = (cat === 'partly-cloudy' ? 0.12 + 0.08 * jitter(i, 23)
                : cat === 'overcast' ? 0.22 + 0.12 * jitter(i, 23)
                : 0.14 + 0.12 * jitter(i, 23)) * (0.4 + 0.6 * scene.cloud01);
            const a = makeSoftEllipse(rx, ry, '8, 12, 22', alpha.toFixed(3));
            actor.add_child(a);
            layer.shadows.push({a, x0: jitter(i, 24) * (W + 2 * rx) - rx, y: H * (0.1 + 0.7 * jitter(i, 25)), rx, ry, vx: (9 + 17 * jitter(i, 26)) * (0.5 + scene.windMph / 18) * sizeScale});
        }
        if (cat === 'partly-cloudy' && !scene.night) {
            for (let i = 0; i < 2; i++) {
                const rx = W * (0.22 + 0.18 * jitter(i, 31)), ry = H * (0.14 + 0.1 * jitter(i, 32));
                const a = makeSoftEllipse(rx, ry, '255, 214, 140', (0.05 + 0.04 * jitter(i, 33)).toFixed(3));
                actor.add_child(a);
                layer.lights.push({a, x0: jitter(i, 34) * (W + 2 * rx) - rx, y: H * (0.2 + 0.6 * jitter(i, 35)), rx, ry, vx: (9 + 11 * jitter(i, 36)) * (0.5 + scene.windMph / 18) * sizeScale});
            }
        }

        // Sky layer: glow, moon, stars, clouds — in detected sky only.
        if (cat === 'clear' || cat === 'mostly-clear' || cat === 'partly-cloudy' || cat === 'overcast') {
            if (cat !== 'overcast') {
                const rng = mulberry32(20261014 + layer.index);
                let spot = null;
                for (let i = 0; i < 24 && !spot; i++) {
                    const p = sky.sample(rng);
                    if (p && p.x > W * 0.45)
                        spot = p;
                    else if (p && !spot)
                        spot = p;
                }
                // No sky found means no glow and no moon: a fixed fallback
                // position would put a moon over a forest wallpaper's trees,
                // which is the placement this design exists to avoid. (When
                // detection itself is unavailable, sample() falls back to
                // the upper band and spot is found as before.)
                if (spot) {
                    const gx = spot.x, gy = spot.y;
                    const glowR = Math.min(W, H) * (scene.night ? 0.4 : 0.55);
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
                            (sky.at(gx - mr * 0.7, gy) && sky.at(gx + mr * 0.7, gy) &&
                             sky.at(gx, gy - mr * 0.7) && sky.at(gx, gy + mr * 0.7));
                        if (fits) {
                            const moon = makeMoon(moonSize);
                            moon.set_position(Math.round(gx - mr), Math.round(gy - mr));
                            actor.add_child(moon);
                            layer.moon = moon;
                        }
                    }
                }
            }
            if (scene.night && sky.fraction > 0.03) {
                const density = Math.min(1, sky.fraction / 0.35) *
                    (cat === 'clear' ? 1 : 0.4) * (1 - scene.cloud01 * 0.7);
                const count = Math.min(170, Math.round(150 * density * densityPref));
                const rng = mulberry32(20261014 + layer.index * 7919);
                const minSep = 16 * sizeScale;
                const placed = [];
                for (let i = 0; i < count; i++) {
                    let spot = null;
                    for (let attempt = 0; attempt < 40 && !spot; attempt++) {
                        const p = sky.sample(rng);
                        if (!p || placed.some(q => Math.abs(q.x - p.x) < minSep && Math.abs(q.y - p.y) < minSep))
                            continue;
                        spot = p;
                    }
                    if (!spot)
                        continue;
                    const mag = Math.pow(rng(), 2.1);
                    const r = (0.8 + mag * 1.6) * sizeScale;
                    const a = makeParticle('lss-atmo-star', r * 2, r * 2);
                    a.set_position(Math.round(spot.x - r), Math.round(spot.y - r));
                    actor.add_child(a);
                    const star = {
                        a, x: spot.x, y: spot.y,
                        base: 0.3 + mag * 0.7,
                        fade: clamp((sky.horizonAt(spot.x) - spot.y) / (H * 0.16), 0.12, 1),
                        ph: rng(), per: [4, 5, 6][i % 3],
                    };
                    placed.push(star);
                    layer.stars.push(star);
                }
            }
            if (cat === 'partly-cloudy' || cat === 'overcast') {
                const n = cat === 'partly-cloudy' ? Math.round(2 + scene.cloud01 * 4) : Math.round(4 + scene.cloud01 * 6);
                const rgb = cat === 'overcast'
                    ? (scene.night ? '86, 94, 116' : '122, 132, 152')
                    : (scene.night ? '150, 160, 184' : '244, 247, 252');
                for (let i = 0; i < n; i++) {
                    const rx = W * (0.1 + 0.13 * jitter(i + seedBase, 41));
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
                        y: Math.max(ry, sky.horizonAt(clamp(x0, 0, W - 1)) * (0.15 + 0.4 * jitter(i, 44))),
                        vx: (7 + 10 * jitter(i, 45)) * (0.5 + scene.windMph / 16) * sizeScale,
                    });
                }
            }
        }

        // Fog hugs the ground: a bottom-weighted wash plus soft puffs.
        if (cat === 'fog') {
            const col = scene.night ? '188, 198, 218' : '226, 232, 242';
            const wash = new St.Widget({width: W, height: H, reactive: false});
            wash.set_style(
                'background-gradient-direction: vertical;' +
                `background-gradient-start: rgba(${col}, 0.05);` +
                `background-gradient-end: rgba(${col}, 0.24);`);
            actor.add_child(wash);
            for (let i = 0; i < 16; i++) {
                const rx = W * (0.16 + 0.22 * jitter(i, 51)), ry = H * (0.05 + 0.07 * jitter(i, 52));
                const a = makeSoftEllipse(rx, ry, col, (0.05 + 0.08 * jitter(i, 53)).toFixed(3));
                actor.add_child(a);
                layer.fogs.push({
                    a, rx, ry, x0: jitter(i, 54) * (W + 2 * rx) - rx,
                    y: H * (0.22 + 0.78 * Math.pow(jitter(i, 55), 0.65)),
                    vx: (jitter(i, 56) < 0.5 ? -1 : 1) * (5 + 10 * jitter(i, 57)) * sizeScale,
                });
            }
        }

        // Precipitation falls in front of everything.
        if (cat === 'drizzle' || cat === 'rain' || cat === 'storm') {
            const count = Math.min(520, Math.round(
                380 * areaSqrt * scene.intensity * densityPref * (cat === 'drizzle' ? 0.45 : 1)));
            const angle = Math.atan(scene.slant) * 180 / Math.PI;
            for (let i = 0; i < count; i++) {
                const depth = jitter(i + seedBase, 61);
                const len = (10 + 12 * jitter(i, 62)) * (1.25 - 0.55 * depth) * sizeScale;
                const a = makeParticle('lss-atmo-drop', depth < 0.33 ? 2 : 1.4, len);
                a.set_pivot_point(0.5, 0.5);
                a.rotation_angle_z = angle;
                a.opacity = 0;
                actor.add_child(a);
                layer.rain.push({
                    a, len, depth,
                    x0: jitter(i, 63) * (W + H * 0.6) - H * 0.3,
                    rate: [40, 48, 60][i % 3] * (1.25 - 0.45 * depth),
                    phase: jitter(i, 64),
                    peak: Math.round(255 - 90 * depth),
                });
            }
        }
        if (cat === 'snow') {
            const count = Math.min(300, Math.round(230 * areaSqrt * scene.intensity * densityPref));
            for (let i = 0; i < count; i++) {
                const depth = jitter(i + seedBase, 71);
                const r = (1.1 + 2.3 * jitter(i, 72)) * (1.3 - 0.6 * depth) * sizeScale;
                const a = makeParticle('lss-atmo-flake', r * 2, r * 2);
                a.set_pivot_point(0.5, 0.5);
                a.opacity = 0;
                actor.add_child(a);
                layer.snow.push({
                    a, r, depth,
                    x0: jitter(i, 73) * W,
                    rate: [10, 12, 15][i % 3] * (1.25 - 0.5 * depth),
                    phase: jitter(i, 74),
                    spin: (jitter(i, 75) < 0.5 ? -1 : 1) * (1 + Math.round(jitter(i, 76) * 2)),
                    swayAmp: (14 + 28 * jitter(i, 77)) * sizeScale,
                    peak: Math.round(235 - 70 * depth),
                });
            }
        }
        if (cat === 'storm' && this._settings.get_boolean('weather-lightning')) {
            const flash = new St.Widget({width: W, height: H, reactive: false, opacity: 0});
            flash.set_style('background-color: rgb(234, 240, 255);');
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
            const {monitor: mon, actor} = layer;
            const W = mon.width, H = mon.height;
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
                const maxY = sky ? sky.horizonAt(clamp(x, 0, W - 1)) - c.ry * 0.7 : H * 0.3;
                c.a.set_position(Math.round(x - c.rx), Math.round(Math.min(c.y, Math.max(c.ry, maxY)) - c.ry));
            }
            for (const f of layer.fogs)
                f.a.set_position(Math.round(wrapX(f.x0 + t * f.vx, f.rx) - f.rx), Math.round(f.y - f.ry));
            const slantPx = scene.slant * gust;
            for (const d of layer.rain) {
                const f = frac(t / LOOP_S * d.rate + d.phase);
                const y = -d.len + f * (H + 2 * d.len);
                const x = d.x0 + slantPx * y;
                d.a.set_position(Math.round(((x % (W + 80)) + W + 80) % (W + 80) - 40), Math.round(y));
                d.a.opacity = Math.round(d.peak * envelope(f));
            }
            for (const fl of layer.snow) {
                const f = frac(t / LOOP_S * fl.rate + fl.phase);
                const y = -fl.r * 2 + f * (H + fl.r * 4);
                const x = fl.x0 + Math.sin(f * TAU + fl.phase * TAU) * fl.swayAmp + slantPx * y * 0.35;
                fl.a.set_position(Math.round(((x % (W + 40)) + W + 40) % (W + 40) - 20), Math.round(y));
                fl.a.rotation_angle_z = f * 360 * fl.spin;
                fl.a.opacity = Math.round(fl.peak * envelope(f, 0.08, 0.9));
            }
            if (layer.flash) {
                const c = t % STRIKE_CYCLE;
                let level = 0;
                for (const s of STRIKES) {
                    const dt = c - s;
                    if (dt >= 0 && dt < 1.2)
                        level = Math.max(level, Math.exp(-dt * 9));
                }
                layer.flash.opacity = Math.round(82 * level);
            }
            void actor;
        }
    }
});
