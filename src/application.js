// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';

import {APP_ID, VERSION} from './constants.js';
import {Service} from './service.js';
import {SupportDialog, aboutDialog} from './support.js';
import {Window} from './window.js';

// A shell restart or a lock and unlock shouldn't start the app from scratch.
const LINGER = 60 * 1000;

export const Application = GObject.registerClass(
class Application extends Adw.Application {
    constructor() {
        super({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
            inactivity_timeout: LINGER,
        });
    }

    // Not in startup: under D-Bus activation the first call is already waiting.
    vfunc_dbus_register(connection, path) {
        super.vfunc_dbus_register(connection, path);
        this._settings = new Gio.Settings({schema_id: APP_ID});
        this._service = new Service(this, this._settings);
        this._service.export(connection);
        return true;
    }

    vfunc_dbus_unregister(connection, path) {
        this._service?.unexport();
        this._service = null;
        super.vfunc_dbus_unregister(connection, path);
    }

    vfunc_startup() {
        super.vfunc_startup();
        const provider = new Gtk.CssProvider();
        provider.load_from_file(Gio.File.new_for_uri(GLib.Uri.resolve_relative(import.meta.url, 'style.css', GLib.UriFlags.NONE)));
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        const show = new Gio.SimpleAction({name: 'show-page', parameter_type: new GLib.VariantType('s')});
        show.connect('activate', (_action, target) => this._window().showPage(target.unpack()));
        this.add_action(show);
        const quit = new Gio.SimpleAction({name: 'quit'});
        quit.connect('activate', () => this.active_window?.close());
        this.add_action(quit);
        const about = new Gio.SimpleAction({name: 'about'});
        about.connect('activate', () => aboutDialog(VERSION).present(this._window()));
        this.add_action(about);
        const support = new Gio.SimpleAction({name: 'support'});
        support.connect('activate', () => new SupportDialog().present(this._window()));
        this.add_action(support);
        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('window.close', ['<Control>w']);
        this.set_accels_for_action('win.add-devices', ['<Control>n']);
    }

    _window() {
        const window = this.active_window ?? new Window(this, this._settings, this._service);
        window.present();
        return window;
    }

    vfunc_activate() {
        this._window();
    }
});
