// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _, pgettext} from 'gettext';

import {CameraCard} from './card-camera.js';
import {ClimateCard} from './card-climate.js';
import {MediaCard} from './card-media.js';
import {SpecCard} from './card-spec.js';
import {TvCard} from './card-tv.js';
import {deviceMenu, setLook, toggled} from './device-menu.js';
import {heroColor, heroOf} from './hero.js';
import {HistorySection, alertsGroup} from './history.js';
import {IN_HERO} from './props.js';
import {heardOf, isBluetooth, isOn, macText, ownSwitch, spanText, whenText} from './text.js';
import {SceneArea, dropPicture, glyphArea, iconDialog, lookOf, renameDialog, tintClass} from './widgets.js';

// The services a did belongs to, by its prefix; a bare did is Mi Home's.
const SOURCES = {
    gree: 'Gree', midea: 'Midea', daikin: 'Daikin', tapo: 'Tapo', cast: 'Google Cast', tv: _('TV'),
    sonoff: 'Sonoff', shelly: 'Shelly', ewelink: 'eWeLink', hue: 'Philips Hue', hass: 'Home Assistant',
    homekit: 'HomeKit', smartlife: 'Smart Life', lg: 'LG ThinQ', smartthings: 'SmartThings',
    melcloud: 'MELCloud', electrolux: 'Electrolux',
};

export function sourceName(did) {
    const prefix = did.includes(':') ? did.slice(0, did.indexOf(':')) : null;
    return prefix ? SOURCES[prefix] ?? prefix : 'Mi Home';
}

export const isLight = device => device.primary.kind === 'switch' &&
    ['bulb', 'rocker', 'plug'].includes(lookOf(device)[0]);

// s between reads of the device's settings while its page shows.
const SPEC_EVERY = 15;
// ms after a write before reading back what the device took.
const READ_BACK = 1500;

// Kinds whose page has a power button; Cast speakers play and pause instead.
const POWERED = ['switch', 'climate', 'tv'];

// The kind's own controls, as the menu's card had them; null: plain rows.
function cardFor(ctx) {
    const kind = ctx.device.primary.kind;
    if (kind === 'media')
        return new MediaCard(ctx);
    if (kind === 'climate')
        return new ClimateCard(ctx);
    if (kind === 'tv')
        return new TvCard(ctx);
    if (kind === 'camera')
        return new CameraCard(ctx);
    return new SpecCard(ctx);
}

// One device: its state, its name and icon in Nook, and how the top bar menu shows it.
export const DevicePage = GObject.registerClass(
class DevicePage extends Adw.NavigationPage {
    _init(device, home, settings, menu) {
        super._init({title: home.nameOf(device), tag: `device:${device.did}`});
        this.device = device;
        this._home = home;
        this._settings = settings;
        this._menu = menu;
        this._handlers = [];
        this._switching = false;
        this._gone = false;

        const page = new Adw.PreferencesPage();

        const top = new Adw.PreferencesGroup();
        const card = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['nook-hero']});
        const status = new Gtk.Box({spacing: 8});
        this._dot = new Gtk.Box({css_classes: ['nook-dot'], valign: Gtk.Align.CENTER});
        status.append(this._dot);
        this._status = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, css_classes: ['nook-hero-status']});
        status.append(this._status);
        this._power = new Gtk.Button({
            icon_name: 'system-shutdown-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['circular', 'nook-power'],
        });
        this._power.connect('clicked', () => this._switch().catch(logError));
        status.append(this._power);
        card.append(status);
        this._scene = new SceneArea(124);
        this._scene.add_css_class('nook-hero-scene');
        // Pressing the drawn device switches it, as in the menu.
        const press = new Gtk.GestureClick();
        press.connect('released', (_gesture, _n, x, y) => {
            const body = this._scene.body();
            if (!this._tappable() || !body)
                return;
            const [left, upper, width, height] = body;
            if (x >= left && x <= left + width && y >= upper && y <= upper + height)
                this._switch().catch(logError);
        });
        this._scene.add_controller(press);
        card.append(this._scene);
        this._big = new Gtk.Label({justify: Gtk.Justification.CENTER, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR});
        card.append(this._big);
        this._small = new Gtk.Label({justify: Gtk.Justification.CENTER, wrap: true, css_classes: ['nook-hero-small']});
        card.append(this._small);
        this._card = card;
        this._tint = null;
        top.add(card);
        page.add(top);
        this._read = false;
        this._kind = cardFor({
            device,
            home,
            page: this,
            toast: text => this.get_root()?.add_toast?.(new Adw.Toast({title: text})),
            written: () => {
                this.sync();
                this._readSoon();
            },
        });
        this._picture = null;
        if (this._kind?.stage)
            card.append(this._kind.stage);
        for (const group of this._kind?.groups ?? [])
            page.add(group);

        this._services = [];
        this._values = new Map();
        this._reading = false;
        this._readBack = 0;
        this._history = new HistorySection(device);
        page.add(this._history.charts);
        page.add(this._history.log);
        const alerts = alertsGroup(device, menu, () => home.service.gatewayHeard);
        if (alerts)
            page.add(alerts);

        const look = new Adw.PreferencesGroup({title: _('In Nook')});
        this._nameRow = new Adw.ActionRow({title: _('Name'), activatable: true});
        this._nameRow.add_suffix(new Gtk.Image({icon_name: 'document-edit-symbolic'}));
        this._nameRow.connect('activated', () => this._rename());
        look.add(this._nameRow);
        this._iconRow = new Adw.ActionRow({title: _('Icon'), activatable: true});
        this._iconPreview = new Gtk.Box({valign: Gtk.Align.CENTER});
        this._iconRow.add_suffix(this._iconPreview);
        this._iconRow.connect('activated', () => this._chooseIcon());
        look.add(this._iconRow);
        page.add(look);

        // The extension's lists: only while it runs to read them.
        this._menuGroup = new Adw.PreferencesGroup({
            title: _('Top Bar Menu'),
        });
        this._switches = [];
        const menuSwitch = (key, title, subtitle, inverted = false, when = () => true) => {
            const row = new Adw.SwitchRow({title, subtitle});
            row.connect('notify::active', () => {
                const on = row.active !== inverted;
                if (menu.get_strv(key).includes(device.did) !== on)
                    toggled(menu, key, device.did, on);
            });
            this._menuGroup.add(row);
            this._switches.push({row, key, inverted, when});
        };
        menuSwitch('hidden', _('Show in the Menu'), null, true);
        menuSwitch('pinned', _('Pin in the Menu'), _('First in the menu, with a tab of its own'));
        menuSwitch('panel-sensors', _('Show in the Top Bar'), _('Its reading or state next to the Nook icon'));
        menuSwitch('login-lights', _('Switch On at Login'), null, false, () => isLight(device));
        menuSwitch('notify-lights', _('Notification Light'), _('Flashes when a chosen app sends a notification'),
            false, () => isLight(device));
        page.add(this._menuGroup);

        this._details = new Adw.PreferencesGroup({title: _('Details')});
        this._detailRows = [];
        this._detailsShown = null;
        page.add(this._details);

        const header = new Adw.HeaderBar();
        const more = new Gtk.MenuButton({icon_name: 'view-more-symbolic', tooltip_text: _('More')});
        // Made when opened: its labels and checks follow the device and the lists.
        more.set_create_popup_func(() => {
            const [model, actions] = deviceMenu(device, home, {parent: this, onRemoved: () => this.get_ancestor(Adw.NavigationView.$gtype)?.pop()});
            this.insert_action_group('device', actions);
            more.menu_model = model;
        });
        header.pack_end(more);
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        this.child = view;

        for (const key of ['names', 'icons'])
            this._handlers.push([settings, settings.connect(`changed::${key}`, () => this.sync())]);
        for (const key of ['hidden', 'pinned', 'panel-sensors', 'login-lights', 'notify-lights'])
            this._handlers.push([menu, menu.connect(`changed::${key}`, () => this._syncMenu())]);
        this._handlers.push([menu, menu.connect('notify::present', () => this._syncMenu())]);
        this.sync();
        this._readSpec().catch(logError);
        this._history.refresh().catch(logError);
        this._specTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SPEC_EVERY, () => {
            this._readSpec().catch(logError);
            this._history.refresh().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // When the page leaves the navigation stack.
    forget() {
        if (this._gone)
            return;
        this._gone = true;
        GLib.source_remove(this._specTimer);
        if (this._readBack)
            GLib.source_remove(this._readBack);
        this._readBack = 0;
        this._kind?.forget();
        this._history.forget();
        if (this._home.devicePage === this)
            this._home.devicePage = null;
        for (const [object, id] of this._handlers)
            object.disconnect(id);
        this._handlers = [];
    }

    sync() {
        const device = this.device;
        const name = this._home.nameOf(device);
        const icons = this._settings.get_value('icons').deepUnpack();
        this.title = name;
        // With what the card set and the device has yet to confirm.
        const hero = heroOf(this._kind?.preview?.() ?? device, this._services, this._values);
        const offline = device.online === false;
        const tint = tintClass(heroColor(device, hero));
        if (tint !== this._tint) {
            if (this._tint)
                this._card.remove_css_class(this._tint);
            this._card.add_css_class(tint);
            this._tint = tint;
        }
        this._scene.show(hero.scene, hero.state);
        const spec = typeof device.source?.services !== 'function' ? {services: [], values: new Map()}
            : this._read ? {services: this._services, values: this._values} : null;
        this._kind?.sync(spec, IN_HERO[hero.scene] ?? []);
        const picture = this._kind?.picture ?? null;
        if (picture && picture !== this._picture) {
            this._card.insert_child_after(picture, this._scene);
            this._picture = picture;
        }
        // A camera's card shows its picture, live or the last still.
        this._scene.visible = !picture && device.primary.kind !== 'camera';
        // Mi Home has it offline unless a gateway relays it; the window hears it nearby.
        const heard = heardOf(device);
        if (isBluetooth(device) && device.online !== true) {
            this._status.label = heard ? _('Heard %s').replace('%s', whenText(heard.time))
                : this._home.hearing ? _('Listening for it nearby…') : _('Bluetooth is off, so it cannot be heard.');
        } else {
            this._status.label = offline ? _('Offline') : device.online ? _('Online') : _('Connecting…');
        }
        if (device.online || heard)
            this._dot.add_css_class('on');
        else
            this._dot.remove_css_class('on');
        this._big.label = hero.big ?? '';
        this._big.visible = Boolean(hero.big) && hero.big !== this._status.label;
        this._big.css_classes = [/^[-−\d]/.test(this._big.label) ? 'nook-hero-big' : 'nook-hero-word'];
        this._small.label = hero.small ?? '';
        this._small.visible = Boolean(hero.small);
        const on = isOn(device);
        this._power.visible = POWERED.includes(device.primary.kind) && typeof device.source?.setSwitch === 'function' &&
            !this._kind?.ownsPower && (device.primary.kind !== 'switch' || ownSwitch(device));
        this._power.sensitive = !offline && !this._switching;
        this._power.tooltip_text = on ? _('Turn Off') : _('Turn On');
        if (on && !offline)
            this._power.add_css_class('on');
        else
            this._power.remove_css_class('on');
        const own = this._settings.get_value('names').deepUnpack()[device.did];
        this._nameRow.subtitle = GLib.markup_escape_text(own ? `${own} · ${device.name}` : device.name, -1);
        for (let child = this._iconPreview.get_first_child(); child; child = this._iconPreview.get_first_child())
            this._iconPreview.remove(child);
        const [glyph, , image] = lookOf(device, icons);
        this._iconPreview.append(image ? new Gtk.Image({file: image, pixel_size: 16}) : glyphArea(glyph, 16));
        this._syncMenu();
        this._fillDetails();
    }

    // Again when it changes: some services tell the firmware or the address only once asked.
    _fillDetails() {
        const device = this.device;
        const about = device.about ?? {};
        const bluetooth = String(device.did).startsWith('blt.');
        const parent = about.parent ? this._home.devices.find(d => d.did === about.parent) : null;
        const facts = [
            [_('Room'), device.room],
            [_('Service'), sourceName(device.did)],
            [_('Model'), about.model ?? device.model],
            [_('Gateway'), parent ? this._home.nameOf(parent) : about.parent],
            [_('Network'), about.ssid],
            [_('Signal'), about.rssi ? `${about.rssi} ${pgettext('unit', 'dBm')}` : null],
            [_('Address'), about.ip ?? device.ip ?? device.host ?? null],
            [bluetooth ? _('Bluetooth address') : _('MAC address'), about.mac ? macText(about.mac) : null],
            [_('Firmware'), about.firmware],
            [_('MCU firmware'), about.mcu],
            [_('Hardware'), about.hardware],
            [_('Up for'), about.uptime > 0 ? spanText(about.uptime) : null],
            [_('Last online'), device.online === false && about.lastOnline ? whenText(about.lastOnline) : null],
            [_('Device ID'), device.did],
        ].filter(([, value]) => value);
        const shown = JSON.stringify(facts);
        if (shown === this._detailsShown)
            return;
        this._detailsShown = shown;
        for (const row of this._detailRows)
            this._details.remove(row);
        this._detailRows = facts.map(([title, value]) => {
            const row = new Adw.ActionRow({title, subtitle: GLib.markup_escape_text(String(value), -1), subtitle_selectable: true});
            row.add_css_class('property');
            this._details.add(row);
            return row;
        });
    }

    // A switch the picture shows: pressing it switches, as in the menu.
    _tappable() {
        const device = this.device;
        return device.primary.kind === 'switch' && device.online !== false && !this._picture &&
            typeof device.source?.setSwitch === 'function';
    }

    _syncMenu() {
        const menu = this._menu;
        this._menuGroup.visible = menu.present;
        if (!menu.present)
            return;
        for (const {row, key, inverted, when} of this._switches) {
            row.visible = when();
            const active = menu.get_strv(key).includes(this.device.did) !== inverted;
            if (row.active !== active)
                row.active = active;
        }
    }

    // Kept in the app and, while it runs, in the extension too.
    _set(key, value) {
        setLook(this._settings, this._menu, key, this.device.did, value);
    }

    // Mi Home, Hue, Home Assistant, Shelly, eWeLink and the like describe their settings as spec services.
    async _readSpec() {
        const device = this.device;
        if (typeof device.source?.services !== 'function' || device.primary.kind === 'camera' || this._reading)
            return;
        this._reading = true;
        try {
            const services = await device.source.services(device);
            const readable = services.flatMap(s => s.properties.filter(p => p.access.includes('read'))
                .map(p => ({siid: s.siid, piid: p.piid})));
            const values = await device.source.readProperties(device, readable);
            if (!this._handlers.length)
                return;
            this._services = services;
            this._values = values;
            this._read = true;
            this.sync();
        } catch (e) {
            console.debug(`nook: ${device.did}: ${e.message}`);
        } finally {
            this._reading = false;
        }
    }

    _readSoon() {
        if (this._readBack)
            GLib.source_remove(this._readBack);
        this._readBack = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READ_BACK, () => {
            this._readBack = 0;
            this._readSpec().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    // One at a time: a TV takes up to 40 s to wake, and a second press turns it off again.
    async _switch() {
        const device = this.device;
        if (this._switching)
            return;
        this._switching = true;
        this.sync();
        try {
            if (device.primary.kind === 'switch') {
                await this._home.toggle(device);
                return;
            }
            try {
                await device.source.setSwitch(device, !isOn(device));
            } catch (e) {
                this.get_root()?.add_toast?.(new Adw.Toast({title: e.message}));
            }
            this._home.onEvent();
        } finally {
            this._switching = false;
            if (!this._gone)
                this.sync();
        }
    }

    _rename() {
        const own = this._settings.get_value('names').deepUnpack()[this.device.did];
        renameDialog(this.device.name, own, this, name => this._set('names', name));
    }

    _chooseIcon() {
        const old = this._settings.get_value('icons').deepUnpack()[this.device.did] ?? '';
        iconDialog(old, this, icon => {
            this._set('icons', icon);
            if (old !== icon)
                dropPicture(old);
        });
    }
});
