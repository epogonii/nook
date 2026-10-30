// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'gettext';

import * as Hue from '../lib/hue.js';
import * as Secrets from '../lib/secrets.js';
import {SpecError} from '../lib/spec-home.js';
import {deviceCount, hueDevices, setGroupIcon, setSearching, specTrouble, wait} from './common.js';
import {FoldGroup} from './fold.js';

// The first bytes of a fingerprint, enough to tell two apart by eye.
const shortPrint = print => (print ?? '').slice(0, 16).toUpperCase().match(/../g)?.join(':') ?? '?';

function askToTrust(parent, before, now) {
    return new Promise(resolve => {
        const dialog = new Adw.AlertDialog({
            heading: _('The Bridge Has a New Certificate'),
            body: _('The bridge answered with another certificate than the one Nook saw before. That is expected after it was replaced or reset; otherwise something on this network may be posing as it.\n\nBefore: %s\nNow: %s')
                .format(shortPrint(before), shortPrint(now)),
            default_response: 'cancel',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('trust', _('Trust the New One'));
        dialog.set_response_appearance('trust', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => resolve(response === 'trust'));
        dialog.present(parent.get_root());
    });
}

// A dialog with only Cancel, shown while waiting on a device; cancels when closed.
function waitingDialog(parent, heading, body, cancellable) {
    const dialog = new Adw.AlertDialog({heading, body, close_response: 'cancel'});
    dialog.add_response('cancel', _('Cancel'));
    let open = true;
    dialog.connect('closed', () => {
        open = false;
        cancellable.cancel();
    });
    dialog.present(parent.get_root());
    return () => {
        if (open)
            dialog.force_close();
    };
}

export const HueGroup = GObject.registerClass(
class HueGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Philips Hue'),
            description: _('Hue lights, plugs and sensors through a Hue Bridge on this network, without the cloud.'),
        });
        setGroupIcon(this, 'hue');
        this._settings = settings;
        this._window = window;
        this._rows = [];
        this._turn = 0;
        this._closed = false;
        this._pairing = null;

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('A Hue Bridge answers on the network it is plugged into.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._entry = new Adw.EntryRow({title: _('Add by Address'), show_apply_button: true});
        this._entry.connect('apply', () => this._addByAddress().catch(logError));

        window.connect('close-request', () => {
            this._closed = true;
            this._pairing?.cancel();
            return false;
        });
        this._handlers = ['hue-bridges', 'hue-devices'].map(key => settings.connect(`changed::${key}`, () => this._fill().catch(logError)));
        this._fill().catch(logError);
        this.foldable(settings, 'accounts-hue', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
        this._turn++;
    }

    _bridges() {
        return Hue.parseBridges(this._settings.get_string('hue-bridges'));
    }

    _devices() {
        return hueDevices(this._settings);
    }

    _saveBridges(bridges) {
        const json = JSON.stringify(bridges);
        if (json !== this._settings.get_string('hue-bridges'))
            this._settings.set_string('hue-bridges', json);
    }

    _saveDevices(devices) {
        const json = JSON.stringify(devices);
        if (json !== this._settings.get_string('hue-devices'))
            this._settings.set_string('hue-devices', json);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    async _fill() {
        const turn = ++this._turn;
        const bridges = this._bridges();
        const paired = await Promise.all(bridges.map(b => Secrets.lookup(Hue.secretService(b.id)).then(Boolean, () => false)));
        if (turn !== this._turn)
            return;
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const devices = this._devices();
        bridges.forEach((bridge, i) => {
            const count = devices.filter(d => d.bridge === bridge.id).length;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(bridge.name || 'Hue Bridge', -1),
                subtitle: GLib.markup_escape_text([bridge.ip, paired[i] ? deviceCount(count) : _('Not paired')].join(' · '), -1),
            });
            if (paired[i]) {
                const update = new Gtk.Button({
                    icon_name: 'view-refresh-symbolic',
                    tooltip_text: _('Read the List Again'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                update.connect('clicked', () => this._update(bridge, update).catch(logError));
                row.add_suffix(update);
            }
            const pair = new Gtk.Button({
                label: paired[i] ? _('Pair Again') : _('Pair'),
                valign: Gtk.Align.CENTER,
                css_classes: paired[i] ? ['flat'] : ['suggested-action'],
            });
            pair.connect('clicked', () => this._pair(bridge, pair).catch(logError));
            row.add_suffix(pair);
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(bridge.id));
            row.add_suffix(remove);
            this._rows.push(row);
        });
        this._rows.push(this._search, this._entry);
        for (const row of this._rows)
            this.add(row);
    }

    // Asks the bridge itself for its id; its certificate is pinned here.
    async _probe(ip) {
        const client = new Hue.HueBridge({ip});
        try {
            return {...await client.config(), ip};
        } finally {
            client.abort();
        }
    }

    _keep(found) {
        const bridges = this._bridges();
        const index = bridges.findIndex(b => b.id === found.id);
        const bridge = {...bridges[index], ...found};
        if (index >= 0)
            bridges[index] = bridge;
        else
            bridges.push(bridge);
        this._saveBridges(bridges);
        return bridge;
    }

    async _addByAddress() {
        const ip = this._entry.text.trim();
        if (!ip)
            return;
        this._entry.sensitive = false;
        try {
            const known = this._bridges();
            const found = await this._probe(ip);
            const before = known.find(b => b.id === found.id);
            if (before && before.fingerprint && before.fingerprint !== found.fingerprint) {
                this._toast(_('This bridge answered with another certificate than before. Remove it first to add it again.'));
                return;
            }
            const bridge = this._keep({...found, fingerprint: before?.fingerprint ?? found.fingerprint});
            this._entry.text = '';
            if (!before)
                await this._pair(bridge, null);
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            this._entry.sensitive = true;
        }
    }

    // Another certificate than the pinned one is let in only when the user says so: a
    // replaced or reset bridge has a new one, and so would something posing as it.
    async _pair(bridge, button) {
        if (this._pairing)
            return;
        const cancellable = this._pairing = new Gio.Cancellable();
        let client = new Hue.HueBridge(bridge);
        let close = () => {};
        if (button)
            button.sensitive = false;
        try {
            let config;
            try {
                config = await client.config();
            } catch (e) {
                if (e.code !== 'certificate')
                    throw e;
                const offered = client.offered;
                client.abort();
                if (!await askToTrust(this, bridge.fingerprint, offered))
                    return;
                client = new Hue.HueBridge({ip: bridge.ip, fingerprint: offered});
                config = await client.config();
            }
            if (config.id !== bridge.id)
                throw new SpecError(_('Another bridge answers at this address now. Search again.'));
            const paired = client;
            cancellable.connect(() => paired.abort());
            close = waitingDialog(this, _('Press the Link Button'),
                _('Press the round button on the Hue Bridge. Nook keeps asking the bridge for a minute.'), cancellable);
            let key = null;
            const until = Date.now() + 60 * 1000;
            while (!key && !cancellable.is_cancelled() && Date.now() < until) {
                key = await client.pair(Hue.pairingName());
                if (!key)
                    await wait(2000);
            }
            if (!key) {
                if (!cancellable.is_cancelled())
                    this._toast(_('The link button was not pressed in time.'));
                return;
            }
            if (!this._bridges().some(b => b.id === bridge.id))
                return;
            await Secrets.store(Hue.secretService(bridge.id), `Nook: Hue Bridge ${bridge.name ?? bridge.id}`, JSON.stringify({key}));
            // paired changes hue-bridges even when nothing else did, so the shell reloads with the new key.
            const pinned = {...bridge, fingerprint: client.fingerprint, paired: Date.now()};
            this._keep(pinned);
            close();
            await this._update(pinned, null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                    logError(e);
                this._toast(specTrouble(e));
            }
        } finally {
            this._pairing = null;
            client.abort();
            if (!this._closed)
                close();
            if (button)
                button.sensitive = true;
        }
        if (!this._closed)
            await this._fill();
    }

    async _client(bridge) {
        const saved = await Secrets.lookup(Hue.secretService(bridge.id));
        const key = saved ? JSON.parse(saved).key : null;
        if (!key)
            throw new SpecError(_('Pair the bridge first.'));
        return new Hue.HueBridge(bridge, key);
    }

    async _update(bridge, button) {
        if (button)
            button.sensitive = false;
        const client = await this._client(bridge).catch(e => {
            this._toast(specTrouble(e));
            return null;
        });
        if (!client) {
            if (button)
                button.sensitive = true;
            return;
        }
        try {
            const fresh = Hue.savedDevices(bridge.id, await client.resources());
            if (!this._bridges().some(b => b.id === bridge.id))
                return;
            this._saveDevices([...Hue.parseDevices(this._settings.get_string('hue-devices')).filter(d => d.bridge !== bridge.id), ...fresh]);
            this._toast(ngettext('%d Hue device.', '%d Hue devices.', fresh.length).format(fresh.length));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            client.abort();
            if (button)
                button.sensitive = true;
        }
    }

    _drop(id) {
        this._saveDevices(Hue.parseDevices(this._settings.get_string('hue-devices')).filter(d => d.bridge !== id));
        this._saveBridges(this._bridges().filter(b => b.id !== id));
        Secrets.clear(Hue.secretService(id)).catch(logError);
    }

    _entryFor(found) {
        return {
            kind: 'Philips Hue',
            name: found.name,
            model: found.model,
            ip: found.ip,
            saved: () => (this._bridges().some(b => b.id === found.id) ? `hue:${found.id}` : null),
            adopt: async () => {
                try {
                    const bridge = this._bridges().find(b => b.id === found.id) ?? this._keep(await this._probe(found.ip));
                    await this._pair(bridge, null);
                } catch (e) {
                    if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                        logError(e);
                    this._toast(specTrouble(e));
                }
            },
            drop: () => this._drop(found.id),
        };
    }

    // Known bridges get their new address; new ones need the link button, so a quiet
    // search only lists them.
    async _find(quiet = false, looking = null) {
        if (!quiet)
            setSearching(this._searchButton, true);
        let single = null;
        try {
            const found = await Hue.discover(3000, looking);
            const bridges = this._bridges();
            let moved = false;
            for (const bridge of bridges) {
                const now = found.find(b => b.id === bridge.id);
                if (now && now.ip !== bridge.ip) {
                    bridge.ip = now.ip;
                    moved = true;
                }
            }
            if (moved)
                this._saveBridges(bridges);
            if (quiet)
                return {added: 0, found: found.map(b => this._entryFor(b))};
            const fresh = found.filter(b => !bridges.some(known => known.id === b.id));
            if (found.length === 0)
                this._toast(_('No Hue Bridge answered. Add it by its address if the network hides it.'));
            else if (fresh.length === 0)
                this._toast(_('Nothing new found.'));
            for (const each of fresh) {
                const bridge = this._keep(await this._probe(each.ip));
                if (fresh.length === 1)
                    single = bridge;
            }
            if (fresh.length > 1)
                this._toast(_('Pair each new bridge with the button beside it.'));
            return {added: fresh.length};
        } catch (e) {
            if (!quiet)
                this._toast(specTrouble(e));
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            if (!quiet)
                setSearching(this._searchButton, false);
            if (single)
                this._pair(single, null).catch(logError);
        }
    }
});
