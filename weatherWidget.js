// Weather widget: animated icon + temperature/label text.
//
// Animation strategy — instead of trying to play Lottie/animated SVG inside
// gnome-shell (no renderer support), we compose each condition out of static
// SVG icons (sun, cloud, raindrop, snowflake, bolt) parented to a St.Widget
// and drive their position/rotation/opacity from ONE Clutter.Timeline per
// icon. That's how Shell itself animates its UI, so it plays cleanly inside
// the unlock dialog with no extra deps.
//
// TIMING — one 60-second loop, sub-periods that divide it.
//
// Every icon runs a single repeating 60s timeline and each element derives its
// own frequency from the elapsed seconds. Sub-periods are chosen from the
// divisors of 60 (3,4,5,6,10,12,15,20,30,60) and particle counts from integer
// falls-per-loop, so nothing jumps at the wrap. That is what lets one icon
// carry several independent motions -- drift plus bob plus twinkle -- at
// different speeds without a timer each.
//
// Everything is eased. The first version drove positions and opacity off the
// raw 0->1 progress, so clouds slid at constant speed, rain fell at constant
// speed in an evenly-spaced column, and the storm bolt stepped between two
// opacity levels. Constant velocity is what reads as "basic": real motion
// accelerates, and light decays. `pulse()` and `envelope()` below exist so no
// linear ramp survives anywhere in this file.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Pango from 'gi://Pango';

import {describeWmoCode} from './weatherService.js';
import {screenOn, watchScreen} from './screen.js';

// -- helpers --------------------------------------------------------------

const TAU = Math.PI * 2;
const LOOP_S = 60;

// Smooth 0->1->0 over one period. Cosine, not a triangle: no visible corner at
// the turnaround.
const pulse = (t, periodS, phase = 0) =>
    0.5 - 0.5 * Math.cos(((t / periodS + phase) % 1) * TAU);

// Signed -1->1->-1, for drift that should overshoot and come back.
const sway = (t, periodS, phase = 0) =>
    Math.sin(((t / periodS + phase) % 1) * TAU);

// Fade a particle in as it leaves the cloud and out as it lands, so drops and
// flakes do not pop into existence mid-air.
function envelope(f, inEnd = 0.18, outStart = 0.82) {
    if (f < inEnd)
        return f / inEnd;
    if (f > outStart)
        return (1 - f) / (1 - outStart);
    return 1;
}

// Deterministic per-particle jitter. Stable across icon rebuilds (so a weather
// refresh does not reshuffle the rain) and needs no state.
function jitter(i, salt) {
    const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
}

function makeSvgIcon(extensionPath, name, size) {
    const path = GLib.build_filenamev([extensionPath, 'icons', 'weather', name]);
    const file = Gio.File.new_for_path(path);
    return new St.Icon({
        gicon: new Gio.FileIcon({file}),
        icon_size: size,
    });
}

// A soft halo, drawn by St's own radial gradient rather than a new asset —
// this is the difference between "a flat sun clip-art rotating" and something
// that reads as light. St supports radial `background-gradient-direction`
// natively, so the glow costs one widget and no file.
function makeGlow(size, rgb, alpha) {
    const w = new St.Widget({width: size, height: size});
    w.set_pivot_point(0.5, 0.5);
    w.set_style(
        'background-gradient-direction: radial;' +
        `background-gradient-start: rgba(${rgb}, ${alpha});` +
        `background-gradient-end: rgba(${rgb}, 0);` +
        `border-radius: ${Math.round(size / 2)}px;`
    );
    return w;
}

function centre(actor, size, w, h) {
    actor.set_position(Math.round((size - w) / 2), Math.round((size - h) / 2));
}

function loopSeconds(actor, onTick) {
    // One 60s looping timeline bound to `actor`'s lifetime. Clutter stops and
    // frees the timeline when the actor is destroyed, so there is no explicit
    // teardown.
    const timeline = new Clutter.Timeline({
        actor,
        duration: LOOP_S * 1000,
        repeat_count: -1,
    });
    timeline.connect('new-frame', () => {
        onTick(timeline.get_progress() * LOOP_S);
        // Draw every frame the timeline runs. A slow drift that rounds to the
        // same pixel for several frames leaves nothing to draw, and a frame
        // with nothing drawn is not paced by the display: the overcast, fog and
        // storm icons spun the main loop at a full core that way.
        actor.queue_redraw();
    });

    // Run only while the icon is actually on screen. Two reasons, both real:
    //
    // The icon is built BEFORE it is parented into _iconBin, so starting
    // eagerly trips clutter_timeline_start's "actor has no stage" check and the
    // animation silently never runs.
    //
    // And a 60fps timeline behind a blank screen is pure idle draw on a
    // machine that sits locked for hours, so it also pauses while the monitors
    // are powered off (see watchScreen). pause()/start() resumes in place.
    const sync = () => {
        if (actor.mapped && screenOn())
            timeline.start();
        else
            timeline.pause();
    };
    const mappedId = actor.connect('notify::mapped', sync);
    const unwatchScreen = watchScreen(sync);
    sync();

    // Stop it explicitly when the icon goes away. `Clutter.Timeline({actor})`
    // holds no reference to the actor and, now that the timeline itself is
    // kept alive below, it outlives the actor instead of being collected with
    // it -- so it went on firing `new-frame` into tick closures whose St.Icons
    // were already disposed. Measured in a nested shell: ~244 warnings per
    // orphaned child ("has been already disposed - impossible to set any
    // property on it") after a single icon swap. `_refreshIcon()` swaps the
    // icon on every weather render, so in production that is a new zombie
    // timeline every 15 minutes, for the life of the session.
    actor.connect('destroy', () => {
        actor.disconnect(mappedId);
        unwatchScreen();
        timeline.stop();
    });

    // The timeline MUST be rooted in something the scene graph keeps alive.
    // `Clutter.Timeline({actor})` does not take a reference from the actor, and
    // every caller here discards the return value -- so GJS collected the
    // wrapper and the animation froze a moment after it started. Measured in a
    // nested shell: the rain drops advanced once and then held the exact same
    // y for 2.5s, while a timeline on the SAME actor held in a local variable
    // ticked 48 frames in 800ms. That was the whole of "the animations are a
    // bit basic" -- most of the time there was no animation at all.
    actor._lssTimeline = timeline;
    return timeline;
}

// -- the moon -------------------------------------------------------------
//
// Drawn with cairo instead of shipped as an asset, because the shape has to be
// the real phase. `moon.svg` was a disc with a circular bite out of it -- not
// any phase the moon actually takes, which is exactly why it read as broken.

const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_EPOCH_MS = 947182440000;   // 2000-01-06T18:14Z, a known new moon

// 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter.
//
// Mean synodic phase, no perturbations. Good to roughly +/-0.5 day, which at
// these icon sizes is under a pixel of terminator. If it ever has to be exact,
// the next step is Meeus ch.49 -- not a longer constant.
export function moonPhase(when = new Date()) {
    const days = (when.getTime() - NEW_MOON_EPOCH_MS) / 86400000;
    return ((days / SYNODIC_DAYS) % 1 + 1) % 1;
}

// Near-side maria: x, y and radius in units of the disc radius from its centre,
// plus an x-squash and a peak alpha. Kept low-contrast and nearly flat -- as
// hard-edged circles they read as polka dots, and as broad soft gradients they
// read as bruises. Neither looks like a moon.
const MARIA = [
    [-0.30, -0.34, 0.30, 1.30, 0.30],   // Imbrium
    [ 0.13, -0.16, 0.22, 1.05, 0.26],   // Serenitatis
    [ 0.33,  0.13, 0.21, 0.90, 0.26],   // Tranquillitatis
    [ 0.00,  0.45, 0.17, 1.40, 0.20],   // Nubium
    [-0.52,  0.18, 0.27, 0.75, 0.24],   // Procellarum
    [ 0.56, -0.28, 0.11, 1.00, 0.22],   // Crisium
];

const MOON_LIT = [0.96, 0.97, 1.00];
const MOON_DARK = [0.40, 0.44, 0.58];
const MOON_EDGE = [0.70, 0.75, 0.88];
const MOON_MARE = [0.56, 0.61, 0.76];

const rgba = (cr, [r, g, b], a) => cr.setSourceRGBA(r, g, b, a);

// Trace the lit region: the outer limb, then back along the terminator.
//
// The limb is an exact cairo arc and only the terminator is sampled. Sampling
// both (the first version, 64 segments each) cut the crescent's horns: near the
// poles a uniform step in angle moves x by ~3px at these sizes, so the tips came
// out blunt and rounded instead of pointed, which is a large part of what read
// as "squishy".
function litPath(cr, cx, cy, r, phase) {
    const lit = (1 - Math.cos(phase * TAU)) / 2;
    // Northern hemisphere: a waxing moon is lit on its right limb. A southern
    // latitude would negate `s`.
    const s = phase < 0.5 ? 1 : -1;
    const rx = r * (1 - 2 * lit);              // signed terminator semi-axis
    const N = 192;

    cr.newPath();
    if (s > 0)
        cr.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);           // top -> right -> bottom
    else
        cr.arcNegative(cx, cy, r, -Math.PI / 2, -3 * Math.PI / 2); // top -> left -> bottom
    for (let i = N; i >= 0; i--) {                               // bottom -> top
        const a = -Math.PI / 2 + (i / N) * Math.PI;
        cr.lineTo(cx + s * rx * Math.cos(a), cy + r * Math.sin(a));
    }
    cr.closePath();
}

function drawMoon(cr, size, phase) {
    const line = Math.max(1, size * 0.013);
    const r = size * 0.46 - line / 2;
    const cx = size / 2;
    const cy = size / 2;

    // The unlit side is drawn, faintly. It is what keeps the SILHOUETTE a
    // circle at every phase -- without it a gibbous moon is an egg and a
    // crescent is a claw, which is exactly the "puffy and squishy" complaint.
    // Earthshine is also a real thing to see on a young moon.
    cr.newPath();
    cr.arc(cx, cy, r, 0, TAU);
    // 0.14 / 0.45 chosen off a rendered matrix against 0.34/0.90 and 0.20/0.60:
    // above ~0.2 the unlit half stops reading as a dark limb and starts reading
    // as a two-tone pie chart.
    rgba(cr, MOON_DARK, 0.14);
    cr.fill();

    // Flat fill with only a whisper of shading. The previous version ramped
    // 0.99 -> 0.78 across the disc, which made it look like a soft blob next to
    // a flat vector sun and flat vector clouds. This icon set is flat: body
    // fill plus a 2px-equivalent edge, same as sun.svg and cloud.svg.
    litPath(cr, cx, cy, r, phase);
    const body = new Cairo.RadialGradient(
        cx - r * 0.35, cy - r * 0.35, r * 0.15, cx, cy, r * 1.6);
    body.addColorStopRGBA(0, ...MOON_LIT, 1);
    body.addColorStopRGBA(1, 0.90, 0.92, 0.97, 1);
    cr.setSource(body);
    cr.fillPreserve();

    // Maria are clipped to the lit shape, so a crescent shows only the few that
    // fall on its sliver -- which is what the real thing does.
    cr.save();
    cr.clip();
    for (const [mx, my, mr, sx, alpha] of MARIA) {
        cr.save();
        cr.translate(cx + mx * r, cy + my * r);
        cr.scale(sx, 1 / sx);
        // Built after the scale so the gradient is squashed with the shape.
        // The stops hold flat to 0.72 and only then fade: a mare wants a soft
        // edge, not a soft middle.
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

    // One crisp edge around the whole disc -- never around the terminator,
    // which in life is a gradient and not a line.
    cr.newPath();
    cr.arc(cx, cy, r, 0, TAU);
    cr.setLineWidth(line);
    rgba(cr, MOON_EDGE, 0.45);
    cr.stroke();
}

export function makeMoon(size, phase = moonPhase()) {
    const area = new St.DrawingArea({width: size, height: size});
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

// -- icon factories -------------------------------------------------------
//
// Each factory returns an `St.Widget` of the requested size whose internal
// transitions are owned by the widget (so destroying the widget stops them).
//
// GEOMETRY — icon_size is the ONLY size knob. Never call set_size() on an
// St.Icon here.
//
// St rasterises a gicon into an icon_size x icon_size box and stretches the
// viewBox to fill it; when the allocation differs from icon_size it then
// rescales the whole square to the SMALLER of the two. Measured at icon_size
// 200: a bare cloud drew 174x149 (the 2.3:1 art squashed to 1.17:1), and the
// `set_size(200, 120)` the old code used to correct that drew it at 104x89 --
// 60% of the size asked for. That is why the drops used to fall beside the
// cloud instead of out of it. The SVG viewBoxes are now square with the art
// centred, so an icon of box side S draws undistorted and its art occupies a
// known fraction of S:

const CLOUD_TOP = 0.28;      // cloud art spans y in [0.28S, 0.72S] of its box
const CLOUD_H = 0.44;
const NARROW = 0.5;          // raindrop and bolt art are half their box wide

// Sun or moon with its halo, sized and positioned into `root`. Returns a tick
// function so a caller that already owns a timeline (the partly-cloudy icon)
// can drive it without starting a second one.
function addLuminary(root, extensionPath, size, {night = false, x = 0, y = 0} = {}) {
    // The moon's halo is tighter and dimmer than the sun's on purpose. The sun
    // is a flat disc that NEEDS the glow to read as a light source; the moon is
    // now a crisp edged body, and a wide soft halo just puts the fuzz back
    // around it -- the "puffy" look this drawing was rewritten to remove.
    const glowSize = Math.round(size * (night ? 1.38 : 1.7));
    const glow = makeGlow(
        glowSize,
        night ? '198, 214, 245' : '255, 200, 74',
        night ? 0.18 : 0.45
    );
    glow.set_position(
        Math.round(x + (size - glowSize) / 2),
        Math.round(y + (size - glowSize) / 2)
    );
    root.add_child(glow);

    const disc = night
        ? makeMoon(size)
        : makeSvgIcon(extensionPath, 'sun.svg', size);
    disc.set_pivot_point(0.5, 0.5);
    disc.set_position(x, y);
    root.add_child(disc);

    // The sun turns; the moon does not (a rotating moon reads as a bug). Both
    // breathe, which is what carries the animation when nothing else moves.
    return (t) => {
        if (!night)
            disc.rotation_angle_z = (t / 30) * 360;   // 30s/turn, 2 turns per loop
        const breath = pulse(t, 6);
        disc.set_scale(1 + 0.035 * breath, 1 + 0.035 * breath);
        const halo = pulse(t, 10);
        glow.set_scale(1 + 0.14 * halo, 1 + 0.14 * halo);
        glow.opacity = night
            ? Math.round(130 + 70 * halo)
            : Math.round(170 + 85 * halo);
    };
}

function buildSunIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const tick = addLuminary(root, extensionPath, size, {night: false});
    if (animate)
        loopSeconds(root, tick);
    return root;
}

function buildMoonIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});

    // A few stars, so a clear night is a scene rather than one static crescent.
    // A lock screen shows this condition on most clear evenings.
    const stars = [];
    for (let i = 0; i < 6; i++) {
        const r = Math.max(2, Math.round(size * (0.011 + 0.011 * jitter(i, 3))));
        const star = new St.Widget({width: r * 2, height: r * 2});
        star.set_pivot_point(0.5, 0.5);
        star.set_style(
            'background-gradient-direction: radial;' +
            'background-gradient-start: rgba(255, 255, 255, 0.95);' +
            'background-gradient-end: rgba(255, 255, 255, 0);' +
            `border-radius: ${r}px;`
        );
        // Kept out of the disc's own circle so they read as sky, not specks on
        // the moon.
        const ang = jitter(i, 1) * TAU;
        const rad = size * (0.40 + 0.12 * jitter(i, 2));
        star.set_position(
            Math.round(size / 2 + Math.cos(ang) * rad - r),
            Math.round(size / 2 + Math.sin(ang) * rad * 0.85 - r)
        );
        root.add_child(star);
        stars.push({star, period: [4, 5, 6][i % 3], phase: jitter(i, 4)});
    }

    const bobRange = Math.max(2, Math.round(size * 0.02));
    const disc = Math.round(size * 0.84);
    const tick = addLuminary(root, extensionPath, disc, {
        night: true,
        x: Math.round((size - disc) / 2),
        y: Math.round((size - disc) / 2),
    });

    if (animate) {
        loopSeconds(root, (t) => {
            tick(t);
            root.translation_y = sway(t, 12) * bobRange;
            for (const {star, period, phase} of stars) {
                const p = pulse(t, period, phase);
                star.opacity = Math.round(50 + 205 * p);
                star.set_scale(0.7 + 0.5 * p, 0.7 + 0.5 * p);
            }
        });
    } else {
        for (const {star} of stars)
            star.opacity = 200;
    }
    return root;
}

// One cloud body: front-and-back layers so drift has parallax instead of a
// single shape sliding across a flat backdrop. `top` is where the cloud ART
// should start, not where its box goes -- see the geometry note above.
function addClouds(root, extensionPath, size, {dark = false, w, x, top}) {
    const file = dark ? 'cloud-dark.svg' : 'cloud.svg';

    const backW = Math.round(w * 0.70);
    const back = makeSvgIcon(extensionPath, file, backW);
    const backX = Math.round(x + w * 0.30);
    const backY = Math.round(top - w * 0.045 - backW * CLOUD_TOP);
    back.set_position(backX, backY);
    back.opacity = dark ? 140 : 115;
    root.add_child(back);

    const front = makeSvgIcon(extensionPath, file, w);
    const frontX = Math.round(x);
    const frontY = Math.round(top - w * CLOUD_TOP);
    front.set_position(frontX, frontY);
    root.add_child(front);

    const drift = Math.max(3, Math.round(size * 0.05));
    return {
        front,
        artBottom: Math.round(top + w * CLOUD_H),
        tick: (t) => {
            // Different periods and directions, so the two layers separate and
            // rejoin rather than moving as one block.
            back.set_position(backX - Math.round(sway(t, 30, 0.25) * drift * 1.5), backY);
            front.set_position(
                frontX + Math.round(sway(t, 20) * drift),
                frontY + Math.round(pulse(t, 12) * drift * 0.25)
            );
        },
    };
}

function buildCloudIcon(extensionPath, size, animate, {dark = false, withSun = false, night = false} = {}) {
    const root = new St.Widget({width: size, height: size});

    let sunTick = null;
    if (withSun) {
        const small = Math.round(size * 0.56);
        sunTick = addLuminary(root, extensionPath, small, {
            night,
            x: Math.round(size * 0.05),
            y: Math.round(size * 0.02),
        });
    }

    const clouds = withSun
        ? {w: Math.round(size * 0.78), x: Math.round(size * 0.20), top: Math.round(size * 0.34)}
        : {w: Math.round(size * 0.98), x: Math.round(size * 0.01), top: Math.round(size * 0.24)};
    const c = addClouds(root, extensionPath, size, {dark, ...clouds});

    if (animate) {
        loopSeconds(root, (t) => {
            sunTick?.(t);
            c.tick(t);
        });
    }
    return root;
}

function buildRainIcon(extensionPath, size, animate, {heavy = false} = {}) {
    const root = new St.Widget({width: size, height: size});
    const clouds = addClouds(root, extensionPath, size, {
        dark: true,
        w: Math.round(size * 0.94),
        x: Math.round(size * 0.03),
        top: Math.round(size * 0.05),
    });

    const count = heavy ? 9 : 5;
    const yStart = clouds.artBottom - Math.round(size * 0.04);
    const yEnd = Math.round(size * 0.98);
    const span = yEnd - yStart;
    // Falls per 60s loop. Divisors of 60 only, or the loop wrap shows as a
    // stutter. Three speeds give depth; the slow ones read as further away.
    const rates = heavy ? [60, 75, 60] : [40, 48, 40];
    const lean = size * (heavy ? 0.10 : 0.06);      // wind

    const drops = [];
    for (let i = 0; i < count; i++) {
        const depth = jitter(i, 7);                 // 0 = near, 1 = far
        // Box side; the drop art is half this wide and nearly all of it tall.
        const box = Math.max(6, Math.round(size * (0.20 - 0.075 * depth)));
        const drop = makeSvgIcon(extensionPath, 'raindrop.svg', box);
        const x = Math.round(size * (0.07 + 0.80 * ((i + 0.15 + 0.7 * jitter(i, 5)) / count))
                             - box / 2);
        drop.set_position(x, yStart);
        drop.opacity = 0;
        root.add_child(drop);
        drops.push({
            drop, x,
            rate: rates[i % rates.length],
            phase: jitter(i, 6),
            peak: Math.round(255 - 80 * depth),
            lean: lean * (0.6 + 0.4 * depth),
        });
    }

    if (animate) {
        loopSeconds(root, (t) => {
            clouds.tick(t);
            for (const d of drops) {
                const f = ((t / LOOP_S) * d.rate + d.phase) % 1;
                // f**1.6 is gravity: a drop leaves the cloud slowly and lands
                // fast. The linear version was the single most "basic"-looking
                // thing here.
                const fall = Math.pow(f, 1.6);
                d.drop.set_position(
                    d.x + Math.round(fall * d.lean),
                    Math.round(yStart + fall * span)
                );
                d.drop.opacity = Math.round(d.peak * envelope(f, 0.14, 0.80));
            }
        });
    } else {
        for (const d of drops) {
            d.drop.set_position(d.x, Math.round(yStart + 0.5 * span));
            d.drop.opacity = d.peak;
        }
    }
    return root;
}

function buildSnowIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const clouds = addClouds(root, extensionPath, size, {
        dark: false,
        w: Math.round(size * 0.94),
        x: Math.round(size * 0.03),
        top: Math.round(size * 0.05),
    });

    const count = 7;
    const yStart = clouds.artBottom - Math.round(size * 0.03);
    const flakes = [];
    for (let i = 0; i < count; i++) {
        const depth = jitter(i, 11);
        const fs = Math.max(5, Math.round(size * (0.20 - 0.09 * depth)));
        const flake = makeSvgIcon(extensionPath, 'snowflake.svg', fs);
        flake.set_pivot_point(0.5, 0.5);
        const x = Math.round(size * (0.06 + 0.82 * ((i + 0.15 + 0.7 * jitter(i, 9)) / count)) - fs / 2);
        flake.set_position(x, yStart);
        flake.opacity = 0;
        root.add_child(flake);
        flakes.push({
            flake, x, size: fs,
            rate: [10, 12, 15][i % 3],              // 6s / 5s / 4s per fall
            phase: jitter(i, 8),
            spin: (jitter(i, 10) < 0.5 ? -1 : 1) * (1 + Math.round(jitter(i, 12) * 2)),
            swayAmp: size * (0.03 + 0.05 * jitter(i, 13)),
            peak: Math.round(235 - 60 * depth),
        });
    }

    if (animate) {
        loopSeconds(root, (t) => {
            clouds.tick(t);
            for (const f of flakes) {
                const p = ((t / LOOP_S) * f.rate + f.phase) % 1;
                const yEnd = size - f.size;
                // Two sway frequencies so flakes wander instead of tracing one
                // clean sine down the screen.
                const drift = Math.sin(p * TAU) * f.swayAmp +
                              Math.sin(p * TAU * 2.7 + f.phase * TAU) * f.swayAmp * 0.35;
                f.flake.set_position(
                    f.x + Math.round(drift),
                    Math.round(yStart + p * (yEnd - yStart))
                );
                f.flake.rotation_angle_z = p * 360 * f.spin;
                f.flake.opacity = Math.round(f.peak * envelope(p, 0.16, 0.84));
            }
        });
    } else {
        for (const f of flakes)
            f.flake.opacity = f.peak;
    }
    return root;
}

function buildStormIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const clouds = addClouds(root, extensionPath, size, {
        dark: true,
        w: Math.round(size * 0.94),
        x: Math.round(size * 0.03),
        top: Math.round(size * 0.04),
    });

    const box = Math.round(size * 0.52);            // bolt art is half this wide
    const boltX = Math.round((size - box) / 2);
    const boltY = clouds.artBottom - Math.round(size * 0.05);

    // The flash has to light something other than the bolt or it reads as an
    // icon blinking rather than a storm.
    const glowSize = Math.round(size * 0.85);
    const flash = makeGlow(glowSize, '255, 244, 180', 0.6);
    flash.set_position(
        boltX + Math.round(box / 2 - glowSize / 2),
        boltY + Math.round(box / 2 - glowSize / 2)
    );
    flash.opacity = 0;
    root.add_child(flash);

    const bolt = makeSvgIcon(extensionPath, 'bolt.svg', box);
    bolt.set_position(boltX, boltY);
    bolt.opacity = 60;
    root.add_child(bolt);

    // Strike offsets inside a 15s super-cycle (4 per loop). Irregular on
    // purpose -- evenly spaced strikes are the thing that reads as a loop.
    const STRIKES = [0.0, 0.16, 0.52, 1.9, 2.06, 7.4];
    const CYCLE = 15;

    if (animate) {
        loopSeconds(root, (t) => {
            clouds.tick(t);
            const c = t % CYCLE;
            // Sharp attack, exponential decay -- lightning does not fade
            // linearly, and a step function is what the old version did.
            let level = 0;
            for (const s of STRIKES) {
                const dt = c - s;
                if (dt >= 0 && dt < 1.2)
                    level = Math.max(level, Math.exp(-dt * 11));
            }
            bolt.opacity = Math.round(55 + 200 * level);
            flash.opacity = Math.round(235 * level);
            clouds.front.opacity = Math.round(255 * (0.82 + 0.18 * level));
        });
    } else {
        bolt.opacity = 255;
    }
    return root;
}

function buildFogIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const layers = [];

    // Three bands at different scales and speeds. One band sliding side to
    // side is a moving picture of fog; layers crossing each other is fog.
    for (const [scale, period, phase, alpha, dy] of
        [[1.10, 30, 0.0, 95, -0.10], [0.98, 20, 0.35, 205, 0.0], [0.84, 24, 0.7, 135, 0.12]]) {
        const w = Math.round(size * scale);
        const fog = makeSvgIcon(extensionPath, 'fog.svg', w);
        const x = Math.round((size - w) / 2);
        const y = Math.round((size - w) / 2 + size * dy);
        fog.set_position(x, y);
        fog.opacity = alpha;
        root.add_child(fog);
        layers.push({fog, x, y, period, phase, alpha, dir: scale > 1 ? -1 : 1});
    }

    const drift = Math.max(4, Math.round(size * 0.08));
    if (animate) {
        loopSeconds(root, (t) => {
            for (const l of layers) {
                l.fog.set_position(
                    l.x + Math.round(sway(t, l.period, l.phase) * drift * l.dir),
                    l.y
                );
                l.fog.opacity = Math.round(l.alpha * (0.65 + 0.35 * pulse(t, 20, l.phase)));
            }
        });
    }
    return root;
}

function buildIconForPayload(extensionPath, payload, size, animate) {
    if (!payload) {
        // Placeholder cloud.
        return buildCloudIcon(extensionPath, size, animate);
    }
    const {category} = describeWmoCode(payload.weatherCode);
    const night = payload.isDay === false;

    switch (category) {
        case 'clear':
            return night
                ? buildMoonIcon(extensionPath, size, animate)
                : buildSunIcon(extensionPath, size, animate);
        case 'mostly-clear':
        case 'partly-cloudy':
            return buildCloudIcon(extensionPath, size, animate, {
                withSun: true, night,
            });
        case 'overcast':
            return buildCloudIcon(extensionPath, size, animate, {dark: true});
        case 'fog':
            return buildFogIcon(extensionPath, size, animate);
        case 'drizzle':
            return buildRainIcon(extensionPath, size, animate, {heavy: false});
        case 'rain':
            return buildRainIcon(extensionPath, size, animate, {heavy: true});
        case 'snow':
            return buildSnowIcon(extensionPath, size, animate);
        case 'storm':
            return buildStormIcon(extensionPath, size, animate);
        default:
            return buildCloudIcon(extensionPath, size, animate);
    }
}

// -- widget ---------------------------------------------------------------

export const WeatherWidget = GObject.registerClass(
class WeatherWidget extends St.BoxLayout {
    _init({settings, extensionPath, service}) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'lss-weather',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._settings = settings;
        this._extensionPath = extensionPath;
        this._service = service;

        this._iconBin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tempLabel = new St.Label({
            style_class: 'lss-weather-temp',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._tempLabel.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        // As in clockWidget.js: zero allocation slack plus END ellipsize
        // truncates these to "71<ellipsis>". Never elide a self-sized label.
        this._tempLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._labelLabel = new St.Label({
            style_class: 'lss-weather-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._labelLabel.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        this._labelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.add_child(this._iconBin);
        this.add_child(this._tempLabel);
        this.add_child(this._labelLabel);

        this._settingsHandlers = [
            this._settings.connect('changed::weather-enabled', () => this._onEnabledChanged()),
            this._settings.connect('changed::weather-latitude', () => this._onEnabledChanged()),
            this._settings.connect('changed::weather-longitude', () => this._onEnabledChanged()),
            this._settings.connect('changed::weather-font-size', () => this._applyStyles()),
            this._settings.connect('changed::weather-icon-size', () => this._refreshIcon()),
            this._settings.connect('changed::weather-show-animation', () => this._refreshIcon()),
        ];

        this._applyStyles();
        this._renderPayload(this._service?.getCachedPayload());
        this._unsubscribe = this._service?.subscribe((p) => this._renderPayload(p));

        // Fetch only if the cached forecast is missing or stale: a widget is
        // rebuilt on every lock.
        this._service?.requestRefresh({ifStale: true});

        this._onEnabledChanged();
        this.connect('destroy', () => this._onDestroy());
    }

    _applyStyles() {
        const fontSize = this._settings.get_int('weather-font-size');
        this._tempLabel.set_style(
            `font-size: ${fontSize}px;` +
            `font-weight: 500;` +
            `color: #ffffff;` +
            `letter-spacing: 1px;` +
            `text-shadow: 0 1px 6px rgba(0,0,0,0.45);` +
            `margin-top: 6px;`
        );
        this._labelLabel.set_style(
            `font-size: ${Math.max(12, Math.round(fontSize * 0.75))}px;` +
            `color: rgba(255,255,255,0.78);` +
            `text-shadow: 0 1px 4px rgba(0,0,0,0.45);`
        );
    }

    _refreshIcon() {
        const size = this._settings.get_int('weather-icon-size');
        const animate = this._settings.get_boolean('weather-show-animation');
        const icon = buildIconForPayload(
            this._extensionPath,
            this._lastPayload,
            size,
            animate
        );
        // St.Bin.set_child replaces but doesn't destroy the prior child — and
        // an undestroyed child keeps its Clutter.Timeline ticking. Destroy
        // the old one explicitly.
        const old = this._iconBin.get_child();
        this._iconBin.set_child(icon);
        old?.destroy();
    }

    _renderPayload(payload) {
        this._lastPayload = payload;
        if (!payload) {
            this._tempLabel.text = '—';
            this._labelLabel.text = 'Weather unavailable';
            this._refreshIcon();
            return;
        }

        const tempStr = (typeof payload.temperature === 'number')
            ? `${Math.round(payload.temperature)}${payload.tempUnit ?? '°'}`
            : '—';
        const {label} = describeWmoCode(payload.weatherCode);
        this._tempLabel.text = tempStr;
        this._labelLabel.text = label;
        this._refreshIcon();
    }

    // No place chosen, no weather row: the lock screen never guesses a
    // location, and a placeholder there is noise.
    _onEnabledChanged() {
        this.visible = this._settings.get_boolean('weather-enabled') &&
            (this._service?.hasPlace() ?? false);
    }

    _onDestroy() {
        try { this._unsubscribe?.(); } catch {}
        this._unsubscribe = null;
        for (const id of this._settingsHandlers)
            this._settings.disconnect(id);
        this._settingsHandlers = [];
    }
});
