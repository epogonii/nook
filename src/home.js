// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

import {deviceMenu} from './device-menu.js';
import {isOn} from './text.js';
import {CameraTile, Tile, lookOf, popupMenu, sidebarButton, switchable} from './widgets.js';

// s between reads while the window is shown, as the menu does while it is open.
const READ_EVERY = 60;
// s between camera stills; each one is a short stream of its own.
const STILL_EVERY = 60;
// Push channels (Home Assistant, Hue) can report several changes a second.
const SETTLE_MS = 300;

// The extension's Modules view sections, by the glyphs they take.
const SECTIONS = [
    ['lights', ['bulb', 'rocker', 'plug']],
    ['climate', ['aircon', 'fan', 'thermometer', 'heater', 'humidifier', 'dehumidifier', 'purifier', 'thermostat']],
    ['media', ['tv', 'speaker']],
    ['cameras', ['camera']],
    ['security', ['shield', 'motion', 'door', 'drop', 'smoke', 'lock', 'doorbell']],
    ['appliances', []],
];

function sectionTitle(id) {
    return {
        lights: _('Lights'),
        climate: _('Climate'),
        media: _('Media'),
        cameras: _('Cameras'),
        security: _('Security'),
        appliances: _('Appliances'),
    }[id];
}

const numberFormat = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});

// Leak, smoke or gas reported.
const alarming = device => device.online !== false && device.primary.props.some((p, i) =>
    ['submersion-state', 'smoke-status', 'gas-status'].includes(p.name) && device.values?.[i] === true);

function sectionSummary(id, devices) {
    const on = devices.filter(isOn).length;
    switch (id) {
    case 'climate': {
        if (on > 0)
            return _('%d on').replace('%d', String(on));
        const reading = devices.map(device => {
            const i = device.primary.props.findIndex(p => p.unit === 'celsius');
            return i >= 0 && device.online !== false ? device.values?.[i] : null;
        }).find(value => typeof value === 'number');
        return reading === undefined ? '' : `${numberFormat.format(reading)}°`;
    }
    case 'security':
        return devices.some(alarming) ? _('Alarm!') : '';
    default:
        return on > 0 ? _('%d on').replace('%d', String(on)) : '';
    }
}

// Which devices show and where: a change rebuilds the grid, anything else updates tiles.
const layoutKey = devices => devices.map(device => `${device.did}${device.online === false ? '-' : '+'}`).join(' ');

function sectionOf(device) {
    if (device.primary.kind === 'camera')
        return 'cameras';
    const [glyph] = lookOf(device);
    return SECTIONS.find(([, glyphs]) => glyphs.includes(glyph))?.[0] ?? 'appliances';
}

// Every device the app reaches, by section, for all rooms or one.
export const HomePage = GObject.registerClass({
    Signals: {
        'rooms-changed': {},
        'open-device': {param_types: [GObject.TYPE_JSOBJECT]},
        'add-devices': {},
    },
}, class HomePage extends Adw.NavigationPage {
    _init(service, settings) {
        super._init({title: _('Home'), tag: 'home'});
        this._service = service;
        this._settings = settings;
        this._room = null;
        this._rooms = new Map();
        this._tiles = [];
        this._summaries = [];
        this._timer = 0;
        this._settle = 0;
        this._sources = [];
        this._stills = new Map();
        this._stillTimer = 0;
        this._stilling = false;
        this._layout = null;
        // Unavailable and Hidden start folded each time; sections stay as left.
        this._unfolded = new Set();
        this.devicePage = null;

        this._body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['nook-home']});
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({maximum_size: 1200, tightening_threshold: 1000, child: this._body}),
        });
        const add = new Gtk.Button({label: _('Add Devices'), halign: Gtk.Align.CENTER, css_classes: ['pill', 'suggested-action']});
        add.connect('clicked', () => this.emit('add-devices'));
        this._empty = new Adw.StatusPage({
            icon_name: 'io.github.epogonii.nook-symbolic',
            title: _('No Devices Yet'),
            description: _('Sign in to an account, or look for devices on this network.'),
            child: add,
        });
        this._stack = new Gtk.Stack();
        this._stack.add_named(scroller, 'grid');
        this._stack.add_named(this._empty, 'empty');

        const header = new Adw.HeaderBar();
        header.pack_start(sidebarButton());
        const more = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: _('Add Devices')});
        more.connect('clicked', () => this.emit('add-devices'));
        header.pack_end(more);
        const view = new Adw.ToolbarView({content: this._stack});
        view.add_top_bar(header);
        this.child = view;
        this._looks = ['changed::names', 'changed::icons', 'changed::home-hidden']
            .map(signal => settings.connect(signal, () => this._render()));
    }

    // While the window shows: reads now and every READ_EVERY s, pushes in between.
    start() {
        this._service.attachWindow(this);
        this._collect();
        this._read().catch(logError);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, READ_EVERY, () => {
            this._read().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
        this._xiaomi().catch(logError);
        this._takeStills().catch(logError);
        this._stillTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, STILL_EVERY, () => {
            this._takeStills().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (this._settle)
            GLib.source_remove(this._settle);
        this._settle = 0;
        if (this._stillTimer)
            GLib.source_remove(this._stillTimer);
        this._stillTimer = 0;
        this._service.detachWindow();
        this._sources = [];
    }

    forget() {
        this.stop();
        this._looks.forEach(id => this._settings.disconnect(id));
        this._looks = [];
    }

    onEvent() {
        if (this._settle)
            return;
        this._settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settle = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    onReloaded() {
        if (!this._timer)
            return;
        this.stop();
        this.start();
    }

    // [key, name, count] by name; keys are lower-cased, as the extension merges rooms.
    get rooms() {
        return [...this._rooms].map(([key, {name, count}]) => [key, name, count])
            .sort((a, b) => a[1].localeCompare(b[1]));
    }

    get devices() {
        return this._sources.flatMap(source => source.devices)
            .filter(device => device.primary && device.primary.kind !== 'scene');
    }

    get room() {
        return this._room;
    }

    setRoom(key) {
        this._room = key;
        this.title = key ? this._rooms.get(key)?.name ?? _('Home') : _('Home');
        this._render();
    }

    nameOf(device) {
        return this._settings.get_value('names').deepUnpack()[device.did] || device.name;
    }

    get appSettings() {
        return this._settings;
    }

    get service() {
        return this._service;
    }

    // The extension's settings, while it runs.
    get menuSettings() {
        return this._service.menu;
    }

    _collect() {
        this._sources = this._service.homes().filter(({kind}) => kind !== 'scenes').map(({home}) => home);
        this._render();
    }

    async _xiaomi() {
        const {list} = await this._service.xiaomi();
        const home = list.find(({kind}) => kind === 'xiaomi')?.home;
        if (!home || !this._timer)
            return;
        if (home.devices.length === 0) {
            await home.load();
            if (home.homes.length === 0 && home.devices.length > 0)
                await home.discover();
        }
        this._collect();
        await home.readAll().catch(e => console.debug(`nook: Mi Home: ${e.message}`));
        this._sync();
    }

    // One camera at a time, while the window shows.
    async _takeStills() {
        if (this._stilling)
            return;
        this._stilling = true;
        try {
            // Not the one whose page shows it live: that would be a second stream.
            const cameras = this.devices.filter(device => device.primary.kind === 'camera' && device.online !== false &&
                typeof device.source?.still === 'function' && device !== this.devicePage?.device);
            for (const device of cameras) {
                if (!this._timer)
                    break;
                try {
                    const jpeg = await device.source.still(device);
                    this._stills.set(device.did, Gdk.Texture.new_from_bytes(new GLib.Bytes(jpeg)));
                } catch (e) {
                    console.debug(`nook: still of ${device.did}: ${e.message}`);
                    continue;
                }
                this._tiles.find(tile => tile.device === device)?.setStill?.(this._stills.get(device.did));
                if (this.devicePage?.device === device)
                    this.devicePage.sync();
            }
        } finally {
            this._stilling = false;
        }
    }

    stillOf(device) {
        return this._stills.get(device.did) ?? null;
    }

    async _read() {
        await Promise.allSettled(this._sources.map(source => (source.readAll ?? source.readPrimary).call(source)
            .then(() => this._sync())));
    }

    _countRooms(devices) {
        const rooms = new Map();
        for (const device of devices) {
            if (!device.room)
                continue;
            const key = device.room.toLocaleLowerCase();
            const room = rooms.get(key) ?? {name: device.room, count: 0};
            room.count++;
            rooms.set(key, room);
        }
        const before = JSON.stringify([...this._rooms]);
        this._rooms = rooms;
        if (JSON.stringify([...rooms]) !== before)
            this.emit('rooms-changed');
    }

    _render() {
        const names = this._settings.get_value('names').deepUnpack();
        const icons = this._settings.get_value('icons').deepUnpack();
        const devices = this.devices;
        this._countRooms(devices);
        if (this._room && !this._rooms.has(this._room)) {
            this._room = null;
            this.title = _('Home');
        }

        for (let child = this._body.get_first_child(); child; child = this._body.get_first_child())
            this._body.remove(child);
        this._tiles = [];
        this._summaries = [];
        const shown = this._shown(devices);
        this._layout = layoutKey(shown);
        this._stack.visible_child_name = shown.length > 0 ? 'grid' : 'empty';
        const byName = (a, b) => (names[a.did] || a.name).localeCompare(names[b.did] || b.name);
        const hidden = new Set(this._settings.get_strv('home-hidden'));
        const here = shown.filter(device => device.online !== false && !hidden.has(device.did));
        for (const [id] of SECTIONS) {
            const own = here.filter(device => sectionOf(device) === id).sort(byName);
            if (own.length === 0)
                continue;
            const summary = new Gtk.Label({label: sectionSummary(id, own), css_classes: ['dim-label', 'caption', 'nook-count']});
            this._summaries.push([summary, id, own]);
            this._fold(sectionTitle(id), this._grid(own, id === 'cameras', names, icons), summary, `home:${id}`, true);
        }

        // Not answering, then hidden: folded last, so they don't crowd the rest.
        const gone = shown.filter(device => device.online === false && !hidden.has(device.did)).sort(byName);
        const count = list => new Gtk.Label({label: String(list.length), css_classes: ['dim-label', 'caption', 'nook-count']});
        if (gone.length > 0)
            this._fold(_('Unavailable'), this._grid(gone, false, names, icons), count(gone), 'unavailable', false);
        const put = shown.filter(device => hidden.has(device.did)).sort(byName);
        if (put.length > 0)
            this._fold(_('Hidden'), this._grid(put, false, names, icons), count(put), 'hidden', false);
    }

    _shown(devices) {
        return devices.filter(device => !this._room || device.room?.toLocaleLowerCase() === this._room);
    }

    // A titled block that its title folds; kept: the fold is saved in folded-groups, else
    // it starts folded each time.
    _fold(title, child, after, key, kept) {
        const folded = kept ? this._settings.get_strv('folded-groups').includes(key) : !this._unfolded.has(key);
        const line = new Gtk.Box({spacing: 6});
        line.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['heading']}));
        line.append(new Gtk.Image({icon_name: 'pan-down-symbolic', css_classes: ['nook-chevron']}));
        const toggle = new Gtk.Button({child: line, halign: Gtk.Align.START, css_classes: ['flat', 'nook-fold-toggle']});
        const header = new Gtk.Box({spacing: 6, css_classes: ['nook-section', ...this._body.get_first_child() ? [] : ['first']]});
        header.append(toggle);
        header.append(new Gtk.Box({hexpand: true}));
        header.append(after);
        const revealer = new Gtk.Revealer({child, transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN});
        const show = open => {
            revealer.reveal_child = open;
            if (open)
                header.remove_css_class('folded');
            else
                header.add_css_class('folded');
            toggle.update_state([Gtk.AccessibleState.EXPANDED], [open]);
        };
        show(!folded);
        toggle.connect('clicked', () => {
            const open = !revealer.reveal_child;
            show(open);
            if (kept) {
                const others = this._settings.get_strv('folded-groups').filter(g => g !== key);
                this._settings.set_strv('folded-groups', open ? others : [...others, key]);
            } else if (open) {
                this._unfolded.add(key);
            } else {
                this._unfolded.delete(key);
            }
        });
        this._body.append(header);
        this._body.append(revealer);
    }

    _grid(devices, cameras, names, icons) {
        const grid = new Gtk.FlowBox({
            homogeneous: true,
            min_children_per_line: cameras ? 2 : 1,
            max_children_per_line: cameras ? 4 : 8,
            column_spacing: 8,
            row_spacing: 8,
            selection_mode: Gtk.SelectionMode.NONE,
        });
        for (const device of devices) {
            const tile = cameras ? this._cameraTile(device, names) : this._tile(device, names, icons);
            grid.append(tile);
            tile.get_parent().focusable = false;
            this._tiles.push(tile);
        }
        return grid;
    }

    _tile(device, names, icons) {
        const tile = new Tile(device, names[device.did] || device.name, lookOf(device, icons));
        tile.width_request = 188;
        tile.connect('toggle', () => this._toggle(device).catch(logError));
        tile.connect('open', () => this.emit('open-device', device));
        tile.connect('menu', (_tile, x, y) => this._popup(tile, x, y));
        return tile;
    }

    _cameraTile(device, names) {
        const tile = new CameraTile(device, names[device.did] || device.name);
        tile.width_request = 220;
        tile.setStill(this._stills.get(device.did) ?? null);
        tile.connect('open', () => this.emit('open-device', device));
        tile.connect('menu', (_tile, x, y) => this._popup(tile, x, y));
        return tile;
    }

    _popup(tile, x, y) {
        const [model, actions] = deviceMenu(tile.device, this, {open: () => this.emit('open-device', tile.device)});
        popupMenu(tile, model, 'device', actions, x, y);
    }

    _sync() {
        if (layoutKey(this._shown(this.devices)) !== this._layout)
            this._render();
        else
            this._tiles.forEach(tile => tile.sync());
        for (const [label, id, own] of this._summaries)
            label.label = sectionSummary(id, own);
        this.devicePage?.sync();
    }

    async _toggle(device) {
        if (!switchable(device))
            return;
        const was = device.values;
        const on = !isOn(device);
        device.values = [on, ...was?.slice(1) ?? []];
        this._sync();
        try {
            await device.source.setSwitch(device, on);
        } catch (e) {
            device.values = was;
            this.get_root()?.add_toast?.(new Adw.Toast({title: e.message}));
        }
        this._sync();
    }

    toggle(device) {
        return this._toggle(device);
    }
});
