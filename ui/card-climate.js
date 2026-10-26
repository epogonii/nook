// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClimateError, MODES} from '../lib/aircon-home.js';
import {snapTemperature, specClimate} from '../lib/climate.js';
import {SpecError} from '../lib/spec-home.js';
import {XiaomiError} from '../lib/xiaomi.js';
import {CLIMATE_AIRFLOWS, CLIMATE_FANS, CLIMATE_MODES, CLIMATE_SIDES, CLIMATE_TOGGLES, MODE_GLYPHS, airflowChoice, climateLook, climateSpeed, climateStatus, climateToggle, climateView, fanText, swingsOnly} from './climate.js';
import {VERTICAL, modeText, numberFormat, readSetting, specTrouble} from './text.js';
import {Glyph, Scene, TemperatureSlider} from './widgets.js';

const NUDGE_SETTLE = 600;

export class ClimateCard {
    async _openClimateCard(device) {
        const home = device.source;
        const again = this._card === device;
        const scroll = again ? this._scroll.vadjustment.value : 0;
        if (!again)
            this._drawer = null;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!again) {
            if (climateView(device))
                this._fillClimateCard(device);
            else
                this._showLoading(true);
        }
        let read;
        try {
            read = await this._readClimate(device);
        } catch (e) {
            if (this._card === device && !again)
                this._message(e instanceof SpecError ? specTrouble(e) : e.message);
            if (!(e instanceof XiaomiError) && !(e instanceof SpecError) && !(e instanceof GLib.Error))
                throw e;
            return;
        }
        if (this._card !== device || !this._sources().includes(home))
            return;
        // A spec unit that is offline, unreadable or lacks the basics gets the plain card.
        if (read && (!device.climate || device.online === false)) {
            this._fillCard(device, read.services, read.values);
            this._putScrollBack(scroll);
            return;
        }
        this._fillClimateCard(device);
    }

    // Native units keep their own state; a spec unit's is made from its services each read.
    async _readClimate(device) {
        const home = device.source;
        if (device.primary.kind === 'climate') {
            await home.readDevice(device);
            return null;
        }
        const services = await home.services(device);
        const readable = services.flatMap(s => s.properties
            .filter(p => p.access.includes('read'))
            .map(p => ({siid: s.siid, piid: p.piid})));
        const values = await home.readProperties(device, readable);
        device.values = device.primary.props.map((p, i) => values.get(`${p.siid}/${p.piid}`) ?? device.values?.[i] ?? null);
        device.extra = {...device.extra};
        for (const extra of home.extras.filter(e => e.did === device.did)) {
            const key = `${extra.siid}/${extra.piid}`;
            if (values.has(key))
                device.extra[key] = values.get(key);
        }
        const view = device.unreadable ? null : specClimate(services, values, device.values?.[0] ?? null);
        if (view)
            Object.assign(view, {services, values});
        Object.defineProperty(device, 'climate', {value: view, writable: true, configurable: true, enumerable: false});
        return {services, values};
    }

    // One write at a time: sources without a queue of their own (the HTTP clouds) could
    // otherwise apply quick changes out of order.
    _climateWrite(device, changes) {
        const run = (this._climateWrites ?? Promise.resolve()).then(() => this._writeClimate(device, changes));
        this._climateWrites = run.catch(() => {});
        return run;
    }

    async _writeClimate(device, changes) {
        if (!climateView(device))
            return;
        try {
            if (device.primary.kind === 'climate') {
                await device.source.set(device, changes);
            } else {
                for (const [siid, piid, value] of device.climate.writes(changes))
                    await device.source.setProperty(device, siid, piid, value);
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof ClimateError) && !(e instanceof XiaomiError) && !(e instanceof SpecError) &&
                !(e instanceof GLib.Error))
                throw e;
            if (this._gone)
                return;
            Main.notifyError(device.name, e instanceof SpecError ? specTrouble(e) : e.message);
        }
        // A write that went through stays done when the read after it fails.
        if (device.primary.kind !== 'climate') {
            await this._readClimate(device).catch(e => {
                if (!(e instanceof XiaomiError) && !(e instanceof SpecError) && !(e instanceof GLib.Error))
                    throw e;
                console.debug(`nook: ${device.name}: ${e.message}`);
            });
        }
        if (this._card === device && climateView(device))
            this._fillClimateCard(device);
    }

    // A spec unit's settings and readings the climate box has no place for, as the plain
    // card shows them.
    _fillClimateExtras() {
        const c = this._climate;
        const view = climateView(c.device);
        if (!c.extras || !view?.services)
            return;
        c.extras.destroy_all_children();
        this._stageTarget = c.extras;
        try {
            this._addSpecTiles(c.device, view.services, view.values, view.keys);
        } finally {
            this._stageTarget = null;
        }
    }

    // Built once, then updated in place so colours transition rather than redraw.
    _fillClimateCard(device) {
        const view = climateView(device);
        if (!device.online || !view) {
            this._message(_('The air conditioner is not answering. Is it plugged in and on the same network?'));
            return;
        }
        const {state, caps} = view;
        const tiles = [
            ['Mod', _('Mode'), 'snowflake', CLIMATE_MODES(caps)],
            ['WdSpd', _('Fan'), 'fan', CLIMATE_FANS(caps)],
            ['SwUpDn', _('Up and down'), 'flow-swing', CLIMATE_AIRFLOWS(caps)],
            ['SwingLfRig', _('Left and right'), 'side-swing', CLIMATE_SIDES(caps)],
            ...CLIMATE_TOGGLES(),
        ].filter(([key, , , choices]) => state[key] !== undefined && (!choices || choices.length > 1))
            .map(([key, title, glyph, choices = null]) => [key, title, glyph,
                choices && !(['SwUpDn', 'SwingLfRig'].includes(key) && swingsOnly(choices)) ? choices : null]);
        const shape = JSON.stringify([caps.range, tiles]);
        if (this._climate?.device === device && this._climate.shape === shape) {
            this._syncClimateCard();
            this._fillClimateExtras();
            return;
        }
        this._clear();
        const write = changes => this._climateWrite(device, changes).catch(logError);
        const c = {device, shape, tiles: new Map(), choosing: null};

        c.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-climate'});

        const top = new St.BoxLayout({style_class: 'nook-climate-top'});
        top.add_child(new Glyph('thermometer'));
        c.room = new St.Label({style_class: 'nook-climate-room', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(c.room);
        c.dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(c.dot);
        c.status = new St.Label({style_class: 'nook-climate-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        top.add_child(c.status);
        c.power = this._addRoundButton(top, 'system-shutdown-symbolic', _('Power'),
            () => write({Pow: climateView(device)?.state.Pow === 1 ? 0 : 1}));
        c.power.add_style_class_name('nook-power');
        c.box.add_child(top);

        c.scene = new Scene('aircon', 'nook-ac-scene');
        c.box.add_child(this._powerScene(c.scene, c.power));

        const middle = new St.BoxLayout({style_class: 'nook-climate-middle', x_align: Clutter.ActorAlign.CENTER});
        c.target = new St.Label({style_class: 'nook-climate-target'});
        middle.add_child(c.target);
        middle.add_child(new St.Label({style_class: 'nook-climate-unit', text: '°C', y_align: Clutter.ActorAlign.START}));
        c.box.add_child(middle);

        const [min, max, step] = caps.range;
        const range = new St.BoxLayout({style_class: 'nook-climate-range'});
        // Quick presses go out as one write once they stop.
        const nudge = delta => {
            const now = climateView(device);
            if (!now)
                return;
            const next = snapTemperature(now.caps, (c.pending ?? now.state.SetTem ?? (min + max) / 2) + delta);
            c.pending = next;
            this._showTarget(next);
            if (c.nudging)
                GLib.source_remove(c.nudging);
            c.flush = () => {
                if (c.nudging)
                    GLib.source_remove(c.nudging);
                c.nudging = 0;
                c.flush = null;
                write({SetTem: next}).finally(() => {
                    if (c.pending === next)
                        c.pending = null;
                });
            };
            c.nudging = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NUDGE_SETTLE, () => {
                c.nudging = 0;
                c.flush?.();
                return GLib.SOURCE_REMOVE;
            });
        };
        c.minus = this._addRoundButton(range, 'list-remove-symbolic', _('Cooler'), () => nudge(-step));
        const track = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        c.slider = new TemperatureSlider(caps.range,
            temperature => this._showTarget(temperature),
            temperature => write({SetTem: temperature}));
        track.add_child(c.slider);
        const ends = new St.BoxLayout({style_class: 'nook-climate-ends'});
        ends.add_child(new St.Label({text: `${numberFormat.format(min)}°`, x_expand: true}));
        ends.add_child(new St.Label({text: `${numberFormat.format(max)}°`}));
        track.add_child(ends);
        range.add_child(track);
        c.plus = this._addRoundButton(range, 'list-add-symbolic', _('Warmer'), () => nudge(step));
        for (const button of [c.minus, c.plus])
            button.add_style_class_name('nook-step');
        c.box.add_child(range);

        let row = null;
        tiles.forEach(([key, title, glyph, choices], i) => {
            if (i % 4 === 0) {
                row = new St.BoxLayout({style_class: 'nook-climate-tiles', x_expand: true});
                row.layout_manager.homogeneous = true;
                c.box.add_child(row);
            }
            const tile = this._climateTile(title, glyph, choices);
            tile.row = row;
            tile.button.connect('clicked', () => {
                if (choices)
                    this._chooseClimate(key);
                else
                    write(climateToggle(climateView(device)?.state ?? {}, key));
            });
            row.add_child(tile.button);
            c.tiles.set(key, tile);
        });
        for (let i = tiles.length % 4; i > 0 && i < 4; i++)
            row.add_child(new St.Widget({x_expand: true}));

        c.chooser = new St.BoxLayout({style_class: 'nook-segments', x_expand: true, visible: false});
        c.chooser.layout_manager.homogeneous = true;
        c.box.add_child(c.chooser);

        this._body.add_child(c.box);
        if (device.primary.kind !== 'climate') {
            c.extras = new St.BoxLayout({...VERTICAL, x_expand: true});
            this._body.add_child(c.extras);
        }
        this._addDeviceInfo(device);
        this._climate = c;
        this._syncClimateCard();
        this._fillClimateExtras();
    }

    _climateTile(title, glyph, choices) {
        const icon = new Glyph(glyph);
        const head = new St.BoxLayout({style_class: 'nook-ac-tile-head'});
        head.add_child(new St.Bin({style_class: 'nook-ac-bubble', child: icon}));
        head.add_child(new St.Widget({x_expand: true}));
        const pin = new St.Icon({
            style_class: 'nook-ac-mark',
            icon_name: 'view-pin-symbolic',
            icon_size: 12,
            visible: false,
            y_align: Clutter.ActorAlign.START,
        });
        head.add_child(pin);
        head.add_child(choices
            ? new St.Icon({style_class: 'nook-ac-mark', icon_name: 'pan-down-symbolic', icon_size: 12})
            : new St.Widget({style_class: 'nook-ac-led', y_align: Clutter.ActorAlign.START}));
        const name = new St.Label({style_class: 'nook-ac-tile-title', text: title});
        const value = new St.Label({style_class: 'nook-ac-tile-value'});
        for (const label of [name, value])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-ac-tile-box', x_expand: true});
        box.add_child(head);
        box.add_child(name);
        box.add_child(value);
        const button = new St.Button({
            style_class: 'nook-ac-tile',
            child: box,
            can_focus: true,
            x_expand: true,
            accessible_name: title,
        });
        return {button, icon, value, choices, pin};
    }

    _chooseClimate(key) {
        const c = this._climate;
        c.choosing = c.choosing === key ? null : key;
        this._syncChoices();
        if (c.choosing) {
            c.box.set_child_above_sibling(c.chooser, c.tiles.get(key).row);
            c.chooser.opacity = 0;
            c.chooser.translation_y = -6;
            c.chooser.ease({
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _syncChoices() {
        const c = this._climate;
        for (const [key, tile] of c.tiles) {
            if (key === c.choosing)
                tile.button.add_style_pseudo_class('open');
            else
                tile.button.remove_style_pseudo_class('open');
        }
        c.chooser.destroy_all_children();
        c.chooser.visible = c.choosing !== null;
        if (!c.choosing)
            return;
        const key = c.choosing;
        const tile = c.tiles.get(key);
        const {state} = climateView(c.device);
        const current = key === 'SwUpDn' ? airflowChoice(state[key]) : state[key];
        for (const [value, label, glyph] of tile.choices) {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-segment-box'});
            box.add_child(new Glyph(glyph));
            const text = new St.Label({text: label, x_align: Clutter.ActorAlign.CENTER});
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(text);
            const segment = new St.Button({
                style_class: 'nook-segment',
                child: box,
                can_focus: true,
                x_expand: true,
                accessible_name: `${tile.button.accessible_name}: ${label}`,
                checked: value === current,
            });
            // Hide only: the segments are rebuilt on the next sync, not inside their own
            // 'clicked' handler.
            segment.connect('clicked', () => {
                c.choosing = null;
                c.chooser.visible = false;
                tile.button.remove_style_pseudo_class('open');
                this._climateWrite(c.device, {[key]: value}).catch(logError);
            });
            c.chooser.add_child(segment);
        }
    }

    // Colour by mode, not a blue-orange blend by target: that went muddy grey mid-range.
    // A target not read yet shows as a dash.
    _showTarget(temperature) {
        const c = this._climate;
        const {state, caps} = climateView(c.device);
        const on = state.Pow === 1;
        const mode = MODES[state.Mod];
        const known = typeof temperature === 'number';
        const {color, air} = climateLook(mode, known ? temperature : 24);
        const shade = share => color.map(v => Math.round(v * 255 * share));
        const [top, bottom] = on ? [shade(0.5), shade(0.24)] : [[66, 66, 72], [48, 48, 54]];
        c.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${top}); background-gradient-end: rgb(${bottom});`;
        c.target.text = known ? numberFormat.format(temperature) : '–';
        c.scene.show({
            on,
            color,
            air,
            target: c.target.text,
            swing: state.SwUpDn ?? 0,
            side: state.SwingLfRig ?? 0,
            speed: climateSpeed(state, caps),
            light: state.Lig !== 0,
        });
        c.minus.reactive = !known || temperature > caps.range[0];
        c.plus.reactive = !known || temperature < caps.range[1];
    }

    _syncClimateCard() {
        const c = this._climate;
        const {state, caps} = climateView(c.device);
        const on = state.Pow === 1;
        c.room.text = typeof state.roomTemperature === 'number'
            ? _('Room %s°').replace('%s', numberFormat.format(state.roomTemperature))
            : _('Room temperature unknown');
        c.status.text = on ? (state.Mod === null ? _('On') : climateStatus(state.Mod)) : _('Off');
        if (on)
            c.dot.add_style_pseudo_class('checked');
        else
            c.dot.remove_style_pseudo_class('checked');
        c.power.checked = on;
        c.power.accessible_name = on ? _('Turn Off') : _('Turn On');
        // A nudge not sent yet keeps its value on screen.
        const target = c.pending ?? state.SetTem;
        const [min, max] = caps.range;
        c.slider.showTemperature(target ?? (min + max) / 2);
        this._showTarget(target);
        for (const [key, tile] of c.tiles) {
            const value = state[key];
            if (key === 'Mod') {
                tile.value.text = value === null ? '–' : modeText(value);
                tile.icon.setName(MODE_GLYPHS[MODES[value]] ?? 'aircon');
            } else if (key === 'WdSpd') {
                const fan = caps.fans.find(f => f.value === value);
                tile.value.text = fan ? fanText(fan, caps)[1] : '–';
                tile.icon.setName(fan?.level >= 1 && fan.level <= 5 ? `speed${fan.level}` : 'fan');
            } else if (key === 'SwUpDn' && tile.choices) {
                const choice = airflowChoice(value);
                if (choice >= 2)
                    tile.value.text = `${choice - 1} / 5`;
                else
                    tile.value.text = choice === 1 ? _('Swing') : _('Off');
                tile.icon.setName(choice === 1 ? 'flow-swing' : `flow${Math.max(0, choice - 1)}`);
            } else if (key === 'SwingLfRig' && tile.choices) {
                if (value >= 2 && value <= 6)
                    tile.value.text = `${value - 1} / 5`;
                else
                    tile.value.text = value === 1 ? _('Swing') : _('Off');
                tile.icon.setName(value === 1 ? 'side-swing' : `side${value >= 2 && value <= 6 ? value - 1 : 0}`);
            } else {
                tile.button.checked = Boolean(value);
                tile.value.text = value === null ? '–' : value ? _('On') : _('Off');
            }
        }
        this._syncChoices();
        c.scene.run(on && this._menu.isOpen);
    }
}
