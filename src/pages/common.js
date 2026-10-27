// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Glyphs from '../lib/glyphs.js';
import * as Electrolux from '../lib/electrolux.js';
import * as Hue from '../lib/hue.js';
import * as Lg from '../lib/lg.js';
import * as Melcloud from '../lib/melcloud.js';
import {CACHE_VERSION} from '../lib/mihome.js';
import * as Secrets from '../lib/secrets.js';
import * as SmartThings from '../lib/smartthings.js';
import {SpecError} from '../lib/spec-home.js';

// Xiaomi's QR image is 480 px; shown smaller, never upscaled, so phones can scan it.
export const QR_SIZE = 240;

// From the menu's cache; prefs never call the cloud. Empty until the menu is opened once.
export function cachedDevices(userId) {
    if (!userId)
        return [];
    const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'nook', `xiaomi-${userId}.json`]);
    try {
        const [, contents] = GLib.file_get_contents(path);
        const cached = JSON.parse(new TextDecoder().decode(contents));
        return cached?.version === CACHE_VERSION ? cached.devices ?? [] : [];
    } catch {
        return [];
    }
}

const GROUP_LOOKS = {
    find: ['search', [0.21, 0.52, 0.89]],
    mihome: ['home', [0.98, 0.45, 0.13]],
    ewelink: ['power', [0.32, 0.74, 0.58]],
    gree: Glyphs.kindOf('air-conditioner'),
    tapo: Glyphs.kindOf('camera'),
    cast: Glyphs.kindOf('speaker'),
    tv: Glyphs.kindOf(null, null, 'tv'),
    sonoff: Glyphs.kindOf(null, null, 'sonoff'),
    shelly: ['rocker', [0.16, 0.48, 0.78]],
    hue: Glyphs.kindOf('light'),
    hass: ['hub', [0.09, 0.74, 0.95]],
    homekit: ['home', [0.98, 0.62, 0.2]],
    smartlife: ['wifi', [1, 0.35, 0.2]],
    lg: ['aircon', [0.65, 0.0, 0.2]],
    smartthings: ['aircon', [0.08, 0.4, 0.75]],
    melcloud: ['aircon', [0.85, 0.12, 0.15]],
    electrolux: ['aircon', [0.0, 0.25, 0.5]],
};

function groupIcon(id) {
    const [glyph, [red, green, blue]] = GROUP_LOOKS[id];
    const area = new Gtk.DrawingArea({
        content_width: 24,
        content_height: 24,
        valign: Gtk.Align.CENTER,
    });
    area.set_draw_func((_area, cr, width, height) => {
        cr.setSourceRGBA(red, green, blue, 0.18);
        cr.arc(width / 2, height / 2, Math.min(width, height) / 2, 0, 2 * Math.PI);
        cr.fill();
        cr.translate(width / 2 - 7, height / 2 - 7);
        cr.scale(14 / 16, 14 / 16);
        cr.setSourceRGB(red, green, blue);
        Glyphs.draw(cr, glyph);
        cr.$dispose();
    });
    return area;
}

export function groupTitle(group, widget = group) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Gtk.Label && child.label === group.title)
            return child;
        const found = groupTitle(group, child);
        if (found)
            return found;
    }
    return null;
}

// Adw.PreferencesGroup has no slot for a title icon, so the title label is moved into a
// box with one. Falls back to header_suffix if libadwaita builds the header differently.
export function setGroupIcon(group, id) {
    const icon = groupIcon(id);
    const title = groupTitle(group);
    const column = title?.get_parent();
    if (column instanceof Gtk.Box) {
        const line = new Gtk.Box({spacing: 8});
        column.insert_child_after(line, title);
        column.remove(title);
        line.append(icon);
        line.append(title);
    } else if (!group.header_suffix) {
        group.header_suffix = icon;
    }
}

export function deviceCount(count) {
    return ngettext('%d device', '%d devices', count).format(count);
}

// As the shell shows them: only those of a bridge still in the list.
export function hueDevices(settings) {
    const bridges = new Set(Hue.parseBridges(settings.get_string('hue-bridges')).map(b => b.id));
    return Hue.parseDevices(settings.get_string('hue-devices')).filter(d => bridges.has(d.bridge));
}

function renameDevice(settings, did, name, parent) {
    const names = settings.get_value('names').deepUnpack();
    const entry = new Gtk.Entry({
        text: names[did] ?? '',
        placeholder_text: name,
        activates_default: true,
    });
    const dialog = new Adw.AlertDialog({
        heading: _('Rename'),
        body: _('A name for Nook only; the device and its app keep their own. Leave it empty to use that one.'),
        extra_child: entry,
        default_response: 'save',
        close_response: 'cancel',
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('save', _('Save'));
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.connect('response', (_dialog, response) => {
        if (response !== 'save')
            return;
        const next = {...settings.get_value('names').deepUnpack()};
        const own = entry.text.trim();
        if (own)
            next[did] = own;
        else
            delete next[did];
        settings.set_value('names', new GLib.Variant('a{ss}', next));
    });
    dialog.present(parent.get_root());
}

export function renameButton(settings, did, name, parent) {
    const button = new Gtk.Button({
        icon_name: 'document-edit-symbolic',
        tooltip_text: _('Rename'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', () => renameDevice(settings, did, name, parent));
    return button;
}

export function helpRow(title, subtitle, url) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true, subtitle_lines: 0});
    row.add_prefix(new Gtk.Image({icon_name: 'help-about-symbolic'}));
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(url, null));
    return row;
}

// Adw.Spinner is new in GNOME 47; GNOME 46 falls back to Gtk.Spinner.
export function setSearching(button, on) {
    button.sensitive = !on;
    if (!on) {
        button.label = _('Search');
        return;
    }
    const box = new Gtk.Box({spacing: 6});
    box.append(Adw.Spinner ? new Adw.Spinner() : new Gtk.Spinner({spinning: true}));
    box.append(new Gtk.Label({label: _('Searching…')}));
    button.child = box;
}

// Devices removed by hand stay out of Search Everything until added again.
export function setSkipped(settings, keys, on) {
    const now = settings.get_strv('find-skipped');
    const next = on ? [...new Set([...now, ...keys])] : now.filter(k => !keys.includes(k));
    if (next.length !== now.length)
        settings.set_strv('find-skipped', next);
}

// A device's own Search adds everything it finds; Search Everything (quiet) skips.
export function skippedIn(settings, quiet) {
    return new Set(quiet ? settings.get_strv('find-skipped') : []);
}

export function findScrolled(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Gtk.ScrolledWindow)
            return child;
        const inner = findScrolled(child);
        if (inner)
            return inner;
    }
    return null;
}

// SpecError codes in words; the rest as the device or service put it.
export function specTrouble(e) {
    switch (e instanceof SpecError ? e.code : null) {
    case 'address':
        return _('This is not an address Nook can use.');
    case 'notfound':
        return _('Home Assistant was not found at this address.');
    case 'nothue':
        return _('This is not a Hue bridge that Nook can use.');
    case 'busy':
        return _('The device is busy. Try again in a moment.');
    case 'unreachable':
        return _('The accessory cannot be reached.');
    case 'refused':
        return _('The device refused it.');
    case 'broken':
        return _('The device sent an answer Nook cannot read.');
    case 'pin':
        return _('The setup code is wrong.');
    case 'taken':
        return _('The accessory is in another home. Remove it from the Home app, or reset it, then pair again.');
    case 'backoff':
        return _('The accessory refuses pairing for a while after wrong codes. Wait, or restart it.');
    case 'full':
        return _('The accessory has as many owners as it can take.');
    case 'unpaired':
        return _('The device no longer knows Nook. Pair it again.');
    case 'certificate':
        return _('The bridge answered with another certificate. Pair it again if it was replaced.');
    case 'unauthorized':
        return _('Home Assistant refused the access token.');
    case 'tls':
        return _('The certificate of this Home Assistant is not trusted. Use its http:// address on this network, or give it a trusted certificate.');
    case 'timeout':
        return _('The device did not answer in time.');
    case 'closed':
        return _('The connection closed. Try again.');
    case 'expired':
        return _('The Smart Life login has expired.');
    default:
        return e.message;
    }
}

export class CredentialRows {
    constructor(group, service, label, [userTitle, passwordTitle], onSaved = null) {
        this._service = service;
        this._label = label;
        this._onSaved = onSaved;
        this.user = new Adw.EntryRow({title: userTitle});
        this.password = new Adw.PasswordEntryRow({title: passwordTitle});
        this.status = new Adw.ActionRow({title: _('Saved in the Keyring')});
        this._save = new Gtk.Button({label: _('Save'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
        this._save.connect('clicked', () => this._store().catch(e => this._failed(e)));
        this._forget = new Gtk.Button({label: _('Forget'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
        this._forget.connect('clicked', () => this._clear().catch(e => this._failed(e)));
        this.status.add_suffix(this._forget);
        this.status.add_suffix(this._save);
        for (const row of [this.user, this.password, this.status])
            group.add(row);
        this.sync().catch(e => this._failed(e));
    }

    _failed(e) {
        this.status.title = _('The keyring could not be used');
        this.status.subtitle = GLib.markup_escape_text(e.message, -1);
        if (!(e instanceof GLib.Error))
            logError(e);
    }

    async sync() {
        const saved = await Secrets.lookup(this._service);
        let user;
        try {
            user = saved ? JSON.parse(saved).user ?? '' : '';
        } catch {
            user = '';
        }
        this.user.text = user;
        this.password.text = '';
        this.status.title = saved ? _('Saved in the keyring') : _('Not saved yet');
        this.status.subtitle = saved ? _('Type a new password and save to change it.') : '';
        this._forget.visible = Boolean(saved);
    }

    async _store() {
        const user = this.user.text.trim();
        const password = this.password.text;
        if (!user || !password)
            return;
        await Secrets.store(this._service, this._label, JSON.stringify({user, password}));
        await this.sync();
        this._onSaved?.();
    }

    async _clear() {
        await Secrets.clear(this._service);
        await this.sync();
    }
}

export function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

export const CLOUD_AIRCONS = () => [
    {
        id: 'lg',
        title: _('LG ThinQ'),
        description: _('LG air conditioners in the LG ThinQ app, through LG’s ThinQ Connect service and a personal access token.'),
        help: [_('Create a Personal Access Token'),
            _('Sign in on LG’s site with your LG ThinQ account and create a token with the device permissions. Your country is its two-letter code, like DE or MD.'),
            Lg.TOKEN_URL],
        fields: [['token', _('Personal Access Token'), true], ['country', _('Country Code')]],
        module: Lg,
    },
    {
        id: 'smartthings',
        title: _('SmartThings'),
        description: _('Samsung air conditioners in the SmartThings app, through an app of your own: SmartThings’ personal tokens last only a day.'),
        help: [_('Make a SmartThings App'),
            _('With the SmartThings CLI, run smartthings apps:create, choose an OAuth-In App, give %s as the redirect URI and the scopes r:devices:* and x:devices:*, then copy its client ID and secret here.')
                .replace('%s', SmartThings.REDIRECT_URL),
            SmartThings.CLI_URL],
        fields: [['clientId', _('Client ID')], ['clientSecret', _('Client Secret'), true]],
        module: SmartThings,
    },
    {
        id: 'melcloud',
        title: _('MELCloud'),
        description: _('Mitsubishi Electric air conditioners in the MELCloud app, with its email and password. MELCloud Home is another service and not supported yet.'),
        help: null,
        fields: [['user', _('Email')], ['password', _('Password'), true]],
        module: Melcloud,
    },
    {
        id: 'electrolux',
        title: _('Electrolux'),
        description: _('Electrolux and AEG air conditioners in their apps, through the Electrolux Group developer API.'),
        help: [_('Get an API Key and Tokens'),
            _('Sign in on the Electrolux developer site with your Electrolux or AEG account, create an API key, then generate an access token and a refresh token.'),
            Electrolux.DASHBOARD_URL],
        fields: [['apiKey', _('API Key'), true], ['accessToken', _('Access Token'), true], ['refreshToken', _('Refresh Token'), true]],
        module: Electrolux,
    },
];
