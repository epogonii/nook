// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {arrange, move} from '../lib/arrange.js';
import * as Glyphs from '../lib/glyphs.js';
import {parseSpeakers} from '../lib/cast-home.js';
import * as EwelinkHome from '../lib/ewelink-home.js';
import {BRANDS as AIRCONS, didOf as airconDid, parseAircons, parseUnits} from '../lib/aircon-home.js';
import {parseEntries} from '../lib/cloud-aircon.js';
import * as Hass from '../lib/hass.js';
import * as HomeKit from '../lib/homekit.js';
import * as SmartLifeHome from '../lib/smartlife-home.js';
import * as Sonoff from '../lib/sonoff.js';
import * as Tapo from '../lib/tapo.js';
import {BRANDS, parseTvs} from '../lib/tv-home.js';
import {CLOUD_AIRCONS, cachedDevices, deviceCount, findScrolled, hueDevices, renameButton, setGroupIcon} from './common.js';
import {FoldGroup} from './fold.js';

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

export const DevicesPage = GObject.registerClass(
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
        this._handlers = ['pinned', 'order', 'hidden', 'panel-sensors', 'names', 'icons', 'xiaomi-user-id', 'gree-units', 'aircons', 'tapo-cameras', 'cast-speakers', 'tvs', 'sonoff-switches', 'ewelink-devices',
            'hue-bridges', 'hue-devices', 'hass-devices', 'homekit-accessories', 'smartlife-devices',
            ...CLOUD_AIRCONS().map(({id}) => `${id}-devices`)]
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

        const conditioners = [...parseUnits(this._settings.get_string('gree-units')),
            ...parseAircons(this._settings.get_string('aircons'))].map(unit => ({
            did: airconDid(unit),
            name: unit.name || unit.mac || AIRCONS[unit.brand ?? 'gree'].title,
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
        const clouds = CLOUD_AIRCONS().flatMap(({id}) => parseEntries(this._settings.get_string(`${id}-devices`)).map(entry => ({
            did: `${id}:${entry.id}`,
            name: entry.name || entry.model || id,
            room: entry.room ?? null,
            primary: {kind: 'switch', props: []},
        })));
        const devices = arrange([...cachedDevices(this._settings.get_string('xiaomi-user-id')), ...conditioners, ...cameras, ...speakers, ...tvs, ...switches, ...ewelink, ...hue, ...hass, ...homekit, ...smartlife,
            ...clouds], {
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
            ['gree', _('Air Conditioners'), d => /^(gree|midea|daikin):/.test(d.did)],
            ['tapo', _('Cameras'), d => d.did.startsWith('tapo:')],
            ['cast', _('Speakers'), d => d.did.startsWith('cast:')],
            ['tv', _('TVs'), d => d.did.startsWith('tv:')],
            ['sonoff', _('Sonoff'), d => d.did.startsWith('sonoff:')],
            ['ewelink', _('eWeLink'), d => d.did.startsWith('ewelink:')],
            ['hue', _('Philips Hue'), d => d.did.startsWith('hue:')],
            ['hass', _('Home Assistant'), d => d.did.startsWith('hass:')],
            ['homekit', _('HomeKit'), d => d.did.startsWith('homekit:')],
            ['smartlife', _('Smart Life'), d => d.did.startsWith('smartlife:')],
            ...CLOUD_AIRCONS().map(({id, title}) => [id, title, d => d.did.startsWith(`${id}:`)]),
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
