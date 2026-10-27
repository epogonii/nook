// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {SonoffError, SonoffHome} from '../lib/sonoff.js';
import {EwelinkError} from '../lib/ewelink.js';
import {SpecError} from '../lib/spec-home.js';
import {XiaomiError} from '../lib/xiaomi.js';
import {EVENT_KEYS} from './events.js';
import {isBluetooth, setLive} from './rows.js';
import {PRIMARY_SECONDARY, VERTICAL, deviceType, readSetting, sonoffTrouble, specTrouble} from './text.js';
import {Glyph, optimistic} from './widgets.js';

const CARD_LOCAL = 5000;

const CARD_CLOUD = 10000;

const CARD_TOUCHED = 5000;

export class Card {
    _setCardMode(on) {
        this._backButton.visible = on;
        this._panelButton.visible = on;
        this._pinButton.visible = on;
        this._hideButton.visible = on;
        this._refreshButton.visible = !on;
        this._quietHeader(!on && readSetting(this._settings, 'view') === 'control');
        if (on)
            this._syncCardHeader();
    }

    _quietHeader(on) {
        if (on)
            this._header.add_style_class_name('nook-header-quiet');
        else
            this._header.remove_style_class_name('nook-header-quiet');
    }

    _syncCardHeader() {
        const pinned = readSetting(this._settings, 'pinned').includes(this._card.did);
        const hidden = readSetting(this._settings, 'hidden').includes(this._card.did);
        this._pinButton.child.icon_name = pinned ? 'starred-symbolic' : 'non-starred-symbolic';
        this._pinButton.accessible_name = pinned ? _('Unpin') : _('Pin');
        this._hideButton.child.icon_name = hidden ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        this._hideButton.accessible_name = hidden ? _('Show in the Menu') : _('Hide from the Menu');
        const shown = readSetting(this._settings, 'panel-sensors').includes(this._card.did);
        this._panelButton.visible = this._devices().includes(this._card);
        this._panelButton.checked = shown;
        this._panelButton.accessible_name = shown ? _('Take Off the Top Bar') : _('Show in the Top Bar');
    }

    _stopCardTimer() {
        if (this._cardTimer)
            GLib.source_remove(this._cardTimer);
        this._cardTimer = 0;
    }

    _refreshCard() {
        const device = this._card;
        if (!device || !this._menu.isOpen || this._cardReading || this._pressed ||
            device.primary.kind === 'camera' || device.listed === false)
            return;
        const now = Date.now();
        const every = [this._home, this._ewelink, this._smartlife, this._miScenes, ...this._clouds].includes(device.source)
            ? CARD_CLOUD : CARD_LOCAL;
        if (now - this._touchedAt < CARD_TOUCHED || now - this._cardReadAt < every)
            return;
        this._cardReading = true;
        this._openCard(device).catch(logError).finally(() => {
            this._cardReading = false;
        });
    }

    async _openCard(device) {
        this._cardReadAt = Date.now();
        if (device.primary.kind === 'camera') {
            await this._openCameraCard(device);
            return;
        }
        if (device.primary.kind === 'climate' || (deviceType(device) === 'air-conditioner' && device.climate !== null)) {
            await this._openClimateCard(device);
            return;
        }
        if (device.primary.kind === 'media') {
            await this._openMediaCard(device);
            return;
        }
        if (device.primary.kind === 'tv') {
            await this._openTvCard(device);
            return;
        }
        if (device.source === this._sonoff) {
            await this._openSwitchCard(device);
            return;
        }
        const home = device.source;
        const again = this._card === device;
        const scroll = again ? this._scroll.vadjustment.value : 0;
        if (!again)
            this._drawer = null;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!again)
            this._showLoading(true);

        let services, values;
        const eventKeys = home === this._home ? EVENT_KEYS()[deviceType(device)] ?? [] : [];
        const live = device.did.startsWith('lumi.')
            ? this._alerts.read(device.did.slice('lumi.'.length)).catch(() => null) : Promise.resolve(null);
        try {
            services = await home.services(device);
            const readable = services.flatMap(s => s.properties
                .filter(p => p.access.includes('read'))
                .map(p => ({siid: s.siid, piid: p.piid})));
            const reading = home.readProperties(device, readable);
            // Asked now so it queues right behind the values, ahead of background reads;
            // _fillHistory then gets it from MiHome's cache.
            this._readHistory(home, device, eventKeys).catch(() => {});
            values = await reading;
            // No spec (e.g. a range extender), but miIO answers. Copy only shown fields:
            // miIO.info also carries the device token, which must never reach the cache.
            if (services.length === 0 && home === this._home && !isBluetooth(device) && device.online) {
                const info = await home.rpc(device, 'miIO.info').catch(e => {
                    console.debug(`nook: miIO.info: ${e.message}`);
                    return null;
                });
                Object.defineProperty(device, 'info', {
                    value: info ? {
                        ap: {ssid: info.ap?.ssid, rssi: info.ap?.rssi},
                        sta: {count: info.sta?.count},
                        netif: {localIp: info.netif?.localIp},
                        fw_ver: info.fw_ver,
                        life: info.life,
                    } : null,
                    writable: true,
                    configurable: true,
                    enumerable: false,
                });
            }
        } catch (e) {
            if (this._card === device && !again)
                this._message(e instanceof SpecError ? specTrouble(e) : e.message);
            if (!(e instanceof XiaomiError) && !(e instanceof EwelinkError) && !(e instanceof SpecError) &&
                !(e instanceof GLib.Error))
                throw e;
            return;
        }
        if (this._card !== device || !this._sources().includes(home))
            return;

        device.values = device.primary.props.map((p, i) => values.get(`${p.siid}/${p.piid}`) ?? device.values?.[i] ?? null);
        device.extra = {...device.extra};
        for (const extra of home.extras.filter(e => e.did === device.did)) {
            const key = `${extra.siid}/${extra.piid}`;
            if (values.has(key))
                device.extra[key] = values.get(key);
        }
        const state = await live;
        if (this._card !== device || !this._sources().includes(home))
            return;
        if (state)
            setLive(device, state);
        this._fillCard(device, services, values, eventKeys);
        this._putScrollBack(scroll);
    }

    async _openSwitchCard(device) {
        const source = device.source;
        const again = this._card === device;
        const scroll = again ? this._scroll.vadjustment.value : 0;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (device.online === null)
            this._showLoading(true);
        else if (!again)
            this._fillCard(device, [], new Map());
        await source.readDevice(device);
        if (this._card !== device || source !== this._sonoff)
            return;
        this._fillCard(device, [], new Map());
        this._putScrollBack(scroll);
    }

    // New rows aren't laid out yet: restore once the adjustment's upper bound covers it.
    _putScrollBack(scroll) {
        this._forgetScroll();
        if (scroll <= 0)
            return;
        const adjustment = this._scroll.vadjustment;
        this._scrollRestore = adjustment.connect('notify::upper', () => {
            if (adjustment.upper - adjustment.page_size >= scroll) {
                this._forgetScroll();
                adjustment.value = scroll;
            }
        });
    }

    _forgetScroll() {
        if (this._scrollRestore)
            this._scroll.vadjustment.disconnect(this._scrollRestore);
        this._scrollRestore = 0;
    }

    _scrollToEnd() {
        this._forgetScroll();
        const adjustment = this._scroll.vadjustment;
        this._scrollRestore = adjustment.connect('notify::upper', () => {
            this._forgetScroll();
            adjustment.value = adjustment.upper - adjustment.page_size;
        });
    }

    _switchRow(text, active, onToggle) {
        const row = new St.BoxLayout({style_class: 'nook-card-row'});
        const label = new St.Label({style_class: 'nook-card-label', text, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const toggle = new PopupMenu.Switch(active);
        toggle.reactive = false;
        const button = new St.Button({child: toggle, can_focus: true, accessible_name: text});
        const pick = optimistic(button, active, on => {
            toggle.state = on;
        });
        button.connect('clicked', () => pick(!toggle.state, onToggle));
        row.add_child(label);
        row.add_child(button);
        return row;
    }

    _closeCard() {
        this._card = null;
        this._setCardMode(false);
        this._render();
        for (const tile of this._tiles)
            tile.sync();
    }

    async _cardWrite(device, task) {
        try {
            await task();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof XiaomiError) && !(e instanceof SonoffError) && !(e instanceof EwelinkError) &&
                !(e instanceof SpecError) && !(e instanceof GLib.Error))
                throw e;
            if (this._gone)
                return;
            Main.notifyError(device.name, device.source instanceof SonoffHome ? sonoffTrouble(e)
                : e instanceof SpecError ? specTrouble(e) : e.message);
        }
        if (this._card === device)
            await this._openCard(device);
    }

    // Tile: {title, glyph, text, on, value, choices, range: {prop, value, write}, fill,
    // extra, pick}. choices, range and fill open a drawer under the row; others switch.
    _addTileGrid(box, tiles) {
        if (tiles.length === 0)
            return;
        let perRow = tiles.length % 4 !== 0 && tiles.length % 3 === 0 ? 3 : 4;
        perRow = Math.min(perRow, tiles.length);
        const drawer = new St.BoxLayout({...VERTICAL, style_class: 'nook-drawer', x_expand: true, visible: false});
        let open = null;
        const fold = () => {
            open?.button.remove_style_pseudo_class('open');
            open = null;
            this._drawer = null;
            drawer.visible = false;
        };
        // Remembered so a slider's drawer survives the re-read after each write.
        const unfold = (tile, made, row, animate) => {
            open = made;
            this._drawer = tile.choices ? null : tile.title;
            made.button.add_style_pseudo_class('open');
            drawer.destroy_all_children();
            if (tile.fill) {
                tile.fill(drawer);
            } else if (tile.range) {
                const {prop, value, write} = tile.range;
                drawer.add_child(this._sliderRow(tile.title, prop, value, write, true));
            } else {
                const count = tile.choices.length;
                const longest = Math.max(...tile.choices.map(([, label]) => label.length));
                const lines = Math.ceil(count / (longest > 10 ? 3 : longest > 6 ? 4 : 5));
                let line = null;
                let room = 0;
                tile.choices.forEach(([value, label, glyph]) => {
                    if (room === 0) {
                        const index = drawer.get_n_children();
                        room = Math.floor(count / lines) + (index < count % lines ? 1 : 0);
                        line = new St.BoxLayout({style_class: 'nook-segments', x_expand: true});
                        line.layout_manager.homogeneous = true;
                        drawer.add_child(line);
                    }
                    room--;
                    const content = new St.BoxLayout({...VERTICAL, style_class: 'nook-segment-box'});
                    const picture = tile.icon?.(value);
                    if (picture)
                        content.add_child(new St.Icon({gicon: picture, icon_size: 32}));
                    else if (glyph)
                        content.add_child(new Glyph(glyph));
                    const text = new St.Label({text: label, x_align: Clutter.ActorAlign.CENTER});
                    text.clutter_text.line_wrap = true;
                    text.clutter_text.line_alignment = Pango.Alignment.CENTER;
                    content.add_child(text);
                    const segment = new St.Button({
                        style_class: 'nook-segment',
                        child: content,
                        can_focus: true,
                        x_expand: true,
                        accessible_name: `${tile.title}: ${label}`,
                        checked: value === tile.value,
                    });
                    segment.connect('clicked', () => {
                        fold();
                        tile.pick(value);
                    });
                    line.add_child(segment);
                });
            }
            box.set_child_above_sibling(drawer, row);
            drawer.visible = true;
            if (!animate)
                return;
            drawer.opacity = 0;
            drawer.translation_y = -6;
            drawer.ease({
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        let row = null;
        let reopen = null;
        tiles.forEach((tile, i) => {
            if (i % perRow === 0) {
                row = new St.BoxLayout({style_class: 'nook-climate-tiles', x_expand: true});
                row.layout_manager.homogeneous = true;
                box.add_child(row);
            }
            const opens = Boolean(tile.choices || tile.range || tile.fill);
            const made = this._climateTile(tile.title, tile.glyph, opens);
            made.value.text = tile.text ?? '';
            made.button.checked = !opens && tile.on === true;
            if (tile.extra) {
                made.pin.visible = readSetting(this._settings, 'extra-tiles').includes(tile.extra);
                made.button.button_mask = PRIMARY_SECONDARY;
            }
            const own = row;
            made.button.connect('clicked', (_button, clicked) => {
                if (clicked === 3) {
                    this._toggleIn('extra-tiles', tile.extra);
                    made.pin.visible = !made.pin.visible;
                    return;
                }
                if (!opens) {
                    tile.pick(!tile.on);
                    return;
                }
                const again = open === made;
                fold();
                if (!again)
                    unfold(tile, made, own, true);
            });
            row.add_child(made.button);
            if (opens && !tile.choices && tile.title === this._drawer)
                reopen = () => unfold(tile, made, own, false);
        });
        for (let i = tiles.length % perRow; i > 0 && i < perRow; i++)
            row.add_child(new St.Widget({x_expand: true}));
        box.add_child(drawer);
        reopen?.();
    }

    _addStepper(box, title, current, [min, max], format, stepOf, write) {
        const row = new St.BoxLayout({style_class: 'nook-stepper'});
        row.add_child(new St.Label({
            style_class: 'nook-card-label',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        let wanted = current;
        let written = current;
        let timer = 0;
        const flush = () => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
            if (wanted !== written) {
                written = wanted;
                write(wanted);
            }
        };
        const shown = new St.Label({style_class: 'nook-stepper-value', text: format(current), y_align: Clutter.ActorAlign.CENTER});
        const nudge = direction => {
            wanted = Math.min(max, Math.max(min, wanted + direction * stepOf(wanted, direction)));
            shown.text = format(wanted);
            if (timer)
                GLib.source_remove(timer);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                timer = 0;
                flush();
                return GLib.SOURCE_REMOVE;
            });
        };
        const minus = this._addRoundButton(row, 'list-remove-symbolic', _('Less'), () => nudge(-1));
        row.add_child(shown);
        const plus = this._addRoundButton(row, 'list-add-symbolic', _('More'), () => nudge(1));
        for (const button of [minus, plus])
            button.add_style_class_name('nook-step');
        row.connect('destroy', () => {
            if (timer)
                flush();
        });
        box.add_child(row);
    }
}
