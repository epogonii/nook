// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'gettext';

import {BRANDS as AIRCONS, didOf as airconDid, parseAircons, parseUnits} from '../lib/aircon-home.js';
import {ClimateError} from '../lib/climate.js';
import * as Daikin from '../lib/daikin.js';
import * as Gree from '../lib/gree.js';
import * as Midea from '../lib/midea.js';
import * as Secrets from '../lib/secrets.js';
import {dropAircon} from '../remove.js';
import {deviceCount, setGroupIcon, setSearching, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

export const AirconGroup = GObject.registerClass(
class AirconGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Air Conditioners'),
            description: _('Gree, Midea and Daikin units on this network, controlled directly. A newer Midea unit gets its key from Midea’s cloud once, when it is added.'),
        });
        setGroupIcon(this, 'gree');
        this._settings = settings;
        this._window = window;
        this._rows = [];

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('The unit has to be on and connected to the same Wi-Fi.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find('255.255.255.255').catch(logError));
        this._search.add_suffix(this._searchButton);

        this._address = new Adw.EntryRow({title: _('Add by Address'), show_apply_button: true});
        this._address.connect('apply', () => this._find(this._address.text.trim()).catch(logError));

        this._handlers = ['gree-units', 'aircons', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this.foldable(settings, 'accounts-gree', () => deviceCount(this._units().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _gree() {
        return parseUnits(this._settings.get_string('gree-units'));
    }

    _others() {
        return parseAircons(this._settings.get_string('aircons'));
    }

    _units() {
        return [...this._gree().map(u => ({...u, brand: 'gree'})), ...this._others()];
    }

    _save(units) {
        for (const [key, list] of [['gree-units', units.filter(u => u.brand === 'gree').map(({brand: _brand, ...u}) => u)],
            ['aircons', units.filter(u => u.brand !== 'gree')]]) {
            const json = JSON.stringify(list);
            if (json !== this._settings.get_string(key))
                this._settings.set_string(key, json);
        }
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const unit of this._units()) {
            const did = airconDid(unit);
            const own = names[did];
            const name = unit.name || unit.mac || AIRCONS[unit.brand].title;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? name, -1),
                subtitle: GLib.markup_escape_text([own ? name : null, AIRCONS[unit.brand].title, unit.ip,
                    unit.brand === 'midea' ? null : unit.mac].filter(Boolean).join(' · '), -1),
            });
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(unit).catch(logError));
            row.add_suffix(remove);
            this._rows.push(row);
        }
        this._rows.push(this._search, this._address);
        for (const row of this._rows)
            this.add(row);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    _drop(unit) {
        return dropAircon(this._settings, unit);
    }

    // What a found unit becomes in the settings, or null with a toast saying why not.
    async _pair(found) {
        try {
            if (found.brand === 'gree') {
                const device = new Gree.GreeDevice(found);
                try {
                    const {key, cipher} = await device.bind();
                    return {brand: 'gree', mac: found.mac, ip: found.ip, name: found.name, key, cipher, version: found.version};
                } finally {
                    device.close();
                }
            }
            if (found.brand === 'midea') {
                const unit = {brand: 'midea', id: found.id, ip: found.ip, port: found.port, sn: found.sn,
                    version: found.version, name: `Midea ${found.name.split('_').pop()}`};
                if (Number(found.version) === 3)
                    await Midea.keepKeys(unit, await Midea.fetchKeys(unit));
                return unit;
            }
            return {brand: 'daikin', id: found.mac, mac: found.mac, ip: found.ip, name: found.name || 'Daikin',
                api: found.api, firmware: found.firmware};
        } catch (e) {
            if (!(e instanceof ClimateError) && !(e instanceof GLib.Error))
                throw e;
            this._toast(_('%s would not pair: %s').replace('%s', found.name || AIRCONS[found.brand].title)
                .replace('%s', e.message));
            return null;
        }
    }

    async _adopt(found) {
        const unit = await this._pair(found);
        if (!unit)
            return;
        const did = airconDid(unit);
        setSkipped(this._settings, [did], false);
        this._save([...this._units().filter(u => airconDid(u) !== did), unit]);
    }

    _entry(found) {
        const did = airconDid(found);
        return {
            kind: AIRCONS[found.brand].title,
            name: found.name || AIRCONS[found.brand].title,
            ip: found.ip,
            mac: found.brand === 'midea' ? null : found.mac,
            saved: () => (this._units().some(u => airconDid(u) === did) ? did : null),
            adopt: () => this._adopt(found),
            drop: () => this._drop(found),
        };
    }

    // Every maker at once; one that fails doesn't keep the others' finds out.
    // Gree and Midea answer UDP, to an IPv4 address only; a host name reaches a Daikin.
    async _look(address) {
        const broadcast = address === '255.255.255.255';
        const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
        const daikin = broadcast
            ? Daikin.discover(address)
            : Daikin.identify(address).then(who => (who ? [{ip: address, ...who}] : []));
        const results = await Promise.allSettled([ipv4 ? Gree.discover(address) : [], ipv4 ? Midea.discover(address) : [], daikin]);
        const failed = results.find(r => r.status === 'rejected')?.reason ?? null;
        const [gree, midea, daikins] = results.map(r => (r.status === 'fulfilled' ? r.value : []));
        // A Daikin found by broadcast tells its API only to a request of its own.
        const told = await Promise.all(daikins.map(async found => {
            if (found.api)
                return found;
            const who = await Daikin.identify(found.ip).catch(() => null);
            return who ? {...found, api: who.api, firmware: who.firmware ?? found.firmware, name: found.name || who.name} : found;
        }));
        const found = [
            ...gree.map(u => ({...u, brand: 'gree'})),
            ...midea.map(u => ({...u, brand: 'midea'})),
            ...told.filter(u => u.api).map(u => ({...u, brand: 'daikin', id: u.mac})),
        ];
        return {found, failed: found.length === 0 ? failed : null};
    }

    async _find(address, quiet = false) {
        if (!address)
            return {added: 0};
        setSearching(this._searchButton, true);
        try {
            const {found, failed} = await this._look(address);
            if (failed)
                throw failed;
            const known = new Set(this._units().map(airconDid));
            const skipped = skippedIn(this._settings, quiet);
            // A known newer Midea whose key is gone (another computer, a cleared keyring)
            // fetches it again.
            for (const unit of found.filter(u => u.brand === 'midea' && Number(u.version) === 3 && known.has(airconDid(u)))) {
                if (!await Secrets.lookup(Midea.secretService(unit.id)).catch(() => null))
                    await this._pair(unit);
            }
            const added = [];
            for (const unit of found.filter(u => !known.has(airconDid(u)) && !skipped.has(airconDid(u)))) {
                const paired = await this._pair(unit);
                if (paired)
                    added.push(paired);
            }
            // Re-read after the awaits: another search may have added the same unit.
            const at = new Map(found.map(u => [airconDid(u), u.ip]));
            const units = this._units();
            const moved = units.some(u => at.has(airconDid(u)) && at.get(airconDid(u)) !== u.ip);
            const kept = units.map(u => (at.has(airconDid(u)) ? {...u, ip: at.get(airconDid(u))} : u));
            const fresh = added.filter(u => !units.some(k => airconDid(k) === airconDid(u)));
            setSkipped(this._settings, fresh.map(airconDid), false);
            if (fresh.length > 0 || moved)
                this._save([...kept, ...fresh]);
            if (quiet)
                return {added: fresh.length, found: found.map(u => this._entry(u))};
            if (found.length === 0)
                this._toast(_('No air conditioner answered.'));
            else if (fresh.length === 0)
                this._toast(_('Nothing new found.'));
            else
                this._address.text = '';
            return {added: fresh.length};
        } catch (e) {
            if (!quiet)
                this._toast(e.message);
            if (!(e instanceof ClimateError) && !(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            setSearching(this._searchButton, false);
        }
    }
});
