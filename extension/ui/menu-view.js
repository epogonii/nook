// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {arrange} from '../lib/arrange.js';
import {ColumnsLayout} from './layouts.js';
import {isBluetooth} from './rows.js';
import {VERTICAL, readSetting} from './text.js';
import {NowPlaying, SECTIONS, SceneChip, Tile, groupRooms, roomLabels, sceneCount, sectionSummary, sectionTitle, tileSection}
    from './tiles.js';
import {Glyph} from './widgets.js';

const BRAND = /^(Xiaomi Smart|Xiaomi|Mi Smart|Mi)\s+/;

function shortName(name) {
    const rest = name.replace(BRAND, '');
    return rest.length >= 3 ? rest : name;
}

const PINNED = '@pinned';
const SCENES = '@scenes';
const isScene = device => device.primary.kind === 'scene';
const TAB_GLYPHS = {
    scenes: 'sparkle',
    lights: 'bulb',
    climate: 'thermometer',
    media: 'tv',
    cameras: 'camera',
    security: 'shield',
    appliances: 'appliance',
};
// Seven with Home; past five they lose their labels.
const MAX_TABS = 6;

export class MenuView {
    _render() {
        if (!this._sources().some(Boolean))
            return;
        // Pin/hide from an open card writes settings; only its header needs updating.
        if (this._card) {
            this._syncCardHeader();
            return;
        }
        this._clear();

        const view = readSetting(this._settings, 'view');
        this._quietHeader(view === 'control');
        this._title.text = this._home?.homeName ?? _('Nook');

        const choices = this._choices();
        let devices = arrange(this._devices(), choices);
        if (devices.length === 0) {
            const miOnly = this._home && !this._sources().some(source => source && source !== this._home && source !== this._miScenes);
            this._message(miOnly ? _('No devices in this Mi Home account.')
                : _('No devices to show. Add them, or show hidden ones, in Settings.'));
            if (this._loginNote)
                this._addLoginNote();
            return;
        }
        this._drawnOffline = this._offlineKey();

        if (readSetting(this._settings, 'sort-by-name'))
            devices = [...devices].sort((a, b) => this._nameOf(a).localeCompare(this._nameOf(b)));
        const icons = readSetting(this._settings, 'icons');
        const extras = this._home?.extras ?? [];
        const inSection = id => (device, extra = null) => tileSection(device, extra, icons) === id;
        const holds = id => device => inSection(id)(device) ||
            extras.some(e => e.did === device.did && inSection(id)(device, e));
        const pane = this._syncSwitcher(id => devices.filter(holds(id)).length);
        if (pane !== 'home') {
            const members = devices.filter(holds(pane));
            if (view === 'control')
                this._addModules(members, inSection(pane));
            else
                this._addTiles(members, ...{grid: [3, 'square'], rooms: [2, 'compact']}[view] ?? [2, 'wide'], inSection(pane));
            this._syncSort();
            if (this._loginNote)
                this._addLoginNote();
            this._roomForSwitcher();
            return;
        }
        // The Scenes tab has them all.
        if (this._panes.get('scenes')?.visible)
            devices = devices.filter(d => !isScene(d));

        if (devices.some(isScene) && readSetting(this._settings, 'scenes-compact')) {
            this._addSceneRow(devices.filter(isScene));
            devices = devices.filter(d => !isScene(d));
        }
        let pinned = devices.filter(d => choices.pinned.includes(d.did));
        // Scenes are no room's devices: a group of their own, and no room tab.
        const rooms = groupRooms(devices.filter(d => !isScene(d) && !(view === 'rooms' && pinned.includes(d))));
        const scenes = devices.filter(d => isScene(d) && !pinned.includes(d));
        if (view === 'rooms' && scenes.length > 0)
            rooms.unshift({key: SCENES, name: _('Scenes'), devices: scenes});
        if (pinned.length > 0)
            rooms.unshift({key: PINNED, name: _('Pinned'), devices: pinned});

        // The rooms view lists every room already: no picker there.
        let current = '';
        if (view === 'rooms') {
            this._syncRoomBar(false, '');
        } else {
            const hiddenRooms = readSetting(this._settings, 'hidden-rooms');
            const shown = rooms.filter(r => !hiddenRooms.includes(r.key));
            current = readSetting(this._settings, 'room');
            if (!shown.some(r => r.key === current))
                current = '';
            const choosing = rooms.length > 1 && shown.length > 0;
            if (choosing) {
                const tabs = [['', _('All')], ...shown.map(r => [r.key, r.name ?? _('Other')])];
                for (const [key, label] of tabs)
                    this._addChip(key, label, current);
            }
            this._syncRoomBar(choosing, current ? shown.find(r => r.key === current).name ?? _('Other') : _('All Rooms'));
            if (current && view !== 'tabs') {
                devices = rooms.find(r => r.key === current).devices;
                pinned = pinned.filter(d => devices.includes(d));
            }
        }

        if (view === 'control') {
            this._addModules(devices);
        } else if (view === 'grid') {
            this._addSections(devices, pinned, 3, 'square');
        } else if (view === 'rooms') {
            for (const room of rooms) {
                if (room.key === SCENES) {
                    this._addFoldedScenes(room.devices, 2, 'compact');
                    continue;
                }
                this._body.add_child(new St.Label({
                    style_class: 'nook-room',
                    text: room.name ?? _('Other'),
                }));
                this._addTiles(room.devices, 2, 'compact');
            }
        } else if (current) {
            this._addTiles(rooms.find(r => r.key === current).devices, 2, 'wide');
        } else {
            this._addSections(devices, pinned, 2, 'wide');
        }
        this._syncSort();
        if (this._loginNote)
            this._addLoginNote();
        this._roomForSwitcher();
    }

    // Not body padding: the body clips its children to inside it, so tiles would stop short
    // of the switcher instead of passing under it.
    _roomForSwitcher() {
        if (this._switcher.visible && this._switcherStyle === 'floating')
            this._body.add_child(new St.Widget({style_class: 'nook-switcher-room'}));
    }

    _addSections(devices, pinned, columns, shape) {
        const sections = [
            [_('Pinned'), []],
            [_('Scenes'), []],
            [_('Controls'), []],
            [_('Speakers'), []],
            [_('TVs'), []],
            [_('Cameras'), []],
            [_('Sensors'), []],
            [_('Offline'), []],
        ];
        for (const device of devices) {
            let index;
            if (pinned.includes(device))
                index = 0;
            else if (device.online === false && !isBluetooth(device))
                index = 7;
            else if (isScene(device))
                index = 1;
            else if (['switch', 'climate'].includes(device.primary.kind))
                index = 2;
            else if (device.primary.kind === 'media')
                index = 3;
            else if (device.primary.kind === 'tv')
                index = 4;
            else if (device.primary.kind === 'camera')
                index = 5;
            else
                index = 6;
            sections[index][1].push(device);
        }
        sections.forEach(([title, members], index) => {
            if (members.length === 0)
                return;
            if (index === 1) {
                this._addFoldedScenes(members, columns, shape);
                return;
            }
            this._body.add_child(new St.Label({style_class: 'nook-room', text: title}));
            this._addTiles(members, columns, shape);
        });
    }

    // Scenes fold away under their heading, the card's Device Info way; the choice holds
    // for every view.
    _foldButton(title, summary, styleClass) {
        const folded = readSetting(this._settings, 'scenes-folded');
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const line = new St.BoxLayout({style_class: 'nook-fold-line', x_expand: true});
        line.add_child(title);
        line.add_child(new St.Icon({
            style_class: 'nook-fold-arrow',
            icon_size: 12,
            icon_name: folded ? `pan-${rtl ? 'start' : 'end'}-symbolic` : 'pan-down-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const box = new St.BoxLayout({x_expand: true});
        box.add_child(line);
        box.add_child(summary);
        const button = new St.Button({
            style_class: `${styleClass} nook-fold`,
            child: box,
            accessible_name: folded ? _('Show Scenes') : _('Hide Scenes'),
            can_focus: true,
            x_expand: true,
        });
        button.connect('clicked', () => this._settings.set_boolean('scenes-folded', !folded));
        return [button, folded];
    }

    _addFoldedScenes(scenes, columns, shape) {
        const title = new St.Label({text: _('Scenes'), y_align: Clutter.ActorAlign.CENTER});
        const count = new St.Label({style_class: 'nook-fold-count', text: sceneCount(scenes.length), y_align: Clutter.ActorAlign.CENTER});
        const [button, folded] = this._foldButton(title, count, 'nook-room');
        this._body.add_child(button);
        if (!folded)
            this._addTiles(scenes, columns, shape);
    }

    // Compact scenes: one line of chips under the header.
    _addSceneRow(scenes) {
        const row = new St.BoxLayout({style_class: 'nook-scene-row'});
        const scroll = new St.ScrollView({
            style_class: 'nook-scene-scroll',
            child: row,
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: false,
            x_expand: true,
        });
        for (const device of scenes) {
            const chip = new SceneChip(device, this._nameOf(device), d => this._openCard(d).catch(logError));
            // Keyboard focus brings a chip past either edge into view.
            chip.connect('key-focus-in', () => {
                const adjustment = scroll.hadjustment;
                const {x1, x2} = chip.get_allocation_box();
                if (x1 < adjustment.value)
                    adjustment.value = x1;
                else if (x2 > adjustment.value + adjustment.page_size)
                    adjustment.value = x2 - adjustment.page_size;
            });
            this._tiles.push(chip);
            row.add_child(chip);
        }
        // The wheel moves the row while it has further to go; past either end, and when
        // it all fits, the menu scrolls as usual. Steps as in St.ScrollView.
        scroll.connect('scroll-event', (_actor, event) => {
            const adjustment = scroll.hadjustment;
            const end = adjustment.upper - adjustment.page_size;
            let delta;
            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                delta = -1;
                break;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                delta = 1;
                break;
            default: {
                const [dx, dy] = event.get_scroll_delta();
                delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            }
            }
            if (end <= adjustment.lower || (delta < 0 && adjustment.value <= adjustment.lower) || (delta > 0 && adjustment.value >= end))
                return Clutter.EVENT_PROPAGATE;
            // A wheel sends smooth events and discrete ones emulated from them: use one kind.
            if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
                return Clutter.EVENT_STOP;
            adjustment.value = Math.min(end, Math.max(adjustment.lower, adjustment.value + delta * adjustment.page_size ** (2 / 3)));
            return Clutter.EVENT_STOP;
        });
        this._body.add_child(scroll);
    }

    _addChip(key, label, current) {
        const text = new St.Label({text: label});
        text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const chip = new St.Button({
            style_class: 'nook-chip',
            child: text,
            can_focus: true,
            checked: key === current,
        });
        chip.connect('clicked', () => {
            if (chip.has_key_focus())
                this._roomPick.grab_key_focus();
            this._foldRooms(false);
            this._settings.set_string('room', key);
        });
        this._chips.add_child(chip);
    }

    _syncRoomBar(choosing, label) {
        this._roomBar.visible = choosing;
        this._roomLabel.text = label;
        this._chips.visible = choosing && this._roomsOpen;
    }

    _syncSort() {
        const byName = readSetting(this._settings, 'sort-by-name');
        this._sortButton.visible = true;
        this._sortButton.checked = byName;
        this._sortButton.accessible_name = byName ? _('Sort in Your Order') : _('Sort by Name');
    }

    _foldRooms(open) {
        this._roomsOpen = open;
        this._chips.visible = open && this._chips.get_n_children() > 0;
        this._roomPick.checked = open;
        this._roomArrow.icon_name = open ? 'pan-up-symbolic' : 'pan-down-symbolic';
    }

    // Bar: a row of tabs under the tiles. Floating: a pill over their bottom edge.
    _buildSwitcher() {
        this._switcher?.destroy();
        const style = this._switcherStyle = readSetting(this._settings, 'switcher-style');
        const floating = style === 'floating';
        const auto = readSetting(this._settings, 'switcher-auto');
        const chosen = readSetting(this._settings, 'switcher-tabs');
        const tabs = [['home', 'home', pgettext('menu pane', 'Home')],
            ...SECTIONS.filter(([id]) => auto || chosen.includes(id)).map(([id]) => [id, TAB_GLYPHS[id], sectionTitle(id)])];
        this._switcher = new St.BoxLayout({
            style_class: floating ? 'nook-switcher' : 'nook-tabbar',
            x_expand: true,
            y_expand: floating,
            x_align: floating ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        this._switcher.layout_manager.homogeneous = !floating;
        this._panes = new Map(tabs.map(([key, glyph, text]) => {
            const box = new St.BoxLayout({
                style_class: floating ? 'nook-switcher-box' : 'nook-tabbar-box',
                ...floating ? {} : VERTICAL,
            });
            box.add_child(new Glyph(glyph));
            const label = new St.Label({text, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            box.add_child(label);
            const button = new St.Button({
                style_class: floating ? 'nook-switcher-tab' : 'nook-tabbar-tab',
                child: box,
                accessible_name: text,
                can_focus: true,
                x_expand: !floating,
            });
            button._label = label;
            button.connect('clicked', () => this._showPane(key));
            this._switcher.add_child(button);
            return [key, button];
        }));
        if (floating)
            this._stack.add_child(this._switcher);
        else
            this._panel.insert_child_above(this._switcher, this._stack);
    }

    // Home always, a chosen tab while its section has something, at most the six fullest
    // in their usual order. Returns the pane to draw.
    _syncSwitcher(count) {
        const style = this._switcherStyle;
        const counts = new Map([...this._panes.keys()].filter(key => key !== 'home').map(key => [key, count(key)]));
        let shown = style === 'none' ? [] : [...counts.keys()].filter(key => counts.get(key) > 0);
        const top = [...shown].sort((a, b) => counts.get(b) - counts.get(a)).slice(0, MAX_TABS);
        shown = shown.filter(key => top.includes(key));
        if (!shown.includes(this._pane))
            this._pane = 'home';
        // Labelled tabs fit about three in the pill, five in the bar. Past that the pill keeps
        // the current one's label; the bar's equal slots are too narrow for it, so icons only.
        const floating = style === 'floating';
        const labels = shown.length < (floating ? 3 : 5);
        this._switcher[labels || floating ? 'remove_style_class_name' : 'add_style_class_name']('nook-tabbar-icons');
        for (const [key, button] of this._panes) {
            button.visible = key === 'home' || shown.includes(key);
            button.checked = key === this._pane;
            button._label.visible = labels || (floating && button.checked);
        }
        this._switcher.visible = shown.length > 0;
        return this._pane;
    }

    _showPane(key) {
        if (key === this._pane)
            return;
        this._pane = key;
        this._scroll.vadjustment.value = 0;
        this._render();
    }


    // keep: a pane's test for a device or one of its extras.
    _addTiles(devices, columns, shape, keep = null) {
        const extras = this._home?.extras ?? [];
        const items = devices.flatMap(device => [
            [device, null],
            ...extras.filter(e => e.did === device.did).map(e => [device, e]),
        ]).filter(item => !keep || keep(...item));

        let row = null;
        items.forEach(([device, extra], i) => {
            if (i % columns === 0) {
                row = new St.BoxLayout({style_class: 'nook-row', x_expand: true});
                row.layout_manager.homogeneous = true;
                this._body.add_child(row);
            }
            row.add_child(this._newTile(device, shape, extra));
        });
        // Pad the last row, or its tiles stretch across it.
        for (let i = items.length % columns; i > 0 && i < columns; i++)
            row.add_child(new St.Widget({x_expand: true}));
    }

    _newTile(device, shape, extra = null, {drop = null, label = null, synced = null} = {}) {
        const tile = new Tile(this._home, device, {
            shape,
            typeColors: readSetting(this._settings, 'type-colors'),
            name: this._nameOf(device),
            label,
            icon: readSetting(this._settings, 'icons')[device.did] ?? '',
            extra,
            openCard: d => this._openCard(d).catch(logError),
            awaits: d => this._awaits(d),
            drop,
            synced,
        });
        this._tiles.push(tile);
        return tile;
    }

    // Control Center style: the user's groups, then a module per section, two tiles a line.
    // keep: as in _addTiles; in a pane the scenes don't fold, they are all there is.
    _addModules(devices, keep = null) {
        const extras = this._home?.extras ?? [];
        const named = readSetting(this._settings, 'groups');
        const icons = readSetting(this._settings, 'icons');
        const names = readSetting(this._settings, 'names');
        const groups = new Map();
        const sections = new Map(SECTIONS.map(([id]) => [id, []]));
        for (const device of devices) {
            const items = [[device, null], ...extras.filter(e => e.did === device.did).map(e => [device, e])]
                .filter(item => !keep || keep(...item));
            if (items.length === 0)
                continue;
            const name = named[device.did];
            if (name !== undefined) {
                if (!groups.has(name))
                    groups.set(name, []);
                groups.get(name).push(...items);
                continue;
            }
            for (const item of items)
                sections.get(tileSection(...item, icons)).push(item);
        }

        const speakers = [];
        const gone = ([device]) => device.online === false && !isBluetooth(device);
        const module = (items, synced = null) => {
            const labels = roomLabels(items, names);
            const grid = new St.Widget({layout_manager: new ColumnsLayout(2, 2), x_expand: true});
            // Offline last; the sort is stable.
            const tiles = [...items].sort((a, b) => gone(a) - gone(b)).map(([device, extra]) => {
                const tile = this._newTile(device, 'row', extra, {
                    drop: this._drop,
                    label: extra ? null : labels.get(device.did) ?? null,
                    synced,
                });
                if (device.primary.kind === 'media' && !extra)
                    speakers.push(tile);
                grid.add_child(tile);
                return tile;
            });
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-cc-module', x_expand: true});
            box.add_child(grid);
            return [box, tiles, grid];
        };

        for (const [name, items] of groups) {
            const [box] = module(items);
            box.insert_child_at_index(this._groupTitle(name, box), 0);
            const members = items.filter(([, extra]) => !extra).map(([device]) => device.did);
            box._delegate = this._drop.group(name, members, box);
            this._body.add_child(box);
        }
        const boxes = new Map();
        for (const [id] of SECTIONS) {
            if (sections.get(id).length === 0)
                continue;
            const summary = new St.Label({style_class: 'nook-cc-summary', y_align: Clutter.ActorAlign.CENTER});
            const tiles = [];
            const sum = () => {
                summary.text = sectionSummary(id, tiles);
            };
            const [box, made, grid] = module(sections.get(id), sum);
            tiles.push(...made);
            sum();
            if (id === 'scenes' && !keep) {
                const title = new St.Label({style_class: 'nook-cc-section', text: sectionTitle(id), y_align: Clutter.ActorAlign.CENTER});
                const [button, folded] = this._foldButton(title, summary, 'nook-cc-head');
                box.insert_child_at_index(button, 0);
                // Folded, the tiles stay: they keep the summary current.
                grid.visible = !folded;
                boxes.set(id, box);
                continue;
            }
            const head = new St.BoxLayout({style_class: 'nook-cc-head', x_expand: true});
            head.add_child(new St.Label({
                style_class: 'nook-cc-section',
                text: sectionTitle(id),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            head.add_child(summary);
            box.insert_child_at_index(head, 0);
            boxes.set(id, box);
        }
        let playing = null;
        if (speakers.length > 0) {
            playing = new NowPlaying(speakers.map(tile => tile.device), speakers, {
                nameOf: device => this._nameOf(device),
                openCard: device => this._openCard(device).catch(logError),
                act: (device, action) => this._castDo(device, () => action(device.source)),
            });
            this._tiles.push(playing);
        }
        for (const [id] of SECTIONS) {
            // The player keeps the media section's place, with or without it.
            if (id === 'media' && playing)
                this._body.add_child(playing);
            if (boxes.has(id))
                this._body.add_child(boxes.get(id));
        }
    }

    _groupTitle(name, box) {
        const title = new St.Button({
            style_class: 'nook-cc-group-title',
            label: name,
            accessible_name: _('Rename Group'),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        title.connect('clicked', () => {
            const entry = new St.Entry({style_class: 'nook-cc-group-entry', text: name, can_focus: true, x_expand: true});
            let done = false;
            const commit = () => {
                if (done)
                    return;
                done = true;
                const text = entry.text.trim();
                // Not destroyed with the key focus: the input method would keep it.
                const focused = entry.clutter_text.has_key_focus();
                if (text && text !== name) {
                    if (focused)
                        this._menu.actor.grab_key_focus();
                    this._drop.rename(name, text);
                } else if (entry.get_parent() === box) {
                    box.replace_child(entry, title);
                    if (focused)
                        title.grab_key_focus();
                    entry.destroy();
                }
            };
            entry.connect('destroy', () => {
                done = true;
            });
            entry.clutter_text.connect('activate', commit);
            entry.clutter_text.connect('key-focus-out', commit);
            box.replace_child(title, entry);
            entry.grab_key_focus();
            entry.clutter_text.set_selection(0, -1);
        });
        return title;
    }

    _nameOf(device) {
        return readSetting(this._settings, 'names')[device.did] || shortName(device.name);
    }
}
