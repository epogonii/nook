// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

import {TileGrid, roundButton} from './card-parts.js';
import {ClimateError, MODES, snapTemperature} from './lib/climate.js';
import {choiceText, modeText, numberFormat} from './text.js';

// ms the − and + presses gather before they go out as one write.
const NUDGE_SETTLE = 600;
// s between reads of the unit while its page shows.
const READ_EVERY = 10;
// ms after the last change with no reads: the unit may not report it yet.
const TOUCHED = 5000;

const CLIMATE_TOGGLES = () => [
    ['SvSt', _('Eco'), 'leaf'],
    ['SwhSlp', _('Sleep'), 'moon'],
    ['Tur', _('Turbo'), 'bolt'],
    ['Quiet', _('Quiet'), 'quiet'],
    ['Lig', _('Display'), 'bulb'],
    ['Health', _('Ionizer'), 'purifier'],
    ['Blo', _('X-Fan'), 'fan'],
    ['StHt', _('8° heat'), 'heater'],
    ['Air', _('Fresh air'), 'wind'],
];

const MODE_GLYPHS = {auto: 'auto', cool: 'snowflake', dry: 'drop', fan: 'fan', heat: 'sun'};

const SWINGS = {SwUpDn: 'flow', SwingLfRig: 'side'};

let fanWords = null;

// [label, value text] of a fan speed; numbered ones count among the unit's own steps.
function fanText(fan, caps) {
    fanWords ??= {
        auto: _('Auto'),
        quiet: _('Quiet'),
        low: _('Low'),
        medium: _('Medium'),
        high: _('High'),
        max: _('Max'),
        turbo: _('Turbo'),
    };
    if (fan.word)
        return [fanWords[fan.word] ?? fan.word, fanWords[fan.word] ?? fan.word];
    if (fan.label)
        return [choiceText(fan.label), choiceText(fan.label)];
    const steps = caps.fans.filter(f => !f.word && !f.label);
    const n = String(steps.indexOf(fan) + 1);
    return [n, `${n} / ${steps.length}`];
}

const fanGlyph = fan => (fan?.level >= 1 && fan.level <= 5 ? `speed${fan.level}` : null);

// SwUpDn 7-11 are partial swings; shown as Swing.
const swingOf = (key, value) => (key === 'SwUpDn' && value >= 7 ? 1 : value);

function swingChoice(value, prefix) {
    if (value === 1)
        return [1, _('Swing'), `${prefix}-swing`];
    if (value >= 2 && value <= 6)
        return [value, String(value - 1), `${prefix}${value - 1}`];
    return [0, _('Off'), `${prefix}0`];
}

// Swing or off is a switch, not a choice.
const swingsOnly = choices => choices.length === 2 && choices.every(([v]) => v === 0 || v === 1);

// [key, title, choices or null, glyph] for what the unit has, in the extension's order.
function climateTiles(state, caps) {
    const swings = (values, prefix) => (values ?? []).map(v => swingChoice(v, prefix));
    return [
        ['Mod', _('Mode'), (caps.modes ?? []).map(i => [i, modeText(i), MODE_GLYPHS[MODES[i]]]), 'aircon'],
        ['WdSpd', _('Fan'), (caps.fans ?? []).map(fan => [fan.value, fanText(fan, caps)[0], fanGlyph(fan) ?? 'auto']), 'fan'],
        ['SwUpDn', _('Up and down'), swings(caps.airflows, 'flow'), 'flow-swing'],
        ['SwingLfRig', _('Left and right'), swings(caps.sides, 'side'), 'side-swing'],
        ...CLIMATE_TOGGLES().map(([key, title, glyph]) => [key, title, null, glyph]),
    ].filter(([key, , choices]) => state[key] !== undefined && (!choices || choices.length > 1));
}

// [glyph or null for the tile's own, value text].
function tileLook(key, value, caps) {
    if (value === null)
        return [null, '–'];
    if (key === 'Mod')
        return [MODE_GLYPHS[MODES[value]] ?? null, modeText(value) || '–'];
    if (key === 'WdSpd') {
        const fan = caps.fans?.find(f => f.value === value);
        return [fanGlyph(fan), fan ? fanText(fan, caps)[1] : '–'];
    }
    const prefix = SWINGS[key];
    if (prefix) {
        const at = swingOf(key, value);
        if (at === 1)
            return [`${prefix}-swing`, _('Swing')];
        if (at >= 2 && at <= 6)
            return [`${prefix}${at - 1}`, `${at - 1} / 5`];
        return [`${prefix}0`, _('Off')];
    }
    return [null, value ? _('On') : _('Off')];
}

// The menu's air conditioner card in a device page: the target and the unit's settings
// as tiles, for Gree, Midea, Daikin (lib/aircon-home.js). The hero shows the rest.
export class ClimateCard {
    constructor({device, home, page, toast, written}) {
        this._device = device;
        this._home = home;
        this._page = page;
        this._toast = toast;
        this._written = written;
        // What the card set and the unit has not confirmed yet, shown over its state.
        this._wanted = new Map();
        this._queue = Promise.resolve();
        this._settle = 0;
        this._touched = 0;
        this._reading = false;
        this._gone = false;
        this.groups = [];

        this.stage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, visible: false, css_classes: ['nook-stage', 'nook-climate']});
        this._line = new Gtk.Box({spacing: 6, css_classes: ['nook-stepper-line']});
        this._line.append(new Gtk.Label({label: _('Temperature'), xalign: 0, hexpand: true, wrap: true, css_classes: ['nook-slider-title']}));
        this._minus = roundButton('list-remove-symbolic', _('Cooler'), () => this._nudge(-1));
        this._target = new Gtk.Label({width_chars: 7, css_classes: ['numeric', 'nook-stepper-value']});
        this._plus = roundButton('list-add-symbolic', _('Warmer'), () => this._nudge(1));
        const stepper = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, css_classes: ['nook-stepper']});
        stepper.append(this._minus);
        stepper.append(this._target);
        stepper.append(this._plus);
        this._line.append(stepper);
        this.stage.append(this._line);
        this._grid = new TileGrid();
        this.stage.append(this._grid);

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, READ_EVERY, () => {
            this._read().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
        this._read(true).catch(logError);
        this.sync();
    }

    // A target still settling goes out now.
    forget() {
        if (this._gone)
            return;
        GLib.source_remove(this._timer);
        this._gone = true;
        if (this._settle) {
            GLib.source_remove(this._settle);
            this._settle = 0;
            this._write({SetTem: this._wanted.get('SetTem')});
        }
    }

    sync() {
        if (this._gone)
            return;
        const {state, caps} = this._device;
        this.stage.visible = Boolean(state && caps);
        this.stage.sensitive = this._device.online !== false;
        if (!state || !caps)
            return;
        const shown = {...state, ...Object.fromEntries(this._wanted)};
        this._line.visible = Boolean(caps.range);
        if (caps.range) {
            const [min, max] = caps.range;
            const target = shown.SetTem;
            const known = typeof target === 'number';
            this._target.label = known ? `${numberFormat.format(target)} °C` : '–';
            this._minus.sensitive = !known || target > min;
            this._plus.sensitive = !known || target < max;
        }
        this._grid.show(climateTiles(shown, caps).map(([key, title, choices, glyph]) => {
            const [look, text] = tileLook(key, shown[key], caps);
            const tile = {title, glyph: look ?? glyph, text};
            if (choices && !(SWINGS[key] && swingsOnly(choices)))
                return {...tile, value: swingOf(key, shown[key]), choices, pick: v => this._write({[key]: v})};
            // Quiet stays 1: greeclimate sends 2, which firmware 3.75 ignores.
            return {...tile, on: Boolean(shown[key]), pick: on => this._write({[key]: on ? 1 : 0})};
        }));
    }

    // The device as it will be once what the card set lands, or null when nothing waits:
    // the page can draw the hero from it.
    preview() {
        if (this._wanted.size === 0 || !this._device.state)
            return null;
        return Object.assign(Object.create(this._device), {state: {...this._device.state, ...Object.fromEntries(this._wanted)}});
    }

    _changed() {
        if (this._gone)
            return;
        if (typeof this._page?.sync === 'function')
            this._page.sync();
        else
            this.sync();
    }

    _nudge(direction) {
        const {state, caps} = this._device;
        if (!state || !caps?.range)
            return;
        const [min, max, step] = caps.range;
        const from = this._wanted.get('SetTem') ?? state.SetTem;
        const next = snapTemperature(caps, (typeof from === 'number' ? from : (min + max) / 2) + direction * step);
        this._touched = Date.now();
        this._wanted.set('SetTem', next);
        this._changed();
        if (this._settle)
            GLib.source_remove(this._settle);
        this._settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NUDGE_SETTLE, () => {
            this._settle = 0;
            this._write({SetTem: next});
            return GLib.SOURCE_REMOVE;
        });
    }

    // One write at a time: a source without a queue of its own could apply quick changes
    // out of order.
    _write(changes) {
        this._touched = Date.now();
        for (const [key, value] of Object.entries(changes))
            this._wanted.set(key, value);
        this._changed();
        this._queue = this._queue.then(() => this._send(changes)).catch(logError);
    }

    async _send(changes) {
        const device = this._device;
        let done = false;
        try {
            await device.source.set(device, changes);
            done = true;
        } catch (e) {
            if (!(e instanceof ClimateError) && !(e instanceof GLib.Error))
                throw e;
            if (!this._gone && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._toast(e.message);
        } finally {
            for (const [key, value] of Object.entries(changes)) {
                if (this._wanted.get(key) === value)
                    this._wanted.delete(key);
            }
            if (!done)
                this._changed();
        }
        if (done && !this._gone) {
            this._written();
            this._home.onEvent?.();
        }
    }

    // The home reads every unit only once a minute; this one is read while its page shows.
    async _read(now = false) {
        const device = this._device;
        if (this._gone || this._reading || typeof device.source?.readDevice !== 'function' ||
            (!now && !this._page?.get_mapped()) || this._settle || this._wanted.size > 0 ||
            Date.now() - this._touched < TOUCHED)
            return;
        this._reading = true;
        try {
            await device.source.readDevice(device);
        } finally {
            this._reading = false;
        }
        if (!this._gone)
            this._home.onEvent?.();
    }
}
