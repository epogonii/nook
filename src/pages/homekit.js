// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as HomeKit from '../lib/homekit.js';
import * as Secrets from '../lib/secrets.js';
import {SpecError} from '../lib/spec-home.js';
import {deviceCount, setGroupIcon, setSearching, specTrouble} from './common.js';
import {FoldGroup} from './fold.js';

function askForCode(parent, heading, body) {
    return new Promise(resolve => {
        const entry = new Gtk.Entry({
            activates_default: true,
            placeholder_text: '123-45-678',
            input_purpose: Gtk.InputPurpose.DIGITS,
            max_length: 10,
        });
        const dialog = new Adw.AlertDialog({
            heading,
            body,
            extra_child: entry,
            default_response: 'pair',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('pair', _('Pair'));
        dialog.set_response_appearance('pair', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => resolve(response === 'pair' ? entry.text.trim() : null));
        dialog.present(parent.get_root());
    });
}

export const HomeKitGroup = GObject.registerClass(
class HomeKitGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('HomeKit'),
            description: _('HomeKit accessories on this network, paired with Nook by the setup code on the accessory or its box. An accessory has one owner: remove it from the Home app first, or reset it.'),
        });
        setGroupIcon(this, 'homekit');
        this._settings = settings;
        this._window = window;
        this._rows = [];
        this._found = [];
        this._busy = false;

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('An accessory answers while it is on; one in another home can only be paired once it is removed there.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._handlers = [settings.connect('changed::homekit-accessories', () => this._fill())];
        this._fill();
        this.foldable(settings, 'accounts-homekit', () => deviceCount(this._hosts().reduce((n, h) => n + h.accessories.length, 0)));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _hosts() {
        return HomeKit.parseHosts(this._settings.get_string('homekit-accessories'));
    }

    _save(hosts) {
        const json = JSON.stringify(hosts);
        if (json !== this._settings.get_string('homekit-accessories'))
            this._settings.set_string('homekit-accessories', json);
    }

    _keep(host) {
        const hosts = this._hosts();
        const index = hosts.findIndex(h => h.id === host.id);
        if (index >= 0)
            hosts[index] = {...hosts[index], ...host};
        else
            hosts.push(host);
        this._save(hosts);
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    _button(props, onClick) {
        const button = new Gtk.Button({valign: Gtk.Align.CENTER, ...props});
        button.connect('clicked', () => onClick(button));
        return button;
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const hosts = this._hosts();
        for (const host of hosts) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(host.name || host.id, -1),
                subtitle: GLib.markup_escape_text([host.model, host.ip, deviceCount(host.accessories.length)]
                    .filter(Boolean).join(' · '), -1),
            });
            row.add_suffix(this._button({icon_name: 'view-refresh-symbolic', tooltip_text: _('Read the List Again'), css_classes: ['flat']},
                button => this._update(host, button).catch(logError)));
            row.add_suffix(this._button({icon_name: 'user-trash-symbolic', tooltip_text: _('Remove'), css_classes: ['flat']},
                button => this._drop(host, button).catch(logError)));
            this._rows.push(row);
        }
        for (const found of this._found.filter(f => !hosts.some(h => h.id === f.id))) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(found.name, -1),
                subtitle: GLib.markup_escape_text([found.model, found.ip, found.unpaired ? null : _('In another home')]
                    .filter(Boolean).join(' · '), -1),
            });
            const pair = this._button({label: _('Pair'), css_classes: ['suggested-action'], sensitive: found.unpaired},
                () => this._pair(found).catch(logError));
            row.add_suffix(pair);
            this._rows.push(row);
        }
        this._rows.push(this._search);
        for (const row of this._rows)
            this.add(row);
    }

    async _credentials(host) {
        try {
            return JSON.parse(await Secrets.lookup(HomeKit.secretService(host.id)) ?? 'null');
        } catch {
            return null;
        }
    }

    async _pair(found) {
        if (this._busy)
            return;
        if (!found.unpaired) {
            this._toast(_('This accessory is in another home. Remove it from the Home app, or reset it, then search again.'));
            return;
        }
        const text = await askForCode(this, _('Pair with HomeKit'),
            _('Type in the eight-digit setup code on %s or its box.').format(found.name));
        if (text === null)
            return;
        const code = HomeKit.setupCode(text);
        if (!code) {
            this._toast(_('A setup code has eight digits, like 123-45-678.'));
            return;
        }
        this._busy = true;
        try {
            const credentials = await HomeKit.pair(found, code);
            try {
                await Secrets.store(HomeKit.secretService(found.id), `Nook: HomeKit ${found.name}`, JSON.stringify(credentials));
            } catch (e) {
                // Keys kept nowhere would leave the accessory owned by nobody: free it again.
                const freeing = new HomeKit.HapHost(found, credentials);
                try {
                    await freeing.unpair();
                } catch (again) {
                    console.debug(`nook: HomeKit unpair: ${again.message}`);
                } finally {
                    freeing.close();
                }
                throw e;
            }
            // Kept even if the list cannot be read now: the accessory is paired either way.
            const host = {id: found.id, name: found.name, ip: found.ip, port: found.port, model: found.model,
                category: found.category, config: found.config, ff: found.ff, accessories: []};
            this._keep(host);
            await this._update(host, null);
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            this._busy = false;
        }
    }

    async _update(host, button) {
        const credentials = await this._credentials(host);
        if (!credentials) {
            this._toast(_('Pair the accessory again: its keys are not in the keyring.'));
            return;
        }
        if (button)
            button.sensitive = false;
        const client = new HomeKit.HapHost(host, credentials);
        try {
            const accessories = HomeKit.savedAccessories(await client.accessories());
            if (!this._hosts().some(h => h.id === host.id))
                return;
            this._keep({id: host.id, accessories});
            this._toast(ngettext('%d HomeKit accessory.', '%d HomeKit accessories.', accessories.length).format(accessories.length));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            client.close();
            if (button)
                button.sensitive = true;
        }
    }

    // Tells the accessory to forget Nook, so another home can pair it; removed here either way.
    async _drop(host, button = null) {
        if (button)
            button.sensitive = false;
        const credentials = await this._credentials(host);
        let freed = !credentials;
        if (credentials) {
            const client = new HomeKit.HapHost(host, credentials);
            try {
                await client.unpair();
                freed = true;
            } catch (e) {
                console.debug(`nook: HomeKit unpair: ${e.message}`);
            } finally {
                client.close();
            }
        }
        await Secrets.clear(HomeKit.secretService(host.id)).catch(logError);
        this._save(this._hosts().filter(h => h.id !== host.id));
        if (!freed)
            this._toast(_('Removed. The accessory could not be reached to forget Nook; reset it before pairing it again.'));
    }

    _entry(found) {
        return {
            kind: 'HomeKit',
            name: found.name,
            model: found.model,
            ip: found.ip,
            saved: () => (this._hosts().some(h => h.id === found.id) ? `homekit:${found.id}` : null),
            adopt: () => this._pair(found),
            drop: () => {
                const host = this._hosts().find(h => h.id === found.id);
                return host ? this._drop(host) : null;
            },
        };
    }

    // Saved accessories get their new address; new ones need their code, so a quiet search only lists them.
    async _find(quiet = false, looking = null) {
        if (!quiet)
            setSearching(this._searchButton, true);
        try {
            const found = await HomeKit.discover(3000, looking);
            const hosts = this._hosts();
            let moved = false;
            for (const host of hosts) {
                const now = found.find(f => f.id === host.id);
                if (now && (now.ip !== host.ip || now.port !== host.port)) {
                    Object.assign(host, {ip: now.ip, port: now.port});
                    moved = true;
                }
            }
            if (moved)
                this._save(hosts);
            this._found = found;
            this._fill();
            const known = new Set(hosts.map(h => h.id));
            if (quiet)
                return {added: 0, found: found.filter(f => f.unpaired || known.has(f.id)).map(f => this._entry(f))};
            if (found.length === 0)
                this._toast(_('No HomeKit accessory answered.'));
            else if (!found.some(f => f.unpaired && !known.has(f.id)))
                this._toast(_('Nothing new to pair. An accessory in another home must be removed there first.'));
            return {added: 0};
        } catch (e) {
            if (!quiet)
                this._toast(specTrouble(e));
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            if (!quiet)
                setSearching(this._searchButton, false);
        }
    }
});
