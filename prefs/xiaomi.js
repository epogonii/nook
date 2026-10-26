// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Secrets from '../lib/secrets.js';
import {XiaomiCloud, XiaomiError} from '../lib/xiaomi.js';
import {QR_SIZE, setGroupIcon} from './common.js';
import {FoldGroup} from './fold.js';

const SECRET_LABEL = 'Nook: Xiaomi account';

export const XiaomiGroup = GObject.registerClass(
class XiaomiGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Mi Home'),
            description: _('Xiaomi devices and everything else added to the Mi Home app.'),
        });
        setGroupIcon(this, 'mihome');
        this._settings = settings;
        this._window = window;
        this._cancellable = null;
        this._loggedIn = false;
        this._closed = false;

        this._row = new Adw.ActionRow({title: _('Account')});
        this._button = new Gtk.Button({valign: Gtk.Align.CENTER});
        this._button.connect('clicked', () => this._onButton().catch(logError));
        this._row.add_suffix(this._button);
        this.add(this._row);

        this._code = new Gtk.Picture({
            width_request: QR_SIZE,
            height_request: QR_SIZE,
            alternative_text: _('A QR code to scan with Mi Home'),
        });
        this._qr = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            visible: false,
        });
        this._qr.append(new Adw.Clamp({maximum_size: QR_SIZE, child: this._code}));
        this._qr.append(new Gtk.Label({
            label: _('Open Mi Home on your phone, tap the scan icon on the Profile tab and point it at this code.'),
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
        this._sync().catch(logError);
        this.foldable(settings, 'accounts-mihome');
    }

    // The keyring is authoritative; xiaomi-user-id only signals the shell, so resync it.
    async _sync() {
        const saved = await Secrets.lookup('xiaomi');
        const userId = saved ? String(JSON.parse(saved).userId ?? '') : '';
        this._loggedIn = Boolean(saved);
        if (this._settings.get_string('xiaomi-user-id') !== userId)
            this._settings.set_string('xiaomi-user-id', userId);

        this._row.subtitle = this._loggedIn
            ? _('Logged in as %s').replace('%s', userId)
            : _('Not logged in');
        this._button.label = this._loggedIn ? _('Log Out') : _('Log In');
        this._button.css_classes = [this._loggedIn ? 'destructive-action' : 'suggested-action'];
        this._button.sensitive = true;
    }

    async _onButton() {
        if (this._cancellable) {
            this._cancellable.cancel();
            return;
        }
        if (this._loggedIn) {
            await Secrets.clear('xiaomi');
            await this._sync();
            return;
        }
        await this._logIn();
    }

    async _logIn() {
        const cancellable = this._cancellable = new Gio.Cancellable();
        const cloud = new XiaomiCloud({});
        // abort() also stops startQrLogin() and downloadQr(), which take no cancellable.
        cancellable.connect(() => cloud.abort());
        this._button.label = _('Cancel');
        this._button.css_classes = [];
        try {
            const {imageUrl, wait} = await cloud.startQrLogin();
            const bytes = await cloud.downloadQr(imageUrl);
            this._code.paintable = Gdk.Texture.new_from_bytes(bytes);
            this._qr.visible = true;

            await wait(cancellable);
            if (!cancellable.is_cancelled())
                await Secrets.store('xiaomi', SECRET_LABEL, JSON.stringify(cloud.credentials));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                if (!(e instanceof XiaomiError))
                    logError(e);
                this._window.add_toast(new Adw.Toast({title: e.message, timeout: 6}));
            }
        } finally {
            cloud.abort();
            this._cancellable = null;
            if (!this._closed) {
                this._qr.visible = false;
                this._code.paintable = null;
            }
        }
        if (!this._closed)
            await this._sync();
    }
});
