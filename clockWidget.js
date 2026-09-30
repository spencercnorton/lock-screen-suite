// Custom lock-screen clock. Renders HH:MM:SS (or HH:MM) + date label, with
// per-setting font size / weight / colour / letter-spacing. Updates every
// second when seconds are enabled, otherwise every 30 s.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {screenOn, watchScreen} from './screen.js';

export const LockClockWidget = GObject.registerClass(
class LockClockWidget extends St.BoxLayout {
    _init(settings) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'lss-clock',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._settings = settings;

        this._time = new St.Label({
            style_class: 'lss-clock-time',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._time.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        // These labels are allocated at their exact natural width. Pango's
        // default END ellipsize can therefore drop the final glyph after
        // sub-pixel rounding, even though the label sized itself to fit.
        this._time.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this._date = new St.Label({
            style_class: 'lss-clock-date',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._date.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
        this._date.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;

        this.add_child(this._time);
        this.add_child(this._date);

        this._settingsHandlers = [
            this._settings.connect('changed::clock-24h', () => this._refresh()),
            this._settings.connect('changed::clock-show-seconds', () => this._refresh()),
            this._settings.connect('changed::clock-show-date', () => this._applyStyles()),
            this._settings.connect('changed::clock-font-size', () => this._applyStyles()),
            this._settings.connect('changed::clock-font-weight', () => this._applyStyles()),
            this._settings.connect('changed::clock-color', () => this._applyStyles()),
            this._settings.connect('changed::clock-date-format', () => this._refresh()),
            this._settings.connect('changed::clock-letter-spacing', () => this._applyStyles()),
        ];

        this._timeoutId = 0;
        this._applyStyles();
        this._refresh();
        this._scheduleNextTick();

        this._unwatchScreen = watchScreen(() => {
            if (screenOn())
                this._refresh();
        });
        this.connect('destroy', () => this._onDestroy());
    }

    _applyStyles() {
        const size = this._settings.get_int('clock-font-size');
        const weight = this._settings.get_string('clock-font-weight');
        const color = this._settings.get_string('clock-color');
        const spacing = this._settings.get_double('clock-letter-spacing');

        this._time.set_style(
            `font-size: ${size}px;` +
            `font-weight: ${weight};` +
            `color: ${color};` +
            `letter-spacing: ${spacing}px;` +
            `font-feature-settings: "tnum";` +
            `text-shadow: 0 2px 12px rgba(0,0,0,0.45);`
        );

        // Date scales with the clock — about a fifth of clock size, never tiny.
        const dateSize = Math.max(14, Math.round(size / 5));
        this._date.set_style(
            `font-size: ${dateSize}px;` +
            `font-weight: ${weight};` +
            `color: ${color};` +
            `letter-spacing: 1px;` +
            `margin-top: ${Math.round(dateSize / 2)}px;` +
            `text-shadow: 0 1px 6px rgba(0,0,0,0.45);`
        );

        this._date.visible = this._settings.get_boolean('clock-show-date');
    }

    _refresh() {
        const now = new Date();
        const use24 = this._settings.get_boolean('clock-24h');
        const showSeconds = this._settings.get_boolean('clock-show-seconds');

        const hours24 = now.getHours();
        const hours = use24 ? hours24 : ((hours24 % 12) || 12);
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();

        const pad = (n) => n.toString().padStart(2, '0');

        let timeStr = use24
            ? `${pad(hours)}:${pad(minutes)}`
            : `${hours}:${pad(minutes)}`;
        if (showSeconds)
            timeStr += `:${pad(seconds)}`;
        if (!use24)
            timeStr += hours24 >= 12 ? ' PM' : ' AM';

        this._time.text = timeStr;

        if (this._settings.get_boolean('clock-show-date')) {
            const fmt = this._settings.get_string('clock-date-format') || '%A, %B %-d';
            try {
                this._date.text = GLib.DateTime.new_now_local().format(fmt) || '';
            } catch {
                this._date.text = now.toDateString();
            }
        }
    }

    _scheduleNextTick() {
        const showSeconds = this._settings.get_boolean('clock-show-seconds');
        // Update every second when seconds are shown; otherwise every 30 s
        // (cheap and still catches minute rollover within ~30 s).
        const periodSec = showSeconds ? 1 : 30;
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            periodSec,
            () => {
                // Nothing to show behind dark monitors; waking redraws at once.
                if (screenOn())
                    this._refresh();
                // If the user toggled show-seconds we may need to switch cadence.
                const wantSeconds = this._settings.get_boolean('clock-show-seconds');
                if (wantSeconds !== showSeconds) {
                    this._timeoutId = 0;
                    this._scheduleNextTick();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _onDestroy() {
        this._unwatchScreen?.();
        this._unwatchScreen = null;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        for (const id of this._settingsHandlers)
            this._settings.disconnect(id);
        this._settingsHandlers = [];
    }
});
