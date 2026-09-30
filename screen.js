import Gio from 'gi://Gio';

// Whether the monitors are on, for anything on the lock screen that redraws
// on its own.
//
// GNOME blanks a locked screen by powering the monitors off, and the unlock
// dialog stays mapped. A timeline gated on `mapped` alone therefore kept
// ticking behind dark monitors, and with nothing pacing its frames it ran flat
// out: more than a CPU core on a blanked lock screen. Mutter publishes the
// monitors' state only as DisplayConfig's PowerSaveMode over D-Bus (0 = on);
// its JS API has just a change signal. The proxy is created asynchronously,
// because a synchronous call would wait on this same process, and it is
// shared by every running icon and dropped with the last one.
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(
    '<node><interface name="org.gnome.Mutter.DisplayConfig">' +
    '<property name="PowerSaveMode" type="i" access="readwrite"/>' +
    '</interface></node>');
let screen = null;

export function screenOn() {
    const mode = screen?.proxy?.PowerSaveMode;
    return typeof mode !== 'number' || mode <= 0;   // unknown or -1 (unsupported) counts as on
}

export function watchScreen(listener) {
    if (!screen) {
        const s = screen = {proxy: null, changedId: 0, listeners: new Set()};
        new DisplayConfigProxy(Gio.DBus.session, 'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig', (proxy, error) => {
                if (error || screen !== s)
                    return;
                s.proxy = proxy;
                s.changedId = proxy.connect('g-properties-changed',
                    () => s.listeners.forEach(l => l()));
                s.listeners.forEach(l => l());
            }, null, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
    }
    const s = screen;
    s.listeners.add(listener);
    return () => {
        s.listeners.delete(listener);
        if (s.listeners.size > 0 || screen !== s)
            return;
        if (s.proxy)
            s.proxy.disconnect(s.changedId);
        screen = null;
    };
}
