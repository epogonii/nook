// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Secrets from '../lib/secrets.js';
import * as Shelly from '../lib/shelly.js';
import {SpecError} from '../lib/spec-home.js';
import {deviceCount, renameButton, setGroupIcon, setSearching, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

// Gen 1 lets its owner pick the login's name; from Gen 2 on it is always admin.
function askForPassword(parent, unit) {
    return new Promise(resolve => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        const user = new Gtk.Entry({text: unit.user || 'admin', activates_default: true});
        const password = new Gtk.PasswordEntry({activates_default: true, show_peek_icon: true});
        if (unit.gen === 1)
            box.append(user);
        box.append(password);
        const dialog = new Adw.AlertDialog({
            heading: unit.name || unit.model || _('Shelly'),
            body: unit.gen === 1 ? _('The login set in this Shelly’s web page.') : _('The password set in this Shelly’s app or web page.'),
            extra_child: box,
            default_response: 'add',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('add', _('Add'));
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            resolve(response === 'add' && password.text ? {user: user.text.trim() || 'admin', password: password.text} : null);
        });
        dialog.present(parent.get_root());
    });
}

function trouble(e) {
    if (e instanceof SpecError && e.code === 'unpaired')
        return _('The Shelly refused the password.');
    if (e instanceof SpecError || e instanceof GLib.Error)
        return _('The Shelly is not answering.');
    return e.message;
}

export const ShellyGroup = GObject.registerClass(
class ShellyGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Shelly'),
            description: _('Shelly relays, plugs, dimmers, lights and covers on this network, every generation, without the cloud. One with a password asks for it when added.'),
        });
        setGroupIcon(this, 'shelly');
        this._settings = settings;
        this._window = window;
        this._rows = [];
        // Found with a password set, waiting for it.
        this._waiting = new Map();
        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('Gen 1 and newer answer over mDNS on their own.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);
        this._handlers = ['shelly-devices', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this.foldable(settings, 'accounts-shelly', () => deviceCount(this._units().reduce((n, u) => n + u.channels.length, 0)));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _units() {
        return Shelly.parseDevices(this._settings.get_string('shelly-devices'));
    }

    _save(units) {
        const json = JSON.stringify(units);
        if (json !== this._settings.get_string('shelly-devices'))
            this._settings.set_string('shelly-devices', json);
    }

    _drop(id) {
        this._save(this._units().filter(u => u.id !== id));
        setSkipped(this._settings, [`shelly:${id}`], true);
        Secrets.clear(Shelly.secretService(id)).catch(logError);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    // Reads its channels, with the password asked for first where it has one.
    async _adopt(unit, password = null) {
        let user = unit.user;
        if (unit.auth && password === null) {
            const answer = await askForPassword(this, unit);
            if (!answer)
                return false;
            ({user, password} = answer);
        }
        const login = {...unit, user: unit.gen === 1 ? user : undefined};
        const client = new Shelly.ShellyClient(login, password);
        try {
            const channels = await client.channels();
            if (password !== null)
                await Secrets.store(Shelly.secretService(unit.id), `Nook: Shelly ${unit.name || unit.model || unit.id}`, password);
            setSkipped(this._settings, [`shelly:${unit.id}`], false);
            this._waiting.delete(unit.id);
            this._save([...this._units().filter(u => u.id !== unit.id), {...login, channels}]);
            return true;
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(trouble(e));
            return false;
        } finally {
            client.abort();
        }
    }

    _entry(unit) {
        return {
            kind: 'Shelly',
            name: unit.name || unit.model || unit.id,
            model: unit.model,
            ip: unit.ip,
            saved: () => {
                const now = this._units().find(u => u.id === unit.id);
                return now?.channels.length ? Shelly.didOf(now, now.channels[0].key) : null;
            },
            adopt: () => this._adopt(unit),
            drop: () => this._drop(unit.id),
        };
    }

    _button(icon, tooltip, onClick) {
        const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
        button.connect('clicked', onClick);
        return button;
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const unit of this._units()) {
            const single = unit.channels.length === 1 ? Shelly.didOf(unit, unit.channels[0].key) : null;
            const own = single ? names[single] : null;
            const name = unit.name || (single ? unit.channels[0].name : null) || unit.model || unit.id;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? name, -1),
                subtitle: GLib.markup_escape_text([own ? name : null, unit.model,
                    unit.channels.length > 1 ? ngettext('%d channel', '%d channels', unit.channels.length).format(unit.channels.length) : null,
                    unit.ip].filter(Boolean).join(' · '), -1),
            });
            // Channels of a unit with several are renamed on the Devices page.
            if (single)
                row.add_suffix(renameButton(this._settings, single, name, this));
            if (unit.auth)
                row.add_suffix(this._button('dialog-password-symbolic', _('Change the Password'), () => this._adopt(unit).catch(logError)));
            row.add_suffix(this._button('user-trash-symbolic', _('Remove'), () => this._drop(unit.id)));
            this._rows.push(row);
        }
        for (const unit of this._waiting.values()) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(unit.name || unit.model || unit.id, -1),
                subtitle: GLib.markup_escape_text([_('Has a password'), unit.model, unit.ip].filter(Boolean).join(' · '), -1),
            });
            const add = new Gtk.Button({label: _('Add…'), valign: Gtk.Align.CENTER});
            add.connect('clicked', () => this._adopt(unit).catch(logError));
            row.add_suffix(add);
            this._rows.push(row);
        }
        this._rows.push(this._search);
        for (const row of this._rows)
            this.add(row);
    }

    // Units without a password are added at once; one with a password waits for it.
    async _find(quiet = false) {
        setSearching(this._searchButton, true);
        try {
            const found = await Shelly.discover(3000);
            const byId = new Map(found.map(u => [u.id, u]));
            const saved = this._units();
            this._save(saved.map(u => (byId.has(u.id) ? {...u, ip: byId.get(u.id).ip} : u)));
            const known = new Set(saved.map(u => u.id));
            const skipped = skippedIn(this._settings, quiet);
            const fresh = found.filter(u => !known.has(u.id) && !skipped.has(`shelly:${u.id}`));
            let added = 0;
            for (const unit of fresh) {
                if (unit.auth)
                    this._waiting.set(unit.id, unit);
                else if (await this._adopt(unit))
                    added++;
            }
            this._fill();
            if (quiet)
                return {added, found: found.map(u => this._entry(u))};
            if (found.length === 0)
                this._toast(_('No Shelly answered.'));
            else if (added === 0 && this._waiting.size === 0)
                this._toast(_('Nothing new found.'));
            return {added};
        } catch (e) {
            if (!quiet)
                this._toast(e.message);
            if (!(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            setSearching(this._searchButton, false);
        }
    }
});
