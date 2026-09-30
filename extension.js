// Lock Screen Suite — entry point.
//
// Lifecycle:
//   enable()  → load settings, install UnlockDialog patches, hook live dialog if any.
//   disable() → uninstall patches, restore live dialog if any.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LockScreenCustomizer} from './lockScreen.js';

export default class LockScreenSuiteExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._customizer = new LockScreenCustomizer({
            settings: this._settings,
            extensionPath: this.path,
        });
        this._customizer.enable();
    }

    disable() {
        this._customizer?.disable();
        this._customizer = null;
        this._settings = null;
    }
}
