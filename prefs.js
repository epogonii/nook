// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _, ngettext, pgettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {arrange, move} from './lib/arrange.js';
import * as Glyphs from './lib/glyphs.js';
import {discover as findSpeakers, parseSpeakers} from './lib/cast-home.js';
import {browse, survey} from './lib/finder.js';
import * as Ewelink from './lib/ewelink.js';
import * as EwelinkHome from './lib/ewelink-home.js';
import * as Gree from './lib/gree.js';
import * as Hass from './lib/hass.js';
import * as HomeKit from './lib/homekit.js';
import * as Hue from './lib/hue.js';
import {parseUnits} from './lib/gree-home.js';
import {CACHE_VERSION} from './lib/mihome.js';
import {encode as encodeQr} from './lib/qr.js';
import * as Secrets from './lib/secrets.js';
import * as SmartLife from './lib/smartlife.js';
import * as SmartLifeHome from './lib/smartlife-home.js';
import * as Sonoff from './lib/sonoff.js';
import {SpecError} from './lib/spec-home.js';
import * as Tapo from './lib/tapo.js';
import {BRANDS, TvError, keepSecret, parseTvs, secretService} from './lib/tv-home.js';
import {XiaomiCloud, XiaomiError} from './lib/xiaomi.js';

const SECRET_LABEL = 'Nook: Xiaomi account';

const PROJECT_URL = 'https://github.com/epogonii/nook';
const ISSUES_URL = 'https://github.com/epogonii/nook/issues';
const FEATURE_URL = 'https://github.com/epogonii/nook/issues/new?labels=enhancement';
const SPONSORS_URL = 'https://github.com/sponsors/epogonii';
const PAYPAL_URL = 'https://www.paypal.com/paypalme/pogonii';
const WALLETS = [
    ['Bitcoin', 'bc1qe6fjj3uv23e2yx2ry3wwhyrl7s2pqshau7mga3'],
    ['Ethereum', '0xDC9e1EfA0F8FAE71377F4018d4ff7D123369438e'],
    ['Solana', '3sYQyR27CVz1VcwCfoDLUioaAHk8jspQaSDHXEvBALxg'],
];

const QR_DIR = 'icons/qr';
const WALLET_QR_SIZE = 168;

const LOGO_FILE = 'icons/nook-logo.svg';
const LOGO_ANIMATION = 'icons/nook-logo-anim.svg';
const LOGO_SIZE = 96;

// Xiaomi's QR image is 480 px; shown smaller, never upscaled, so phones can scan it.
const QR_SIZE = 240;

// From the menu's cache; prefs never call the cloud. Empty until the menu is opened once.
function cachedDevices(userId) {
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
    hue: Glyphs.kindOf('light'),
    hass: ['hub', [0.09, 0.74, 0.95]],
    homekit: ['home', [0.98, 0.62, 0.2]],
    smartlife: ['wifi', [1, 0.35, 0.2]],
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

function groupTitle(group, widget = group) {
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
function setGroupIcon(group, id) {
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

function deviceCount(count) {
    return ngettext('%d device', '%d devices', count).format(count);
}

// As the shell shows them: only those of a bridge still in the list.
function hueDevices(settings) {
    const bridges = new Set(Hue.parseBridges(settings.get_string('hue-bridges')).map(b => b.id));
    return Hue.parseDevices(settings.get_string('hue-devices')).filter(d => bridges.has(d.bridge));
}

// Rows of a folded group are taken out rather than hidden: groups show and hide rows of
// their own, and unfolding would undo that.
const FoldGroup = GObject.registerClass(
class FoldGroup extends Adw.PreferencesGroup {
    _init(params) {
        super._init(params);
        this._children = [];
        this._folded = false;
    }

    add(child) {
        this._children.push(child);
        if (this._folded)
            this._describe();
        else
            super.add(child);
    }

    remove(child) {
        this._children = this._children.filter(c => c !== child);
        if (!this._folded)
            super.remove(child);
    }

    // Kept in folded-groups under id; summary() is the description while folded.
    foldable(settings, id, summary = () => null) {
        this._open = this.description;
        this._summary = summary;
        this._fold = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat', 'circular']});
        const toggle = () => {
            const folded = !this._folded;
            const others = settings.get_strv('folded-groups').filter(g => g !== id);
            settings.set_strv('folded-groups', folded ? [...others, id] : others);
            this._setFolded(folded);
        };
        this._fold.connect('clicked', toggle);
        this._unfold = () => {
            if (this._folded)
                toggle();
        };
        const title = groupTitle(this);
        if (title) {
            const click = new Gtk.GestureClick();
            click.connect('released', toggle);
            title.add_controller(click);
            title.set_cursor_from_name('pointer');
        }
        const suffix = this.header_suffix;
        if (suffix) {
            this.header_suffix = null;
            const box = new Gtk.Box({spacing: 6});
            box.append(suffix);
            box.append(this._fold);
            this.header_suffix = box;
        } else {
            this.header_suffix = this._fold;
        }
        this._setFolded(settings.get_strv('folded-groups').includes(id));
        return this._fold;
    }

    // The widget to scroll to for a device in this group; the group itself by default.
    reveal(_did) {
        this._unfold?.();
        return this;
    }

    _setFolded(folded) {
        this._fold.icon_name = folded ? 'pan-end-symbolic' : 'pan-down-symbolic';
        this._fold.tooltip_text = folded ? _('Expand') : _('Collapse');
        if (folded !== this._folded) {
            this._folded = folded;
            for (const child of this._children) {
                if (folded)
                    super.remove(child);
                else
                    super.add(child);
            }
        }
        this._describe();
    }

    _describe() {
        this.description = this._folded ? this._summary() : this._open;
    }
});

function iconToggle(icons, tooltip, active, onToggled) {
    const button = new Gtk.ToggleButton({
        icon_name: active ? icons[0] : icons[1],
        tooltip_text: tooltip,
        active,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('toggled', () => onToggled(button.active));
    return button;
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

function renameButton(settings, did, name, parent) {
    const button = new Gtk.Button({
        icon_name: 'document-edit-symbolic',
        tooltip_text: _('Rename'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', () => renameDevice(settings, did, name, parent));
    return button;
}

// Copies get fresh names: the shell's texture cache keys on the path.
const ICON_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'nook', 'icons']);

function glyphArea(name, size) {
    const area = new Gtk.DrawingArea({content_width: size, content_height: size, valign: Gtk.Align.CENTER});
    area.set_draw_func((_area, cr, width, height) => {
        const ink = area.get_color();
        cr.setSourceRGBA(ink.red, ink.green, ink.blue, ink.alpha);
        cr.scale(width / 16, height / 16);
        Glyphs.draw(cr, name);
        cr.$dispose();
    });
    return area;
}

function iconPreview(icon) {
    if (icon.startsWith('/'))
        return new Gtk.Image({gicon: new Gio.FileIcon({file: Gio.File.new_for_path(icon)}), pixel_size: 16});
    if (Glyphs.CHOICES.includes(icon))
        return glyphArea(icon, 16);
    return new Gtk.Image({icon_name: 'image-x-generic-symbolic'});
}

function setIcon(settings, did, icon) {
    const next = {...settings.get_value('icons').deepUnpack()};
    const old = next[did];
    if (icon)
        next[did] = icon;
    else
        delete next[did];
    settings.set_value('icons', new GLib.Variant('a{ss}', next));
    if (old?.startsWith(`${ICON_DIR}/`) && old !== icon)
        GLib.unlink(old);
}

function keepPicture(source) {
    GLib.mkdir_with_parents(ICON_DIR, 0o700);
    // St recolours an SVG only when its name ends in -symbolic.svg.
    const suffix = /(-symbolic)?\.[^./]+$/.exec(source.get_basename())?.[0] ?? '';
    const target = Gio.File.new_for_path(GLib.build_filenamev([ICON_DIR, `${GLib.uuid_string_random()}${suffix}`]));
    source.copy(target, Gio.FileCopyFlags.NONE, null, null);
    return target.get_path();
}

function choosePicture(settings, did, parent) {
    const filter = new Gtk.FileFilter({name: _('Images')});
    filter.add_pixbuf_formats();
    const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
    filters.append(filter);
    const dialog = new Gtk.FileDialog({title: _('Choose an Image'), filters, default_filter: filter});
    dialog.open(parent.get_root(), null, (_dialog, result) => {
        let file;
        try {
            file = dialog.open_finish(result);
        } catch {
            return;
        }
        try {
            setIcon(settings, did, keepPicture(file));
        } catch (e) {
            const alert = new Adw.AlertDialog({heading: _('Could Not Use the Image'), body: e.message});
            alert.add_response('close', _('Close'));
            alert.present(parent.get_root());
        }
    });
}

function chooseIcon(settings, did, parent) {
    const current = settings.get_value('icons').deepUnpack()[did] ?? '';
    const grid = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 6,
        max_children_per_line: 8,
        column_spacing: 4,
        row_spacing: 4,
    });
    const dialog = new Adw.AlertDialog({
        heading: _('Icon'),
        body: _('Pick one for the tile, or use an image of your own.'),
        extra_child: grid,
        close_response: 'cancel',
    });
    for (const name of Glyphs.CHOICES) {
        const button = new Gtk.ToggleButton({
            child: glyphArea(name, 20),
            active: name === current,
            css_classes: ['flat'],
        });
        button.connect('clicked', () => {
            setIcon(settings, did, name);
            dialog.close();
        });
        grid.append(button);
    }
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('default', _('Default'));
    dialog.add_response('file', _('Image…'));
    dialog.set_response_enabled('default', current !== '');
    dialog.connect('response', (_dialog, response) => {
        if (response === 'default')
            setIcon(settings, did, '');
        else if (response === 'file')
            choosePicture(settings, did, parent);
    });
    dialog.present(parent.get_root());
}

function iconButton(settings, did, parent) {
    const button = new Gtk.Button({
        child: iconPreview(settings.get_value('icons').deepUnpack()[did] ?? ''),
        tooltip_text: _('Icon'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', () => chooseIcon(settings, did, parent));
    return button;
}

const CAMERA_ACCOUNT_URL = 'https://www.tp-link.com/support/faq/2680/';
const EWELINK_DEV_URL = 'https://dev.ewelink.cc/';
const HASS_TOKEN_URL = 'https://www.home-assistant.io/docs/authentication/#your-account-profile';

function helpRow(title, subtitle, url) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true, subtitle_lines: 0});
    row.add_prefix(new Gtk.Image({icon_name: 'help-about-symbolic'}));
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(url, null));
    return row;
}

// Adw.Spinner is new in GNOME 47; GNOME 46 falls back to Gtk.Spinner.
function setSearching(button, on) {
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
function setSkipped(settings, keys, on) {
    const now = settings.get_strv('find-skipped');
    const next = on ? [...new Set([...now, ...keys])] : now.filter(k => !keys.includes(k));
    if (next.length !== now.length)
        settings.set_strv('find-skipped', next);
}

// A device's own Search adds everything it finds; Search Everything (quiet) skips.
function skippedIn(settings, quiet) {
    return new Set(quiet ? settings.get_strv('find-skipped') : []);
}

function findScrolled(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child instanceof Gtk.ScrolledWindow)
            return child;
        const inner = findScrolled(child);
        if (inner)
            return inner;
    }
    return null;
}

const DevicesPage = GObject.registerClass(
class DevicesPage extends Adw.PreferencesPage {
    _init(settings, find) {
        super._init({
            name: 'devices',
            title: _('Devices'),
            icon_name: 'view-grid-symbolic',
        });
        this._settings = settings;
        this._find = find;
        this.add(find);

        const bar = new FoldGroup({
            title: _('Top Bar'),
            description: _('Pin a device below with the button beside it, and its reading or state shows next to the icon.'),
        });
        const interval = new Adw.SpinRow({
            title: _('Read Every'),
            subtitle: _('Minutes. Each time is one small request to each account or device with a reading there, and none is made while the screen is locked.'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
        });
        interval.value = settings.get_uint('panel-interval');
        interval.connect('notify::value', () => settings.set_uint('panel-interval', interval.value));
        bar.add(interval);
        bar.foldable(settings, 'top-bar');
        this.add(bar);

        this._groups = [];
        this._focusables = new Map();
        this._handlers = ['pinned', 'order', 'hidden', 'panel-sensors', 'names', 'icons', 'xiaomi-user-id', 'gree-units', 'tapo-cameras', 'cast-speakers', 'tvs', 'sonoff-switches', 'ewelink-devices',
            'hue-bridges', 'hue-devices', 'hass-devices', 'homekit-accessories', 'smartlife-devices']
            .map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
        this._find.forget();
    }

    _list(key) {
        return this._settings.get_strv(key);
    }

    _toggle(key, did, on) {
        const list = this._list(key).filter(d => d !== did);
        this._settings.set_strv(key, on ? [...list, did] : list);
    }

    _fill() {
        const focused = this.get_root()?.get_focus() ?? null;
        const focusKey = [...this._focusables].find(([, widget]) => widget === focused)?.[0];
        const adjustment = findScrolled(this)?.vadjustment ?? null;
        const top = adjustment?.value ?? 0;
        this._focusables = new Map();
        this._build();
        if (focusKey)
            this._focusables.get(focusKey)?.grab_focus();
        if (adjustment) {
            // Relayout of the new rows scrolls the page again; restore once idle.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                adjustment.value = top;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _build() {
        for (const group of this._groups ?? [])
            this.remove(group);
        this._groups = [];

        const conditioners = parseUnits(this._settings.get_string('gree-units')).map(unit => ({
            did: `gree:${unit.mac}`,
            name: unit.name || unit.mac,
            room: unit.room ?? null,
            primary: {kind: 'climate', props: []},
        }));
        const cameras = Tapo.parseCameras(this._settings.get_string('tapo-cameras')).map(camera => ({
            did: `tapo:${camera.id}`,
            name: camera.name,
            room: camera.room ?? null,
            primary: {kind: 'camera', props: []},
        }));
        const speakers = parseSpeakers(this._settings.get_string('cast-speakers')).map(speaker => ({
            did: `cast:${speaker.id}`,
            name: speaker.name || speaker.model || speaker.id,
            room: speaker.room ?? null,
            primary: {kind: 'media', props: []},
        }));
        const tvs = parseTvs(this._settings.get_string('tvs')).map(tv => ({
            did: `tv:${tv.id}`,
            name: tv.name || tv.model || BRANDS[tv.brand].title,
            room: tv.room ?? null,
            primary: {kind: 'tv', props: []},
        }));
        const switches = Sonoff.parseSwitches(this._settings.get_string('sonoff-switches')).flatMap(unit =>
            Sonoff.channels(unit).map(({did, name}) => ({
                did,
                name,
                room: unit.room ?? null,
                primary: {kind: 'switch', props: []},
            })));
        const ewelink = EwelinkHome.parseDevices(this._settings.get_string('ewelink-devices')).flatMap(unit =>
            EwelinkHome.channels(unit).map(({did, name}) => ({
                did,
                name,
                room: unit.room ?? null,
                primary: {kind: 'switch', props: []},
            })));
        const hue = hueDevices(this._settings).map(entry => ({
            did: `hue:${entry.id}`,
            name: entry.name || entry.model || 'Hue',
            room: entry.room ?? null,
            primary: {kind: entry.kind === 'sensor' ? 'reading' : 'switch', props: []},
        }));
        const hass = Hass.parseDevices(this._settings.get_string('hass-devices')).map(entry => ({
            did: `hass:${entry.id}`,
            name: entry.name || entry.id,
            room: entry.room ?? null,
            primary: {kind: entry.type.endsWith('sensor') ? 'reading' : 'switch', props: []},
        }));
        const homekit = HomeKit.parseHosts(this._settings.get_string('homekit-accessories')).flatMap(host =>
            host.accessories.map(accessory => ({
                did: `homekit:${host.id}/${accessory.aid}`,
                name: accessory.name || host.name || 'HomeKit',
                room: null,
                primary: {kind: accessory.services.some(s => ['light', 'outlet', 'switch', 'fan', 'fan2', 'thermostat', 'heater-cooler', 'humidifier', 'purifier'].includes(s.kind)) ? 'switch' : 'reading', props: []},
            })));
        const smartlife = SmartLifeHome.parseDevices(this._settings.get_string('smartlife-devices')).map(entry => ({
            did: SmartLifeHome.didOf(entry),
            name: entry.name,
            room: entry.room ?? null,
            primary: {kind: SmartLifeHome.typeOf(entry).endsWith('sensor') ? 'reading' : 'switch', props: []},
        }));
        const devices = arrange([...cachedDevices(this._settings.get_string('xiaomi-user-id')), ...conditioners, ...cameras, ...speakers, ...tvs, ...switches, ...ewelink, ...hue, ...hass, ...homekit, ...smartlife], {
            pinned: this._list('pinned'),
            order: this._list('order'),
            hidden: this._list('hidden'),
        }, true);
        const help = _('Drag a row to move its tile. Pinned devices come first and have a tab of their own. The card a device opens in the menu can pin and hide it too.');
        if (devices.length === 0) {
            const group = new Adw.PreferencesGroup({title: _('Devices'), description: help});
            group.add(new Adw.ActionRow({
                title: _('No devices yet'),
                subtitle: _('Add an account on the Accounts page, then open the menu once.'),
            }));
            this.add(group);
            this._groups.push(group);
            return;
        }

        const sources = [
            ['mihome', _('Mi Home'), d => !d.did.includes(':')],
            ['gree', _('Air Conditioners'), d => d.did.startsWith('gree:')],
            ['tapo', _('Cameras'), d => d.did.startsWith('tapo:')],
            ['cast', _('Speakers'), d => d.did.startsWith('cast:')],
            ['tv', _('TVs'), d => d.did.startsWith('tv:')],
            ['sonoff', _('Sonoff'), d => d.did.startsWith('sonoff:')],
            ['ewelink', _('eWeLink'), d => d.did.startsWith('ewelink:')],
            ['hue', _('Philips Hue'), d => d.did.startsWith('hue:')],
            ['hass', _('Home Assistant'), d => d.did.startsWith('hass:')],
            ['homekit', _('HomeKit'), d => d.did.startsWith('homekit:')],
            ['smartlife', _('Smart Life'), d => d.did.startsWith('smartlife:')],
        ];
        const ids = devices.map(d => d.did);
        for (const [id, title, belongs] of sources) {
            const own = devices.filter(belongs);
            if (own.length === 0)
                continue;
            const group = new FoldGroup({title, description: this._groups.length === 0 ? help : null});
            setGroupIcon(group, id);
            for (const device of own)
                group.add(this._row(device, ids));
            this._focusables.set(`group ${id}`, group.foldable(this._settings, id, () => deviceCount(own.length)));
            this.add(group);
            this._groups.push(group);
        }
    }

    _names() {
        return this._settings.get_value('names').deepUnpack();
    }

    _row(device, ids) {
        const hidden = this._list('hidden').includes(device.did);
        const ownName = this._names()[device.did];
        const room = device.room ?? _('No room');
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(ownName ?? device.name, -1),
            subtitle: GLib.markup_escape_text(ownName ? `${room} · ${device.name}` : room, -1),
        });
        if (hidden)
            row.add_css_class('dim-label');
        row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic'}));

        const suffix = (key, widget) => {
            this._focusables.set(`${device.did} ${key}`, widget);
            row.add_suffix(widget);
        };
        suffix('panel', iconToggle(['nook-top-bar-symbolic', 'nook-top-bar-symbolic'], _('Show in the top bar'),
            this._list('panel-sensors').includes(device.did),
            on => this._toggle('panel-sensors', device.did, on)));
        suffix('pin', iconToggle(['starred-symbolic', 'non-starred-symbolic'], _('Pin'),
            this._list('pinned').includes(device.did),
            on => this._toggle('pinned', device.did, on)));
        suffix('hide', iconToggle(['view-conceal-symbolic', 'view-reveal-symbolic'], _('Hide from the menu'),
            hidden, on => this._toggle('hidden', device.did, on)));
        suffix('icon', iconButton(this._settings, device.did, this));
        suffix('rename', renameButton(this._settings, device.did, device.name, this));

        const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
        drag.connect('prepare', () => Gdk.ContentProvider.new_for_value(device.did));
        drag.connect('drag-begin', source => {
            source.set_icon(new Gtk.WidgetPaintable({widget: row}), 0, 0);
        });
        row.add_controller(drag);

        const drop = new Gtk.DropTarget({actions: Gdk.DragAction.MOVE});
        drop.set_gtypes([GObject.TYPE_STRING]);
        drop.connect('drop', (_target, moved, _x, y) => {
            if (!ids.includes(moved))
                return false;
            this._settings.set_strv('order', move(ids, moved, device.did, y > row.get_height() / 2));
            return true;
        });
        row.add_controller(drop);
        return row;
    }
});

const GreeGroup = GObject.registerClass(
class GreeGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Air Conditioners'),
            description: _('Gree units on this network, controlled directly: no account, no cloud.'),
        });
        setGroupIcon(this, 'gree');
        this._settings = settings;
        this._window = window;
        this._rows = [];

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('The unit has to be on and connected to the same Wi-Fi.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find('255.255.255.255').catch(logError));
        this._search.add_suffix(this._searchButton);

        this._address = new Adw.EntryRow({title: _('Add by Address'), show_apply_button: true});
        this._address.connect('apply', () => this._find(this._address.text.trim()).catch(logError));

        this._handlers = ['gree-units', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this.foldable(settings, 'accounts-gree', () => deviceCount(this._units().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _units() {
        return parseUnits(this._settings.get_string('gree-units'));
    }

    _save(units) {
        const json = JSON.stringify(units);
        if (json !== this._settings.get_string('gree-units'))
            this._settings.set_string('gree-units', json);
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const unit of this._units()) {
            const own = names[`gree:${unit.mac}`];
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? unit.name, -1),
                subtitle: GLib.markup_escape_text([own ? unit.name : null, unit.ip, unit.mac].filter(Boolean).join(' · '), -1),
            });
            row.add_suffix(renameButton(this._settings, `gree:${unit.mac}`, unit.name || unit.mac, this));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(unit.mac));
            row.add_suffix(remove);
            this._rows.push(row);
        }
        this._rows.push(this._search, this._address);
        for (const row of this._rows)
            this.add(row);
    }

    _toast(title) {
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
    }

    _drop(mac) {
        this._save(this._units().filter(u => u.mac !== mac));
        setSkipped(this._settings, [`gree:${mac}`], true);
    }

    async _bind(unit) {
        const device = new Gree.GreeDevice(unit);
        try {
            const {key, cipher} = await device.bind();
            return {mac: unit.mac, ip: unit.ip, name: unit.name, key, cipher, version: unit.version};
        } catch (e) {
            if (!(e instanceof Gree.GreeError) && !(e instanceof GLib.Error))
                throw e;
            this._toast(_('%s would not pair: %s').replace('%s', unit.name).replace('%s', e.message));
            return null;
        } finally {
            device.close();
        }
    }

    async _adopt(unit) {
        const bound = await this._bind(unit);
        if (!bound)
            return;
        setSkipped(this._settings, [`gree:${unit.mac}`], false);
        this._save([...this._units().filter(u => u.mac !== unit.mac), bound]);
    }

    _entry(unit) {
        const did = `gree:${unit.mac}`;
        return {
            kind: 'Gree',
            name: unit.name || unit.mac,
            ip: unit.ip,
            mac: unit.mac,
            saved: () => (this._units().some(u => u.mac === unit.mac) ? did : null),
            adopt: () => this._adopt(unit),
            drop: () => this._drop(unit.mac),
        };
    }

    async _find(address, quiet = false) {
        if (!address)
            return {added: 0};
        setSearching(this._searchButton, true);
        try {
            const found = await Gree.discover(address);
            const known = new Set(this._units().map(u => u.mac));
            const skipped = skippedIn(this._settings, quiet);
            const added = [];
            for (const unit of found.filter(u => !known.has(u.mac) && !skipped.has(`gree:${u.mac}`))) {
                const bound = await this._bind(unit);
                if (bound)
                    added.push(bound);
            }
            // Re-read after the awaits: another search may have added the same unit.
            const at = new Map(found.map(u => [u.mac, u.ip]));
            const units = this._units();
            const moved = units.some(u => at.has(u.mac) && at.get(u.mac) !== u.ip);
            const kept = units.map(u => (at.has(u.mac) ? {...u, ip: at.get(u.mac)} : u));
            const fresh = added.filter(u => !units.some(k => k.mac === u.mac));
            setSkipped(this._settings, fresh.map(u => `gree:${u.mac}`), false);
            if (fresh.length > 0 || moved)
                this._save([...kept, ...fresh]);
            if (quiet)
                return {added: fresh.length, found: found.map(u => this._entry(u))};
            if (found.length === 0)
                this._toast(_('No air conditioner answered.'));
            else if (fresh.length === 0)
                this._toast(_('Nothing new found.'));
            else
                this._address.text = '';
            return {added: fresh.length};
        } catch (e) {
            if (!quiet)
                this._toast(e.message);
            if (!(e instanceof Gree.GreeError) && !(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            setSearching(this._searchButton, false);
        }
    }
});

const SpeakersGroup = GObject.registerClass(
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
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
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

const SonoffGroup = GObject.registerClass(
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
        this._save(this._switches().filter(s => s.id !== id));
        setSkipped(this._settings, [`sonoff:${id}`], true);
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
            // Channels of a multi-channel switch are renamed on the Devices page.
            if (more.length === 0)
                row.add_suffix(renameButton(this._settings, first.did, name, this));
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
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
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

// SpecError codes in words; the rest as the device or service put it.
function specTrouble(e) {
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

const TvsGroup = GObject.registerClass(
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
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
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

class CredentialRows {
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
        let user = '';
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

const CamerasGroup = GObject.registerClass(
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
            this._window.add_toast?.(new Adw.Toast({
                title: found.length === 0
                    ? _('No camera answered. A camera answers only once its camera account exists.')
                    : added > 0 ? _('Cameras added.') : _('Nothing new found.'),
                timeout: 6,
            }));
            return {added};
        } catch (e) {
            if (!quiet)
                this._window.add_toast?.(new Adw.Toast({title: e.message, timeout: 6}));
            if (!(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            setSearching(this._searchButton, false);
        }
    }
});

function verdict(device, known) {
    if (known)
        return _('Already in Nook');
    if (device.kinds.includes('Mi Home'))
        return _('Comes with the Mi Home account');
    if (device.kinds.includes('eWeLink'))
        return _('With the eWeLink account, or in Sonoff DIY mode');
    if (device.kinds.includes('Philips Hue'))
        return _('Pair it under Philips Hue');
    if (device.kinds.includes('Home Assistant'))
        return _('Connect it under Home Assistant');
    if (device.kinds.includes('HomeKit'))
        return _('Pair it under HomeKit, once it is in no other home');
    return _('Not supported yet');
}

const FindGroup = GObject.registerClass(
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
            {name: _('Everything'), about: _('Gree, Cast, ONVIF, mDNS and UPnP. Nothing leaves this network, except eWeLink device IDs sent to the eWeLink account.')},
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
        this._handlers = ['names', 'xiaomi-user-id', 'gree-units', 'tapo-cameras', 'cast-speakers', 'tvs', 'sonoff-switches', 'ewelink-devices',
            'hue-bridges', 'homekit-accessories']
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
            this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
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
            ...Sonoff.parseSwitches(this._settings.get_string('sonoff-switches'))
                .map(t => ({did: Sonoff.channels(t)[0].did, name: t.name || t.id, ip: t.ip, mac: null})),
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

const EwelinkGroup = GObject.registerClass(
class EwelinkGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('eWeLink'),
            description: _('Sonoff and other eWeLink devices, through a free app of your own on eWeLink\'s developer site.'),
        });
        setGroupIcon(this, 'ewelink');
        this._settings = settings;
        this._window = window;
        this._cancellable = null;
        this._loggedIn = false;
        this._closed = false;
        this._rows = [];

        this.add(helpRow(_('Get an App ID and App Secret'),
            _('Sign up on the developer site, wait for the approval, then create an app there with the redirect URL %s and copy its two keys here.')
                .replace('%s', Ewelink.REDIRECT_URL),
            EWELINK_DEV_URL));
        new CredentialRows(this, 'ewelink-app', 'Nook: eWeLink app', [_('App ID'), _('App Secret')],
            () => this._sync().catch(logError));

        this._row = new Adw.ActionRow({title: _('Account')});
        this._button = new Gtk.Button({valign: Gtk.Align.CENTER});
        this._button.connect('clicked', () => this._onButton().catch(logError));
        this._row.add_suffix(this._button);
        this.add(this._row);

        this._entry = new Adw.EntryRow({title: _('Add by Device ID'), show_apply_button: true});
        this._entry.connect('apply', () => this._addById().catch(logError));

        window.connect('close-request', () => {
            this._closed = true;
            this._cancellable?.cancel();
            return false;
        });
        this._handlers = ['ewelink-devices', 'names'].map(key => settings.connect(`changed::${key}`, () => this._fill()));
        this._fill();
        this._sync().catch(logError);
        this.foldable(settings, 'accounts-ewelink', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _devices() {
        return EwelinkHome.parseDevices(this._settings.get_string('ewelink-devices'));
    }

    _save(devices) {
        const json = JSON.stringify(devices);
        if (json !== this._settings.get_string('ewelink-devices'))
            this._settings.set_string('ewelink-devices', json);
    }

    _fill() {
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const names = this._settings.get_value('names').deepUnpack();
        for (const unit of this._devices()) {
            const [first, ...more] = EwelinkHome.channels(unit);
            const own = more.length === 0 ? names[first.did] : null;
            const name = unit.name || unit.id;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(own ?? name, -1),
                subtitle: GLib.markup_escape_text([own ? name : null, unit.model,
                    more.length > 0 ? ngettext('%d channel', '%d channels', more.length + 1).format(more.length + 1) : null,
                    unit.id].filter(Boolean).join(' · '), -1),
            });
            // Channels of a multi-channel switch are renamed on the Devices page.
            if (more.length === 0)
                row.add_suffix(renameButton(this._settings, first.did, name, this));
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
        this._rows.push(this._entry);
        for (const row of this._rows)
            this.add(row);
    }

    _toast(title) {
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
    }

    async _sync() {
        const saved = await Ewelink.savedTokens();
        const app = await Ewelink.savedApp();
        if (this._closed)
            return;
        this._loggedIn = Boolean(saved);
        // The keyring is authoritative; ewelink-region only signals the shell, so resync it.
        const region = saved?.region ?? '';
        if (this._settings.get_string('ewelink-region') !== region)
            this._settings.set_string('ewelink-region', region);
        if (this._loggedIn)
            this._row.subtitle = _('Logged in, region %s').replace('%s', region);
        else
            this._row.subtitle = app ? _('Not logged in') : _('Save the app keys first');
        this._button.label = this._loggedIn ? _('Log Out') : _('Log In');
        this._button.css_classes = [this._loggedIn ? 'destructive-action' : 'suggested-action'];
        this._button.sensitive = this._loggedIn || Boolean(app);
        this._entry.sensitive = this._loggedIn;
    }

    async _onButton() {
        if (this._cancellable) {
            this._cancellable.cancel();
            return;
        }
        if (this._loggedIn) {
            // Revoke the token on the server too; the keyring is cleared either way.
            await this._withCloud(cloud => cloud.logOut()).catch(e => console.debug(`nook: eWeLink logout: ${e.message}`));
            await Secrets.clear('ewelink');
            await this._sync();
            return;
        }
        await this._logIn();
    }

    async _logIn() {
        const app = await Ewelink.savedApp();
        if (!app)
            return;
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._button.label = _('Cancel');
        this._button.css_classes = [];
        this._row.subtitle = _('Finish signing in in the browser.');
        let tokens = null;
        let reply = null;
        try {
            const state = Ewelink.newState();
            reply = Ewelink.waitForCode(state, cancellable);
            Gio.AppInfo.launch_default_for_uri(Ewelink.loginUrl(app, state), null);
            tokens = await Ewelink.getToken(app, await reply);
            await Ewelink.storeTokens(tokens);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                    logError(e);
                this._toast(e.message);
            }
        } finally {
            // Frees the redirect port when no browser came back to it.
            reply?.catch(() => {});
            cancellable.cancel();
            this._cancellable = null;
        }
        if (this._closed)
            return;
        await this._sync();
        if (tokens)
            await this._addListed();
    }

    async _withCloud(task) {
        const cloud = await Ewelink.EwelinkCloud.load();
        if (!cloud)
            return null;
        try {
            return await task(cloud);
        } finally {
            cloud.abort();
        }
    }

    // Saves the switches among the given devices; returns how many are new.
    async _merge(cloud, items) {
        const switches = items.filter(i => typeof i.params?.switch === 'string' || Array.isArray(i.params?.switches));
        if (switches.length === 0)
            return 0;
        const rooms = await cloud.rooms().catch(e => {
            console.debug(`nook: eWeLink rooms: ${e.message}`);
            return new Map();
        });
        const devices = this._devices();
        let added = 0;
        for (const item of switches) {
            const fresh = Ewelink.savedDevice(item, rooms);
            const index = devices.findIndex(d => d.id === fresh.id);
            if (index >= 0) {
                devices[index] = {...devices[index], ...fresh, room: fresh.room ?? devices[index].room};
            } else {
                devices.push(fresh);
                added++;
            }
        }
        this._save(devices);
        return added;
    }

    async _addListed() {
        try {
            const added = await this._withCloud(async cloud => this._merge(cloud, await cloud.listDevices()));
            this._toast(added > 0
                ? ngettext('%d eWeLink device added.', '%d eWeLink devices added.', added).format(added)
                : _('eWeLink lists no new devices for this app. Search on the Devices page, or add one by its Device ID from the eWeLink app.'));
        } catch (e) {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
        }
    }

    async _addById() {
        const id = this._entry.text.trim().toLowerCase();
        if (!/^[0-9a-f]{10}$/.test(id)) {
            this._toast(_('A Device ID is 10 letters and digits, like 1000a1b2c3, shown in the device settings of the eWeLink app.'));
            return;
        }
        this._entry.sensitive = false;
        try {
            const added = await this._withCloud(async cloud => {
                const items = await cloud.devicesById([id]);
                return items.length > 0 ? this._merge(cloud, items) : null;
            });
            if (added === null) {
                this._toast(_('This eWeLink account and app have no switch with that Device ID.'));
                return;
            }
            this._entry.text = '';
            this._toast(added > 0 ? _('Device added.') : _('Already in Nook'));
        } catch (e) {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
        } finally {
            this._entry.sensitive = this._loggedIn;
        }
    }

    _drop(id) {
        this._save(this._devices().filter(d => d.id !== id));
        setSkipped(this._settings, [`ewelink:${id}`], true);
    }

    async _adopt(id) {
        const added = await this._withCloud(async cloud => {
            const items = await cloud.devicesById([id]);
            return items.length > 0 ? this._merge(cloud, items) : null;
        }).catch(e => {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(e.message);
            return undefined;
        });
        if (added === undefined)
            return;
        if (!this._loggedIn)
            this._toast(_('Log in to eWeLink first.'));
        else if (!this._devices().some(d => d.id === id))
            this._toast(_('This eWeLink account and app have no switch with that Device ID.'));
        else
            setSkipped(this._settings, [`ewelink:${id}`], false);
    }

    _entry({ewelink: id, name, model, ip}) {
        return {
            kind: 'eWeLink',
            name,
            model,
            ip,
            saved: () => {
                const now = this._devices().find(d => d.id === id);
                return now ? EwelinkHome.channels(now)[0].did : null;
            },
            adopt: () => this._adopt(id),
            drop: () => this._drop(id),
        };
    }

    // For Find Devices: eWeLink devices that answered on this network, looked up by ID.
    async _find(quiet, looking) {
        try {
            const seen = (await looking).filter(d => d.ewelink);
            const found = seen.map(d => this._entry(d));
            const known = new Set(this._devices().map(d => d.id));
            const skipped = skippedIn(this._settings, quiet);
            const ids = [...new Set(seen.map(d => d.ewelink).filter(id => !known.has(id) && !skipped.has(`ewelink:${id}`)))];
            if (ids.length === 0)
                return {added: 0, found};
            const added = await this._withCloud(async cloud => this._merge(cloud, await cloud.devicesById(ids)));
            return {added: added ?? 0, found};
        } catch (e) {
            if (!(e instanceof Ewelink.EwelinkError) && !(e instanceof GLib.Error))
                logError(e);
            if (!quiet)
                this._toast(e.message);
            return {added: 0, failed: true};
        }
    }
});

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

// The first bytes of a fingerprint, enough to tell two apart by eye.
const shortPrint = print => (print ?? '').slice(0, 16).toUpperCase().match(/../g)?.join(':') ?? '?';

function askToTrust(parent, before, now) {
    return new Promise(resolve => {
        const dialog = new Adw.AlertDialog({
            heading: _('The Bridge Has a New Certificate'),
            body: _('The bridge answered with another certificate than the one Nook saw before. That is expected after it was replaced or reset; otherwise something on this network may be posing as it.\n\nBefore: %s\nNow: %s')
                .format(shortPrint(before), shortPrint(now)),
            default_response: 'cancel',
            close_response: 'cancel',
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('trust', _('Trust the New One'));
        dialog.set_response_appearance('trust', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => resolve(response === 'trust'));
        dialog.present(parent.get_root());
    });
}

// A dialog with only Cancel, shown while waiting on a device; cancels when closed.
function waitingDialog(parent, heading, body, cancellable) {
    const dialog = new Adw.AlertDialog({heading, body, close_response: 'cancel'});
    dialog.add_response('cancel', _('Cancel'));
    let open = true;
    dialog.connect('closed', () => {
        open = false;
        cancellable.cancel();
    });
    dialog.present(parent.get_root());
    return () => {
        if (open)
            dialog.force_close();
    };
}

const HueGroup = GObject.registerClass(
class HueGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Philips Hue'),
            description: _('Hue lights, plugs and sensors through a Hue Bridge on this network, without the cloud.'),
        });
        setGroupIcon(this, 'hue');
        this._settings = settings;
        this._window = window;
        this._rows = [];
        this._turn = 0;
        this._closed = false;
        this._pairing = null;

        this._search = new Adw.ActionRow({
            title: _('Find on This Network'),
            subtitle: _('A Hue Bridge answers on the network it is plugged into.'),
        });
        this._searchButton = new Gtk.Button({label: _('Search'), valign: Gtk.Align.CENTER});
        this._searchButton.connect('clicked', () => this._find().catch(logError));
        this._search.add_suffix(this._searchButton);

        this._entry = new Adw.EntryRow({title: _('Add by Address'), show_apply_button: true});
        this._entry.connect('apply', () => this._addByAddress().catch(logError));

        window.connect('close-request', () => {
            this._closed = true;
            this._pairing?.cancel();
            return false;
        });
        this._handlers = ['hue-bridges', 'hue-devices'].map(key => settings.connect(`changed::${key}`, () => this._fill().catch(logError)));
        this._fill().catch(logError);
        this.foldable(settings, 'accounts-hue', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
        this._turn++;
    }

    _bridges() {
        return Hue.parseBridges(this._settings.get_string('hue-bridges'));
    }

    _devices() {
        return hueDevices(this._settings);
    }

    _saveBridges(bridges) {
        const json = JSON.stringify(bridges);
        if (json !== this._settings.get_string('hue-bridges'))
            this._settings.set_string('hue-bridges', json);
    }

    _saveDevices(devices) {
        const json = JSON.stringify(devices);
        if (json !== this._settings.get_string('hue-devices'))
            this._settings.set_string('hue-devices', json);
    }

    _toast(title) {
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
    }

    async _fill() {
        const turn = ++this._turn;
        const bridges = this._bridges();
        const paired = await Promise.all(bridges.map(b => Secrets.lookup(Hue.secretService(b.id)).then(Boolean, () => false)));
        if (turn !== this._turn)
            return;
        for (const row of this._rows)
            this.remove(row);
        this._rows = [];
        const devices = this._devices();
        bridges.forEach((bridge, i) => {
            const count = devices.filter(d => d.bridge === bridge.id).length;
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(bridge.name || 'Hue Bridge', -1),
                subtitle: GLib.markup_escape_text([bridge.ip, paired[i] ? deviceCount(count) : _('Not paired')].join(' · '), -1),
            });
            if (paired[i]) {
                const update = new Gtk.Button({
                    icon_name: 'view-refresh-symbolic',
                    tooltip_text: _('Read the List Again'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                update.connect('clicked', () => this._update(bridge, update).catch(logError));
                row.add_suffix(update);
            }
            const pair = new Gtk.Button({
                label: paired[i] ? _('Pair Again') : _('Pair'),
                valign: Gtk.Align.CENTER,
                css_classes: paired[i] ? ['flat'] : ['suggested-action'],
            });
            pair.connect('clicked', () => this._pair(bridge, pair).catch(logError));
            row.add_suffix(pair);
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => this._drop(bridge.id));
            row.add_suffix(remove);
            this._rows.push(row);
        });
        this._rows.push(this._search, this._entry);
        for (const row of this._rows)
            this.add(row);
    }

    // Asks the bridge itself for its id; its certificate is pinned here.
    async _probe(ip) {
        const client = new Hue.HueBridge({ip});
        try {
            return {...await client.config(), ip};
        } finally {
            client.abort();
        }
    }

    _keep(found) {
        const bridges = this._bridges();
        const index = bridges.findIndex(b => b.id === found.id);
        const bridge = {...bridges[index], ...found};
        if (index >= 0)
            bridges[index] = bridge;
        else
            bridges.push(bridge);
        this._saveBridges(bridges);
        return bridge;
    }

    async _addByAddress() {
        const ip = this._entry.text.trim();
        if (!ip)
            return;
        this._entry.sensitive = false;
        try {
            const known = this._bridges();
            const found = await this._probe(ip);
            const before = known.find(b => b.id === found.id);
            if (before && before.fingerprint && before.fingerprint !== found.fingerprint) {
                this._toast(_('This bridge answered with another certificate than before. Remove it first to add it again.'));
                return;
            }
            const bridge = this._keep({...found, fingerprint: before?.fingerprint ?? found.fingerprint});
            this._entry.text = '';
            if (!before)
                await this._pair(bridge, null);
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            this._entry.sensitive = true;
        }
    }

    // Another certificate than the pinned one is let in only when the user says so: a
    // replaced or reset bridge has a new one, and so would something posing as it.
    async _pair(bridge, button) {
        if (this._pairing)
            return;
        const cancellable = this._pairing = new Gio.Cancellable();
        let client = new Hue.HueBridge(bridge);
        let close = () => {};
        if (button)
            button.sensitive = false;
        try {
            let config;
            try {
                config = await client.config();
            } catch (e) {
                if (e.code !== 'certificate')
                    throw e;
                const offered = client.offered;
                client.abort();
                if (!await askToTrust(this, bridge.fingerprint, offered))
                    return;
                client = new Hue.HueBridge({ip: bridge.ip, fingerprint: offered});
                config = await client.config();
            }
            if (config.id !== bridge.id)
                throw new SpecError(_('Another bridge answers at this address now. Search again.'));
            const paired = client;
            cancellable.connect(() => paired.abort());
            close = waitingDialog(this, _('Press the Link Button'),
                _('Press the round button on the Hue Bridge. Nook keeps asking the bridge for a minute.'), cancellable);
            let key = null;
            const until = Date.now() + 60 * 1000;
            while (!key && !cancellable.is_cancelled() && Date.now() < until) {
                key = await client.pair(Hue.pairingName());
                if (!key)
                    await wait(2000);
            }
            if (!key) {
                if (!cancellable.is_cancelled())
                    this._toast(_('The link button was not pressed in time.'));
                return;
            }
            if (!this._bridges().some(b => b.id === bridge.id))
                return;
            await Secrets.store(Hue.secretService(bridge.id), `Nook: Hue Bridge ${bridge.name ?? bridge.id}`, JSON.stringify({key}));
            // paired changes hue-bridges even when nothing else did, so the shell reloads with the new key.
            const pinned = {...bridge, fingerprint: client.fingerprint, paired: Date.now()};
            this._keep(pinned);
            close();
            await this._update(pinned, null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                    logError(e);
                this._toast(specTrouble(e));
            }
        } finally {
            this._pairing = null;
            client.abort();
            if (!this._closed)
                close();
            if (button)
                button.sensitive = true;
        }
        if (!this._closed)
            await this._fill();
    }

    async _client(bridge) {
        const saved = await Secrets.lookup(Hue.secretService(bridge.id));
        const key = saved ? JSON.parse(saved).key : null;
        if (!key)
            throw new SpecError(_('Pair the bridge first.'));
        return new Hue.HueBridge(bridge, key);
    }

    async _update(bridge, button) {
        if (button)
            button.sensitive = false;
        const client = await this._client(bridge).catch(e => {
            this._toast(specTrouble(e));
            return null;
        });
        if (!client) {
            if (button)
                button.sensitive = true;
            return;
        }
        try {
            const fresh = Hue.savedDevices(bridge.id, await client.resources());
            if (!this._bridges().some(b => b.id === bridge.id))
                return;
            this._saveDevices([...Hue.parseDevices(this._settings.get_string('hue-devices')).filter(d => d.bridge !== bridge.id), ...fresh]);
            this._toast(ngettext('%d Hue device.', '%d Hue devices.', fresh.length).format(fresh.length));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            client.abort();
            if (button)
                button.sensitive = true;
        }
    }

    _drop(id) {
        this._saveDevices(Hue.parseDevices(this._settings.get_string('hue-devices')).filter(d => d.bridge !== id));
        this._saveBridges(this._bridges().filter(b => b.id !== id));
        Secrets.clear(Hue.secretService(id)).catch(logError);
    }

    _entryFor(found) {
        return {
            kind: 'Philips Hue',
            name: found.name,
            model: found.model,
            ip: found.ip,
            saved: () => (this._bridges().some(b => b.id === found.id) ? `hue:${found.id}` : null),
            adopt: async () => {
                try {
                    const bridge = this._bridges().find(b => b.id === found.id) ?? this._keep(await this._probe(found.ip));
                    await this._pair(bridge, null);
                } catch (e) {
                    if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                        logError(e);
                    this._toast(specTrouble(e));
                }
            },
            drop: () => this._drop(found.id),
        };
    }

    // Known bridges get their new address; new ones need the link button, so a quiet
    // search only lists them.
    async _find(quiet = false, looking = null) {
        if (!quiet)
            setSearching(this._searchButton, true);
        let single = null;
        try {
            const found = await Hue.discover(3000, looking);
            const bridges = this._bridges();
            let moved = false;
            for (const bridge of bridges) {
                const now = found.find(b => b.id === bridge.id);
                if (now && now.ip !== bridge.ip) {
                    bridge.ip = now.ip;
                    moved = true;
                }
            }
            if (moved)
                this._saveBridges(bridges);
            if (quiet)
                return {added: 0, found: found.map(b => this._entryFor(b))};
            const fresh = found.filter(b => !bridges.some(known => known.id === b.id));
            if (found.length === 0)
                this._toast(_('No Hue Bridge answered. Add it by its address if the network hides it.'));
            else if (fresh.length === 0)
                this._toast(_('Nothing new found.'));
            for (const each of fresh) {
                const bridge = this._keep(await this._probe(each.ip));
                if (fresh.length === 1)
                    single = bridge;
            }
            if (fresh.length > 1)
                this._toast(_('Pair each new bridge with the button beside it.'));
            return {added: fresh.length};
        } catch (e) {
            if (!quiet)
                this._toast(specTrouble(e));
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            return {added: 0, failed: true};
        } finally {
            if (!quiet)
                setSearching(this._searchButton, false);
            if (single)
                this._pair(single, null).catch(logError);
        }
    }
});

const HassGroup = GObject.registerClass(
class HassGroup extends FoldGroup {
    _init(settings, window) {
        super._init({
            title: _('Home Assistant'),
            description: _('Lights, switches, climate, covers and sensors of a Home Assistant server, through an access token of your own.'),
        });
        setGroupIcon(this, 'hass');
        this._settings = settings;
        this._window = window;
        this._connected = false;
        this._busy = false;
        this._closed = false;

        this.add(helpRow(_('Create an Access Token'),
            _('In Home Assistant, open your profile, then Security, and create a long-lived access token at the bottom of the page.'),
            HASS_TOKEN_URL));
        this._address = new Adw.EntryRow({title: _('Address, like http://homeassistant.local:8123')});
        this._token = new Adw.PasswordEntryRow({title: _('Access Token')});
        this.add(this._address);
        this.add(this._token);

        this._row = new Adw.ActionRow({title: _('Server')});
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

        window.connect('close-request', () => {
            this._closed = true;
            return false;
        });
        this._handlers = ['hass-devices', 'hass-server'].map(key => settings.connect(`changed::${key}`, () => this._sync().catch(logError)));
        this._sync().then(() => this._suggest()).catch(logError);
        this.foldable(settings, 'accounts-hass', () => deviceCount(this._devices().length));
    }

    forget() {
        for (const id of this._handlers)
            this._settings.disconnect(id);
        this._handlers = [];
    }

    _devices() {
        return Hass.parseDevices(this._settings.get_string('hass-devices'));
    }

    _toast(title) {
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
    }

    async _account() {
        const saved = await Secrets.lookup(Hass.SECRET);
        try {
            return saved ? JSON.parse(saved) : null;
        } catch {
            return null;
        }
    }

    // The keyring is authoritative; hass-server only signals the shell, so resync it.
    async _sync() {
        const account = await this._account();
        if (this._closed)
            return;
        this._connected = Boolean(account?.url && account?.token);
        const url = this._connected ? account.url : '';
        if (this._settings.get_string('hass-server') !== url)
            this._settings.set_string('hass-server', url);
        if (this._connected)
            this._address.text = url;
        this._row.subtitle = this._connected
            ? GLib.markup_escape_text(`${url} · ${deviceCount(this._devices().length)}`, -1)
            : _('Not connected');
        this._button.label = this._connected ? _('Disconnect') : _('Connect');
        this._button.css_classes = [this._connected ? 'destructive-action' : 'suggested-action'];
        this._button.sensitive = !this._busy;
        this._update.visible = this._connected;
        this._update.sensitive = !this._busy;
        this._address.sensitive = !this._connected && !this._busy;
        this._token.visible = !this._connected;
    }

    // Fills in the address of a server that announces itself on this network.
    async _suggest() {
        if (this._connected || this._address.text)
            return;
        const [found] = await browse(3000, ['_home-assistant._tcp']);
        if (!found || this._closed || this._connected || this._address.text)
            return;
        this._address.text = found.txt.internal_url || found.txt.base_url || `http://${found.ip}:${found.port}`;
    }

    async _onButton() {
        if (this._connected) {
            await Secrets.clear(Hass.SECRET);
            await this._sync();
            return;
        }
        const url = Hass.serverUrl(this._address.text);
        const token = this._token.text.trim();
        if (!url) {
            this._toast(_('Type the address of Home Assistant first.'));
            return;
        }
        if (!token) {
            this._toast(_('Paste an access token first.'));
            return;
        }
        await this._read({url, token});
    }

    // Connects with the given account, or the saved one, and saves what it reads.
    async _read(given = null) {
        if (this._busy)
            return;
        const account = given ?? await this._account();
        if (!account)
            return;
        this._busy = true;
        await this._sync();
        const client = new Hass.HassClient(account.url, account.token);
        try {
            await client.connect();
            const devices = Hass.savedDevices(await Hass.readHome(client));
            if (given)
                await Secrets.store(Hass.SECRET, 'Nook: Home Assistant', JSON.stringify(account));
            const json = JSON.stringify(devices);
            if (json !== this._settings.get_string('hass-devices'))
                this._settings.set_string('hass-devices', json);
            if (given)
                this._token.text = '';
            this._toast(ngettext('%d device from Home Assistant.', '%d devices from Home Assistant.', devices.length)
                .format(devices.length));
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                logError(e);
            this._toast(specTrouble(e));
        } finally {
            client.close();
            this._busy = false;
        }
        if (!this._closed)
            await this._sync();
    }
});

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

const HomeKitGroup = GObject.registerClass(
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
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
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

const SmartLifeGroup = GObject.registerClass(
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
        this._window.add_toast?.(new Adw.Toast({title, timeout: 6}));
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

const XiaomiGroup = GObject.registerClass(
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
                this._window.add_toast?.(new Adw.Toast({title: e.message, timeout: 6}));
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

export default class NookPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const icons = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (!icons.get_search_path().includes(`${this.path}/icons`))
            icons.add_search_path(`${this.path}/icons`);

        const look = new Adw.PreferencesPage({
            name: 'appearance',
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        look.add(this._placementGroup(settings));
        look.add(this._appearanceGroup(settings));
        look.add(this._roomTabsGroup(settings));
        window.add(look);

        const gree = new GreeGroup(settings, window);
        const cameras = new CamerasGroup(settings, window);
        const speakers = new SpeakersGroup(settings, window);
        const tvs = new TvsGroup(settings, window);
        const sonoff = new SonoffGroup(settings, window);
        const ewelink = new EwelinkGroup(settings, window);
        const hue = new HueGroup(settings, window);
        const hass = new HassGroup(settings, window);
        const homekit = new HomeKitGroup(settings, window);
        const smartlife = new SmartLifeGroup(settings, window);
        const devices = new DevicesPage(settings, new FindGroup(settings, window, [
            {name: _('Air Conditioners'), about: _('Gree units, by a broadcast on this network.'),
                find: () => gree._find('255.255.255.255', true)},
            {name: _('Cameras'), about: _('Tapo cameras, by ONVIF. A camera answers only once its camera account exists.'),
                find: () => cameras._find(true)},
            {name: _('Speakers'), about: _('Google Cast speakers and displays, by mDNS.'),
                find: () => speakers._find(true)},
            {name: _('TVs'), about: _('By mDNS and UPnP.'),
                find: looking => tvs._find(true, looking), survey: true},
            {name: _('Sonoff Switches'), about: _('Switches in DIY mode, by mDNS.'),
                find: () => sonoff._find(true)},
            {name: _('eWeLink Devices'), about: _('By mDNS, once the eWeLink account is logged in. Their device IDs are sent to that account.'),
                find: looking => ewelink._find(true, looking), survey: true},
            {name: _('Philips Hue'), about: _('Hue bridges, by mDNS.'),
                find: looking => hue._find(true, looking)},
            {name: _('HomeKit'), about: _('HomeKit accessories, by mDNS.'),
                find: looking => homekit._find(true, looking)},
        ]));
        window.add(devices);
        window.connect('close-request', () => {
            devices.forget();
            return false;
        });

        // Adw refocuses the last focused widget on page switch and scrolls to it.
        // Clear the focus and restore the Devices page's scroll position instead.
        let left = 0;
        let shown = window.visible_page;
        window.connect('notify::visible-page', () => {
            if (shown === devices)
                left = findScrolled(devices)?.vadjustment.value ?? 0;
            shown = window.visible_page;
            if (shown !== devices)
                return;
            window.set_focus(null);
            const restore = () => {
                const adjustment = findScrolled(devices)?.vadjustment;
                if (adjustment)
                    adjustment.value = left;
                return GLib.SOURCE_REMOVE;
            };
            // Restore at idle and again after 120 ms: layout scrolls the page once more.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, restore);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, restore);
        });

        const accounts = new Adw.PreferencesPage({
            name: 'accounts',
            title: _('Accounts'),
            icon_name: 'system-users-symbolic',
        });
        const xiaomi = new XiaomiGroup(settings, window);
        accounts.add(xiaomi);
        accounts.add(gree);
        accounts.add(cameras);
        accounts.add(speakers);
        accounts.add(tvs);
        accounts.add(sonoff);
        accounts.add(ewelink);
        accounts.add(hue);
        accounts.add(hass);
        accounts.add(homekit);
        accounts.add(smartlife);
        window.connect('close-request', () => {
            gree.forget();
            cameras.forget();
            speakers.forget();
            tvs.forget();
            sonoff.forget();
            ewelink.forget();
            hue.forget();
            hass.forget();
            homekit.forget();
            smartlife.forget();
            return false;
        });
        window.add(accounts);
        this._goTo(window, settings, accounts, new Map([
            ['accounts-mihome', xiaomi], ['accounts-gree', gree], ['accounts-tapo', cameras], ['accounts-cast', speakers],
            ['accounts-tv', tvs], ['accounts-sonoff', sonoff], ['accounts-ewelink', ewelink], ['accounts-hue', hue],
            ['accounts-hass', hass], ['accounts-homekit', homekit], ['accounts-smartlife', smartlife],
        ]));

        this._window = window;
        this._closed = false;
        window.connect('close-request', () => {
            this._closed = true;
            return false;
        });
        window.add(this._aboutPage());
    }

    // The shell names a group, and maybe a device in it, in prefs-target before it opens this window.
    _goTo(window, settings, page, groups) {
        const go = () => {
            const [id, did] = settings.get_string('prefs-target').split(' ');
            if (!id)
                return;
            settings.set_string('prefs-target', '');
            const group = groups.get(id);
            if (!group)
                return;
            window.visible_page = page;
            const target = group.reveal(did);
            // Again after 120 ms: the first layout and the focus Adw restores both scroll the page.
            const scroll = () => {
                const scrolled = findScrolled(page);
                const [ok, bounds] = target.compute_bounds(scrolled?.child ?? page);
                if (scrolled && ok)
                    scrolled.vadjustment.value += bounds.origin.y - 12;
                return GLib.SOURCE_REMOVE;
            };
            window.set_focus(null);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, scroll);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, scroll);
        };
        const handler = settings.connect('changed::prefs-target', go);
        window.connect('close-request', () => {
            settings.disconnect(handler);
            return false;
        });
        go();
    }

    _logo() {
        const logo = new Gtk.Image({pixel_size: LOGO_SIZE});
        // Gtk.Svg (GTK 4.22, GNOME 50) plays SMIL; older GTK gets the still logo.
        if (typeof Gtk.Svg !== 'function' || !Gtk.Settings.get_default().gtk_enable_animations) {
            logo.file = `${this.path}/${LOGO_FILE}`;
            return logo;
        }
        const [, bytes] = Gio.File.new_for_path(`${this.path}/${LOGO_ANIMATION}`).load_contents(null);
        // A finished Gtk.Svg does not replay, so each visit to the page draws a fresh one.
        logo.connect('map', () => {
            const svg = Gtk.Svg.new_from_bytes(new GLib.Bytes(bytes));
            svg.set_frame_clock(logo.get_frame_clock());
            logo.paintable = svg;
            svg.play();
        });
        return logo;
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            name: 'about',
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const header = new Adw.PreferencesGroup();
        page.add(header);
        header.add(this._logo());
        header.add(new Gtk.Label({
            label: this.metadata.name,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_top: 12,
            css_classes: ['title-1'],
        }));
        header.add(new Gtk.Label({
            label: _('Your smart home, from the top bar'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_top: 6,
            css_classes: ['dim-label'],
        }));

        const about = new Adw.PreferencesGroup();
        page.add(about);
        about.add(this._linkRow(_('Project page'), PROJECT_URL, PROJECT_URL));

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            halign: Gtk.Align.CENTER,
            spacing: 12,
            margin_top: 18,
        });
        buttons.append(this._pill(_('Report a problem'), ISSUES_URL));
        buttons.append(this._pill(_('Request a feature'), FEATURE_URL));
        about.add(buttons);
        about.add(new Gtk.Label({
            label: _('A device it gets wrong, or one it cannot reach yet - either one belongs in an issue.'),
            justify: Gtk.Justification.CENTER,
            wrap: true,
            max_width_chars: 44,
            margin_top: 12,
            css_classes: ['dim-label', 'caption'],
        }));

        const support = new Adw.PreferencesGroup({title: _('Support')});
        page.add(support);
        const free = new Adw.ActionRow({
            title: _('Nook is free and stays free. If it earned a coffee ☕'),
            title_lines: 0,
        });
        free.add_prefix(new Gtk.Image({icon_name: 'emblem-favorite-symbolic'}));
        support.add(free);
        support.add(this._linkRow(_('GitHub Sponsors'), _('Monthly or one time'), SPONSORS_URL));
        support.add(this._linkRow(_('PayPal'), PAYPAL_URL, PAYPAL_URL));
        this._wallets(support);

        support.add(new Gtk.Label({
            label: `· ${_('Nook %s').format(this.metadata['version-name'] ?? '')} ·`,
            justify: Gtk.Justification.CENTER,
            margin_top: 18,
            css_classes: ['dim-label', 'caption'],
        }));
        return page;
    }

    _wallets(group) {
        const networks = new Gtk.StringList();
        for (const [name] of WALLETS)
            networks.append(name);
        const network = new Adw.ComboRow({title: _('Cryptocurrency'), model: networks});
        group.add(network);

        const address = new Adw.ActionRow({
            title: _('Address'),
            subtitle_selectable: true,
            subtitle_lines: 0,
        });
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy the address'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        address.add_suffix(copy);
        group.add(address);

        const code = new Gtk.Picture({
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            width_request: WALLET_QR_SIZE,
            height_request: WALLET_QR_SIZE,
        });
        group.add(code);

        const chosen = () => WALLETS[network.selected] ?? WALLETS[0];
        const show = () => {
            const [name, wallet] = chosen();
            address.subtitle = wallet;
            code.file = Gio.File.new_for_path(`${this.path}/${QR_DIR}/${name.toLowerCase().replaceAll(' ', '-')}.svg`);
            code.alternative_text = _('The %s address as a QR code').format(name);
        };
        network.connect('notify::selected', show);
        show();

        copy.connect('clicked', () => {
            const [name, wallet] = chosen();
            const value = new GObject.Value();
            value.init(GObject.TYPE_STRING);
            value.set_string(wallet);
            Gdk.Display.get_default()?.get_clipboard().set_value(value);
            if (!this._closed)
                this._window.add_toast?.(new Adw.Toast({title: _('%s address copied').format(name), timeout: 6}));
        });
    }

    _pill(label, url) {
        const button = new Gtk.Button({label, css_classes: ['pill']});
        button.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(url, null));
        return button;
    }

    _linkRow(title, subtitle, url) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(url, null));
        return row;
    }

    _choiceRow(settings, key, choices, props) {
        const row = new Adw.ComboRow({
            ...props,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const sync = () => {
            const i = choices.findIndex(([value]) => value === settings.get_string(key));
            row.selected = Math.max(i, 0);
        };
        sync();
        row.connect('notify::selected', () => {
            const value = choices[row.selected]?.[0];
            if (value && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        const handler = settings.connect(`changed::${key}`, sync);
        row.connect('destroy', () => settings.disconnect(handler));
        return row;
    }

    _placementGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Placement')});

        group.add(this._choiceRow(settings, 'location', [
            ['panel', _('Top bar button')],
            ['quick-settings', _('Quick Settings')],
        ], {
            title: _('Location'),
            subtitle: _('A button of its own, or a tile next to Wi-Fi and Bluetooth.'),
        }));

        const box = this._choiceRow(settings, 'panel-box', [
            ['left', pgettext('top bar area', 'Left')],
            ['center', pgettext('top bar area', 'Centre')],
            ['right', pgettext('top bar area', 'Right')],
        ], {
            title: _('Top Bar Area'),
            subtitle: _('Which part of the top bar the button is in.'),
        });
        group.add(box);

        const index = new Adw.SpinRow({
            title: _('Position'),
            subtitle: _('Counted from the left of that area. Zero is first.'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1, page_increment: 1}),
        });
        settings.bind('panel-index', index, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(index);

        const middle = this._choiceRow(settings, 'middle-click', [
            ['none', _('Nothing')],
            ['refresh', _('Find devices again')],
            ['settings', _('Open these settings')],
        ], {
            title: _('Middle Click'),
            subtitle: _('On the button in the top bar.'),
        });
        group.add(middle);

        const hover = new Adw.SwitchRow({
            title: _('Switch Menus on Hover'),
            subtitle: _('Pointing at another top bar button closes Nook and opens that menu. Off: Nook stays open until a click outside it.'),
        });
        settings.bind('hover-switch', hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hover);

        const follow = () => {
            const own = settings.get_string('location') === 'panel';
            box.sensitive = own;
            index.sensitive = own;
            middle.sensitive = own;
            hover.sensitive = own;
        };
        follow();
        const handler = settings.connect('changed::location', follow);
        group.connect('destroy', () => settings.disconnect(handler));

        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Menu')});

        const views = [
            ['tabs', _('Rooms as tabs')],
            ['grid', _('Small tiles')],
            ['rooms', _('Tiles by room')],
            ['control', _('Modules')],
        ];
        const viewRow = new Adw.ComboRow({
            title: _('View'),
            subtitle: _('How the menu lays out the devices.'),
            model: Gtk.StringList.new(views.map(([, label]) => label)),
        });
        const syncView = () => {
            const i = views.findIndex(([value]) => value === settings.get_string('view'));
            viewRow.selected = Math.max(i, 0);
        };
        syncView();
        viewRow.connect('notify::selected', () => {
            const value = views[viewRow.selected]?.[0];
            if (value && value !== settings.get_string('view'))
                settings.set_string('view', value);
        });
        const viewHandler = settings.connect('changed::view', syncView);
        viewRow.connect('destroy', () => settings.disconnect(viewHandler));
        group.add(viewRow);

        const colorRow = new Adw.SwitchRow({
            title: _('Colour by Device Type'),
            subtitle: _('Fans, lights and sensors each get a colour of their own instead of the accent colour.'),
        });
        settings.bind('type-colors', colorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(colorRow);

        const iconRow = new Adw.SwitchRow({
            title: _('Coloured Top Bar Icon'),
            subtitle: _('Cream with a clay doorway. Off: monochrome, in the colour of the other icons.'),
        });
        settings.bind('colored-icon', iconRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(iconRow);

        return group;
    }

    // Rooms are keyed by lower-cased name, as extension.js merges same-named rooms.
    _roomTabsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Room Tabs'),
            description: _('The tabs shown over the tiles. A room left out keeps its devices under All.'),
        });
        const names = new Map();
        for (const device of [
            ...cachedDevices(settings.get_string('xiaomi-user-id')),
            ...parseUnits(settings.get_string('gree-units')),
            ...Tapo.parseCameras(settings.get_string('tapo-cameras')),
            ...parseSpeakers(settings.get_string('cast-speakers')),
            ...parseTvs(settings.get_string('tvs')),
            ...Sonoff.parseSwitches(settings.get_string('sonoff-switches')),
            ...EwelinkHome.parseDevices(settings.get_string('ewelink-devices')),
            ...hueDevices(settings),
            ...Hass.parseDevices(settings.get_string('hass-devices')),
            ...SmartLifeHome.parseDevices(settings.get_string('smartlife-devices')),
        ]) {
            if (typeof device.room === 'string' && device.room)
                names.set(device.room.toLocaleLowerCase(), device.room);
        }
        const rooms = [...names].sort((a, b) => a[1].localeCompare(b[1]));
        rooms.unshift(['@pinned', _('Pinned')]);
        rooms.push(['@other', _('Other')]);
        const rows = [];
        for (const [key, name] of rooms) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(name, -1),
                active: !settings.get_strv('hidden-rooms').includes(key),
            });
            row.connect('notify::active', () => {
                const was = settings.get_strv('hidden-rooms');
                if (was.includes(key) !== row.active)
                    return;
                const hidden = was.filter(k => k !== key);
                if (!row.active)
                    hidden.push(key);
                settings.set_strv('hidden-rooms', hidden);
            });
            group.add(row);
            rows.push([key, row]);
        }

        const all = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat']});
        all.connect('clicked', () => {
            const hidden = settings.get_strv('hidden-rooms');
            const listed = rows.map(([key]) => key);
            const others = hidden.filter(key => !listed.includes(key));
            settings.set_strv('hidden-rooms',
                listed.some(key => hidden.includes(key)) ? others : [...others, ...listed]);
        });
        group.header_suffix = all;

        const sync = () => {
            const hidden = settings.get_strv('hidden-rooms');
            for (const [key, row] of rows)
                row.active = !hidden.includes(key);
            all.label = rows.some(([key]) => hidden.includes(key)) ? _('Show All') : _('Hide All');
        };
        sync();
        const handler = settings.connect('changed::hidden-rooms', sync);
        group.connect('destroy', () => settings.disconnect(handler));
        return group;
    }
}
