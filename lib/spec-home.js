// SPDX-License-Identifier: GPL-2.0-or-later

// Base for the sources whose devices are described as trimmed MIoT services built from
// their own state (Hue, Home Assistant, HomeKit, Smart Life), so the card shows them
// like Mi Home devices. A subclass provides _layout(device, state), _refresh(devices)
// and _send(device, command, state).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class SpecError extends Error {
    constructor(message, code = '') {
        super(message);
        this.name = 'SpecError';
        this.code = code;
    }
}

export const RW = ['read', 'write'];
export const RO = ['read'];

export function prop(piid, name, format, access, extra = {}) {
    return {piid, name, format, access, unit: null, range: null, choices: null, ...extra};
}

export function service(siid, name, properties, actions = []) {
    return {siid, name, description: null, properties, actions};
}

// groups: [siid, service name, [[prop, read(state), write(value, state), time(state)]...],
// [[aiid, action name, run(state)]...]]. read gives null when unknown; write and run give
// the command _send() takes; time is when a boolean last changed, in Unix seconds.
export function layout(groups) {
    const services = [];
    const fields = new Map();
    for (const [siid, name, props, actions = []] of groups) {
        services.push(service(siid, name, props.map(([p]) => p),
            actions.map(([aiid, action]) => ({aiid, name: action, in: []}))));
        for (const [p, read, write = null, time = null] of props)
            fields.set(`${siid}/${p.piid}`, {read, write, time});
        for (const [aiid, , run] of actions)
            fields.set(`${siid}/a${aiid}`, {run});
    }
    return {services, fields};
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function unixTime(text) {
    if (typeof text !== 'string' || !text)
        return null;
    return GLib.DateTime.new_from_iso8601(text, null)?.to_unix() ?? null;
}

// A light shows one of these; any other colour reads as the nearest. White is the
// white (colour temperature) mode where a light has one.
export const WHITE = 0xffffff;
const PRESETS = [
    ['White', WHITE],
    ['Red', 0xff0000],
    ['Orange', 0xff8000],
    ['Yellow', 0xffd200],
    ['Green', 0x00ff00],
    ['Cyan', 0x00ffff],
    ['Blue', 0x0000ff],
    ['Purple', 0x8000ff],
    ['Pink', 0xff40a0],
];

export function colorProp(piid) {
    return prop(piid, 'color', 'uint32', RW, {
        choices: PRESETS.map(([description, value]) => ({value, description})),
    });
}

const channels = rgb => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map(v => v / 255);
const pack = ([r, g, b]) => (Math.round(clamp(r, 0, 1) * 255) << 16) | (Math.round(clamp(g, 0, 1) * 255) << 8) |
    Math.round(clamp(b, 0, 1) * 255);

// h in degrees, s and v 0-1.
export function rgbToHsv(rgb) {
    const [r, g, b] = channels(rgb);
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    let h = 0;
    if (span > 0 && max === r)
        h = 60 * (((g - b) / span) % 6);
    else if (span > 0 && max === g)
        h = 60 * ((b - r) / span + 2);
    else if (span > 0)
        h = 60 * ((r - g) / span + 4);
    return [(h + 360) % 360, max > 0 ? span / max : 0, max];
}

// Hue's own conversion (wide gamut, D65); the bridge clamps to each lamp's gamut.
export function rgbToXy(rgb) {
    const [r, g, b] = channels(rgb).map(v => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
    const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
    const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
    const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
    const sum = X + Y + Z;
    return sum > 0 ? [X / sum, Y / sum] : [0.3127, 0.329];
}

export function xyToRgb(x, y) {
    if (!(y > 0))
        return WHITE;
    const X = x / y;
    const Z = (1 - x - y) / y;
    let rgb = [
        X * 1.656492 - 0.354851 - Z * 0.255038,
        -X * 0.707196 + 1.655397 + Z * 0.036152,
        X * 0.051713 - 0.121364 + Z * 1.01153,
    ].map(v => Math.max(0, v));
    const top = Math.max(...rgb);
    if (top > 1)
        rgb = rgb.map(v => v / top);
    return pack(rgb.map(v => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
}

export function nearestColor(h, s) {
    if (!(s >= 0.25))
        return WHITE;
    let best = WHITE;
    let gap = Infinity;
    for (const [, value] of PRESETS.slice(1)) {
        const [hue] = rgbToHsv(value);
        const distance = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
        if (distance < gap) {
            gap = distance;
            best = value;
        }
    }
    return best;
}

export const nearestRgb = rgb => {
    const [h, s] = rgbToHsv(rgb);
    return nearestColor(h, s);
};

// Primary readings by device type, in the order a tile shows them. A single boolean
// gets the time of its last change beside it.
const READINGS = {
    'motion-sensor': ['motion-state'],
    'magnet-sensor': ['contact-state'],
    'submersion-sensor': ['submersion-state'],
    'smoke-sensor': ['smoke-status', 'gas-status'],
    'curtain': ['current-position', 'status'],
    'lock': ['status'],
};
const ANY_READINGS = ['temperature', 'relative-humidity', 'illumination', 'electric-power', 'status', 'battery-level'];

export const typeOf = device => device.urn?.split(':')[3] ?? null;

export function pickPrimary(services, type) {
    for (const s of services) {
        const on = s.properties.find(p => p.name === 'on' && p.format === 'bool' && p.access.includes('write'));
        if (on)
            return {kind: 'switch', props: [{siid: s.siid, service: s.name, ...on}]};
    }
    const readable = services.flatMap(s => s.properties
        .filter(p => p.access.includes('read'))
        .map(p => ({siid: s.siid, ...p})));
    const props = (READINGS[type] ?? ANY_READINGS).flatMap(name => readable.filter(p => p.name === name)).slice(0, 2);
    return {kind: props.length > 0 ? 'reading' : 'none', props};
}

const MAX_BACKOFF = 10 * 60 * 1000;

const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.5);

export class SpecHome {
    // gap: least time between background reads; fresh: a card asks for services and
    // values back to back, one read serves both; assumed: how long a written value is
    // shown before the device confirms it.
    constructor(label, {gap, fresh = 2500, assumed = 5000}) {
        this.label = label;
        this._gap = gap;
        this._freshFor = fresh;
        this._assumedFor = assumed;
        this._nextRead = 0;
        this._backoff = 0;
        this._states = new Map();
        this._assumed = new Map();
        this._told = false;
        this.onExpired = null;
        this.extras = [];
        this.devices = [];
    }

    // device: did, name, urn, model, room, about; the primary comes from the layout.
    _add(fields) {
        const device = {room: null, online: null, values: null, state: null, about: {}, ...fields};
        Object.defineProperty(device, 'source', {value: this, enumerable: false});
        device.primary = pickPrimary(this._layout(device, null).services, typeOf(device));
        this.devices.push(device);
        return device;
    }

    abort() {}

    _expired() {
        if (this._told)
            return;
        this._told = true;
        this.onExpired?.();
    }

    _stateOf(device) {
        return this._states.get(device.did)?.state ?? null;
    }

    _keep(device, state, online = true) {
        this._states.set(device.did, {state, at: Date.now()});
        device.online = online;
        this._sync(device);
    }

    _value(device, key, field, state) {
        const id = `${device.did} ${key}`;
        let read = null;
        if (state !== null && field.read)
            read = field.read(state) ?? null;
        const assumed = this._assumed.get(id);
        if (assumed) {
            if (Date.now() < assumed.until && !same(read, assumed.value))
                return assumed.value;
            this._assumed.delete(id);
        }
        return read;
    }

    _sync(device) {
        const state = this._stateOf(device);
        const {fields} = this._layout(device, state);
        const keys = device.primary.props.map(p => `${p.siid}/${p.piid}`);
        device.values = keys.map(key => (fields.has(key) ? this._value(device, key, fields.get(key), state) : null));
        const times = keys.map(key => (state !== null ? fields.get(key)?.time?.(state) ?? null : null));
        device.times = times.some(Boolean) ? times : undefined;
    }

    async readPrimary() {
        if (this.devices.length === 0 || Date.now() < this._nextRead)
            return false;
        this._nextRead = Date.now() + this._gap;
        try {
            await this._refresh(this.devices);
            this._backoff = 0;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return false;
            this._backoff = Math.min(Math.max(this._backoff * 2, this._gap), MAX_BACKOFF);
            this._nextRead = Date.now() + this._backoff;
            for (const device of this.devices)
                device.online = false;
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: ${this.label}: ${e.message}`);
        }
        return true;
    }

    // An unreachable device opens as offline rather than as an error.
    async _fresh(device) {
        const known = this._states.get(device.did);
        if (known && Date.now() - known.at < this._freshFor)
            return;
        try {
            await this._refresh([device]);
        } catch (e) {
            if (!(e instanceof SpecError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: ${this.label}: ${e.message}`);
            device.online = false;
            // Counted as a read: a card asks for services, then values, and should wait once.
            this._states.set(device.did, {state: known?.state ?? null, at: Date.now()});
        }
    }

    readDevice(device) {
        return this._fresh(device);
    }

    async services(device) {
        await this._fresh(device);
        return this._layout(device, this._stateOf(device)).services;
    }

    async readProperties(device, props) {
        await this._fresh(device);
        const state = this._stateOf(device);
        const {fields} = this._layout(device, state);
        const values = new Map();
        for (const {siid, piid} of props) {
            const key = `${siid}/${piid}`;
            const field = fields.get(key);
            const value = field ? this._value(device, key, field, state) : null;
            if (value !== null && value !== undefined)
                values.set(key, value);
        }
        return values;
    }

    // Read back on the next look: a write can change more than the one value.
    _stale(device) {
        const known = this._states.get(device.did);
        if (known)
            known.at = 0;
    }

    async setProperty(device, siid, piid, value) {
        const state = this._stateOf(device);
        const key = `${siid}/${piid}`;
        const write = this._layout(device, state).fields.get(key)?.write;
        if (!write)
            throw new SpecError(`${device.name} has no such setting`, 'unsupported');
        await this._send(device, write(value, state), state);
        this._assumed.set(`${device.did} ${key}`, {value, until: Date.now() + this._assumedFor});
        device.online = true;
        this._stale(device);
        this._sync(device);
    }

    setSwitch(device, on) {
        const [p] = device.primary.props;
        if (device.primary.kind !== 'switch' || !p)
            return Promise.reject(new SpecError(`${device.name} has no switch`, 'unsupported'));
        return this.setProperty(device, p.siid, p.piid, on);
    }

    async runAction(device, siid, aiid) {
        const state = this._stateOf(device);
        const run = this._layout(device, state).fields.get(`${siid}/a${aiid}`)?.run;
        if (!run)
            throw new SpecError(`${device.name} cannot do that`, 'unsupported');
        await this._send(device, run(state), state);
        this._stale(device);
    }

    readEventLog() {
        return Promise.resolve([]);
    }

    readHistory() {
        return Promise.resolve([]);
    }

    noteEvent(device, event) {
        device.lastEvent = event;
    }
}
