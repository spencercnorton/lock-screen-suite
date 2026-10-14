// The weather line: a symbolic icon, the temperature, and the condition
// with today's high and low, in one horizontal row under the clock.
//
// This replaces the large animated icon that used to sit here. The
// condition itself is now shown by the full-screen atmosphere behind
// everything (atmosphere.js); what belongs in text is only what the
// atmosphere cannot say — the numbers. A symbolic icon at text size is
// the native GNOME idiom for that (the top bar does the same), so the
// row reads as part of the lock screen instead of clip-art on it.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {describeWmoCode} from './weatherService.js';

// Symbolic names shipped by both Adwaita and Yaru.
function iconNameForPayload(payload) {
    if (!payload)
        return 'weather-overcast-symbolic';
    const {category} = describeWmoCode(payload.weatherCode);
    const night = payload.isDay === false;
    switch (category) {
        case 'clear':
            return night ? 'weather-clear-night-symbolic' : 'weather-clear-symbolic';
        case 'mostly-clear':
        case 'partly-cloudy':
            return night ? 'weather-few-clouds-night-symbolic' : 'weather-few-clouds-symbolic';
        case 'fog':
            return 'weather-fog-symbolic';
        case 'drizzle':
            return 'weather-showers-scattered-symbolic';
        case 'rain':
            return 'weather-showers-symbolic';
        case 'snow':
            return 'weather-snow-symbolic';
        case 'storm':
            return 'weather-storm-symbolic';
        default:
            return 'weather-overcast-symbolic';
    }
}

export const WeatherWidget = GObject.registerClass(
class WeatherWidget extends St.BoxLayout {
    _init({settings, extensionPath, service}) {
        super._init({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'lss-weather',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        void extensionPath;

        this._settings = settings;
        this._service = service;

        this._icon = new St.Icon({
            icon_name: 'weather-overcast-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tempLabel = new St.Label({
            style_class: 'lss-weather-temp',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._tempLabel.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        // As in clockWidget.js: zero allocation slack plus END ellipsize
        // truncates these to "71<ellipsis>". Never elide a self-sized label.
        this._tempLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._labelLabel = new St.Label({
            style_class: 'lss-weather-label',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._labelLabel.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        this._labelLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.add_child(this._icon);
        this.add_child(this._tempLabel);
        this.add_child(this._labelLabel);

        this._settingsHandlers = [
            this._settings.connect('changed::weather-enabled', () => this._onEnabledChanged()),
            this._settings.connect('changed::weather-latitude', () => this._onEnabledChanged()),
            this._settings.connect('changed::weather-longitude', () => this._onEnabledChanged()),
            this._settings.connect('changed::weather-font-size', () => this._applyStyles()),
            this._settings.connect('changed::weather-icon-size', () => this._applyStyles()),
        ];

        this._applyStyles();
        this._renderPayload(this._service?.getCachedPayload());
        this._unsubscribe = this._service?.subscribe(p => this._renderPayload(p));

        // Fetch only if the cached forecast is missing or stale: a widget is
        // rebuilt on every lock.
        this._service?.requestRefresh({ifStale: true});

        this._onEnabledChanged();
        this.connect('destroy', () => this._onDestroy());
    }

    _applyStyles() {
        const fontSize = this._settings.get_int('weather-font-size');
        this._icon.icon_size = this._settings.get_int('weather-icon-size');
        this._icon.set_style('color: #ffffff;');
        this._tempLabel.set_style(
            `font-size: ${fontSize}px;` +
            'font-weight: 500;' +
            'color: #ffffff;' +
            'letter-spacing: 1px;' +
            'text-shadow: 0 1px 6px rgba(0,0,0,0.45);' +
            'margin-left: 10px;'
        );
        this._labelLabel.set_style(
            `font-size: ${Math.max(12, Math.round(fontSize * 0.62))}px;` +
            'color: rgba(255,255,255,0.78);' +
            'text-shadow: 0 1px 4px rgba(0,0,0,0.45);' +
            'margin-left: 12px;'
        );
    }

    // The icon updates in place: no actor is created or destroyed when the
    // condition changes, so there is no timeline to leak and nothing to
    // tear down on a refresh.
    _refreshIcon() {
        this._icon.icon_name = iconNameForPayload(this._lastPayload);
    }

    _renderPayload(payload) {
        this._lastPayload = payload;
        if (!payload) {
            this._tempLabel.text = '—';
            this._labelLabel.text = 'Weather unavailable';
            this._refreshIcon();
            return;
        }
        this._tempLabel.text = (typeof payload.temperature === 'number')
            ? `${Math.round(payload.temperature)}${payload.tempUnit ?? '°'}`
            : '—';
        const {label} = describeWmoCode(payload.weatherCode);
        const hi = typeof payload.tempMax === 'number' ? Math.round(payload.tempMax) : null;
        const lo = typeof payload.tempMin === 'number' ? Math.round(payload.tempMin) : null;
        this._labelLabel.text = (hi !== null && lo !== null)
            ? `${label} · H:${hi}° L:${lo}°`
            : label;
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
