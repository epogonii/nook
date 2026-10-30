// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _, ngettext, pgettext} from 'gettext';

import {isLight} from './device.js';
import {listDevices} from './devices.js';
import {arrange, move} from './lib/arrange.js';
import {navigationRow, sidebarButton, subpage} from './widgets.js';

const PROJECT_URL = 'https://github.com/epogonii/nook';

const rgbaOf = rgb => new Gdk.RGBA({red: ((rgb >> 16) & 255) / 255, green: ((rgb >> 8) & 255) / 255, blue: (rgb & 255) / 255, alpha: 1});
const rgbOf = ({red, green, blue}) => (Math.round(red * 255) << 16) | (Math.round(green * 255) << 8) | Math.round(blue * 255);

function choiceRow(menu, key, choices, props) {
    const row = new Adw.ComboRow({...props, model: Gtk.StringList.new(choices.map(([, label]) => label))});
    const sync = () => {
        const i = choices.findIndex(([value]) => value === menu.get_string(key));
        row.selected = Math.max(i, 0);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== menu.get_string(key))
            menu.set_string(key, value);
    });
    const handler = menu.connect(`changed::${key}`, sync);
    row.connect('destroy', () => menu.disconnect(handler));
    return row;
}

function switchRow(menu, key, props) {
    const row = new Adw.SwitchRow(props);
    menu.bind(key, row, 'active');
    return row;
}

function toggle(menu, key, did, on) {
    const list = menu.get_strv(key).filter(d => d !== did);
    menu.set_strv(key, on ? [...list, did] : list);
}

function lightCount(menu, key, lights) {
    const count = menu.get_strv(key).filter(did => lights.some(d => d.did === did)).length;
    return count > 0 ? ngettext('%d light', '%d lights', count).replace('%d', String(count)) : _('None');
}

const nameOf = (settings, device) => settings.get_value('names').deepUnpack()[device.did] || device.name;

function placementGroup(menu) {
    const group = new Adw.PreferencesGroup({title: _('Placement')});
    group.add(choiceRow(menu, 'location', [
        ['panel', _('Top bar button')],
        ['quick-settings', _('Quick Settings')],
    ], {
        title: _('Location'),
        subtitle: _('A button of its own, or a tile next to Wi-Fi and Bluetooth.'),
    }));
    const box = choiceRow(menu, 'panel-box', [
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
    menu.bind('panel-index', index, 'value');
    group.add(index);
    const middle = choiceRow(menu, 'middle-click', [
        ['none', _('Nothing')],
        ['refresh', _('Find devices again')],
        ['settings', _('Open these settings')],
    ], {
        title: _('Middle Click'),
        subtitle: _('On the button in the top bar.'),
    });
    group.add(middle);
    const hover = switchRow(menu, 'hover-switch', {
        title: _('Switch Menus on Hover'),
        subtitle: _('Pointing at another top bar button closes Nook and opens that menu. Off: Nook stays open until a click outside it.'),
    });
    group.add(hover);
    const follow = () => {
        const own = menu.get_string('location') === 'panel';
        for (const row of [box, index, middle, hover])
            row.sensitive = own;
    };
    follow();
    const handler = menu.connect('changed::location', follow);
    group.connect('destroy', () => menu.disconnect(handler));
    return group;
}

function menuGroup(menu) {
    const group = new Adw.PreferencesGroup({title: _('Menu')});
    group.add(choiceRow(menu, 'view', [
        ['tabs', _('Rooms as tabs')],
        ['grid', _('Small tiles')],
        ['rooms', _('Tiles by room')],
        ['control', _('Modules')],
    ], {
        title: _('View'),
        subtitle: _('How the menu lays out the devices.'),
    }));
    group.add(switchRow(menu, 'type-colors', {
        title: _('Colour by Device Type'),
        subtitle: _('Fans, lights and sensors each get a colour of their own instead of the accent colour.'),
    }));
    const scenes = switchRow(menu, 'scenes-compact', {
        title: _('Compact Scenes'),
        subtitle: _('Scenes as one row of buttons under the header, instead of a section of their own.'),
    });
    group.add(scenes);
    group.add(choiceRow(menu, 'switcher-style', [
        ['bar', _('Static')],
        ['floating', _('Floating')],
        ['none', _('None')],
    ], {
        title: _('Tabs at the Bottom'),
        subtitle: _('Home and the sections chosen below, while they have devices.'),
    }));

    const sections = [
        ['scenes', _('Scenes')],
        ['lights', _('Lights')],
        ['climate', _('Climate')],
        ['media', _('Media')],
        ['cameras', _('Cameras')],
        ['security', _('Security')],
        ['appliances', _('Appliances')],
    ];
    const tabRows = new Adw.ExpanderRow({title: _('Tabs')});
    tabRows.add_row(switchRow(menu, 'switcher-auto', {
        title: _('Automatic'),
        subtitle: _('Up to six sections with the most devices.'),
    }));
    const tabs = sections.map(([id, title]) => {
        const row = new Adw.SwitchRow({title});
        row.connect('notify::active', () => {
            const chosen = menu.get_strv('switcher-tabs');
            if (chosen.includes(id) !== row.active)
                menu.set_strv('switcher-tabs', row.active ? [...chosen, id] : chosen.filter(t => t !== id));
        });
        tabRows.add_row(row);
        return [id, row];
    });
    group.add(tabRows);

    const follow = () => {
        const auto = menu.get_boolean('switcher-auto');
        const chosen = menu.get_strv('switcher-tabs');
        // The bar holds six tabs next to Home.
        const full = chosen.filter(id => sections.some(([section]) => section === id)).length >= 6;
        for (const [id, row] of tabs) {
            row.active = chosen.includes(id);
            row.visible = !auto;
            row.sensitive = row.active || !full;
        }
        const titles = sections.filter(([id]) => chosen.includes(id)).map(([, title]) => title);
        tabRows.subtitle = GLib.markup_escape_text(auto ? _('Automatic')
            : titles.length > 0 ? titles.join(', ') : _('None'), -1);
        const shown = menu.get_string('switcher-style') !== 'none';
        tabRows.sensitive = shown;
        // The Scenes tab takes the scenes out of Home; an automatic one may or may not be there.
        scenes.sensitive = !shown || auto || !chosen.includes('scenes');
    };
    follow();
    const handlers = ['changed::switcher-style', 'changed::switcher-auto', 'changed::switcher-tabs']
        .map(signal => menu.connect(signal, follow));
    group.connect('destroy', () => handlers.forEach(handler => menu.disconnect(handler)));
    return group;
}

// Rooms are keyed by lower-cased name, as the extension merges same-named rooms.
function roomTabsContent(menu, devices) {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        description: _('The tabs shown over the tiles. A room left out keeps its devices under All.'),
    });
    const names = new Map();
    for (const device of devices) {
        if (typeof device.room === 'string' && device.room)
            names.set(device.room.toLocaleLowerCase(), device.room);
    }
    const rooms = [['@pinned', _('Pinned')], ...[...names].sort((a, b) => a[1].localeCompare(b[1])), ['@other', _('Other')]];
    const rows = rooms.map(([key, name]) => {
        const row = new Adw.SwitchRow({title: GLib.markup_escape_text(name, -1)});
        row.connect('notify::active', () => {
            const was = menu.get_strv('hidden-rooms');
            if (was.includes(key) !== row.active)
                return;
            menu.set_strv('hidden-rooms', row.active ? was.filter(k => k !== key) : [...was, key]);
        });
        group.add(row);
        return [key, row];
    });
    const all = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat']});
    all.connect('clicked', () => {
        const hidden = menu.get_strv('hidden-rooms');
        const listed = rooms.map(([key]) => key);
        const others = hidden.filter(key => !listed.includes(key));
        menu.set_strv('hidden-rooms', listed.some(key => hidden.includes(key)) ? others : [...others, ...listed]);
    });
    group.header_suffix = all;
    const sync = () => {
        const hidden = menu.get_strv('hidden-rooms');
        for (const [key, row] of rows)
            row.active = !hidden.includes(key);
        all.label = rows.some(([key]) => hidden.includes(key)) ? _('Show All') : _('Hide All');
    };
    sync();
    const handler = menu.connect('changed::hidden-rooms', sync);
    page.connect('destroy', () => menu.disconnect(handler));
    page.add(group);
    return page;
}

function iconToggle(icons, tooltip, active, onToggled) {
    const button = new Gtk.ToggleButton({
        icon_name: active ? icons[0] : icons[1],
        tooltip_text: tooltip,
        active,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('toggled', () => {
        button.icon_name = button.active ? icons[0] : icons[1];
        onToggled(button.active);
    });
    return button;
}

// The menu's order, pins and hidden devices; rows drag to move a tile.
function orderContent(menu, settings, found) {
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        description: _('Drag a row to move its tile. Pinned devices come first and have a tab of their own.'),
    });
    const list = key => menu.get_strv(key);
    let rows = [];
    const fill = () => {
        rows.forEach(row => group.remove(row));
        const devices = arrange(found, {pinned: list('pinned'), order: list('order'), hidden: list('hidden')}, true);
        const ids = devices.map(d => d.did);
        rows = devices.map(device => {
            const hidden = list('hidden').includes(device.did);
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(nameOf(settings, device), -1),
                subtitle: GLib.markup_escape_text(device.room ?? _('No room'), -1),
            });
            if (hidden)
                row.add_css_class('dim-label');
            row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic'}));
            row.add_suffix(iconToggle(['focus-top-bar-symbolic', 'focus-top-bar-symbolic'], _('Show in the top bar'),
                list('panel-sensors').includes(device.did), on => toggle(menu, 'panel-sensors', device.did, on)));
            row.add_suffix(iconToggle(['starred-symbolic', 'non-starred-symbolic'], _('Pin'),
                list('pinned').includes(device.did), on => toggle(menu, 'pinned', device.did, on)));
            row.add_suffix(iconToggle(['view-conceal-symbolic', 'view-reveal-symbolic'], _('Hide from the menu'),
                hidden, on => toggle(menu, 'hidden', device.did, on)));

            const drag = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
            drag.connect('prepare', () => Gdk.ContentProvider.new_for_value(device.did));
            drag.connect('drag-begin', source => source.set_icon(new Gtk.WidgetPaintable({widget: row}), 0, 0));
            row.add_controller(drag);
            const drop = new Gtk.DropTarget({actions: Gdk.DragAction.MOVE});
            drop.set_gtypes([GObject.TYPE_STRING]);
            drop.connect('drop', (_target, moved, _x, y) => {
                if (!ids.includes(moved))
                    return false;
                menu.set_strv('order', move(ids, moved, device.did, y > row.get_height() / 2));
                return true;
            });
            row.add_controller(drop);
            group.add(row);
            return row;
        });
    };
    fill();
    // Pins and hiding reorder the list, so the rows are made again.
    const handlers = ['order', 'pinned', 'hidden'].map(key => menu.connect(`changed::${key}`, () => {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            fill();
            return GLib.SOURCE_REMOVE;
        });
    }));
    page.connect('destroy', () => handlers.forEach(id => menu.disconnect(id)));
    page.add(group);
    return page;
}

function devicePicker(menu, settings, key, devices, description, onChanged = () => {}) {
    const group = new Adw.PreferencesGroup({description});
    for (const device of devices) {
        const row = new Adw.SwitchRow({
            title: GLib.markup_escape_text(nameOf(settings, device), -1),
            subtitle: GLib.markup_escape_text(device.room ?? _('No room'), -1),
            active: menu.get_strv(key).includes(device.did),
        });
        row.connect('notify::active', () => {
            if (menu.get_strv(key).includes(device.did) !== row.active)
                toggle(menu, key, device.did, row.active);
            onChanged();
        });
        group.add(row);
    }
    return group;
}

function readingsContent(menu, settings, devices) {
    const page = new Adw.PreferencesPage();
    const timing = new Adw.PreferencesGroup();
    const interval = new Adw.SpinRow({
        title: _('Read Every'),
        subtitle: _('Minutes. Each time is one small request to each account or device with a reading there, and none is made while the screen is locked.'),
        adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, page_increment: 5}),
    });
    menu.bind('panel-interval', interval, 'value');
    timing.add(interval);
    page.add(timing);
    page.add(devicePicker(menu, settings, 'panel-sensors', devices,
        _('Their reading or state shows next to the Nook icon.')));
    return page;
}

function notifyContent(menu, settings, lights) {
    const page = new Adw.PreferencesPage();
    const color = new Adw.PreferencesGroup({
        description: _('When one of the apps below sends a notification, the lights show the colour for a moment, then go back as they were. Lights without colour blink. Not with Do Not Disturb on or the screen locked.'),
    });
    const colorRow = new Adw.ActionRow({title: _('Colour')});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        rgba: rgbaOf(menu.get_uint('notify-color')),
        valign: Gtk.Align.CENTER,
    });
    button.connect('notify::rgba', () => menu.set_uint('notify-color', rgbOf(button.rgba)));
    colorRow.add_suffix(button);
    colorRow.activatable_widget = button;
    color.add(colorRow);
    page.add(color);

    const lightGroup = devicePicker(menu, settings, 'notify-lights', lights, null);
    lightGroup.title = _('Lights');
    page.add(lightGroup);

    const apps = new Adw.PreferencesGroup({title: _('Apps')});
    const known = menu.get_value('$apps')?.deepUnpack() ?? [];
    if (known.length === 0)
        apps.add(new Adw.ActionRow({title: _('No app has sent a notification yet')}));
    for (const [id, name] of known) {
        const row = new Adw.SwitchRow({
            title: GLib.markup_escape_text(name, -1),
            active: menu.get_strv('notify-apps').includes(id),
        });
        row.connect('notify::active', () => {
            if (menu.get_strv('notify-apps').includes(id) !== row.active)
                toggle(menu, 'notify-apps', id, row.active);
        });
        apps.add(row);
    }
    page.add(apps);
    return page;
}

// What the extension's own settings were: placement, the menu's look and its device lists.
export const TopBarPage = GObject.registerClass(
class TopBarPage extends Adw.NavigationPage {
    _init(menu, settings, home, nav) {
        super._init({title: _('Top Bar'), tag: 'top-bar'});
        this._menu = menu;
        this._settings = settings;
        this._home = home;
        this._nav = nav;
        this._devices = [];

        const get = new Gtk.Button({label: _('Get the Extension'), halign: Gtk.Align.CENTER, css_classes: ['pill']});
        get.connect('clicked', () => new Gtk.UriLauncher({uri: PROJECT_URL}).launch(this.get_root(), null, null));
        const missing = new Adw.StatusPage({
            icon_name: 'focus-top-bar-symbolic',
            title: _('No Top Bar Menu'),
            description: _('The Nook extension puts these devices in the GNOME top bar. Once it runs, its settings are here.'),
            child: get,
        });
        this._stack = new Gtk.Stack();
        this._stack.add_named(missing, 'missing');
        const view = new Adw.ToolbarView({content: this._stack});
        const header = new Adw.HeaderBar();
        header.pack_start(sidebarButton());
        view.add_top_bar(header);
        this.child = view;

        this._present = menu.connect('notify::present', () => this._sync());
        this._lists = ['pinned', 'hidden', 'panel-sensors', 'login-lights', 'notify-lights', 'hidden-rooms']
            .map(key => menu.connect(`changed::${key}`, () => this._describe()));
        this._sync();
    }

    forget() {
        this._menu.disconnect(this._present);
        this._lists.forEach(id => this._menu.disconnect(id));
        this._lists = [];
    }

    _sync() {
        if (!this._menu.present) {
            this._stack.visible_child_name = 'missing';
            return;
        }
        if (!this._page) {
            this._page = this._build();
            this._stack.add_named(this._page, 'settings');
        }
        this._stack.visible_child_name = 'settings';
        this._load().catch(logError);
    }

    refresh() {
        if (this._menu.present)
            this._load().catch(logError);
    }

    // What the window has read, and from settings and caches whatever it hasn't yet.
    async _load() {
        const live = this._home.devices;
        const known = new Set(live.map(d => d.did));
        const listed = (await listDevices(this._settings)).filter(d => !known.has(d.did));
        this._devices = [...live, ...listed].filter(d => d.primary?.kind !== 'scene');
        this._describe();
    }

    _build() {
        const menu = this._menu;
        const page = new Adw.PreferencesPage();
        page.add(placementGroup(menu));
        page.add(menuGroup(menu));

        const devices = new Adw.PreferencesGroup({title: _('Devices')});
        this._rows = {};
        const open = (id, title, content) => {
            const row = navigationRow(title);
            row.connect('activated', () => {
                const sub = subpage(title, content(), `top-bar:${id}`);
                this._nav.push(sub);
            });
            devices.add(row);
            this._rows[id] = row;
        };
        const lights = () => this._devices.filter(isLight);
        open('order', _('Order and Visibility'), () => orderContent(menu, this._settings, this._devices));
        open('rooms', _('Room Tabs'), () => roomTabsContent(menu, this._devices));
        open('readings', _('Readings in the Top Bar'), () => readingsContent(menu, this._settings, this._devices));
        open('login', _('Lights at Login'), () => {
            const content = new Adw.PreferencesPage();
            content.add(devicePicker(menu, this._settings, 'login-lights', lights(), _('Switched on each time you log in.')));
            return content;
        });
        open('notify', _('Notification Light'), () => notifyContent(menu, this._settings, lights()));
        page.add(devices);
        return page;
    }

    _describe() {
        if (!this._rows || !this._menu.present)
            return;
        const menu = this._menu;
        const count = key => menu.get_strv(key).filter(did => this._devices.some(d => d.did === did)).length;
        const hidden = count('hidden');
        const pinned = count('pinned');
        const parts = [];
        if (pinned > 0)
            parts.push(ngettext('%d pinned', '%d pinned', pinned).replace('%d', String(pinned)));
        if (hidden > 0)
            parts.push(ngettext('%d hidden', '%d hidden', hidden).replace('%d', String(hidden)));
        this._rows.order.subtitle = parts.join(', ');
        const rooms = new Set(this._devices.filter(d => d.room).map(d => d.room.toLocaleLowerCase()));
        const shown = [...rooms].filter(key => !menu.get_strv('hidden-rooms').includes(key)).length;
        this._rows.rooms.subtitle = ngettext('%d of %d room', '%d of %d rooms', rooms.size)
            .replace('%d', String(shown)).replace('%d', String(rooms.size));
        const readings = count('panel-sensors');
        this._rows.readings.subtitle = readings > 0
            ? ngettext('%d device', '%d devices', readings).replace('%d', String(readings)) : _('None');
        const lights = this._devices.filter(isLight);
        this._rows.login.subtitle = lightCount(menu, 'login-lights', lights);
        this._rows.notify.subtitle = lightCount(menu, 'notify-lights', lights);
    }
});

