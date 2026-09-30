// Open-Meteo client. Async fetch + cached payload in gsettings so the lock
// screen has something to show immediately on first paint even if the user
// just woke from suspend and we haven't refreshed yet.
//
// Endpoint: https://api.open-meteo.com/v1/forecast — the free tier, which
//          serves every field below and takes no API key. One lookup per
//          refresh interval is nowhere near its limits, so there is nothing
//          to authenticate with and no key to keep.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const USER_AGENT = 'gnome-lock-screen-suite/1';

export class WeatherService {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 15});
        this._subscribers = new Set();
        this._timeoutId = 0;
        this._inFlight = null;

        this._settingsHandlers = [
            this._settings.connect('changed::weather-enabled', () => this._reschedule()),
            this._settings.connect('changed::weather-refresh-minutes', () => this._reschedule()),
            this._settings.connect('changed::weather-latitude', () => this.requestRefresh()),
            this._settings.connect('changed::weather-longitude', () => this.requestRefresh()),
            this._settings.connect('changed::weather-units', () => this.requestRefresh()),
        ];

        this._reschedule();
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        for (const id of this._settingsHandlers)
            this._settings.disconnect(id);
        this._settingsHandlers = [];
        try {
            this._session.abort();
        } catch {}
        this._subscribers.clear();
    }

    subscribe(callback) {
        this._subscribers.add(callback);
        // Push cached payload immediately if any.
        const cached = this.getCachedPayload();
        if (cached) {
            try { callback(cached); } catch (e) {
                console.warn(`[lock-screen-suite] subscriber threw: ${e}`);
            }
        }
        return () => this._subscribers.delete(callback);
    }

    getCachedPayload() {
        const raw = this._settings.get_string('weather-last-payload');
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return null; }
    }

    _emit(payload) {
        for (const cb of [...this._subscribers]) {
            try { cb(payload); } catch (e) {
                console.warn(`[lock-screen-suite] subscriber threw: ${e}`);
            }
        }
    }

    _reschedule() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (!this._settings.get_boolean('weather-enabled'))
            return;

        const periodMin = Math.max(5, this._settings.get_int('weather-refresh-minutes'));
        const lastFetch = this._settings.get_int64('weather-last-fetch');
        const nowSec = Math.floor(Date.now() / 1000);
        const elapsed = nowSec - Number(lastFetch);
        const periodSec = periodMin * 60;
        const initialDelay = elapsed >= periodSec ? 1 : (periodSec - elapsed);

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            initialDelay,
            () => {
                this.requestRefresh();
                // Re-schedule for the regular interval after the first kick.
                this._timeoutId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_LOW,
                    periodSec,
                    () => {
                        this.requestRefresh();
                        return GLib.SOURCE_CONTINUE;
                    }
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    requestRefresh() {
        if (!this._settings.get_boolean('weather-enabled'))
            return;
        if (this._inFlight) {
            // Mark dirty so the in-flight loop re-fetches with the latest
            // settings once it finishes. Avoids parallel fetches that could
            // race-overwrite the cached payload with stale coordinates.
            this._dirty = true;
            return;
        }
        this._runFetchLoop();
    }

    async _runFetchLoop() {
        do {
            this._dirty = false;
            const lat = this._settings.get_double('weather-latitude');
            const lon = this._settings.get_double('weather-longitude');
            // No location chosen yet: nothing to fetch. The widget asks for one,
            // and preferences offers a place search; the lock screen never looks
            // a location up by itself.
            if (this._coordinatesUnset())
                return;
            this._inFlight = true;
            try {
                await this._fetch(lat, lon);
            } catch (e) {
                console.warn(`[lock-screen-suite] weather fetch failed: ${e}`);
            } finally {
                this._inFlight = false;
            }
        } while (this._dirty);
    }

    /**
     * True only when NEITHER coordinate has ever been written.
     *
     * `get_double() === 0` cannot tell an unset key from a deliberate 0/0 --
     * which is a real place, in the Gulf of Guinea. `get_user_value()` returns
     * null only for a key that has never been written, so someone who actually
     * wants 0, 0 keeps it and is never geolocated over the top of it.
     */
    _coordinatesUnset() {
        return this._settings.get_user_value('weather-latitude') === null &&
               this._settings.get_user_value('weather-longitude') === null;
    }

    async _fetch(lat, lon) {
        const units = this._settings.get_string('weather-units');
        const tempUnit = units === 'metric' ? 'celsius' : 'fahrenheit';
        const windUnit = units === 'metric' ? 'kmh' : 'mph';

        const params = [
            `latitude=${encodeURIComponent(lat.toFixed(4))}`,
            `longitude=${encodeURIComponent(lon.toFixed(4))}`,
            'current=temperature_2m,apparent_temperature,relative_humidity_2m,' +
                'is_day,weather_code,wind_speed_10m,wind_direction_10m,' +
                'precipitation,cloud_cover',
            `temperature_unit=${tempUnit}`,
            `wind_speed_unit=${windUnit}`,
            'timezone=auto',
        ];
        const url =
            `https://api.open-meteo.com/v1/forecast?${params.join('&')}`;

        const message = Soup.Message.new('GET', url);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_LOW,
                null,
                (session, result) => {
                    try {
                        const b = session.send_and_read_finish(result);
                        if (message.get_status() !== Soup.Status.OK) {
                            reject(new Error(
                                `HTTP ${message.get_status()} ${message.reason_phrase}`
                            ));
                            return;
                        }
                        resolve(b);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        const text = new TextDecoder().decode(bytes.get_data());
        const json = JSON.parse(text);
        const current = json.current || {};
        const payload = {
            fetchedAt: Math.floor(Date.now() / 1000),
            tempUnit: tempUnit === 'celsius' ? '°C' : '°F',
            windUnit,
            temperature: current.temperature_2m,
            apparent: current.apparent_temperature,
            humidity: current.relative_humidity_2m,
            isDay: current.is_day === 1 || current.is_day === true,
            weatherCode: current.weather_code,
            windSpeed: current.wind_speed_10m,
            cloudCover: current.cloud_cover,
            precipitation: current.precipitation,
        };

        this._settings.set_string('weather-last-payload', JSON.stringify(payload));
        this._settings.set_int64('weather-last-fetch', payload.fetchedAt);
        this._emit(payload);
    }
}

// WMO code → {category, label}. Categories drive icon selection in
// weatherWidget; labels are the human-readable summary.
// Reference: https://open-meteo.com/en/docs#weathervariables
export function describeWmoCode(code) {
    const c = Number(code);
    if (c === 0) return {category: 'clear', label: 'Clear sky'};
    if (c === 1) return {category: 'mostly-clear', label: 'Mostly clear'};
    if (c === 2) return {category: 'partly-cloudy', label: 'Partly cloudy'};
    if (c === 3) return {category: 'overcast', label: 'Overcast'};
    if (c === 45 || c === 48) return {category: 'fog', label: 'Fog'};
    if (c >= 51 && c <= 57) return {category: 'drizzle', label: 'Drizzle'};
    if (c >= 61 && c <= 67) return {category: 'rain', label: 'Rain'};
    if (c >= 71 && c <= 77) return {category: 'snow', label: 'Snow'};
    if (c >= 80 && c <= 82) return {category: 'rain', label: 'Rain showers'};
    if (c === 85 || c === 86) return {category: 'snow', label: 'Snow showers'};
    if (c === 95) return {category: 'storm', label: 'Thunderstorm'};
    if (c === 96 || c === 99) return {category: 'storm', label: 'Storm w/ hail'};
    return {category: 'overcast', label: 'Unknown'};
}
