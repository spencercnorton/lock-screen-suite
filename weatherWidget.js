// Weather widget: animated icon + temperature/label text.
//
// Animation strategy — instead of trying to play Lottie/animated SVG inside
// gnome-shell (no renderer support), we compose each condition out of static
// SVG icons (sun, cloud, raindrop, snowflake, bolt) parented to a St.Widget
// and drive their position/rotation/opacity via Clutter property transitions
// using `St.Adjustment`. That's how Shell itself animates its UI, so it plays
// cleanly inside the unlock dialog with no extra deps.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {describeWmoCode} from './weatherService.js';

// -- helpers --------------------------------------------------------------

function makeSvgIcon(extensionPath, name, size) {
    const path = GLib.build_filenamev([extensionPath, 'icons', 'weather', name]);
    const file = Gio.File.new_for_path(path);
    return new St.Icon({
        gicon: new Gio.FileIcon({file}),
        icon_size: size,
    });
}

function loopAdjustment(actor, durationMs, onValue) {
    // 0→1 looping timeline bound to `actor`'s lifetime. Clutter auto-stops
    // and frees the timeline when the actor is destroyed, so we don't need
    // explicit teardown.
    const timeline = new Clutter.Timeline({
        actor,
        duration: durationMs,
        repeat_count: -1,
    });
    timeline.connect('new-frame', () => onValue(timeline.get_progress()));
    // Icons are built before they are parented into _iconBin. Starting a
    // timeline without a stage makes Clutter reject it, so wait for mapping.
    if (actor.mapped) {
        timeline.start();
    } else {
        const id = actor.connect('notify::mapped', () => {
            if (!actor.mapped)
                return;
            actor.disconnect(id);
            timeline.start();
        });
    }
    return timeline;
}

// -- icon factories -------------------------------------------------------
//
// Each factory returns an `St.Widget` of the requested size whose internal
// transitions are owned by the widget (so destroying the widget stops them).

function buildSunIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const sun = makeSvgIcon(extensionPath, 'sun.svg', size);
    sun.set_pivot_point(0.5, 0.5);
    root.add_child(sun);
    sun.set_position(0, 0);
    if (animate) {
        // 360°/30s slow spin.
        loopAdjustment(root, 30000, (v) => {
            sun.rotation_angle_z = v * 360;
        });
    }
    return root;
}

function buildMoonIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const moon = makeSvgIcon(extensionPath, 'moon.svg', size);
    root.add_child(moon);
    moon.set_position(0, 0);
    if (animate) {
        // Gentle opacity pulse.
        loopAdjustment(root, 4500, (v) => {
            const t = Math.sin(v * Math.PI);
            moon.opacity = Math.round(220 + 35 * t);
        });
    }
    return root;
}

function buildCloudIcon(extensionPath, size, animate, {dark = false, withSun = false, night = false} = {}) {
    const root = new St.Widget({width: size, height: size});

    if (withSun) {
        const small = Math.round(size * 0.55);
        const sun = night
            ? makeSvgIcon(extensionPath, 'moon.svg', small)
            : makeSvgIcon(extensionPath, 'sun.svg', small);
        sun.set_pivot_point(0.5, 0.5);
        sun.set_position(Math.round(size * 0.02), Math.round(size * 0.02));
        root.add_child(sun);
        if (animate && !night) {
            loopAdjustment(root, 30000, (v) => {
                sun.rotation_angle_z = v * 360;
            });
        }
    }

    const cloudW = Math.round(size * (withSun ? 0.85 : 1.0));
    const cloudH = Math.round(cloudW * 0.6);
    const cloud = makeSvgIcon(extensionPath, dark ? 'cloud-dark.svg' : 'cloud.svg', cloudW);
    cloud.set_size(cloudW, cloudH);
    const baseX = withSun ? Math.round(size * 0.15) : Math.round((size - cloudW) / 2);
    const baseY = Math.round(size - cloudH - size * 0.05);
    cloud.set_position(baseX, baseY);
    root.add_child(cloud);

    if (animate) {
        const driftPx = Math.max(4, Math.round(size * 0.08));
        loopAdjustment(root, 7000, (v) => {
            const t = Math.sin(v * Math.PI * 2);
            cloud.set_position(baseX + Math.round(t * driftPx), baseY);
        });
    }
    return root;
}

function buildRainIcon(extensionPath, size, animate, {heavy = false} = {}) {
    const root = new St.Widget({width: size, height: size});
    const cloudW = size;
    const cloudH = Math.round(cloudW * 0.6);
    const cloud = makeSvgIcon(extensionPath, 'cloud-dark.svg', cloudW);
    cloud.set_size(cloudW, cloudH);
    cloud.set_position(0, 0);
    root.add_child(cloud);

    const count = heavy ? 6 : 4;
    const drops = [];
    const dropW = Math.round(size * 0.10);
    const dropH = Math.round(dropW * 2);
    const yStart = Math.round(cloudH * 0.75);
    const yEnd = size - 2;

    for (let i = 0; i < count; i++) {
        const drop = makeSvgIcon(extensionPath, 'raindrop.svg', dropW);
        drop.set_size(dropW, dropH);
        const xFrac = (i + 0.5) / count;
        const x = Math.round(xFrac * (size - dropW));
        const phase = i / count;
        drop.set_position(x, yStart);
        drop.opacity = 0;
        root.add_child(drop);
        drops.push({drop, x, phase});
    }

    if (animate) {
        loopAdjustment(root, heavy ? 900 : 1300, (v) => {
            for (const {drop, x, phase} of drops) {
                let f = (v + phase) % 1;
                drop.set_position(x, Math.round(yStart + f * (yEnd - yStart)));
                // Fade in then out for each drop.
                const op = f < 0.15 ? (f / 0.15) :
                           f > 0.85 ? ((1 - f) / 0.15) : 1;
                drop.opacity = Math.round(255 * op);
            }
        });
    } else {
        for (const {drop} of drops) drop.opacity = 200;
    }
    return root;
}

function buildSnowIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const cloudW = size;
    const cloudH = Math.round(cloudW * 0.6);
    const cloud = makeSvgIcon(extensionPath, 'cloud.svg', cloudW);
    cloud.set_size(cloudW, cloudH);
    cloud.set_position(0, 0);
    root.add_child(cloud);

    const count = 5;
    const flakeSize = Math.round(size * 0.16);
    const yStart = Math.round(cloudH * 0.85);
    const yEnd = size - flakeSize;
    const flakes = [];
    for (let i = 0; i < count; i++) {
        const flake = makeSvgIcon(extensionPath, 'snowflake.svg', flakeSize);
        flake.set_pivot_point(0.5, 0.5);
        const xFrac = (i + 0.5) / count;
        const x = Math.round(xFrac * (size - flakeSize));
        const phase = i / count;
        flake.set_position(x, yStart);
        flake.opacity = 0;
        root.add_child(flake);
        flakes.push({flake, x, phase});
    }

    if (animate) {
        loopAdjustment(root, 3000, (v) => {
            for (const {flake, x, phase} of flakes) {
                let f = (v + phase) % 1;
                flake.set_position(
                    x + Math.round(Math.sin(f * Math.PI * 2) * size * 0.04),
                    Math.round(yStart + f * (yEnd - yStart))
                );
                flake.rotation_angle_z = f * 360;
                const op = f < 0.15 ? (f / 0.15) :
                           f > 0.85 ? ((1 - f) / 0.15) : 1;
                flake.opacity = Math.round(230 * op);
            }
        });
    } else {
        for (const {flake} of flakes) flake.opacity = 230;
    }
    return root;
}

function buildStormIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const cloudW = size;
    const cloudH = Math.round(cloudW * 0.6);
    const cloud = makeSvgIcon(extensionPath, 'cloud-dark.svg', cloudW);
    cloud.set_size(cloudW, cloudH);
    cloud.set_position(0, 0);
    root.add_child(cloud);

    const boltH = Math.round(size * 0.48);
    const boltW = Math.round(boltH * 0.5);
    const bolt = makeSvgIcon(extensionPath, 'bolt.svg', boltW);
    bolt.set_size(boltW, boltH);
    bolt.set_position(Math.round((size - boltW) / 2), Math.round(cloudH * 0.85));
    root.add_child(bolt);

    if (animate) {
        // Two flashes per ~2s cycle, otherwise dim.
        loopAdjustment(root, 2000, (v) => {
            const a = v < 0.08 ? 1 :
                      v < 0.16 ? 0.3 :
                      v < 0.22 ? 1 :
                      v < 0.3 ? 0.3 : 0.35;
            bolt.opacity = Math.round(255 * a);
        });
    } else {
        bolt.opacity = 255;
    }
    return root;
}

function buildFogIcon(extensionPath, size, animate) {
    const root = new St.Widget({width: size, height: size});
    const layerW = size;
    const layerH = Math.round(size * 0.6);
    const fog = makeSvgIcon(extensionPath, 'fog.svg', layerW);
    fog.set_size(layerW, layerH);
    fog.set_position(0, Math.round((size - layerH) / 2));
    root.add_child(fog);

    if (animate) {
        loopAdjustment(root, 6000, (v) => {
            const t = Math.sin(v * Math.PI * 2);
            fog.set_position(
                Math.round(t * size * 0.06),
                Math.round((size - layerH) / 2)
            );
            fog.opacity = Math.round(200 + 40 * Math.sin(v * Math.PI * 2 + 0.5));
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
            this._settings.connect('changed::weather-font-size', () => this._applyStyles()),
            this._settings.connect('changed::weather-icon-size', () => this._refreshIcon()),
            this._settings.connect('changed::weather-show-animation', () => this._refreshIcon()),
        ];

        this._applyStyles();
        this._renderPayload(this._service?.getCachedPayload());
        this._unsubscribe = this._service?.subscribe((p) => this._renderPayload(p));

        // Ask for a refresh now (cheap if cached is fresh).
        this._service?.requestRefresh();

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
            this._labelLabel.text = this._settings.get_double('weather-latitude') === 0 &&
                this._settings.get_double('weather-longitude') === 0
                ? 'Choose a place in preferences'
                : 'Weather unavailable';
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

    _onEnabledChanged() {
        this.visible = this._settings.get_boolean('weather-enabled');
    }

    _onDestroy() {
        try { this._unsubscribe?.(); } catch {}
        this._unsubscribe = null;
        for (const id of this._settingsHandlers)
            this._settings.disconnect(id);
        this._settingsHandlers = [];
    }
});
