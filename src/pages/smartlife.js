// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'gettext';

import {encode as encodeQr} from '../lib/qr.js';
import * as Secrets from '../lib/secrets.js';
import * as SmartLife from '../lib/smartlife.js';
import * as SmartLifeHome from '../lib/smartlife-home.js';
import {SpecError} from '../lib/spec-home.js';
import {QR_SIZE, deviceCount, setGroupIcon, specTrouble, wait} from './common.js';
import {FoldGroup} from './fold.js';

// White behind the code and a quiet zone of four modules, so it scans on a dark theme.
function qrArea(size) {
    const area = new Gtk.DrawingArea({content_width: size, content_height: size, halign: Gtk.Align.CENTER});
    area.modules = null;
    area.set_draw_func((_area, cr, width, height) => {
        const modules = area.modules;
        if (!modules) {
            cr.$dispose();
            return;
        }
        const count = modules.length + 8;
        const cell = Math.floor(Math.min(width, height) / count);
        const offset = [(width - cell * count) / 2, (height - cell * count) / 2];
        cr.setSourceRGB(1, 1, 1);
        cr.rectangle(offset[0], offset[1], cell * count, cell * count);
        cr.fill();
        cr.setSourceRGB(0, 0, 0);
        modules.forEach((row, r) => row.forEach((dark, c) => {
            if (dark)
                cr.rectangle(offset[0] + (c + 4) * cell, offset[1] + (r + 4) * cell, cell, cell);
        }));
        cr.fill();
        cr.$dispose();
    });
    return area;
}

export const SmartLifeGroup = GObject.registerClass(
class SmartLifeGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Smart Life'),
            description: _('Devices in a Smart Life or Tuya Smart account, signed in the way Home Assistant does it: with the user code from the app and a QR code scanned with it.'),
        });
        setGroupIcon(this, 'smartlife');
        this._settings = settings;
        this._window = window;
        this._cancellable = null;
        this._loggedIn = false;
        this._busy = false;
        this._closed = false;

        this._code = new Adw.EntryRow({title: _('User Code')});
        this.add(new Adw.ActionRow({
            title: _('Where the User Code Is'),
            subtitle: _('In the Smart Life app: Me, the gear at the top, Account and Security, User Code.'),
            subtitle_lines: 0,
        }));
        this.add(this._code);

        this._row = new Adw.ActionRow({title: _('Account')});
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

        this._picture = qrArea(QR_SIZE);
        this._qr = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 18, visible: false});
        this._qr.append(this._picture);
        this._qr.append(new Gtk.Label({
            label: _('Open Smart Life on the phone, tap + on the Home tab, then Scan, point it at this code and confirm the login.'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ['dim-label'],
        }));
        this.add(this._qr);

        window.connect('close-request', () => {
            this._closed = true;
            this._cancellable?.cancel();
            return false;
        });
        this._handlers = ['smartlife-devices'].map(key => settings.connect(`changed::${key}`, () => this._sync().catch(logError)));
        this._sync().catch(logError);
        this.foldable(settings, 'accounts-smartlife', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _devices() {
        return SmartLifeHome.parseDevices(this._settings.get_string('smartlife-devices'));
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 6}));
    }

    // The keyring is authoritative; smartlife-user only signals the shell, so resync it.
    async _sync() {
        const account = await SmartLife.savedAccount();
        if (this._closed)
            return;
        this._loggedIn = Boolean(account);
        const user = account?.uid ?? '';
        if (this._settings.get_string('smartlife-user') !== user)
            this._settings.set_string('smartlife-user', user);
        if (account?.userCode && !this._code.text)
            this._code.text = account.userCode;
        this._row.subtitle = this._loggedIn ? deviceCount(this._devices().length) : _('Not logged in');
        if (!this._cancellable) {
            this._button.label = this._loggedIn ? _('Log Out') : _('Log In');
            this._button.css_classes = [this._loggedIn ? 'destructive-action' : 'suggested-action'];
        }
        this._button.sensitive = !this._busy;
        this._update.visible = this._loggedIn;
        this._update.sensitive = !this._busy;
        this._code.sensitive = !this._loggedIn && !this._cancellable;
    }

    async _onButton() {
        if (this._cancellable) {
            this._cancellable.cancel();
            return;
        }
        if (this._loggedIn) {
            const cloud = await SmartLife.SmartLifeCloud.load();
            await cloud?.logOut().catch(e => console.debug(`nook: Smart Life logout: ${e.message}`));
            cloud?.abort();
            await Secrets.clear(SmartLife.SECRET);
            await this._sync();
            return;
        }
        await this._logIn();
    }

    async _logIn() {
        const userCode = this._code.text.trim();
        if (!userCode) {
            this._toast(_('Type in the user code from the Smart Life app first.'));
            return;
        }
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._button.label = _('Cancel');
        this._button.css_classes = [];
        this._code.sensitive = false;
        let saved = false;
        try {
            const {token, text} = await SmartLife.startLogin(userCode, cancellable);
            this._picture.modules = encodeQr(text);
            this._picture.queue_draw();
            this._qr.visible = true;
            let account = null;
            const until = Date.now() + 5 * 60 * 1000;
            while (!account && Date.now() < until && !cancellable.is_cancelled()) {
                await wait(2000);
                if (!cancellable.is_cancelled())
                    account = await SmartLife.loginResult(token, userCode, cancellable);
            }
            if (account) {
                await SmartLife.storeAccount(account);
                saved = true;
            } else if (!cancellable.is_cancelled()) {
                this._toast(_('The QR code was not scanned in time. Log in again for a new one.'));
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                    logError(e);
                this._toast(specTrouble(e));
            }
        } finally {
            this._cancellable = null;
            if (!this._closed) {
                this._qr.visible = false;
                this._picture.modules = null;
            }
        }
        if (this._closed)
            return;
        await this._sync();
        if (saved)
            await this._read();
    }

    async _read() {
        if (this._busy)
            return;
        const cloud = await SmartLife.SmartLifeCloud.load();
        if (!cloud)
            return;
        cloud.onRefresh = account => SmartLife.storeAccount(account).catch(logError);
        this._busy = true;
        await this._sync();
        try {
            const entries = [];
            for (const home of await cloud.homes()) {
                for (const item of await cloud.homeDevices(home.ownerId ?? home.homeId)) {
                    const [specification, room] = await Promise.all([
                        cloud.specifications(item.id),
                        cloud.room(item.id).catch(() => null),
                    ]);
                    entries.push(...SmartLifeHome.savedDevices(item, specification, room));
                }
            }
            const json = JSON.stringify(entries);
            if (json !== this._settings.get_string('smartlife-devices'))
                this._settings.set_string('smartlife-devices', json);
            this._toast(ngettext('%d device from Smart Life.', '%d devices from Smart Life.', entries.length).format(entries.length));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            cloud.abort();
            this._busy = false;
        }
        if (!this._closed)
            await this._sync();
    }
});
