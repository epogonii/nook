// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {discover as findSpeakers, parseSpeakers} from '../lib/cast-home.js';
import {deviceCount, renameButton, setGroupIcon, setSearching, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

export const SpeakersGroup = GObject.registerClass(
class SpeakersGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Speakers'),
            description: _('Google Nest speakers and other Cast devices on this network: what plays, pause and volume, without the cloud.'),
        });
        setGroupIcon(this, 'cast');
        this._settings = settings;
        this._window = window;
        this._rows = [];

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('Speakers in the Google Home app show up here too.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._handlers = ['cast-speakers', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this.foldable(settings, 'accounts-cast', () => deviceCount(this._speakers().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _speakers() {
        return parseSpeakers(this._settings.get_string('cast-speakers'));
    }

    _save(speakers) {
        const json = JSON.stringify(speakers);
        if (json !== this._settings.get_string('cast-speakers'))
            this._settings.set_string('cast-speakers', json);
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const speaker of this._speakers()) {
            const did = `cast:${speaker.id}`;
            const own = names[did];
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? speaker.name, -1),
                subtitle: GLib.markup_escape_text([own ? speaker.name : null, speaker.model, speaker.ip].filter(Boolean).join(' · '), -1),
            });
            row.add_suffix(renameButton(this._settings, did, speaker.name, this));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(speaker.id));
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

    _drop(id) {
        this._save(this._speakers().filter(s => s.id !== id));
        setSkipped(this._settings, [`cast:${id}`], true);
    }

    _entry({id, name, model, ip, port}) {
        const did = `cast:${id}`;
        return {
            kind: 'Cast',
            name,
            model,
            ip,
            saved: () => (this._speakers().some(s => s.id === id) ? did : null),
            adopt: async () => {
                setSkipped(this._settings, [did], false);
                this._save([...this._speakers().filter(s => s.id !== id), {id, name, model, ip, port}]);
            },
            drop: () => this._drop(id),
        };
    }

    async _find(quiet = false) {
        setSearching(this._searchButton, true);
        try {
            const found = await findSpeakers(3000);
            const saved = this._speakers();
            const byId = new Map(found.map(s => [s.id, s]));
            const kept = saved.map(s => (byId.has(s.id) ? {...s, ip: byId.get(s.id).ip, port: byId.get(s.id).port} : s));
            const known = new Set(saved.map(s => s.id));
            const skipped = skippedIn(this._settings, quiet);
            const added = found.filter(s => !known.has(s.id) && !skipped.has(`cast:${s.id}`))
                .map(({id, name, model, ip, port}) => ({id, name, model, ip, port}));
            setSkipped(this._settings, added.map(s => `cast:${s.id}`), false);
            this._save([...kept, ...added]);
            if (quiet)
                return {added: added.length, found: found.map(s => this._entry(s))};
            if (found.length === 0)
                this._toast(_('No speaker answered.'));
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
