// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseEntries, savedAccount} from '../lib/cloud-aircon.js';
import * as Secrets from '../lib/secrets.js';
import {SpecError} from '../lib/spec-home.js';
import {deviceCount, helpRow, setGroupIcon} from './common.js';
import {FoldGroup} from './fold.js';

// The air conditioners of a maker's cloud account. spec: {id, title, description, help:
// [title, subtitle, url] or null, fields: [[key, title, secret, placeholder]], module},
// where module has SECRET, connect(fields), store(account) and, for SmartThings, the
// browser login with a pasted address.
export const CloudAirconGroup = GObject.registerClass(
class CloudAirconGroup extends FoldGroup {
    _init(settings, window, spec) {
        super._init({title: spec.title, description: spec.description});
        setGroupIcon(this, spec.id);
        this._settings = settings;
        this._window = window;
        this._spec = spec;
        this._key = `${spec.id}-devices`;
        this._connected = false;
        this._busy = false;
        this._closed = false;
        this._pending = null;

        if (spec.help)
            this.add(helpRow(...spec.help));
        this._fields = spec.fields.map(([key, title, secret]) => {
            const row = secret ? new Adw.PasswordEntryRow({title}) : new Adw.EntryRow({title});
            this.add(row);
            return [key, row];
        });
        if (spec.module.loginUrl) {
            this._paste = new Adw.EntryRow({title: _('Address the Browser Ended On'), show_apply_button: true, visible: false});
            this._paste.connect('apply', () => this._finish().catch(logError));
            this.add(this._paste);
        }

        this._row = new Adw.ActionRow({title: _('Account')});
        this._update = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Read the List Again'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._update.connect('clicked', () => this._read().catch(logError));
        this._row.add_suffix(this._update);
        this._button = new Gtk.Button({valign: Gtk.Align.CENTER});
        this._button.connect('clicked', () => this._onButton().catch(logError));
        this._row.add_suffix(this._button);
        this.add(this._row);

        window.connect('close-request', () => {
            this._closed = true;
            return false;
        });
        this._handlers = [settings.connect(`changed::${this._key}`, () => this._sync().catch(logError))];
        this._sync().catch(logError);
        this.foldable(settings, `accounts-${spec.id}`, () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _devices() {
        return parseEntries(this._settings.get_string(this._key));
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    async _sync() {
        const account = await savedAccount(this._spec.module.SECRET);
        if (this._closed)
            return;
        this._connected = Boolean(account);
        this._row.subtitle = this._connected ? deviceCount(this._devices().length) : _('Not connected');
        this._button.label = this._connected ? _('Disconnect') : _('Connect');
        this._button.css_classes = [this._connected ? 'destructive-action' : 'suggested-action'];
        this._button.sensitive = !this._busy;
        this._update.visible = this._connected;
        this._update.sensitive = !this._busy;
        for (const [, row] of this._fields)
            row.visible = !this._connected;
        if (this._paste)
            this._paste.visible = !this._connected && this._pending !== null;
    }

    async _onButton() {
        if (this._connected) {
            await Secrets.clear(this._spec.module.SECRET);
            if (this._settings.get_string(this._key) !== '[]')
                this._settings.set_string(this._key, '[]');
            await this._sync();
            return;
        }
        const given = Object.fromEntries(this._fields.map(([key, row]) => [key, row.text.trim()]));
        if (Object.values(given).some(v => !v)) {
            this._toast(_('Fill in every field first.'));
            return;
        }
        const module = this._spec.module;
        if (!module.loginUrl) {
            await this._read(given);
            return;
        }
        this._pending = {...given, state: module.newState()};
        Gio.AppInfo.launch_default_for_uri(module.loginUrl(given.clientId, this._pending.state), null);
        this._toast(_('Sign in in the browser, then paste the address it ends on here.'));
        await this._sync();
    }

    // The code works once: its tokens are kept before anything else can fail.
    async _finish() {
        const pending = this._pending;
        if (!pending || this._busy)
            return;
        let code = null;
        try {
            code = this._spec.module.codeFrom(this._paste.text, pending.state);
        } catch {}
        if (!code) {
            this._toast(_('That address has no login code in it.'));
            return;
        }
        this._busy = true;
        this._paste.sensitive = false;
        let account = null;
        try {
            const {state: _state, ...app} = pending;
            account = await this._spec.module.logIn(app, code);
            await this._spec.module.store(account);
            this._pending = null;
            this._paste.text = '';
            for (const [, row] of this._fields)
                row.text = '';
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
        } finally {
            this._busy = false;
            this._paste.sensitive = true;
        }
        if (account)
            await this._read(account);
    }

    // Connects with the given login, or the saved one, and keeps what it reads.
    async _read(given = null) {
        if (this._busy)
            return;
        const module = this._spec.module;
        const login = given ?? await savedAccount(module.SECRET);
        if (!login)
            return;
        this._busy = true;
        await this._sync();
        try {
            const {account, devices} = await module.connect(login);
            // Unchanged, the saved login stays as it is: the shell may have renewed it since.
            if (JSON.stringify(account) !== JSON.stringify(login))
                await module.store(account);
            const json = JSON.stringify(devices);
            if (json !== this._settings.get_string(this._key))
                this._settings.set_string(this._key, json);
            if (given) {
                for (const [, row] of this._fields)
                    row.text = '';
            }
            this._toast(ngettext('%d air conditioner from %s.', '%d air conditioners from %s.', devices.length)
                .format(devices.length, this._spec.title));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
        } finally {
            this._busy = false;
        }
        if (!this._closed)
            await this._sync();
    }
});
