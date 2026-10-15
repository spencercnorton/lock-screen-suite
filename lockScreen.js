// Patches GNOME Shell's UnlockDialog to inject our wallpapers, clock, and weather.
//
// Strategy:
//   * Monkey-patch UnlockDialog.prototype._createBackground so each monitor is built
//     from our settings (per-monitor file paths) when configured. We add a dim shade
//     overlay on top so dim is independent of blur brightness.
//   * Monkey-patch _updateBackgroundEffects to honour our blur radius setting.
//   * Wrap _init so that AFTER the dialog finishes building itself we hide the
//     built-in clock labels and add our own clock + weather subtree inside the
//     existing clock BoxLayout. Keeping our widgets parented to the original
//     _clock means we inherit show/hide behaviour from _showClock / _showPrompt /
//     _setTransitionProgress automatically — no need to patch any of those.
//   * Insert the weather atmosphere (atmosphere.js) as its own layer between
//     _backgroundGroup and the clock/prompt box, and patch
//     _setTransitionProgress only to quieten it while the prompt is up.
//
// On disable() we restore prototype methods and clean up any live dialog.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as UnlockDialogModule from 'resource:///org/gnome/shell/ui/unlockDialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LockClockWidget} from './clockWidget.js';
import {WeatherWidget} from './weatherWidget.js';
import {WeatherService} from './weatherService.js';
import {AtmosphereGroup, conditionGrade} from './atmosphere.js';

// Marker we attach to St.Widgets we create, so we can tell ours from upstream's
// when iterating background children.
const OUR_BG_MARKER = '__lssCustomBackground';

export class LockScreenCustomizer {
    constructor({settings, extensionPath}) {
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._origCreateBackground = null;
        this._origUpdateBackgroundEffects = null;
        this._origSetTransitionProgress = null;
        this._origInit = null;
        this._liveDialogs = new Set();
        this._weatherService = null;
        this._settingsChangedId = 0;
        this._lastPayload = null;
        this._unsubscribeGrade = null;
        this._screensaverSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.screensaver'});
    }

    enable() {
        // Single shared weather service across all dialogs for the session.
        this._weatherService = new WeatherService(this._settings);
        this._lastPayload = this._weatherService.getCachedPayload();
        this._unsubscribeGrade = this._weatherService.subscribe(p => {
            this._lastPayload = p;
            for (const dialog of this._liveDialogs)
                this._applyBackgroundEffectsTo(dialog);
        });

        const proto = UnlockDialogModule.UnlockDialog.prototype;
        this._origCreateBackground = proto._createBackground;
        this._origUpdateBackgroundEffects = proto._updateBackgroundEffects;
        this._origSetTransitionProgress = proto._setTransitionProgress;
        this._origInit = proto._init;

        const self = this;

        proto._createBackground = function (monitorIndex) {
            self._createBackgroundFor(this, monitorIndex);
        };

        proto._updateBackgroundEffects = function () {
            self._applyBackgroundEffectsTo(this);
        };

        proto._setTransitionProgress = function (progress) {
            self._origSetTransitionProgress.call(this, progress);
            this._lssAtmosphere?.setPromptProgress(progress);
        };

        proto._init = function (parentActor) {
            self._origInit.call(this, parentActor);
            try {
                self._customizeDialog(this);
            } catch (e) {
                console.error(`[lock-screen-suite] customize failed: ${e}\n${e.stack}`);
            }
        };

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            this._onSettingChanged(key);
        });

        // If a dialog is already live (e.g. extension re-enabled mid-session
        // while locked), retro-fit it.
        const existing = Main.screenShield?._dialog;
        if (existing && existing instanceof UnlockDialogModule.UnlockDialog) {
            try {
                this._customizeDialog(existing);
                // Force backgrounds to rebuild via our path.
                existing._updateBackgrounds?.();
            } catch (e) {
                console.error(`[lock-screen-suite] retrofit failed: ${e}`);
            }
        }
    }

    disable() {
        const proto = UnlockDialogModule.UnlockDialog.prototype;
        if (this._origCreateBackground)
            proto._createBackground = this._origCreateBackground;
        if (this._origUpdateBackgroundEffects)
            proto._updateBackgroundEffects = this._origUpdateBackgroundEffects;
        if (this._origSetTransitionProgress)
            proto._setTransitionProgress = this._origSetTransitionProgress;
        if (this._origInit)
            proto._init = this._origInit;
        this._origCreateBackground = null;
        this._origUpdateBackgroundEffects = null;
        this._origSetTransitionProgress = null;
        this._origInit = null;

        try { this._unsubscribeGrade?.(); } catch {}
        this._unsubscribeGrade = null;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        for (const dialog of this._liveDialogs)
            this._teardownDialog(dialog);
        this._liveDialogs.clear();

        this._weatherService?.destroy();
        this._weatherService = null;
    }

    // ---- background construction ----

    // The custom wallpaper file for a monitor, or null for the system one.
    _wallpaperFileFor(monitorIndex) {
        const uri = this._wallpaperUriFor(monitorIndex);
        if (!uri)
            return null;
        try {
            const file = Gio.File.new_for_uri(uri);
            return file.query_exists(null) ? file : null;
        } catch {
            return null;
        }
    }

    _fallbackWallpaperFile() {
        try {
            const uri = this._screensaverSettings.get_string('picture-uri');
            return uri ? Gio.File.new_for_uri(uri) : null;
        } catch {
            return null;
        }
    }

    _createBackgroundFor(dialog, monitorIndex) {
        const file = this._wallpaperFileFor(monitorIndex);

        if (!file) {
            // No override → fall back to upstream behaviour (uses the
            // org.gnome.desktop.screensaver picture-uri wallpaper).
            this._origCreateBackground.call(dialog, monitorIndex);
            // Re-apply our blur + dim to the upstream-built widget.
            this._applyBackgroundEffectsTo(dialog);
            return;
        }

        const monitor = Main.layoutManager.monitors[monitorIndex];

        const bg = new St.Widget({
            style_class: 'screen-shield-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            effect: new Shell.BlurEffect({name: 'blur'}),
        });
        bg[OUR_BG_MARKER] = true;

        // Background image. St supports background-image: url(...) via librsvg/pixbuf.
        // GFile.get_path() handles both file:// and local paths.
        const path = file.get_path();
        const safePath = path.replace(/"/g, '\\"');
        bg.set_style(
            `background-image: url("${safePath}");` +
            // St centres a background by default and rejects the keyword form
            // of background-position, so none is set.
            'background-size: cover;'
        );

        // Dim shade overlay — a separate child so dim is independent of the
        // BlurEffect's brightness (which we still use for blur tuning).
        const dim = new St.Widget({
            x: 0, y: 0,
            width: monitor.width,
            height: monitor.height,
            style_class: 'lss-dim-overlay',
        });
        bg.add_child(dim);
        bg._lssDim = dim;

        // Track with a stub object so _updateBackgrounds()'s cleanup loop
        // (`this._bgManagers[i].destroy()`) doesn't blow up.
        dialog._bgManagers.push({destroy: () => {}, _lssCustom: true});
        dialog._backgroundGroup.add_child(bg);

        this._applyBackgroundEffectsTo(dialog);
    }

    _applyBackgroundEffectsTo(dialog) {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const radius = this._settings.get_int('wallpaper-blur-radius');
        const dimPct = this._settings.get_int('wallpaper-dim-percent');
        // Weather grading adjusts the user's own blur and dim, never
        // replaces them (atmosphere.js documents the per-condition table).
        const grade = this._settings.get_boolean('weather-grading')
            ? conditionGrade(this._lastPayload, dialog._lssAtmosphere?.getSkies())
            : {dimDelta: 0, radiusMul: 1, tint: [0, 0, 0]};
        const effDim = Math.min(90, Math.max(0, dimPct + grade.dimDelta));
        const effRadius = Math.max(0, radius * grade.radiusMul);
        const [tr, tg, tb] = grade.tint;

        for (const widget of dialog._backgroundGroup) {
            const effect = widget.get_effect('blur');
            if (effect) {
                effect.set({
                    // Keep blur effect's brightness near full — we use a
                    // separate dim overlay so it composes cleanly with custom
                    // backgrounds. (Upstream's BLUR_BRIGHTNESS is ~0.55; we
                    // approximate by treating dimPct as the overlay alpha.)
                    brightness: 1.0,
                    radius: effRadius * themeContext.scale_factor,
                });
            }
            if (widget._lssDim) {
                const alpha = Math.min(1, Math.max(0, effDim / 100));
                widget._lssDim.set_style(
                    `background-color: rgba(${tr}, ${tg}, ${tb}, ${alpha.toFixed(3)});`
                );
            } else if (widget[OUR_BG_MARKER] !== true) {
                // Upstream-built background. We can't add a dim overlay safely
                // (the BackgroundManager owns its children), so fall back to
                // dimming via the BlurEffect brightness, matching upstream's
                // style. The grade's tint has nowhere to go on this path;
                // its dim and blur still apply.
                if (effect) {
                    effect.set({
                        brightness: 1.0 - (effDim / 100),
                    });
                }
            }
        }
    }

    _wallpaperUriFor(monitorIndex) {
        // Settings are 1-indexed, monitors 0-indexed.
        const key = `wallpaper-monitor-${monitorIndex + 1}`;
        try {
            const v = this._settings.get_string(key);
            if (!v) return null;
            if (v.startsWith('file://') || v.startsWith('/'))
                return v.startsWith('/') ? `file://${v}` : v;
            return v;
        } catch {
            return null;
        }
    }

    // ---- per-dialog customisations (clock + weather) ----

    _customizeDialog(dialog) {
        if (dialog._lssCustomized)
            return;
        dialog._lssCustomized = true;
        this._liveDialogs.add(dialog);

        const clockBox = dialog._clock;
        if (!clockBox)
            return;

        // Hide the built-in time/date labels (we keep _hint visible so the
        // "Click or press a key to unlock" prompt still works, but only if the
        // user wants it — we don't expose that yet).
        if (clockBox._time) clockBox._time.hide();
        if (clockBox._date) clockBox._date.hide();

        // Insert our custom widgets above the existing labels so they sit at
        // the top of the vertical box. The _hint label stays at the bottom.
        const ourClock = new LockClockWidget(this._settings);
        const ourWeather = new WeatherWidget({
            settings: this._settings,
            extensionPath: this._extensionPath,
            service: this._weatherService,
        });

        clockBox.insert_child_at_index(ourClock, 0);
        clockBox.insert_child_at_index(ourWeather, 1);

        dialog._lssClock = ourClock;
        dialog._lssWeather = ourWeather;

        // The atmosphere sits between the backgrounds and everything else:
        // above the blur so weather stays crisp, below the clock and the
        // password prompt so it can never cover them, and non-reactive so
        // clicks, swipes, and keys reach the dialog untouched. It lives
        // in a bounded stage around this clock cluster on the primary
        // monitor; the cluster's own allocation is the invisible box
        // precipitation collides with, so feed it live geometry.
        const atmosphere = new AtmosphereGroup({
            settings: this._settings,
            service: this._weatherService,
            monitors: Main.layoutManager.monitors,
            primaryIndex: Main.layoutManager.primaryIndex,
            clockBoxFor: () => {
                try {
                    const [x, y] = clockBox.get_transformed_position();
                    const [w, h] = clockBox.get_transformed_size();
                    return w > 40 && h > 20 ? {x, y, width: w, height: h} : null;
                } catch {
                    return null;
                }
            },
            fileForMonitor: i => this._wallpaperFileFor(i),
            fallbackFile: this._fallbackWallpaperFile(),
            onGradeDirty: () => this._applyBackgroundEffectsTo(dialog),
        });
        dialog.insert_child_above(atmosphere, dialog._backgroundGroup);
        dialog._lssAtmosphere = atmosphere;
        clockBox.connectObject('notify::allocation', () => {
            atmosphere.syncClockBox();
        }, dialog);
        Main.layoutManager.connectObject('monitors-changed', () => {
            atmosphere.rebuild(Main.layoutManager.monitors,
                Main.layoutManager.primaryIndex);
        }, dialog);

        // Style the surrounding box so our cluster reads as one block.
        clockBox.add_style_class_name('lss-cluster');

        // When the dialog is destroyed (user authenticates and screen unlocks,
        // or session ends), forget it so we don't try to clean up a freed
        // actor on disable.
        const destroyId = dialog.connect('destroy', () => {
            this._liveDialogs.delete(dialog);
        });
        dialog._lssDestroyId = destroyId;
    }

    _teardownDialog(dialog) {
        try {
            if (dialog._lssDestroyId) {
                dialog.disconnect(dialog._lssDestroyId);
                dialog._lssDestroyId = 0;
            }
            dialog._lssClock?.destroy();
            dialog._lssWeather?.destroy();
            dialog._lssAtmosphere?.destroy();
            dialog._lssClock = null;
            dialog._lssWeather = null;
            dialog._lssAtmosphere = null;
            if (dialog._clock) {
                dialog._clock.remove_style_class_name('lss-cluster');
                dialog._clock._time?.show();
                dialog._clock._date?.show();
            }
            dialog._lssCustomized = false;
        } catch (e) {
            console.warn(`[lock-screen-suite] teardown error: ${e}`);
        }
    }

    _onSettingChanged(key) {
        // Wallpaper / blur / dim changes: rebuild backgrounds on any live dialog.
        if (key.startsWith('wallpaper-')) {
            for (const dialog of this._liveDialogs) {
                try {
                    dialog._updateBackgrounds?.();
                    // New wallpaper, new sky to detect.
                    dialog._lssAtmosphere?.setFallbackFile(this._fallbackWallpaperFile());
                    dialog._lssAtmosphere?.rebuild();
                } catch (e) {
                    console.warn(`[lock-screen-suite] live bg refresh failed: ${e}`);
                }
            }
        }
        if (key === 'weather-grading') {
            for (const dialog of this._liveDialogs)
                this._applyBackgroundEffectsTo(dialog);
        }
        // The weather service refetches on its own when the place, units,
        // interval or enabled state change; styling keys need no request.
        // Clock/weather widget re-styling is handled inside the widgets via
        // their own settings change handlers.
    }
}
