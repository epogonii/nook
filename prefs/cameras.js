// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Secrets from '../lib/secrets.js';
import * as Tapo from '../lib/tapo.js';
import {CredentialRows, deviceCount, helpRow, renameButton, setGroupIcon, setSearching, setSkipped, skippedIn} from './common.js';
import {FoldGroup} from './fold.js';

const CAMERA_ACCOUNT_URL = 'https://www.tp-link.com/support/faq/2680/';

export const CamerasGroup = GObject.registerClass(
class CamerasGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Cameras'),
            description: _('Tapo and other ONVIF cameras on this network, watched and turned directly. A Tapo camera needs a camera account, which is not your TP-Link login; the same one on every camera is simplest. Any other camera takes its own login, under its row.'),
        });
        setGroupIcon(this, 'tapo');
        this._settings = settings;
        this._window = window;
        this._rows = [];
        this.add(helpRow(_('Make a camera account'),
            _('In the Tapo app: the camera, then Settings, Advanced Settings, Camera Account.'),
            CAMERA_ACCOUNT_URL));
        this._credentials = new CredentialRows(this, 'tapo', 'Nook: Tapo camera account',
            [_('Camera Account Login'), _('Camera Account Password')]);

        this.add(new Adw.ActionRow({
            title: _('Privacy mode, light, night vision and siren'),
            subtitle: _('These need your TP-Link account\'s password. The camera checks it itself; from here it never goes to TP-Link.'),
            subtitle_lines: 0,
        }));
        this._admin = new Adw.PasswordEntryRow({title: _('TP-Link Password'), show_apply_button: true});
        const forget = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Forget'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._admin.add_suffix(forget);
        const syncAdmin = async () => {
            const saved = await Secrets.lookup('tapo-admin');
            this._admin.title = saved ? _('TP-Link Password, saved') : _('TP-Link Password');
            forget.visible = Boolean(saved);
        };
        this._admin.connect('apply', () => {
            const password = this._admin.text;
            if (!password)
                return;
            Secrets.store('tapo-admin', 'Nook: TP-Link password for Tapo cameras', JSON.stringify({password}))
                .then(() => {
                    this._admin.text = '';
                    return syncAdmin();
                }).catch(logError);
        });
        forget.connect('clicked', () => Secrets.clear('tapo-admin').then(syncAdmin).catch(logError));
        this.add(this._admin);
        syncAdmin().catch(logError);

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('Cameras at another place, like a summer house, cannot be reached from here.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._handlers = ['tapo-cameras', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this.foldable(settings, 'accounts-tapo', () => deviceCount(this._cameras().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    reveal(did) {
        super.reveal();
        const row = did === 'admin' ? this._admin : this._byDid.get(did);
        if (row instanceof Adw.ExpanderRow)
            row.expanded = true;
        return row ?? this;
    }

    _cameras() {
        return Tapo.parseCameras(this._settings.get_string('tapo-cameras'));
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        this._byDid = new Map();
        const names = this._settings.get_value('names').deepUnpack();
        for (const camera of this._cameras()) {
            const own = names[`tapo:${camera.id}`];
            const tapo = Tapo.isTapo(camera);
            const title = GLib.markup_escape_text(own ?? camera.name, -1);
            const subtitle = GLib.markup_escape_text([own ? camera.name : null, tapo ? null : 'ONVIF', camera.model, camera.ip]
                .filter(Boolean).join(' · '), -1);
            const row = tapo ? new Adw.ActionRow({title, subtitle}) : new Adw.ExpanderRow({title, subtitle});
            if (!tapo) {
                new CredentialRows({add: each => row.add_row(each)}, `onvif:${camera.id}`, `Nook: ${camera.name} camera login`,
                    [_('Camera Login'), _('Camera Password')]);
            }
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(camera.id));
            this._byDid.set(`tapo:${camera.id}`, row);
            // An expander row puts each new suffix in front of the last.
            const suffixes = [renameButton(this._settings, `tapo:${camera.id}`, camera.name, this), remove];
            for (const suffix of tapo ? suffixes : suffixes.reverse())
                row.add_suffix(suffix);
            this._rows.push(row);
        }
        this._rows.push(this._search);
        for (const row of this._rows)
            this.add(row);
    }

    _save(cameras) {
        const json = JSON.stringify(cameras);
        if (json !== this._settings.get_string('tapo-cameras'))
            this._settings.set_string('tapo-cameras', json);
    }

    _drop(id) {
        this._save(this._cameras().filter(c => c.id !== id));
        Secrets.clear(`onvif:${id}`).catch(logError);
        setSkipped(this._settings, [`tapo:${id}`], true);
    }

    _entry(camera) {
        const did = `tapo:${camera.id}`;
        return {
            kind: Tapo.isTapo(camera) ? 'Tapo' : 'ONVIF',
            name: camera.name,
            model: camera.model,
            ip: camera.ip,
            saved: () => (this._cameras().some(c => c.id === camera.id) ? did : null),
            adopt: async () => {
                setSkipped(this._settings, [did], false);
                this._save([...this._cameras().filter(c => c.id !== camera.id), camera]);
            },
            drop: () => this._drop(camera.id),
        };
    }

    async _find(quiet = false) {
        setSearching(this._searchButton, true);
        try {
            const found = await Tapo.discover(3000);
            const cameras = this._cameras();
            const skipped = skippedIn(this._settings, quiet);
            const fresh = [];
            for (const camera of found) {
                const known = cameras.find(c => c.id === camera.id);
                if (known)
                    Object.assign(known, {ip: camera.ip, xaddr: camera.xaddr, model: known.model || camera.model});
                else if (!skipped.has(`tapo:${camera.id}`))
                    fresh.push(camera);
            }
            const added = fresh.length;
            setSkipped(this._settings, fresh.map(c => `tapo:${c.id}`), false);
            this._save([...cameras, ...fresh]);
            if (quiet)
                return {added, found: found.map(c => this._entry(c))};
            this._window.add_toast(new Adw.Toast({
                title: found.length === 0
                    ? _('No camera answered. A camera answers only once its camera account exists.')
                    : added > 0 ? _('Cameras added.') : _('Nothing new found.'),
                timeout: 6,
            }));
            return {added};
        } catch (e) {
            if (!quiet)
                this._window.add_toast(new Adw.Toast({title: e.message, timeout: 6}));
            if (!(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            setSearching(this._searchButton, false);
        }
    }
});
