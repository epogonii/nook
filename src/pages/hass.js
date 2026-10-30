// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'gettext';

import {browse} from '../lib/finder.js';
import * as Hass from '../lib/hass.js';
import * as Secrets from '../lib/secrets.js';
import {SpecError} from '../lib/spec-home.js';
import {deviceCount, helpRow, setGroupIcon, specTrouble} from './common.js';
import {FoldGroup} from './fold.js';

const HASS_TOKEN_URL = 'https://www.home-assistant.io/docs/authentication/#your-account-profile';

export const HassGroup = GObject.registerClass(
class HassGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Home Assistant'),
            description: _('Lights, switches, climate, covers and sensors of a Home Assistant server, through an access token of your own.'),
        });
        setGroupIcon(this, 'hass');
        this._settings = settings;
        this._window = window;
        this._connected = false;
        this._busy = false;
        this._closed = false;

        this.add(helpRow(_('Create an Access Token'),
            _('In Home Assistant, open your profile, then Security, and create a long-lived access token at the bottom of the page.'),
            HASS_TOKEN_URL));
        this._address = new Adw.EntryRow({title: _('Address, like http://homeassistant.local:8123')});
        this._token = new Adw.PasswordEntryRow({title: _('Access Token')});
        this.add(this._address);
        this.add(this._token);

        this._row = new Adw.ActionRow({title: _('Server')});
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
        this._handlers = ['hass-devices', 'hass-server'].map(key => settings.connect(`changed::${key}`, () => this._sync().catch(logError)));
        this._sync().then(() => this._suggest()).catch(logError);
        this.foldable(settings, 'accounts-hass', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _devices() {
        return Hass.parseDevices(this._settings.get_string('hass-devices'));
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    async _account() {
        const saved = await Secrets.lookup(Hass.SECRET);
        try {
            return saved ? JSON.parse(saved) : null;
        } catch {
            return null;
        }
    }

    // The keyring is authoritative; hass-server only signals the shell, so resync it.
    async _sync() {
        const account = await this._account();
        if (this._closed)
            return;
        this._connected = Boolean(account?.url && account?.token);
        const url = this._connected ? account.url : '';
        if (this._settings.get_string('hass-server') !== url)
            this._settings.set_string('hass-server', url);
        if (this._connected)
            this._address.text = url;
        this._row.subtitle = this._connected
            ? GLib.markup_escape_text(`${url} · ${deviceCount(this._devices().length)}`, -1)
            : _('Not connected');
        this._button.label = this._connected ? _('Disconnect') : _('Connect');
        this._button.css_classes = [this._connected ? 'destructive-action' : 'suggested-action'];
        this._button.sensitive = !this._busy;
        this._update.visible = this._connected;
        this._update.sensitive = !this._busy;
        this._address.sensitive = !this._connected && !this._busy;
        this._token.visible = !this._connected;
    }

    // Fills in the address of a server that announces itself on this network.
    async _suggest() {
        if (this._connected || this._address.text)
            return;
        const [found] = await browse(3000, ['_home-assistant._tcp']);
        if (!found || this._closed || this._connected || this._address.text)
            return;
        this._address.text = found.txt.internal_url || found.txt.base_url || `http://${found.ip}:${found.port}`;
    }

    async _onButton() {
        if (this._connected) {
            await Secrets.clear(Hass.SECRET);
            await this._sync();
            return;
        }
        const url = Hass.serverUrl(this._address.text);
        const token = this._token.text.trim();
        if (!url) {
            this._toast(_('Type the address of Home Assistant first.'));
            return;
        }
        if (!token) {
            this._toast(_('Paste an access token first.'));
            return;
        }
        await this._read({url, token});
    }

    // Connects with the given account, or the saved one, and saves what it reads.
    async _read(given = null) {
        if (this._busy)
            return;
        const account = given ?? await this._account();
        if (!account)
            return;
        this._busy = true;
        await this._sync();
        const client = new Hass.HassClient(account.url, account.token);
        try {
            await client.connect();
            const devices = Hass.savedDevices(await Hass.readHome(client));
            if (given)
                await Secrets.store(Hass.SECRET, 'Nook: Home Assistant', JSON.stringify(account));
            const json = JSON.stringify(devices);
            if (json !== this._settings.get_string('hass-devices'))
                this._settings.set_string('hass-devices', json);
            if (given)
                this._token.text = '';
            this._toast(ngettext('%d device from Home Assistant.', '%d devices from Home Assistant.', devices.length)
                .format(devices.length));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            client.close();
            this._busy = false;
        }
        if (!this._closed)
            await this._sync();
    }
});
