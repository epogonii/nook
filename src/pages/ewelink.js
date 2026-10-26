// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Ewelink from '../lib/ewelink.js';
import * as EwelinkHome from '../lib/ewelink-home.js';
import * as Secrets from '../lib/secrets.js';
import {CredentialRows, deviceCount, helpRow, renameButton, setGroupIcon, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

const EWELINK_DEV_URL = 'https://dev.ewelink.cc/';

export const EwelinkGroup = GObject.registerClass(
class EwelinkGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('eWeLink'),
            description: _('Sonoff and other eWeLink devices, through a free app of your own on eWeLink\'s developer site.'),
        });
        setGroupIcon(this, 'ewelink');
        this._settings = settings;
        this._window = window;
        this._cancellable = null;
        this._loggedIn = false;
        this._closed = false;
        this._rows = [];

        this.add(helpRow(_('Get an App ID and App Secret'),
            _('Sign up on the developer site, wait for the approval, then create an app there with the redirect URL %s and copy its two keys here.')
                .replace('%s', Ewelink.REDIRECT_URL),
            EWELINK_DEV_URL));
        new CredentialRows(this, 'ewelink-app', 'Nook: eWeLink app', [_('App ID'), _('App Secret')],
            () => this._sync().catch(logError));

        this._row = new Adw.ActionRow({title: _('Account')});
        this._button = new Gtk.Button({valign: Gtk.Align.CENTER});
        this._button.connect('clicked', () => this._onButton().catch(logError));
        this._row.add_suffix(this._button);
        this.add(this._row);

        this._entry = new Adw.EntryRow({title: _('Add by Device ID'), show_apply_button: true});
        this._entry.connect('apply', () => this._addById().catch(logError));

        window.connect('close-request', () => {
            this._closed = true;
            this._cancellable?.cancel();
            return false;
        });
        this._handlers = ['ewelink-devices', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this._sync().catch(logError);
        this.foldable(settings, 'accounts-ewelink', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _devices() {
        return EwelinkHome.parseDevices(this._settings.get_string('ewelink-devices'));
    }

    _save(devices) {
        const json = JSON.stringify(devices);
        if (json !== this._settings.get_string('ewelink-devices'))
            this._settings.set_string('ewelink-devices', json);
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const unit of this._devices()) {
            const [first, ...more] = EwelinkHome.channels(unit);
            const own = more.length === 0 ? names[first.did] : null;
            const name = unit.name || unit.id;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? name, -1),
                subtitle: GLib.markup_escape_text([own ? name : null, unit.model,
                    more.length > 0 ? ngettext('%d channel', '%d channels', more.length + 1).format(more.length + 1) : null,
                    unit.id].filter(Boolean).join(' · '), -1),
            });
            // Channels of a multi-channel switch are renamed on the Devices page.
            if (more.length === 0)
                row.add_suffix(renameButton(this._settings, first.did, name, this));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(unit.id));
            row.add_suffix(remove);
            this._rows.push(row);
        }
        this._rows.push(this._entry);
        for (const row of this._rows)
            this.add(row);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    async _sync() {
        const saved = await Ewelink.savedTokens();
        const app = await Ewelink.savedApp();
        if (this._closed)
            return;
        this._loggedIn = Boolean(saved);
        // The keyring is authoritative; ewelink-region only signals the shell, so resync it.
        const region = saved?.region ?? '';
        if (this._settings.get_string('ewelink-region') !== region)
            this._settings.set_string('ewelink-region', region);
        if (this._loggedIn)
            this._row.subtitle = _('Logged in, region %s').replace('%s', region);
        else
            this._row.subtitle = app ? _('Not logged in') : _('Save the app keys first');
        this._button.label = this._loggedIn ? _('Log Out') : _('Log In');
        this._button.css_classes = [this._loggedIn ? 'destructive-action' : 'suggested-action'];
        this._button.sensitive = this._loggedIn || Boolean(app);
        this._entry.sensitive = this._loggedIn;
    }

    async _onButton() {
        if (this._cancellable) {
            this._cancellable.cancel();
            return;
        }
        if (this._loggedIn) {
            // Revoke the token on the server too; the keyring is cleared either way.
            await this._withCloud(cloud => cloud.logOut()).catch(e => console.debug(`nook: eWeLink logout: ${e.message}`));
            await Secrets.clear('ewelink');
            await this._sync();
            return;
        }
        await this._logIn();
    }

    async _logIn() {
        const app = await Ewelink.savedApp();
        if (!app)
            return;
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._button.label = _('Cancel');
        this._button.css_classes = [];
        this._row.subtitle = _('Finish signing in in the browser.');
        let tokens = null;
        let reply = null;
        try {
            const state = Ewelink.newState();
            reply = Ewelink.waitForCode(state, cancellable);
            Gio.AppInfo.launch_default_for_uri(Ewelink.loginUrl(app, state), null);
            tokens = await Ewelink.getToken(app, await reply);
            await Ewelink.storeTokens(tokens);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                    logError(e);
                this._toast(e.message);
            }
        } finally {
            // Frees the redirect port when no browser came back to it.
            reply?.catch(() => {});
            cancellable.cancel();
            this._cancellable = null;
        }
        if (this._closed)
            return;
        await this._sync();
        if (tokens)
            await this._addListed();
    }

    async _withCloud(task) {
        const cloud = await Ewelink.EwelinkCloud.load();
        if (!cloud)
            return null;
        try {
            return await task(cloud);
        } finally {
            cloud.abort();
        }
    }

    // Saves the switches among the given devices; returns how many are new.
    async _merge(cloud, items) {
        const switches = items.filter(i => typeof i.params?.switch === 'string' || Array.isArray(i.params?.switches));
        if (switches.length === 0)
            return 0;
        const rooms = await cloud.rooms().catch(e => {
            console.debug(`nook: eWeLink rooms: ${e.message}`);
            return new Map();
        });
        const devices = this._devices();
        let added = 0;
        for (const item of switches) {
            const fresh = Ewelink.savedDevice(item, rooms);
            const index = devices.findIndex(d => d.id === fresh.id);
            if (index >= 0) {
                devices[index] = {...devices[index], ...fresh, room: fresh.room ?? devices[index].room};
            } else {
                devices.push(fresh);
                added++;
            }
        }
        this._save(devices);
        return added;
    }

    async _addListed() {
        try {
            const added = await this._withCloud(async cloud => this._merge(cloud, await cloud.listDevices()));
            this._toast(added > 0
                ? ngettext('%d eWeLink device added.', '%d eWeLink devices added.', added).format(added)
                : _('eWeLink lists no new devices for this app. Search on the Devices page, or add one by its Device ID from the eWeLink app.'));
        } catch (e) {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
        }
    }

    async _addById() {
        const id = this._entry.text.trim().toLowerCase();
        if (!/^[0-9a-f]{10}$/.test(id)) {
            this._toast(_('A Device ID is 10 letters and digits, like 1000a1b2c3, shown in the device settings of the eWeLink app.'));
            return;
        }
        this._entry.sensitive = false;
        try {
            const added = await this._withCloud(async cloud => {
                const items = await cloud.devicesById([id]);
                return items.length > 0 ? this._merge(cloud, items) : null;
            });
            if (added === null) {
                this._toast(_('This eWeLink account and app have no switch with that Device ID.'));
                return;
            }
            this._entry.text = '';
            this._toast(added > 0 ? _('Device added.') : _('Already in Nook'));
        } catch (e) {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
        } finally {
            this._entry.sensitive = this._loggedIn;
        }
    }

    _drop(id) {
        this._save(this._devices().filter(d => d.id !== id));
        setSkipped(this._settings, [`ewelink:${id}`], true);
    }

    async _adopt(id) {
        const added = await this._withCloud(async cloud => {
            const items = await cloud.devicesById([id]);
            return items.length > 0 ? this._merge(cloud, items) : null;
        }).catch(e => {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
            return undefined;
        });
        if (added === undefined)
            return;
        if (!this._loggedIn)
            this._toast(_('Log in to eWeLink first.'));
        else if (!this._devices().some(d => d.id === id))
            this._toast(_('This eWeLink account and app have no switch with that Device ID.'));
        else
            setSkipped(this._settings, [`ewelink:${id}`], false);
    }

    _entryFor({ewelink: id, name, model, ip}) {
        return {
            kind: 'eWeLink',
            name,
            model,
            ip,
            saved: () => {
                const now = this._devices().find(d => d.id === id);
                return now ? EwelinkHome.channels(now)[0].did : null;
            },
            adopt: () => this._adopt(id),
            drop: () => this._drop(id),
        };
    }

    // For Find Devices: eWeLink devices that answered on this network, looked up by ID.
    async _find(quiet, looking) {
        try {
            const seen = (await looking).filter(d => d.ewelink);
            const found = seen.map(d => this._entryFor(d));
            const known = new Set(this._devices().map(d => d.id));
            const skipped = skippedIn(this._settings, quiet);
            const ids = [...new Set(seen.map(d => d.ewelink).filter(id => !known.has(id) && !skipped.has(`ewelink:${id}`)))];
            if (ids.length === 0)
                return {added: 0, found};
            const added = await this._withCloud(async cloud => this._merge(cloud, await cloud.devicesById(ids)));
            return {added: added ?? 0, found};
        } catch (e) {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            if (!quiet)
                this._toast(e.message);
            return {added: 0, failed: true};
        }
    }
});
