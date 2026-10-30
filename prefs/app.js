// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {BUS_NAME} from '../ui/bridge.js';

const APP_PATH = '/io/github/epogonii/nook_app';

// By hand, not Gio._promisify(): this process runs every extension's preferences.
function call(bus, ...args) {
    return new Promise((resolve, reject) => {
        bus.call(...args, (_bus, result) => {
            try {
                resolve(bus.call_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class AppLink {
    constructor() {
        this._info = GioUnix.DesktopAppInfo.new(`${BUS_NAME}.desktop`);
    }

    get installed() {
        return Boolean(this._info);
    }

    destroy() {
        this._info = null;
    }

    // target: "top-bar", "accounts", "accounts-hue"...
    async open(target, window) {
        if (!this._info) {
            this.install(window);
            return;
        }
        this._info.launch([], window.get_display().get_app_launch_context());
        await call(Gio.DBus.session, BUS_NAME, APP_PATH, 'org.freedesktop.Application', 'ActivateAction',
            new GLib.Variant('(sava{sv})', ['show-page', [new GLib.Variant('s', target)], {}]), null,
            Gio.DBusCallFlags.NONE, -1, null);
    }

    // appstream:// needs a software store; Flathub's page otherwise.
    install(window) {
        new Gtk.UriLauncher({uri: `appstream://${BUS_NAME}`}).launch(window, null, (launcher, result) => {
            try {
                launcher.launch_finish(result);
            } catch {
                new Gtk.UriLauncher({uri: `https://flathub.org/apps/${BUS_NAME}`}).launch(window, null, null);
            }
        });
    }
}
