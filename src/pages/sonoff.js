// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'gettext';

import * as Sonoff from '../lib/sonoff.js';
import {dropSonoff} from '../remove.js';
import {deviceCount, setGroupIcon, setSearching, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

export const SonoffGroup = GObject.registerClass(
class SonoffGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Sonoff'),
            description: _('Sonoff relays and plugs in DIY mode on this network, without the cloud. One paired the usual way with the eWeLink app answers only eWeLink.'),
        });
        setGroupIcon(this, 'sonoff');
        this._settings = settings;
        this._window = window;
        this._rows = [];

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('A switch answers here once it is in DIY mode.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._handlers = ['sonoff-switches', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this.foldable(settings, 'accounts-sonoff', () => deviceCount(this._switches().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _switches() {
        return Sonoff.parseSwitches(this._settings.get_string('sonoff-switches'));
    }

    _drop(id) {
        dropSonoff(this._settings, id);
    }

    _entry(unit) {
        return {
            kind: 'Sonoff',
            name: unit.name,
            ip: unit.ip,
            saved: () => {
                const now = this._switches().find(s => s.id === unit.id);
                return now ? Sonoff.channels(now)[0].did : null;
            },
            adopt: async () => {
                setSkipped(this._settings, [`sonoff:${unit.id}`], false);
                this._save([...this._switches().filter(s => s.id !== unit.id), unit]);
            },
            drop: () => this._drop(unit.id),
        };
    }

    _save(switches) {
        const json = JSON.stringify(switches);
        if (json !== this._settings.get_string('sonoff-switches'))
            this._settings.set_string('sonoff-switches', json);
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const unit of this._switches()) {
            const [first, ...more] = Sonoff.channels(unit);
            const own = more.length === 0 ? names[first.did] : null;
            const name = unit.name || unit.id;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? name, -1),
                subtitle: GLib.markup_escape_text([own ? name : null,
                    more.length > 0 ? ngettext('%d channel', '%d channels', more.length + 1).format(more.length + 1) : null,
                    unit.ip].filter(Boolean).join(' · '), -1),
            });
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
        this._rows.push(this._search);
        for (const row of this._rows)
            this.add(row);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    async _find(quiet = false) {
        setSearching(this._searchButton, true);
        try {
            const found = await Sonoff.discover(3000);
            const saved = this._switches();
            const byId = new Map(found.map(s => [s.id, s]));
            const kept = saved.map(s => (byId.has(s.id) ? {...s, ip: byId.get(s.id).ip, port: byId.get(s.id).port} : s));
            const known = new Set(saved.map(s => s.id));
            const skipped = skippedIn(this._settings, quiet);
            const added = found.filter(s => !known.has(s.id) && !skipped.has(`sonoff:${s.id}`));
            setSkipped(this._settings, added.map(s => `sonoff:${s.id}`), false);
            this._save([...kept, ...added]);
            if (quiet)
                return {added: added.length, found: found.map(s => this._entry(s))};
            if (found.length === 0)
                this._toast(_('No Sonoff in DIY mode answered.'));
            else if (added.length === 0)
                this._toast(_('Nothing new found.'));
            return {added: added.length};
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
