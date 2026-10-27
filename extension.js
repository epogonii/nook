// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {clearPacing} from './lib/mihome.js';
import * as Tapo from './lib/tapo.js';
import * as Timers from './lib/timers.js';
import {Alerts} from './ui/alerts.js';
import {clearFanWords} from './ui/climate.js';
import {clearNameWords} from './ui/humanize.js';
import {NookButton} from './ui/menu.js';
import {beacons} from './ui/rows.js';
import {clearWords, readSetting} from './ui/text.js';

// ms without network-changed before connections are renewed.
const NETWORK_SETTLE = 3000;

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
        this._alerts = new Alerts(this._settings, this.path);
        this._alerts.start();

        // prefs.js writes this on login/logout; the keyring has no usable change signal.
        this._settings.connectObject(
            'changed::xiaomi-user-id', () => this._button?.reload().catch(logError),
            'changed::ewelink-region', () => this._button?.reload().catch(logError),
            'changed::hass-server', () => this._button?.reload().catch(logError),
            'changed::smartlife-user', () => this._button?.reload().catch(logError),
            this);
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
        this._syncButton();
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
        const openPreferences = (target = '') => {
            this._settings.set_string('prefs-target', target);
            Main.extensionManager.openExtensionPrefs(this.uuid, '', {});
        };
        this._button = new NookButton(this._settings, openPreferences, this.path, this._alerts);
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

    // Stays enabled in unlock-dialog only for gateway leak/smoke alerts while locked;
    // the menu, and with it every cloud call, is dropped on lock and rebuilt on unlock.
    disable() {
        Timers.removeAll();
        if (this._placing)
            GLib.source_remove(this._placing);
        this._placing = 0;
        if (this._networking)
            GLib.source_remove(this._networking);
        this._networking = 0;
        Gio.NetworkMonitor.get_default().disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._dropButton();
        this._alerts?.stop();
        this._alerts = null;
        this._settings = null;
        beacons.clear();
        clearWords();
        clearFanWords();
        clearNameWords();
        clearPacing();
        Tapo.clearRefusals();
    }
}
