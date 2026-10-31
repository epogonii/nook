// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

import {deviceMenu} from './device-menu.js';
import {tileText} from './hero.js';
import {AirconCard, PlayerCard} from './home-cards.js';
import {openBeacons} from './homes.js';
import {beacons, isBluetooth, isOn} from './text.js';
import {
    CameraTile, Showcase, Tile, animating, holdStill, lookOf, popupMenu, powered, showPictures, sidebarButton, switchable,
} from './widgets.js';

// s between reads while the window is shown, as the menu does while it is open.
const READ_EVERY = 60;
// s between camera stills; each one is a short stream of its own.
const STILL_EVERY = 60;
// Push channels (Home Assistant, Hue) can report several changes a second.
const SETTLE_MS = 300;
// Width of a device tile and of a camera tile, by tile-size: a row has as many as fit at this
// width, and they grow to fill it.
const TILE_WIDTHS = {small: [180, 200], medium: [220, 240], large: [300, 300]};
// The last of the delays before a card rises in, nook-rise-N in style.css.
const RISE_LAST = 9;

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

// What the page shows while there are no devices: a few, the lamp on, the sensor reading. The
// sensor keeps out of the lamp's light, which would have its display drawn coarse.
const WELCOME = [
    {name: 'speaker', x: 0.25, floor: 0.9, height: 1},
    {name: 'light', x: 0.86, floor: 0.9, height: 0.92, foot: 0.4, glow: [1, 0.74, 0.4, 0.8]},
    {name: 'temperature-humidity-sensor', x: 0, floor: 1.1, height: 0.55, screen: [`${numberFormat.format(21.5)}°`, '46%']},
    {name: 'plug', x: 1.2, floor: 1.1, height: 0.42},
];

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

// Not answering. Mi Home has a Bluetooth device offline unless a gateway relays it; its tile
// says whether the window heard it instead.
const unavailable = device => device.online === false && !isBluetooth(device);

// Which devices show and where: a change rebuilds the grid, anything else updates tiles.
const layoutKey = devices => devices.map(device => `${device.did}${unavailable(device) ? '-' : '+'}`).sort().join(' ');

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
        'pin-changed': {},
        'open-device': {param_types: [GObject.TYPE_JSOBJECT]},
        'add-devices': {},
        'show-accounts': {},
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
        this._beacons = null;
        this._sources = [];
        this._stills = new Map();
        this._stillTimer = 0;
        this._stilling = false;
        this._layout = null;
        // What is going on, over the sections: a speaker playing, an air conditioner on.
        this._wideRow = null;
        this._wide = [];
        this._wideKey = null;
        // Keys of what the page shows: device dids, "wide <did>" and section keys. What was not
        // on it before rises in, one after another.
        this._keys = new Set();
        this._was = new Set();
        this._rising = false;
        this._risen = 0;
        // Unavailable and Hidden start folded each time; sections stay as left.
        this._unfolded = new Set();
        this.devicePage = null;

        this._body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['nook-home']});
        const scroller = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({maximum_size: 1200, tightening_threshold: 1000, child: this._body}),
        });
        this._welcome = new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER});
        this._stack = new Gtk.Stack();
        this._stack.add_named(scroller, 'grid');
        this._stack.add_named(this._welcome, 'empty');

        const header = this._header = new Adw.HeaderBar();
        header.pack_start(sidebarButton());
        // The rooms, as tabs in place of the title: All, then each room by name.
        this._tabs = new Gtk.Box({accessible_role: Gtk.AccessibleRole.TAB_LIST, css_classes: ['nook-room-tabs']});
        this._tabButtons = new Map();
        this._tabStrip = new Gtk.ScrolledWindow({
            child: this._tabs,
            hscrollbar_policy: Gtk.PolicyType.EXTERNAL,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_width: true,
            hexpand: true,
            visible: false,
            css_classes: ['nook-room-strip'],
        });
        header.pack_start(this._tabStrip);
        this.connect('rooms-changed', () => this._fillTabs());
        const more = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: _('Add Devices')});
        more.connect('clicked', () => this.emit('add-devices'));
        header.pack_end(more);
        header.pack_end(this._viewButton(settings));
        const view = new Adw.ToolbarView({content: this._stack});
        view.add_top_bar(header);
        this.child = view;
        holdStill(!settings.get_boolean('animations'));
        showPictures(settings.get_boolean('pictures'));
        this._looks = ['changed::names', 'changed::icons', 'changed::home-hidden', 'changed::tile-size']
            .map(signal => settings.connect(signal, () => this._render()));
        this._looks.push(settings.connect('changed::animations', () => {
            holdStill(!settings.get_boolean('animations'));
            this._render();
        }), settings.connect('changed::pictures', () => {
            showPictures(settings.get_boolean('pictures'));
            this._render();
        }));
    }

    // Made anew each time the page empties, to rise in again. The text waits for the pictures.
    _fillWelcome() {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, css_classes: ['nook-welcome']});
        const showcase = new Showcase(WELCOME, 165);
        box.append(showcase);
        const title = new Gtk.Label({label: _('Welcome to Nook'), wrap: true, justify: Gtk.Justification.CENTER, css_classes: ['title-1']});
        const about = new Gtk.Label({
            label: _('Sign in to an account, or look for devices on this network.'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            css_classes: ['body', 'dim-label'],
        });
        const accounts = new Gtk.Button({label: _('Accounts'), css_classes: ['pill']});
        accounts.connect('clicked', () => this.emit('show-accounts'));
        const add = new Gtk.Button({label: _('Add Devices'), css_classes: ['pill', 'suggested-action']});
        add.connect('clicked', () => this.emit('add-devices'));
        const buttons = new Gtk.Box({spacing: 12, halign: Gtk.Align.CENTER, homogeneous: true, css_classes: ['nook-welcome-buttons']});
        buttons.append(accounts);
        buttons.append(add);
        const text = [title, about, buttons];
        text.forEach(widget => {
            if (animating())
                widget.add_css_class('nook-held');
            box.append(widget);
        });
        showcase.connect('started', () => text.forEach((widget, i) => {
            widget.remove_css_class('nook-held');
            if (animating())
                widget.css_classes = [...widget.css_classes, 'nook-rise', `nook-rise-${i + 5}`];
        }));
        this._welcome.child = new Adw.Clamp({maximum_size: 560, child: box});
    }

    _viewButton(settings) {
        const size = Gio.SimpleAction.new_stateful('tile-size', new GLib.VariantType('s'),
            GLib.Variant.new_string(settings.get_string('tile-size')));
        size.connect('change-state', (_action, value) => settings.set_string('tile-size', value.get_string()[0]));
        this._sizeHandler = settings.connect('changed::tile-size',
            () => size.set_state(GLib.Variant.new_string(settings.get_string('tile-size'))));
        const actions = new Gio.SimpleActionGroup();
        actions.add_action(size);
        actions.add_action(settings.create_action('pictures'));
        actions.add_action(settings.create_action('animations'));
        this.insert_action_group('home', actions);
        const menu = new Gio.Menu();
        for (const [value, label] of [['small', _('Small')], ['medium', _('Medium')], ['large', _('Large')]])
            menu.append(label, `home.tile-size::${value}`);
        const look = new Gio.Menu();
        look.append(_('Device Pictures'), 'home.pictures');
        look.append(_('Animations'), 'home.animations');
        const view = new Gio.Menu();
        view.append_section(_('Tile Size'), menu);
        view.append_section(null, look);
        return new Gtk.MenuButton({icon_name: 'view-grid-symbolic', tooltip_text: _('View Options'), menu_model: view});
    }

    _fillTabs() {
        const rooms = this.rooms;
        for (let child = this._tabs.get_first_child(); child; child = this._tabs.get_first_child())
            this._tabs.remove(child);
        this._tabButtons.clear();
        let group = null;
        for (const [key, name] of [[null, _('All')], ...rooms]) {
            const tab = new Gtk.ToggleButton({
                label: name,
                group,
                active: key === this._room,
                accessible_role: Gtk.AccessibleRole.TAB,
                css_classes: ['flat', 'nook-room-tab'],
            });
            group ??= tab;
            tab.update_state([Gtk.AccessibleState.SELECTED], [tab.active]);
            tab.connect('toggled', () => {
                tab.update_state([Gtk.AccessibleState.SELECTED], [tab.active]);
                if (tab.active && key !== this._room)
                    this.setRoom(key);
            });
            this._tabs.append(tab);
            this._tabButtons.set(key, tab);
        }
        this._tabStrip.visible = rooms.length > 0;
        this._header.show_title = rooms.length === 0;
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
        this._beacons?.stop();
        this._beacons = null;
        this._service.detachWindow();
        this._sources = [];
    }

    forget() {
        this.stop();
        this._wide.forEach(card => card.forget());
        this._wide = [];
        this._looks.forEach(id => this._settings.disconnect(id));
        this._looks = [];
        if (this._sizeHandler)
            this._settings.disconnect(this._sizeHandler);
        this._sizeHandler = 0;
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
        this._tabButtons.get(key)?.set_active(true);
        // The room comes in whole, as Home does on opening.
        this._keys = new Set();
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
        if (this._timer)
            this._listen(home);
        await home.readAll().catch(e => console.debug(`nook: Mi Home: ${e.message}`));
        this._sync();
    }

    // While the window shows, as the extension's menu while open: Bluetooth devices' adverts.
    _listen(home) {
        if (this._beacons || !home.devices.some(isBluetooth))
            return;
        const byAddress = address => home.devices.find(d => isBluetooth(d) && d.mac?.toUpperCase() === address);
        const scan = this._beacons = openBeacons((address, beacon) => {
            const device = byAddress(address);
            if (!device)
                return;
            const before = tileText(device);
            // Adverts may carry only some readings; keep the rest from earlier ones.
            beacons.set(device.did, {...beacons.get(device.did), ...beacon, time: Math.floor(Date.now() / 1000)});
            // Adverts come many times a second: redraw only on a change.
            if (tileText(device) !== before)
                this.onEvent();
        });
        scan.onLocked = address => {
            const device = byAddress(address);
            if (!device)
                return;
            home.beaconKey(device).then(key => {
                if (key && this._beacons === scan)
                    scan.setKey(address, key);
            }).catch(e => console.debug(`nook: beacon key: ${e.message}`));
        };
        scan.start().then(() => this.devicePage?.sync()).catch(e => {
            console.debug(`nook: bluetooth: ${e.message}`);
            scan.off = true;
            this.devicePage?.sync();
        });
    }

    // Whether Bluetooth devices can be heard now.
    get hearing() {
        return Boolean(this._beacons && !this._beacons.off);
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
                this.emit('pin-changed');
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

    // The camera the sidebar shows: the first by name with a still, of those on Home.
    get pinned() {
        const names = this._settings.get_value('names').deepUnpack();
        const hidden = new Set(this._settings.get_strv('home-hidden'));
        return this.devices.filter(device => device.primary.kind === 'camera' && device.online !== false &&
            this._stills.has(device.did) && !hidden.has(device.did))
            .sort((a, b) => (names[a.did] || a.name).localeCompare(names[b.did] || b.name))[0] ?? null;
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
            this._tabButtons.get(null)?.set_active(true);
        }

        // A focused tile or fold about to go would pass the focus to the first widget left, and
        // the page would scroll up to it.
        const root = this.get_root();
        if (root?.get_focus()?.is_ancestor(this._body))
            root.set_focus(null);
        for (let child = this._body.get_first_child(); child; child = this._body.get_first_child())
            this._body.remove(child);
        this._wide.forEach(card => card.forget());
        this._wide = [];
        this._wideKey = null;
        this._tiles = [];
        this._summaries = [];
        this._was = this._keys;
        this._keys = new Set();
        this._rising = animating();
        this._risen = 0;
        const shown = this._shown(devices);
        this._layout = layoutKey(shown);
        if (shown.length === 0 && this._stack.visible_child_name !== 'empty')
            this._fillWelcome();
        this._stack.visible_child_name = shown.length > 0 ? 'grid' : 'empty';
        const byName = (a, b) => (names[a.did] || a.name).localeCompare(names[b.did] || b.name);
        const hidden = new Set(this._settings.get_strv('home-hidden'));
        const here = this._here(shown);
        this._wideRow = new Gtk.FlowBox({
            homogeneous: true,
            max_children_per_line: 2,
            column_spacing: 14,
            row_spacing: 14,
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['nook-wide-row'],
        });
        this._body.append(this._wideRow);
        this._fillWide(here, true);
        for (const [id] of SECTIONS) {
            const own = here.filter(device => sectionOf(device) === id).sort(byName);
            if (own.length === 0)
                continue;
            const summary = new Gtk.Label({label: sectionSummary(id, own), css_classes: ['dim-label', 'nook-count']});
            this._summaries.push([summary, id, own]);
            const from = this._tiles.length;
            this._fold(sectionTitle(id), this._grid(own, id === 'cameras', names, icons), summary, `home:${id}`, true);
            // After their title. Unavailable and hidden ones don't count: one back in its section
            // turns up there.
            this._tiles.slice(from).forEach(tile => this._rise(tile, tile.device.did));
        }

        // Not answering, then hidden: folded last, so they don't crowd the rest.
        const gone = shown.filter(device => unavailable(device) && !hidden.has(device.did)).sort(byName);
        const count = list => new Gtk.Label({label: String(list.length), css_classes: ['dim-label', 'nook-count']});
        if (gone.length > 0)
            this._fold(_('Unavailable'), this._grid(gone, false, names, icons), count(gone), 'unavailable', false);
        const put = shown.filter(device => hidden.has(device.did)).sort(byName);
        if (put.length > 0)
            this._fold(_('Hidden'), this._grid(put, false, names, icons), count(put), 'hidden', false);
        this.emit('pin-changed');
    }

    _shown(devices) {
        return devices.filter(device => !this._room || device.room?.toLocaleLowerCase() === this._room);
    }

    // Of those shown, the ones in the sections: answering and not hidden.
    _here(shown) {
        const hidden = new Set(this._settings.get_strv('home-hidden'));
        return shown.filter(device => !unavailable(device) && !hidden.has(device.did));
    }

    // Refilled when which devices it shows changes, else its cards follow theirs. fresh: in a
    // page _render() builds.
    _fillWide(here, fresh = false) {
        const names = this._settings.get_value('names').deepUnpack();
        const byName = (a, b) => (names[a.did] || a.name).localeCompare(names[b.did] || b.name);
        const media = here.filter(device => device.primary.kind === 'media' && device.online !== false && device.state?.media);
        // A speaker playing in a group shown here is in that group's card.
        const players = media.filter(device => !media.some(other => other !== device && other.name === device.state.group));
        const aircons = here.filter(device => device.primary.kind === 'climate' && device.state?.Pow === 1 && device.caps);
        const devices = [...players.sort(byName), ...aircons.sort(byName)];
        const key = devices.map(device => device.did).join(' ');
        if (key === this._wideKey) {
            this._wide.forEach(card => card.sync());
            return;
        }
        this._wideKey = key;
        if (!fresh) {
            this._was = new Set(this._keys);
            this._rising = animating();
            this._risen = 0;
        }
        // As in _render(): no focus left to pass up the page.
        const root = this.get_root();
        if (root?.get_focus()?.is_ancestor(this._wideRow))
            root.set_focus(null);
        for (const card of this._wide) {
            card.forget();
            this._keys.delete(`wide ${card.device.did}`);
        }
        this._wideRow.remove_all();
        this._wide = devices.map(device => (device.primary.kind === 'media' ? new PlayerCard(device, this) : new AirconCard(device, this)));
        for (const card of this._wide) {
            this._wideRow.append(card);
            card.get_parent().focusable = false;
            this._rise(card, `wide ${card.device.did}`);
        }
        this._wideRow.visible = this._wide.length > 0;
    }

    _rise(widget, key) {
        this._keys.add(key);
        if (!this._rising || this._was.has(key))
            return;
        widget.add_css_class('nook-rise');
        widget.add_css_class(`nook-rise-${Math.min(this._risen++, RISE_LAST)}`);
    }

    // A titled block that its title folds; kept: the fold is saved in folded-groups, else
    // it starts folded each time.
    _fold(title, child, after, key, kept) {
        const folded = kept ? this._settings.get_strv('folded-groups').includes(key) : !this._unfolded.has(key);
        // The count follows the title, on its baseline; an empty one takes no room.
        const line = new Gtk.Box({spacing: 8});
        line.append(new Gtk.Label({label: title, xalign: 0, valign: Gtk.Align.BASELINE_CENTER, css_classes: ['title-4']}));
        after.valign = Gtk.Align.BASELINE_CENTER;
        const fit = () => {
            after.visible = after.label !== '';
        };
        fit();
        after.connect('notify::label', fit);
        line.append(after);
        line.append(new Gtk.Image({icon_name: 'pan-down-symbolic', css_classes: ['nook-chevron']}));
        const toggle = new Gtk.Button({child: line, halign: Gtk.Align.START, css_classes: ['flat', 'nook-fold-toggle']});
        const header = new Gtk.Box({css_classes: ['nook-section', ...this._body.get_last_child() === this._wideRow ? ['first'] : []]});
        header.append(toggle);
        this._rise(header, key);
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
            max_children_per_line: cameras ? 6 : 12,
            column_spacing: 14,
            row_spacing: 14,
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
        tile.setWidth((TILE_WIDTHS[this._settings.get_string('tile-size')] ?? TILE_WIDTHS.medium)[0]);
        tile.connect('toggle', () => this._toggle(device).catch(logError));
        tile.connect('open', () => this.emit('open-device', device));
        tile.connect('menu', (_tile, x, y) => this._popup(tile, x, y));
        return tile;
    }

    _cameraTile(device, names) {
        const tile = new CameraTile(device, names[device.did] || device.name);
        tile.setWidth((TILE_WIDTHS[this._settings.get_string('tile-size')] ?? TILE_WIDTHS.medium)[1]);
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
        const shown = this._shown(this.devices);
        if (layoutKey(shown) !== this._layout) {
            this._render();
        } else {
            this._tiles.forEach(tile => tile.sync());
            this._fillWide(this._here(shown));
        }
        for (const [label, id, own] of this._summaries)
            label.label = sectionSummary(id, own);
        this.devicePage?.sync();
    }

    async _toggle(device) {
        if (!switchable(device) && !powered(device))
            return;
        const {values, state} = device;
        const on = !isOn(device);
        // Shown at once; the unit's answer or the next read corrects it.
        if (device.primary.kind === 'switch')
            device.values = [on, ...values?.slice(1) ?? []];
        else if (state && device.primary.kind === 'climate')
            device.state = {...state, Pow: on ? 1 : 0};
        else if (state)
            device.state = {...state, on};
        this._sync();
        try {
            await device.source.setSwitch(device, on);
        } catch (e) {
            device.values = values;
            device.state = state;
            this.get_root()?.add_toast?.(new Adw.Toast({title: e.message}));
        }
        this._sync();
    }

    toggle(device) {
        return this._toggle(device);
    }
});
