// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import * as Timers from './lib/timers.js';
import {Alerts} from './ui/alerts.js';
import {clearFanWords} from './ui/climate.js';
import {clearNameWords} from './ui/humanize.js';
import {NookButton} from './ui/menu.js';
import {App, DEVICE_KEYS} from './ui/remote.js';
import {beacons} from './ui/rows.js';
import {clearWords, readSetting} from './ui/text.js';

// ms without network-changed before connections are renewed.
const NETWORK_SETTLE = 3000;
// ms before reattaching to an app that stopped in use.
const APP_RESTART = 3000;

// Apps that have sent a notification, as [id, name]: GNOME keeps settings for each of them,
// and their ids are what a notification source's policy calls them.
function notifyingApps() {
    const schemas = Gio.SettingsSchemaSource.get_default();
    if (!schemas?.lookup('org.gnome.desktop.notifications', true) ||
        !schemas.lookup('org.gnome.desktop.notifications.application', true))
        return [];
    const system = Shell.AppSystem.get_default();
    const apps = [];
    for (const child of new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'}).get_strv('application-children')) {
        const desktop = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications.application',
            path: `/org/gnome/desktop/notifications/application/${child}/`,
        }).get_string('application-id');
        const app = system.lookup_app(desktop);
        if (app)
            apps.push([desktop.replace(/\.desktop$/, ''), app.get_name()]);
    }
    return apps.sort((a, b) => a[1].localeCompare(b[1]));
}

const NookToggle = GObject.registerClass(
class NookToggle extends QuickSettings.QuickMenuToggle {
    _init(path) {
        super._init({
            title: _('Nook'),
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/nook-symbolic.svg`)),
            toggleMode: false,
        });
        this.connect('clicked', () => this.menu.open());
    }
});

const NookIndicator = GObject.registerClass(
class NookIndicator extends QuickSettings.SystemIndicator {
    _init(button, path) {
        super._init();
        this.add_child(button.takeMark());
        this.visible = true;
        const toggle = new NookToggle(path);
        const quickSettings = Main.panel.statusArea.quickSettings;
        button.hostIn(toggle.menu, quickSettings.menu);
        this.quickSettingsItems.push(toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export default class NookExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._app = new App();
        this._app.onReloaded = () => this._button?.reload().catch(logError);
        this._restarting = 0;
        this._app.onLost = () => this._restartSoon();
        this._alerts = new Alerts(this._settings, this.path, this._app);
        this._alerts.start();
        // The settings live here and are set in the app's window, which gets all of them
        // whenever it starts, and each change after that.
        this._app.onUi = values => this._takeUi(values);
        this._app.onUiWanted = () => this._sendUi();
        this._app.onAppeared = () => this._sendUi();
        this._settings.connectObject('changed', (_settings, key) => {
            if (!DEVICE_KEYS.includes(key))
                this._app.setUi({[key]: this._settings.get_value(key)});
        }, this);
        this._sendUi();

        this._placing = 0;
        const placeInPanel = () => {
            if (readSetting(this._settings, 'location') === 'panel')
                this._placeSoon();
        };
        this._settings.connectObject(
            'changed::location', () => this._placeSoon(),
            'changed::panel-box', placeInPanel,
            'changed::panel-index', placeInPanel,
            this);
        Main.sessionMode.connectObject('updated', () => this._syncButton(), this);
        this._networking = 0;
        Gio.NetworkMonitor.get_default().connectObject('network-changed', () => this._networkChanged(), this);
        // GNOME doesn't wait for extensions before startup-complete, so one enabled after it
        // lights up at once. Only the first enable in this shell counts: GNOME re-enables
        // extensions when one before them in the list is switched off.
        const startingUp = Main.layoutManager._startingUp;
        if (startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._lightUp(), this);
        // A source stays alive while its app's notifications are switched off, out of the
        // tray, and comes back with source-added when they are switched on again.
        this._watched = new Set();
        const watch = source => {
            if (this._watched.has(source))
                return;
            this._watched.add(source);
            source.connectObject(
                'notification-added', () => this._notified(source),
                'destroy', () => this._watched?.delete(source),
                this);
        };
        Main.messageTray.getSources().forEach(watch);
        Main.messageTray.connectObject('source-added', (_tray, source) => watch(source), this);
        this._syncButton();
        if (!startingUp && !this._litUp)
            this._lightUp();
    }

    _sendUi() {
        const values = {};
        for (const key of this._settings.settings_schema.list_keys()) {
            if (!DEVICE_KEYS.includes(key))
                values[key] = this._settings.get_value(key);
        }
        values['$apps'] = new GLib.Variant('a(ss)', notifyingApps());
        this._app.setUi(values);
    }

    // Only keys of this schema, of their own type and range.
    _takeUi(values) {
        const schema = this._settings.settings_schema;
        for (const [key, value] of Object.entries(values)) {
            if (DEVICE_KEYS.includes(key) || !schema.has_key(key))
                continue;
            const spec = schema.get_key(key);
            if (!value.get_type().equal(spec.get_value_type()) || !spec.range_check(value))
                continue;
            if (!this._settings.get_value(key).equal(value))
                this._settings.set_value(key, value);
        }
    }

    _lightUp() {
        this._litUp = true;
        this._button?.lightUp(readSetting(this._settings, 'login-lights'));
    }

    // The source's policy already answers for Do Not Disturb and the app's own notification
    // and banner settings. While locked there is no button, so nothing flashes.
    _notified(source) {
        if (!this._button || !source.policy?.enable || !source.policy.showBanners)
            return;
        const lights = readSetting(this._settings, 'notify-lights');
        if (lights.length === 0 || !readSetting(this._settings, 'notify-apps').includes(source.policy.id))
            return;
        this._button.flash(lights, readSetting(this._settings, 'notify-color'));
    }

    // A move means rebuilding the button (addToStatusArea() takes a role once), which
    // re-reads every device; debounced so stepping the position rebuilds once.
    _placeSoon() {
        if (this._placing)
            GLib.source_remove(this._placing);
        this._placing = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._placing = 0;
            this._dropButton();
            this._syncButton();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncButton() {
        if (Main.sessionMode.isLocked) {
            this._dropButton();
            return;
        }
        if (this._button)
            return;
        // Everything is set up in the app's window; the prefs only say where to get it.
        const openPreferences = (target = 'top-bar') => {
            if (!this._app.openWindow(target))
                Main.extensionManager.openExtensionPrefs(this.uuid, '', {});
        };
        this._button = new NookButton(this._settings, openPreferences, this.path, this._alerts, this._app);
        if (readSetting(this._settings, 'location') === 'quick-settings') {
            this._indicator = new NookIndicator(this._button, this.path);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        } else {
            Main.panel.addToStatusArea(this.uuid, this._button,
                readSetting(this._settings, 'panel-index'),
                readSetting(this._settings, 'panel-box'));
        }
        this._button.reload().catch(logError);
    }

    _dropButton() {
        this._button?.stop();
        this._button?.destroy();
        this._button = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // A new network leaves open sockets on a dead connection and the gateway alerts in
    // the old interface's multicast group. network-changed comes in bursts while a
    // connection comes up, so this waits for it to settle.
    _networkChanged() {
        if (this._networking)
            GLib.source_remove(this._networking);
        this._networking = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NETWORK_SETTLE, () => {
            this._networking = 0;
            if (Gio.NetworkMonitor.get_default().network_available) {
                this._alerts.start();
                this._button?.reconnect();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // The bus starts the app again on the next call.
    _restartSoon() {
        if (this._restarting)
            return;
        this._restarting = GLib.timeout_add(GLib.PRIORITY_DEFAULT, APP_RESTART, () => {
            this._restarting = 0;
            this._alerts.stop();
            this._alerts.start();
            this._button?.reload().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Stays enabled in unlock-dialog only for gateway leak/smoke alerts while locked;
    // the menu, and with it every cloud call, is dropped on lock and rebuilt on unlock.
    disable() {
        if (this._placing)
            GLib.source_remove(this._placing);
        this._placing = 0;
        if (this._networking)
            GLib.source_remove(this._networking);
        this._networking = 0;
        if (this._restarting)
            GLib.source_remove(this._restarting);
        this._restarting = 0;
        Gio.NetworkMonitor.get_default().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        for (const source of this._watched ?? [])
            source.disconnectObject(this);
        this._watched = null;
        Main.sessionMode.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._dropButton();
        this._alerts?.stop();
        this._alerts = null;
        // After the button: lets go of homes kept for a light mid-flash.
        Timers.removeAll();
        this._app?.destroy();
        this._app = null;
        this._settings = null;
        beacons.clear();
        clearWords();
        clearFanWords();
        clearNameWords();
    }
}
