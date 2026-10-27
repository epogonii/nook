// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseSpeakers} from '../lib/cast-home.js';
import {survey} from '../lib/finder.js';
import * as EwelinkHome from '../lib/ewelink-home.js';
import {didOf as airconDid, parseAircons, parseUnits} from '../lib/aircon-home.js';
import * as Shelly from '../lib/shelly.js';
import * as Sonoff from '../lib/sonoff.js';
import * as Tapo from '../lib/tapo.js';
import {parseTvs} from '../lib/tv-home.js';
import {cachedDevices, setGroupIcon, setSearching} from './common.js';
import {FoldGroup} from './fold.js';

function verdict(device, known) {
    if (known)
        return _('Already in Nook');
    if (device.kinds.includes('Mi Home'))
        return _('Comes with the Mi Home account');
    if (device.kinds.includes('eWeLink'))
        return _('With the eWeLink account, or in Sonoff DIY mode');
    if (device.kinds.includes('Shelly'))
        return _('Add it under Shelly');
    if (device.kinds.includes('Philips Hue'))
        return _('Pair it under Philips Hue');
    if (device.kinds.includes('Home Assistant'))
        return _('Connect it under Home Assistant');
    if (device.kinds.includes('HomeKit'))
        return _('Pair it under HomeKit, once it is in no other home');
    return _('Not supported yet');
}

export const FindGroup = GObject.registerClass(
class FindGroup extends FoldGroup {
    _init(settings, window, finders) {
        super._init({
            title: _('Find Devices'),
            description: _('Air conditioners, cameras, speakers, TVs and Sonoff switches on this network are added, and eWeLink devices once that account is logged in. Whatever else answers is listed, with what it would take.'),
        });
        setGroupIcon(this, 'find');
        this._settings = settings;
        this._window = window;
        this._finders = finders;
        this._rows = [];
        this._last = null;
        this._choices = [
            {name: _('Everything'), about: _('Gree, Midea, Daikin, Cast, ONVIF, mDNS and UPnP. Nothing leaves this network, except eWeLink device IDs sent to the eWeLink account and a newer Midea unit’s ID sent to Midea’s cloud for its key.')},
            ...finders,
        ];
        const search = new Adw.ComboRow({
            title: _('Look For'),
            subtitle_lines: 0,
            model: Gtk.StringList.new(this._choices.map(c => c.name)),
        });
        const describe = () => {
            search.subtitle = this._choices[search.selected]?.about ?? '';
        };
        describe();
        search.connect('notify::selected', describe);
        this._choice = search;
        this._button = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        this._button.connect('clicked', () => this._search().catch(logError));
        search.add_suffix(this._button);
        this.add(search);
        this._handlers = ['names', 'xiaomi-user-id', 'gree-units', 'aircons', 'tapo-cameras', 'cast-speakers', 'tvs', 'sonoff-switches', 'shelly-devices',
            'ewelink-devices', 'hue-bridges', 'homekit-accessories']
            .map(key => settings.connect(`changed::${key}`, () => {
                if (this._last)
                    this._show();
            }));
        this.foldable(settings, 'find');
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    async _search() {
        setSearching(this._button, true);
        try {
            const choice = this._choices[this._choice.selected];
            const one = choice?.find ? choice : null;
            const finders = one ? [one.find] : this._finders.map(f => f.find);
            // Alone, Hue and HomeKit browse only their own mDNS service.
            const looking = !one || one.survey ? survey(3000).catch(e => {
                console.debug(`nook: finder: ${e.message}`);
                return [];
            }) : null;
            const [results, seen] = await Promise.all([
                Promise.allSettled(finders.map(find => find(looking))),
                one ? [] : looking,
            ]);
            const added = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value?.added ?? 0 : 0), 0);
            const failed = results.some(r => r.status === 'rejected' || r.value?.failed);
            for (const r of results.filter(each => each.status === 'rejected'))
                console.debug(`nook: finder: ${r.reason?.message}`);
            this._last = {
                entries: results.flatMap(r => (r.status === 'fulfilled' ? r.value?.found ?? [] : [])),
                seen,
            };
            this._show();
            let title = _('Nothing new to add.');
            if (added > 0)
                title = ngettext('%d new device added.', '%d new devices added.', added).format(added);
            else if (failed)
                title = _('Part of the search failed. Try again in a moment.');
            this._window.add_toast(new Adw.Toast({title, timeout: 6}));
        } finally {
            setSearching(this._button, false);
        }
    }

    _show() {
        for (const row of this._rows)
            this.remove(row);
        const {entries, seen} = this._last;
        const names = this._settings.get_value('names').deepUnpack();
        const macOf = text => (text ?? '').replace(/[:-]/g, '').toLowerCase() || null;
        // A device a finder can add gets its own row; survey rows are for the rest.
        const covered = new Set(entries.flatMap(e => [e.ip, macOf(e.mac)]).filter(Boolean));
        const rest = seen.filter(d => !covered.has(d.ip) && !covered.has(macOf(d.mac)));
        this._rows = [
            ...entries.map(entry => this._entryRow(entry, names)),
            ...this._surveyRows(rest, names, macOf),
        ].sort((a, b) => a.title.localeCompare(b.title));
        for (const row of this._rows)
            this.add(row);
    }

    _entryRow(entry, names) {
        const did = entry.saved();
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text((did && names[did]) || entry.name, -1),
            subtitle: GLib.markup_escape_text([entry.kind, entry.model, entry.ip].filter(Boolean).join(' · '), -1),
        });
        const toggle = new Gtk.Switch({
            active: Boolean(did),
            valign: Gtk.Align.CENTER,
            tooltip_text: _('In Nook'),
        });
        let syncing = false;
        toggle.connect('notify::active', () => {
            if (syncing)
                return;
            toggle.sensitive = false;
            Promise.resolve(toggle.active ? entry.adopt() : entry.drop()).catch(logError).finally(() => {
                syncing = true;
                toggle.active = Boolean(entry.saved());
                syncing = false;
                toggle.sensitive = true;
            });
        });
        row.add_suffix(toggle);
        row.activatable_widget = toggle;
        return row;
    }

    _surveyRows(seen, names, macOf) {
        const mine = new Map(cachedDevices(this._settings.get_string('xiaomi-user-id')).map(d => [d.did, d]));
        const saved = [
            ...parseTvs(this._settings.get_string('tvs'))
                .map(t => ({did: `tv:${t.id}`, name: t.name, ip: t.ip, mac: macOf(t.mac)})),
            ...parseSpeakers(this._settings.get_string('cast-speakers'))
                .map(t => ({did: `cast:${t.id}`, name: t.name, ip: t.ip, mac: null})),
            ...Tapo.parseCameras(this._settings.get_string('tapo-cameras'))
                .map(t => ({did: `tapo:${t.id}`, name: t.name, ip: t.ip, mac: null})),
            ...parseUnits(this._settings.get_string('gree-units'))
                .map(t => ({did: `gree:${t.mac}`, name: t.name || t.mac, ip: t.ip, mac: macOf(t.mac)})),
            ...parseAircons(this._settings.get_string('aircons'))
                .map(t => ({did: airconDid(t), name: t.name, ip: t.ip, mac: macOf(t.mac)})),
            ...Sonoff.parseSwitches(this._settings.get_string('sonoff-switches'))
                .map(t => ({did: Sonoff.channels(t)[0].did, name: t.name || t.id, ip: t.ip, mac: null})),
            ...Shelly.parseDevices(this._settings.get_string('shelly-devices')).filter(t => t.channels.length > 0)
                .map(t => ({did: Shelly.didOf(t, t.channels[0].key), name: t.name || t.model, ip: t.ip, mac: t.id})),
        ];
        const clouded = EwelinkHome.parseDevices(this._settings.get_string('ewelink-devices'))
            .map(t => ({did: EwelinkHome.channels(t)[0].did, name: t.name || t.id, id: t.id}));
        return seen.map(device => {
            const known = device.did ? mine.get(device.did) : null;
            const mac = macOf(device.mac);
            const added = known ? null : clouded.find(o => device.ewelink && o.id === device.ewelink) ??
                saved.find(o => (o.mac && mac ? o.mac === mac : o.ip === device.ip));
            let title = device.name;
            if (known)
                title = names[known.did] || known.name;
            else if (added)
                title = names[added.did] || added.name;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(title, -1),
                subtitle: GLib.markup_escape_text([device.kinds.join(', '), device.model, device.ip]
                    .filter(Boolean).join(' · '), -1),
            });
            row.add_suffix(new Gtk.Label({
                label: verdict(device, Boolean(known || added)),
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
                justify: Gtk.Justification.RIGHT,
                wrap: true,
                natural_wrap_mode: Gtk.NaturalWrapMode.NONE,
                max_width_chars: 32,
            }));
            return row;
        });
    }
});
