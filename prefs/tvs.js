// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {survey} from '../lib/finder.js';
import * as Secrets from '../lib/secrets.js';
import {BRANDS, TvError, keepSecret, parseTvs, secretService} from '../lib/tv-home.js';
import {deviceCount, renameButton, setGroupIcon, setSearching, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

function tvsIn(seen) {
    return seen.filter(d => d.tv).map(d => ({
        id: d.mac?.replace(/:/g, '') || d.tv.udn.replace(/^uuid:/i, '') || d.ip,
        brand: d.tv.brand,
        name: d.name,
        model: d.tv.model,
        ip: d.ip,
        mac: d.mac,
        port: d.tv.port,
    }));
}

const sameTv = (a, b) => a.id === b.id || Boolean(a.mac && a.mac === b.mac) ||
    (!a.mac && a.brand === b.brand && a.ip === b.ip);

function tvTrouble(e) {
    if (e instanceof TvError && e.code === '600')
        return _('The TV did not take the PIN. Pair again for a new one.');
    if (e instanceof TvError && e.code === 'denied')
        return _('The TV did not let Nook in.');
    if (e instanceof TvError && e.code === 'timeout')
        return _('Nobody answered on the TV in time.');
    if (e instanceof TvError && e.code === 'openssl')
        return _('Pairing this TV needs the openssl command, which is not installed.');
    if (e instanceof TvError || e instanceof GLib.Error)
        return _('The TV is not answering. It has to be on.');
    return e.message;
}

function askForPairing(parent, body) {
    return new Promise(resolve => {
        const entry = new Gtk.PasswordEntry({activates_default: true, show_peek_icon: true});
        const dialog = new Adw.AlertDialog({
            heading: _('Pair with the TV'),
            body,
            extra_child: entry,
            default_response: 'pair',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('pair', _('Pair'));
        dialog.set_response_appearance('pair', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            const text = entry.text.trim();
            resolve(response === 'pair' && text ? text : null);
        });
        dialog.present(parent.get_root());
    });
}

export const TvsGroup = GObject.registerClass(
class TvsGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('TVs'),
            description: _('Panasonic, Samsung, LG, Sony, Philips and Roku TVs, Android TV, Google TV and Apple TV on this network: power, volume, inputs, apps and a remote, without the cloud.'),
        });
        setGroupIcon(this, 'tv');
        this._settings = settings;
        this._window = window;
        this._rows = [];
        this._byDid = new Map();
        this._turn = 0;

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('A TV answers while it is on, or in standby if it keeps its network on.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._handlers = ['tvs', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill().catch(logError)));
        this._fill().catch(logError);
        this.foldable(settings, 'accounts-tv', () => deviceCount(this._tvs().length));
    }

    reveal(did) {
        super.reveal();
        return this._byDid.get(did) ?? this;
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
        // Invalidates a _fill() still waiting on the keyring.
        this._turn++;
    }

    _tvs() {
        return parseTvs(this._settings.get_string('tvs'));
    }

    _save(tvs) {
        const json = JSON.stringify(tvs);
        if (json !== this._settings.get_string('tvs'))
            this._settings.set_string('tvs', json);
    }

    async _fill() {
        const turn = ++this._turn;
        const tvs = this._tvs();
        const paired = await Promise.all(tvs.map(tv => Secrets.lookup(secretService(tv.id)).then(Boolean, () => false)));
        if (turn !== this._turn)
            return;
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        this._byDid = new Map();
        const names = this._settings.get_value('names').deepUnpack();
        tvs.forEach((tv, i) => {
            const did = `tv:${tv.id}`;
            const own = names[did];
            const {title, Driver} = BRANDS[tv.brand];
            const model = tv.model?.toLowerCase().startsWith(title.toLowerCase())
                ? tv.model : [title, tv.model].filter(Boolean).join(' ');
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? tv.name ?? model, -1),
                subtitle: GLib.markup_escape_text([own ? tv.name : null, model, tv.ip, paired[i] ? _('Paired') : null]
                    .filter(Boolean).join(' · '), -1),
            });
            if (Driver.pairing) {
                const pair = new Gtk.Button({
                    label: paired[i] ? _('Pair Again') : _('Pair'),
                    valign: Gtk.Align.CENTER,
                    css_classes: paired[i] ? ['flat'] : ['suggested-action'],
                });
                pair.connect('clicked', () => this._pair(tv, pair).catch(logError));
                row.add_suffix(pair);
            }
            row.add_suffix(renameButton(this._settings, did, tv.name ?? model, this));
            this._byDid.set(did, row);
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(tv.id));
            row.add_suffix(remove);
            this._rows.push(row);
        });
        this._rows.push(this._search);
        for (const row of this._rows)
            this.add(row);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    // One driver for the whole pairing: it holds the state between steps (Panasonic's
    // PIN challenge, the connection an LG or Samsung accepted).
    async _pair(tv, button) {
        const {title, Driver} = BRANDS[tv.brand];
        const driver = new Driver(tv, null);
        const label = button.label;
        button.sensitive = false;
        button.label = _('Pairing…');
        try {
            let secret;
            if (Driver.pairing === 'pin') {
                const begun = await driver.pairBegin('Nook');
                if (begun.done) {
                    this._toast(_('This TV takes commands without pairing.'));
                    return;
                }
                const pin = await askForPairing(this, _('Type in the PIN the TV shows now.'));
                if (pin === null)
                    return;
                secret = await driver.pairEnd(pin);
                // A second step with a PIN of its own (Apple TV's AirPlay); the first one
                // works alone if this one is skipped or fails.
                while (secret?.again) {
                    const next = await askForPairing(this, _('Type in the new PIN the TV shows now.'));
                    if (next === null) {
                        secret = secret.secret;
                        break;
                    }
                    try {
                        secret = await driver.pairEnd(next);
                    } catch (e) {
                        this._toast(tvTrouble(e));
                        secret = secret.secret;
                    }
                }
            } else if (Driver.pairing === 'prompt') {
                this._toast(_('Allow Nook on the TV when it asks.'));
                ({secret} = await driver.pairBegin());
            } else {
                const psk = await askForPairing(this,
                    _('On the TV, under Network, Home Network, IP Control, set the authentication to a pre-shared key, then type the same key in here.'));
                if (psk === null)
                    return;
                secret = await driver.pairEnd(psk);
            }
            // Removed during pairing: don't store a secret for it.
            if (!this._tvs().some(t => t.id === tv.id))
                return;
            try {
                await keepSecret(tv, secret);
            } catch (e) {
                this._toast(_('The pairing could not be saved in the keyring: %s').format(e.message));
                return;
            }
            this._toast(_('Paired with the %s TV.').format(title));
            await this._fill();
        } catch (e) {
            this._toast(tvTrouble(e));
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                logError(e);
        } finally {
            driver.close();
            button.sensitive = true;
            button.label = label;
        }
    }

    _drop(id) {
        this._save(this._tvs().filter(t => t.id !== id));
        Secrets.clear(secretService(id)).catch(logError);
        setSkipped(this._settings, [`tv:${id}`], true);
    }

    _entry(t) {
        return {
            kind: BRANDS[t.brand].title,
            name: t.name,
            model: t.model,
            ip: t.ip,
            mac: t.mac,
            saved: () => {
                const now = this._tvs().find(tv => sameTv(tv, t));
                return now ? `tv:${now.id}` : null;
            },
            adopt: async () => {
                setSkipped(this._settings, [`tv:${t.id}`], false);
                if (!this._tvs().some(tv => sameTv(tv, t)))
                    this._save([...this._tvs(), t]);
            },
            drop: () => {
                for (const tv of this._tvs().filter(each => sameTv(each, t)))
                    this._drop(tv.id);
                setSkipped(this._settings, [`tv:${t.id}`], true);
            },
        };
    }

    async _find(quiet = false, looking = null) {
        setSearching(this._searchButton, true);
        try {
            const found = tvsIn(await (looking ?? survey(3000)));
            const saved = this._tvs();
            const kept = saved.map(tv => {
                const now = found.find(t => sameTv(tv, t));
                return now ? {...tv, ip: now.ip, mac: tv.mac || now.mac, port: now.port ?? tv.port} : tv;
            });
            const skipped = skippedIn(this._settings, quiet);
            const added = [];
            for (const t of found) {
                if (!saved.some(tv => sameTv(tv, t)) && !added.some(tv => sameTv(tv, t)) && !skipped.has(`tv:${t.id}`))
                    added.push(t);
            }
            setSkipped(this._settings, added.map(t => `tv:${t.id}`), false);
            this._save([...kept, ...added]);
            if (quiet)
                return {added: added.length, found: found.map(t => this._entry(t))};
            if (found.length === 0)
                this._toast(_('No TV answered.'));
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
