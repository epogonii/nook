// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

import * as Qr from './lib/qr.js';

export const PROJECT_URL = 'https://github.com/epogonii/nook';
export const ISSUES_URL = 'https://github.com/epogonii/nook/issues';
export const FEATURE_URL = 'https://github.com/epogonii/nook/issues/new?labels=enhancement';
const SPONSORS_URL = 'https://github.com/sponsors/epogonii';
const PAYPAL_URL = 'https://www.paypal.com/paypalme/pogonii';

const WALLETS = [
    ['Bitcoin', 'bc1qe6fjj3uv23e2yx2ry3wwhyrl7s2pqshau7mga3'],
    ['Ethereum', '0xDC9e1EfA0F8FAE71377F4018d4ff7D123369438e'],
    ['Solana', '3sYQyR27CVz1VcwCfoDLUioaAHk8jspQaSDHXEvBALxg'],
];

const QR_SIZE = 168;

function linkRow(title, subtitle, url) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(url, null));
    return row;
}

function qrCode() {
    let modules = null;
    const area = new Gtk.DrawingArea({
        content_width: QR_SIZE,
        content_height: QR_SIZE,
        halign: Gtk.Align.CENTER,
        css_classes: ['nook-qr'],
    });
    area.set_draw_func((_area, cr, width, height) => {
        if (!modules)
            return;
        const cell = Math.floor(Math.min(width, height) / modules.length);
        const left = Math.floor((width - cell * modules.length) / 2);
        const top = Math.floor((height - cell * modules.length) / 2);
        cr.setSourceRGB(0, 0, 0);
        modules.forEach((row, r) => row.forEach((dark, c) => {
            if (dark)
                cr.rectangle(left + c * cell, top + r * cell, cell, cell);
        }));
        cr.fill();
        cr.$dispose();
    });
    area.setText = text => {
        modules = Qr.encode(text);
        area.queue_draw();
    };
    return area;
}

export const SupportDialog = GObject.registerClass(
class SupportDialog extends Adw.Dialog {
    _init() {
        super._init({title: _('Support Nook'), content_width: 460, content_height: 640});
        const page = new Adw.PreferencesPage();
        const intro = new Adw.PreferencesGroup({
            description: _('Nook is free and stays free. If it earned a coffee, this is where it goes.'),
        });
        intro.add(linkRow(_('GitHub Sponsors'), _('Monthly or one time'), SPONSORS_URL));
        intro.add(linkRow(_('PayPal'), PAYPAL_URL, PAYPAL_URL));
        page.add(intro);

        const crypto = new Adw.PreferencesGroup({title: _('Cryptocurrency')});
        const network = new Adw.ComboRow({title: _('Network'), model: Gtk.StringList.new(WALLETS.map(([name]) => name))});
        crypto.add(network);
        const address = new Adw.ActionRow({title: _('Address'), subtitle_selectable: true, subtitle_lines: 0});
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy the address'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        address.add_suffix(copy);
        crypto.add(address);
        const code = qrCode();
        code.margin_top = 18;
        crypto.add(code);
        page.add(crypto);

        const chosen = () => WALLETS[network.selected] ?? WALLETS[0];
        const show = () => {
            const [name, wallet] = chosen();
            address.subtitle = wallet;
            code.setText(wallet);
            code.update_property([Gtk.AccessibleProperty.LABEL], [_('The %s address as a QR code').replace('%s', name)]);
        };
        network.connect('notify::selected', show);
        show();
        copy.connect('clicked', () => {
            const [name, wallet] = chosen();
            Gdk.Display.get_default()?.get_clipboard().set(wallet);
            this._toasts.add_toast(new Adw.Toast({title: _('%s address copied').replace('%s', name), timeout: 4}));
        });

        this._toasts = new Adw.ToastOverlay({child: page});
        const view = new Adw.ToolbarView({content: this._toasts});
        view.add_top_bar(new Adw.HeaderBar());
        this.child = view;
    }
});

export function aboutDialog(version) {
    const about = new Adw.AboutDialog({
        application_name: _('Nook'),
        application_icon: 'io.github.epogonii.nook',
        developer_name: 'Evghenii Pogonii',
        version,
        website: PROJECT_URL,
        issue_url: ISSUES_URL,
        license_type: Gtk.License.GPL_2_0,
        comments: _('Your smart home on the GNOME desktop'),
    });
    about.add_link(_('Request a Feature'), FEATURE_URL);
    return about;
}
