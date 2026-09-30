// Adw preferences for Lock Screen Suite. Three pages: Wallpapers, Clock,
// Weather. No fancy bindings library — we hand-wire each row to gsettings
// because the surface is small enough that a binding helper would be more
// code than it saves.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MONITOR_COUNT = 4;

export default class LockScreenSuitePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(820, 720);

        window.add(this._buildWallpapersPage(settings));
        window.add(this._buildClockPage(settings));
        window.add(this._buildWeatherPage(settings));
    }

    // ---- Wallpapers ----

    _buildWallpapersPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Wallpapers',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });

        const imgGroup = new Adw.PreferencesGroup({
            title: 'Per-monitor wallpapers',
            description: 'Pick one image per physical monitor. Leave blank to ' +
                'fall back to the system lock-screen wallpaper.',
        });
        for (let i = 1; i <= MONITOR_COUNT; i++) {
            imgGroup.add(this._buildImageRow(settings, i));
        }
        page.add(imgGroup);

        const fxGroup = new Adw.PreferencesGroup({title: 'Effects'});
        fxGroup.add(this._intSliderRow(
            settings, 'wallpaper-blur-radius',
            'Blur radius', 'Higher = more blur. 0 disables.', 0, 80
        ));
        fxGroup.add(this._intSliderRow(
            settings, 'wallpaper-dim-percent',
            'Dim', 'Darken the wallpaper to make foreground text readable.', 0, 80
        ));
        page.add(fxGroup);

        const previewGroup = new Adw.PreferencesGroup({
            title: 'Preview',
            description: 'Lock the screen now to see your settings. ' +
                'Unlock with your password as normal.',
        });
        previewGroup.add(this._lockNowRow());
        page.add(previewGroup);

        return page;
    }

    _lockNowRow() {
        const row = new Adw.ActionRow({
            title: 'Lock screen now',
            subtitle: 'Triggers loginctl lock-session.',
        });
        const btn = new Gtk.Button({
            label: 'Lock now',
            valign: Gtk.Align.CENTER,
        });
        btn.add_css_class('suggested-action');
        btn.connect('clicked', () => {
            try {
                Gio.Subprocess.new(
                    ['loginctl', 'lock-session'],
                    Gio.SubprocessFlags.NONE
                );
            } catch (e) {
                console.warn(`[lock-screen-suite] lock failed: ${e}`);
            }
        });
        row.add_suffix(btn);
        row.activatable_widget = btn;
        return row;
    }

    // A place search through Open-Meteo's geocoding API: the same provider as
    // the forecast, no key, and nothing leaves the machine until you search.
    _placeSearchRows(settings, group) {
        const session = new Soup.Session({user_agent: 'gnome-lock-screen-suite/1', timeout: 15});
        const results = [];
        const entry = new Adw.EntryRow({title: 'Search for a place', show_apply_button: true});
        const chosen = new Adw.ActionRow({
            title: 'Last place chosen from the search',
            subtitle: settings.get_string('weather-location-name') || 'None yet',
        });
        const clear = () => {
            for (const row of results.splice(0))
                group.remove(row);
        };
        const search = () => {
            const query = entry.text.trim();
            clear();
            if (!query)
                return;
            chosen.subtitle = 'Searching…';
            const message = Soup.Message.new('GET',
                'https://geocoding-api.open-meteo.com/v1/search?count=5&format=json&language=en' +
                `&name=${encodeURIComponent(query)}`);
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                let places;
                try {
                    const bytes = s.send_and_read_finish(res);
                    if (message.get_status() !== Soup.Status.OK)
                        throw new Error(`HTTP ${message.get_status()}`);
                    places = JSON.parse(new TextDecoder().decode(bytes.get_data())).results ?? [];
                } catch (e) {
                    chosen.subtitle = `Search failed: ${e.message ?? e}`;
                    return;
                }
                chosen.subtitle = places.length
                    ? settings.get_string('weather-location-name') || 'None yet'
                    : `Nothing found for “${query}”`;
                for (const place of places) {
                    const name = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
                    const row = new Adw.ActionRow({
                        title: name,
                        subtitle: `${place.latitude.toFixed(3)}, ${place.longitude.toFixed(3)}`,
                    });
                    const use = new Gtk.Button({label: 'Use', valign: Gtk.Align.CENTER});
                    use.connect('clicked', () => {
                        settings.set_double('weather-latitude', place.latitude);
                        settings.set_double('weather-longitude', place.longitude);
                        settings.set_string('weather-location-name', name);
                        chosen.subtitle = name;
                        clear();
                    });
                    row.add_suffix(use);
                    row.activatable_widget = use;
                    group.add(row);
                    results.push(row);
                }
            });
        };
        entry.connect('apply', search);
        entry.connect('entry-activated', search);
        group.add(entry);
        group.add(chosen);
    }

    _buildImageRow(settings, monitorIdx) {
        const key = `wallpaper-monitor-${monitorIdx}`;
        const row = new Adw.ActionRow({
            title: `Monitor ${monitorIdx}`,
            subtitle: settings.get_string(key) || '(using system lock wallpaper)',
        });
        const pickBtn = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Clear',
        });
        clearBtn.add_css_class('flat');

        pickBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: `Lock wallpaper for monitor ${monitorIdx}`});
            const filter = new Gtk.FileFilter({name: 'Images'});
            filter.add_mime_type('image/png');
            filter.add_mime_type('image/jpeg');
            filter.add_mime_type('image/webp');
            filter.add_mime_type('image/avif');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            dialog.filters = filters;

            // Start in current dir if set, else Pictures.
            const currentVal = settings.get_string(key);
            if (currentVal) {
                try {
                    const f = Gio.File.new_for_uri(currentVal);
                    dialog.initial_folder = f.get_parent();
                } catch {}
            } else {
                const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
                if (pictures) dialog.initial_folder = Gio.File.new_for_path(pictures);
            }

            dialog.open(pickBtn.get_root(), null, (d, res) => {
                try {
                    const file = d.open_finish(res);
                    settings.set_string(key, file.get_uri());
                    row.subtitle = file.get_path();
                } catch (e) {
                    // User cancelled — fine.
                }
            });
        });

        clearBtn.connect('clicked', () => {
            settings.set_string(key, '');
            row.subtitle = '(using system lock wallpaper)';
        });

        settings.connect(`changed::${key}`, () => {
            const v = settings.get_string(key);
            row.subtitle = v ? (Gio.File.new_for_uri(v).get_path() || v) : '(using system lock wallpaper)';
        });

        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        box.append(pickBtn);
        box.append(clearBtn);
        row.add_suffix(box);
        row.activatable_widget = pickBtn;
        return row;
    }

    // ---- Clock ----

    _buildClockPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Clock',
            icon_name: 'preferences-system-time-symbolic',
        });

        const fmt = new Adw.PreferencesGroup({title: 'Format'});
        fmt.add(this._switchRow(settings, 'clock-24h', '24-hour time'));
        fmt.add(this._switchRow(settings, 'clock-show-seconds', 'Show seconds'));
        fmt.add(this._switchRow(settings, 'clock-show-date', 'Show date'));
        fmt.add(this._textRow(
            settings, 'clock-date-format',
            'Date format',
            'strftime tokens: %A=day name, %B=month, %-d=day, %Y=year'
        ));
        page.add(fmt);

        const style = new Adw.PreferencesGroup({title: 'Style'});
        style.add(this._intSliderRow(
            settings, 'clock-font-size', 'Font size', null, 32, 320
        ));
        style.add(this._comboRow(
            settings, 'clock-font-weight', 'Font weight',
            [
                ['300', 'Light'],
                ['400', 'Regular'],
                ['500', 'Medium'],
                ['600', 'Semibold'],
                ['700', 'Bold'],
            ]
        ));
        style.add(this._doubleSliderRow(
            settings, 'clock-letter-spacing',
            'Letter spacing (px)', null, -8.0, 16.0
        ));
        style.add(this._textRow(
            settings, 'clock-color',
            'Text colour',
            'Hex (#ffffff) or any CSS colour'
        ));
        page.add(style);

        return page;
    }

    // ---- Weather ----

    _buildWeatherPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'Weather',
            icon_name: 'weather-clear-symbolic',
        });

        const main = new Adw.PreferencesGroup({title: 'Weather widget'});
        main.add(this._switchRow(settings, 'weather-enabled', 'Show weather'));
        main.add(this._switchRow(settings, 'weather-show-animation', 'Animate icon'));
        main.add(this._comboRow(
            settings, 'weather-units', 'Units',
            [['imperial', 'Imperial (°F, mph)'], ['metric', 'Metric (°C, km/h)']]
        ));
        main.add(this._intSliderRow(
            settings, 'weather-refresh-minutes',
            'Refresh interval (min)', null, 5, 120
        ));
        page.add(main);

        const loc = new Adw.PreferencesGroup({
            title: 'Location',
            description: 'Search for a place, or set its latitude and longitude.',
        });
        loc.add(this._doubleSliderRow(
            settings, 'weather-latitude', 'Latitude', null, -90, 90
        ));
        loc.add(this._doubleSliderRow(
            settings, 'weather-longitude', 'Longitude', null, -180, 180
        ));
        this._placeSearchRows(settings, loc);
        page.add(loc);

        const style = new Adw.PreferencesGroup({title: 'Style'});
        style.add(this._intSliderRow(
            settings, 'weather-icon-size', 'Icon size (px)', null, 32, 200
        ));
        style.add(this._intSliderRow(
            settings, 'weather-font-size', 'Text size (px)', null, 12, 64
        ));
        page.add(style);

        // Open-Meteo's data is licensed CC BY 4.0: credit it where the settings are.
        const credit = new Adw.PreferencesGroup({title: 'Data'});
        const source = new Adw.ActionRow({
            title: 'Weather data by Open-Meteo.com',
            subtitle: 'Forecasts and place search, under CC BY 4.0',
        });
        source.add_suffix(new Gtk.LinkButton({
            uri: 'https://open-meteo.com/', label: 'open-meteo.com', valign: Gtk.Align.CENTER,
        }));
        credit.add(source);
        const licence = new Adw.ActionRow({
            title: 'Licence',
            subtitle: 'Creative Commons Attribution 4.0 International',
        });
        licence.add_suffix(new Gtk.LinkButton({
            uri: 'https://creativecommons.org/licenses/by/4.0/', label: 'CC BY 4.0', valign: Gtk.Align.CENTER,
        }));
        credit.add(licence);
        page.add(credit);

        return page;
    }

    // ---- generic row helpers ----

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _textRow(settings, key, title, subtitle) {
        const row = new Adw.EntryRow({title});
        if (subtitle) row.set_tooltip_text(subtitle);
        row.text = settings.get_string(key);
        row.connect('apply', () => settings.set_string(key, row.text));
        settings.connect(`changed::${key}`, () => {
            const v = settings.get_string(key);
            if (v !== row.text) row.text = v;
        });
        return row;
    }

    _intSliderRow(settings, key, title, subtitle, min, max) {
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle ?? '',
            adjustment: new Gtk.Adjustment({
                lower: min, upper: max, step_increment: 1, page_increment: 5,
                value: settings.get_int(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _doubleSliderRow(settings, key, title, subtitle, min, max, {digits = 4, step = null, page = null} = {}) {
        // step/page default to something usable for the value range — a 0.0001
        // step on a -180..180 slider is unusable. Caller may override.
        const range = max - min;
        const stepInc = step ?? (range > 100 ? 0.1 : (range > 10 ? 0.05 : 0.01));
        const pageInc = page ?? (range > 100 ? 1.0 : (range > 10 ? 0.5 : 0.1));
        const row = new Adw.SpinRow({
            title,
            subtitle: subtitle ?? '',
            digits,
            adjustment: new Gtk.Adjustment({
                lower: min, upper: max,
                step_increment: stepInc,
                page_increment: pageInc,
                value: settings.get_double(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _comboRow(settings, key, title, choices) {
        // choices: [[value, label], ...]
        const stringList = new Gtk.StringList();
        for (const [, label] of choices) stringList.append(label);

        const row = new Adw.ComboRow({
            title,
            model: stringList,
        });

        const current = settings.get_string(key);
        const idx = choices.findIndex(([v]) => v === current);
        if (idx >= 0) row.selected = idx;

        row.connect('notify::selected', () => {
            const sel = row.selected;
            if (sel >= 0 && sel < choices.length)
                settings.set_string(key, choices[sel][0]);
        });
        settings.connect(`changed::${key}`, () => {
            const v = settings.get_string(key);
            const i = choices.findIndex(([cv]) => cv === v);
            if (i >= 0 && i !== row.selected) row.selected = i;
        });
        return row;
    }
}
