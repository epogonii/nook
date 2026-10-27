// SPDX-License-Identifier: GPL-2.0-or-later

// Home Assistant entities, grouped as prefs saved them in hass-devices. One WebSocket
// subscription keeps their states current while the menu lives.

import GLib from 'gi://GLib';

import * as Secrets from './secrets.js';
import {BINARY_CLASSES, HassClient, SECRET, SENSOR_CLASSES} from './hass.js';
import {RO, RW, SpecError, SpecHome, WHITE, clamp, colorProp, layout, nearestColor, prop, rgbToHsv} from './spec-home.js';

export {parseDevices} from './hass.js';

// Home Assistant restarting closes the socket; tiles come back without a click.
const RECONNECT = 30;

const ON = s => (s === 'on' ? true : s === 'off' ? false : null);
const number = value => (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? Number(value) : null);
const round = (value, digits = 1) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const has = (attributes, flag) => ((attributes.supported_features ?? 0) & flag) !== 0;

// HA's own units to MIoT's; others are shown as HA writes them.
const UNITS = {'°C': 'celsius', '%': 'percentage', 'lx': 'lux', 'W': 'watt', 'V': 'volt', 'A': 'ampere', 'kWh': 'kWh', 'ppm': 'ppm', 'K': 'kelvin'};
const unitOf = unit => (UNITS[unit] ? {unit: UNITS[unit]} : {suffix: unit || null});

const HVAC = {off: 'Off', heat: 'Heat', cool: 'Cool', heat_cool: 'Heat and cool', auto: 'Auto', dry: 'Dry', fan_only: 'Fan'};
const COVER = {open: 'Open', closed: 'Closed', opening: 'Opening', closing: 'Closing'};
const LOCK = {locked: 'Locked', unlocked: 'Unlocked', locking: 'Locking', unlocking: 'Unlocking', jammed: 'Jammed', open: 'Open', opening: 'Opening'};
// vacuumMode() reads these: "Go charging" is returning, "Charging" docked.
const VACUUM = {cleaning: 'Cleaning', docked: 'Charging', returning: 'Go charging', paused: 'Paused', idle: 'Idle', error: 'Error'};
const PLAYER = {playing: 'Playing', paused: 'Paused', idle: 'Idle', buffering: 'Buffering', on: 'On', off: 'Off', standby: 'Standby'};

const choices = map => Object.entries(map).map(([value, description]) => ({value, description}));
const named = list => list.map(value => ({value, description: String(value).replace(/_/g, ' ')}));

function controlProps(entity, attributes, fahrenheit) {
    const id = entity.id;
    const [domain] = id.split('.');
    const call = (service, data = {}) => ({domain, service, id, data});
    const state = s => s.get(id);
    const value = (s, key) => state(s)?.a?.[key];
    const props = [];
    const actions = [];
    const temperature = fahrenheit ? {suffix: '°F'} : {unit: 'celsius'};

    switch (domain) {
    case 'light': {
        const modes = attributes.supported_color_modes ?? [];
        props.push([prop(1, 'on', 'bool', RW), s => ON(state(s)?.s), v => call(v ? 'turn_on' : 'turn_off')]);
        if (modes.some(m => m !== 'onoff')) {
            props.push([prop(2, 'brightness', 'uint8', RW, {unit: 'percentage', range: [1, 100, 1]}),
                s => (number(value(s, 'brightness')) !== null ? Math.max(1, Math.round(value(s, 'brightness') / 255 * 100)) : null),
                v => call('turn_on', {brightness_pct: clamp(v, 1, 100)})]);
        }
        const low = attributes.min_color_temp_kelvin ?? 2000;
        const high = attributes.max_color_temp_kelvin ?? 6500;
        const white = s => ['color_temp', 'white'].includes(value(s, 'color_mode'));
        if (modes.includes('color_temp')) {
            props.push([prop(3, 'color-temperature', 'uint16', RW, {unit: 'kelvin', range: [low, high, 1]}),
                s => (value(s, 'color_mode') === 'color_temp' ? number(value(s, 'color_temp_kelvin')) : null),
                v => call('turn_on', {color_temp_kelvin: clamp(Math.round(v), low, high)})]);
        }
        if (modes.some(m => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(m))) {
            props.push([colorProp(4), s => {
                if (white(s))
                    return WHITE;
                const hs = value(s, 'hs_color');
                return Array.isArray(hs) ? nearestColor(hs[0], hs[1] / 100) : null;
            }, v => {
                if (v === WHITE && modes.includes('color_temp'))
                    return call('turn_on', {color_temp_kelvin: clamp(4000, low, high)});
                const [h, sat] = rgbToHsv(v);
                return call('turn_on', {hs_color: [Math.round(h), Math.round(sat * 100)]});
            }]);
        }
        break;
    }
    case 'switch':
    case 'input_boolean':
        props.push([prop(1, 'on', 'bool', RW), s => ON(state(s)?.s), v => call(v ? 'turn_on' : 'turn_off')]);
        break;
    case 'fan':
        props.push([prop(1, 'on', 'bool', RW), s => ON(state(s)?.s), v => call(v ? 'turn_on' : 'turn_off')]);
        if (has(attributes, 1)) {
            props.push([prop(2, 'fan-percent', 'uint8', RW, {unit: 'percentage', range: [1, 100, Math.max(1, Math.round(attributes.percentage_step ?? 1))]}),
                s => number(value(s, 'percentage')) || null, v => call('set_percentage', {percentage: clamp(v, 1, 100)})]);
        }
        if (has(attributes, 2)) {
            props.push([prop(3, 'horizontal-swing', 'bool', RW), s => value(s, 'oscillating') ?? null,
                v => call('oscillate', {oscillating: v})]);
        }
        if (has(attributes, 8) && attributes.preset_modes?.length > 0) {
            props.push([prop(4, 'mode', 'string', RW, {choices: named(attributes.preset_modes)}),
                s => value(s, 'preset_mode') ?? null, v => call('set_preset_mode', {preset_mode: v})]);
        }
        break;
    case 'cover':
        if (has(attributes, 4)) {
            props.push([prop(1, 'current-position', 'uint8', RO, {unit: 'percentage', range: [0, 100, 1]}),
                s => number(value(s, 'current_position'))]);
            props.push([prop(2, 'target-position', 'uint8', RW, {unit: 'percentage', range: [0, 100, 1]}),
                s => number(value(s, 'current_position')), v => call('set_cover_position', {position: clamp(v, 0, 100)})]);
        }
        props.push([prop(3, 'status', 'string', RO, {choices: choices(COVER)}), s => (COVER[state(s)?.s] ? state(s).s : null)]);
        if (has(attributes, 1))
            actions.push([1, 'open-cover', () => call('open_cover')]);
        if (has(attributes, 2))
            actions.push([2, 'close-cover', () => call('close_cover')]);
        if (has(attributes, 8))
            actions.push([3, 'stop-cover', () => call('stop_cover')]);
        break;
    case 'climate': {
        const modes = attributes.hvac_modes ?? [];
        const firstOn = ['heat_cool', 'auto', 'heat', 'cool'].find(m => modes.includes(m)) ?? modes.find(m => m !== 'off');
        if (modes.includes('off') && firstOn) {
            props.push([prop(1, 'on', 'bool', RW), s => (state(s) && state(s).s !== 'unavailable' ? state(s).s !== 'off' : null),
                v => (has(attributes, v ? 256 : 128) ? call(v ? 'turn_on' : 'turn_off') : call('set_hvac_mode', {hvac_mode: v ? firstOn : 'off'}))]);
        }
        if (modes.length > 1) {
            props.push([prop(2, 'mode', 'string', RW, {choices: modes.map(m => ({value: m, description: HVAC[m] ?? m}))}),
                s => (modes.includes(state(s)?.s) ? state(s).s : null), v => call('set_hvac_mode', {hvac_mode: v})]);
        }
        if (has(attributes, 1)) {
            const step = attributes.target_temp_step ?? (fahrenheit ? 1 : 0.5);
            props.push([prop(3, 'target-temperature', 'float', RW, {...temperature,
                range: [attributes.min_temp ?? (fahrenheit ? 45 : 7), attributes.max_temp ?? (fahrenheit ? 95 : 35), step]}),
            s => number(value(s, 'temperature')), v => call('set_temperature', {temperature: v})]);
        }
        props.push([prop(4, 'temperature', 'float', RO, temperature), s => round(number(value(s, 'current_temperature')))]);
        props.push([prop(5, 'relative-humidity', 'float', RO, {unit: 'percentage'}), s => round(number(value(s, 'current_humidity')))]);
        if (has(attributes, 8) && attributes.fan_modes?.length > 0) {
            props.push([prop(6, 'fan-level', 'string', RW, {choices: named(attributes.fan_modes)}),
                s => value(s, 'fan_mode') ?? null, v => call('set_fan_mode', {fan_mode: v})]);
        }
        break;
    }
    case 'humidifier':
        props.push([prop(1, 'on', 'bool', RW), s => ON(state(s)?.s), v => call(v ? 'turn_on' : 'turn_off')]);
        props.push([prop(2, 'target-humidity', 'uint8', RW, {unit: 'percentage',
            range: [attributes.min_humidity ?? 0, attributes.max_humidity ?? 100, 1]}),
        s => number(value(s, 'humidity')), v => call('set_humidity', {humidity: Math.round(v)})]);
        if (has(attributes, 1) && attributes.available_modes?.length > 0) {
            props.push([prop(3, 'mode', 'string', RW, {choices: named(attributes.available_modes)}),
                s => value(s, 'mode') ?? null, v => call('set_mode', {mode: v})]);
        }
        props.push([prop(4, 'relative-humidity', 'float', RO, {unit: 'percentage'}), s => round(number(value(s, 'current_humidity')))]);
        break;
    // Locking only: unlocking from a menu is one stray click too easy.
    case 'lock':
        props.push([prop(1, 'status', 'string', RO, {choices: choices(LOCK)}), s => (LOCK[state(s)?.s] ? state(s).s : null)]);
        actions.push([1, 'lock-door', () => call('lock')]);
        break;
    case 'vacuum':
        props.push([prop(1, 'status', 'string', RO, {choices: choices(VACUUM)}), s => (VACUUM[state(s)?.s] ? state(s).s : null)]);
        props.push([prop(2, 'battery-level', 'uint8', RO, {unit: 'percentage'}), s => number(value(s, 'battery_level'))]);
        if (has(attributes, 8192))
            actions.push([1, 'start-sweep', () => call('start')]);
        if (has(attributes, 4))
            actions.push([2, 'pause', () => call('pause')]);
        if (has(attributes, 8))
            actions.push([3, 'stop-sweeping', () => call('stop')]);
        if (has(attributes, 16))
            actions.push([4, 'start-charge', () => call('return_to_base')]);
        break;
    case 'media_player':
        if (has(attributes, 128) && has(attributes, 256)) {
            props.push([prop(1, 'on', 'bool', RW), s => (state(s) && state(s).s !== 'unavailable' ? !['off', 'standby'].includes(state(s).s) : null),
                v => call(v ? 'turn_on' : 'turn_off')]);
        }
        if (has(attributes, 4)) {
            props.push([prop(2, 'volume', 'uint8', RW, {unit: 'percentage', range: [0, 100, 1]}),
                s => (number(value(s, 'volume_level')) !== null ? Math.round(value(s, 'volume_level') * 100) : null),
                v => call('volume_set', {volume_level: clamp(v, 0, 100) / 100})]);
        }
        if (has(attributes, 8)) {
            props.push([prop(3, 'mute', 'bool', RW), s => value(s, 'is_volume_muted') ?? null,
                v => call('volume_mute', {is_volume_muted: v})]);
        }
        props.push([prop(4, 'playing-state', 'string', RO, {choices: choices(PLAYER)}), s => (PLAYER[state(s)?.s] ? state(s).s : null)]);
        if (has(attributes, 16384))
            actions.push([1, 'play-media', () => call('media_play')]);
        if (has(attributes, 1))
            actions.push([2, 'pause', () => call('media_pause')]);
        if (has(attributes, 32))
            actions.push([3, 'next-track', () => call('media_next_track')]);
        break;
    }
    return {props, actions};
}

function sensorProp(entity, attributes, piid, fahrenheit) {
    const id = entity.id;
    const [domain] = id.split('.');
    const cls = attributes.device_class;
    const since = s => {
        const changed = s.get(id)?.lc;
        return typeof changed === 'number' ? Math.floor(changed) : null;
    };
    if (domain === 'binary_sensor') {
        const name = BINARY_CLASSES[cls];
        // contact-state is true when closed; a door's binary sensor is on when open.
        const read = name === 'contact-state'
            ? s => (ON(s.get(id)?.s) === null ? null : !ON(s.get(id).s))
            : s => ON(s.get(id)?.s);
        return [prop(piid, name, 'bool', RO), read, null, since];
    }
    const name = SENSOR_CLASSES[cls];
    const unit = attributes.unit_of_measurement ?? null;
    const shown = unit === '°F' || (fahrenheit && cls === 'temperature' && !unit) ? {suffix: '°F'} : unitOf(unit);
    return [prop(piid, name, 'float', RO, shown), s => round(number(s.get(id)?.s), 2)];
}

function groupsOf(entry) {
    const [lead, ...rest] = entry.entities;
    const [domain] = lead.id.split('.');
    const groups = [];
    const sensors = domain === 'sensor' || domain === 'binary_sensor' ? entry.entities : rest;
    if (sensors !== entry.entities) {
        const {props, actions} = controlProps(lead, lead.attributes, entry.fahrenheit);
        groups.push([2, entry.type, props, actions]);
    }
    const readings = sensors.map((entity, i) => sensorProp(entity, entity.attributes, i + 1, entry.fahrenheit));
    if (readings.length > 0)
        groups.push([3, 'sensor', readings]);
    return groups;
}

export class HassHome extends SpecHome {
    constructor(entries) {
        super('Home Assistant', {gap: 1000, fresh: 1000, assumed: 4000});
        this._client = null;
        this._connecting = null;
        this._retry = 0;
        this._aborted = false;
        // Set when HA refused the token: every retry would be a failed login on its side.
        this._refused = false;
        this._open = false;
        this._entities = new Map();
        this._entries = new Map();
        this._layouts = new Map();
        this.onChange = null;
        for (const entry of entries) {
            const did = `hass:${entry.id}`;
            if (this._entries.has(did))
                continue;
            this._entries.set(did, entry);
            this._layouts.set(did, layout(groupsOf(entry)));
            this._add({
                did,
                name: entry.name || entry.id,
                model: 'hass',
                urn: `urn:nook:device:${entry.type}:0`,
                room: entry.room ?? null,
                about: {model: entry.model ?? null},
            });
        }
    }

    abort() {
        this._aborted = true;
        if (this._retry)
            GLib.source_remove(this._retry);
        this._retry = 0;
        this._client?.close();
        this._client = null;
    }

    _reconnectSoon() {
        if (this._aborted || this._retry)
            return;
        this._retry = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, RECONNECT, () => {
            this._retry = 0;
            this._reconnect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reconnect() {
        this._refresh().then(() => this.onChange?.()).catch(e => console.debug(`nook: Home Assistant: ${e.message}`));
    }

    // After a network change an open socket can hang on a dead connection until TCP gives
    // up. A connection still being made is left to its own timeout: closing it here would
    // race its failure handler.
    reconnect() {
        if (this._open)
            this._client.close();
        if (!this._retry)
            return;
        GLib.source_remove(this._retry);
        this._retry = 0;
        this._reconnect();
    }

    _layout(device) {
        return this._layouts.get(device.did);
    }

    _ids() {
        return [...new Set([...this._entries.values()].flatMap(e => e.entities.map(entity => entity.id)))];
    }

    _connect() {
        if (this._refused)
            return Promise.reject(new SpecError('Home Assistant refused the access token', 'unauthorized'));
        this._connecting ??= (async () => {
            const saved = await Secrets.lookup(SECRET);
            let account;
            try {
                account = saved ? JSON.parse(saved) : null;
            } catch {
                account = null;
            }
            if (!account?.url || !account?.token)
                throw new SpecError('Connect Home Assistant in the Nook settings', 'unauthorized');
            const client = new HassClient(account.url, account.token);
            if (this._aborted)
                throw new SpecError('Closed', 'closed');
            this._client = client;
            client.onClose = error => {
                if (this._client !== client)
                    return;
                this._client = null;
                this._connecting = null;
                this._open = false;
                for (const device of this.devices)
                    device.online = false;
                this.onChange?.();
                if (error?.code !== 'unauthorized')
                    this._reconnectSoon();
            };
            try {
                await client.connect();
                await client.subscribeEntities(this._ids(), event => this._heard(event));
            } catch (e) {
                client.onClose = null;
                client.close();
                if (this._client === client)
                    this._client = null;
                throw e;
            }
            this._open = true;
            return client;
        })().catch(e => {
            this._connecting = null;
            if (e.code === 'unauthorized') {
                this._refused = true;
                this._expired();
            } else {
                this._reconnectSoon();
            }
            throw e;
        });
        return this._connecting;
    }

    _heard(event) {
        for (const [id, state] of Object.entries(event?.a ?? {}))
            this._entities.set(id, {s: state.s, a: state.a ?? {}, lc: state.lc});
        for (const [id, diff] of Object.entries(event?.c ?? {})) {
            const known = this._entities.get(id);
            if (!known)
                continue;
            const plus = diff['+'] ?? {};
            const next = {...known, a: {...known.a, ...plus.a ?? {}}};
            if (plus.s !== undefined)
                next.s = plus.s;
            if (plus.lc !== undefined)
                next.lc = plus.lc;
            for (const key of diff['-']?.a ?? [])
                delete next.a[key];
            this._entities.set(id, next);
        }
        for (const id of event?.r ?? [])
            this._entities.delete(id);
        this._keepAll();
        this.onChange?.();
    }

    _keepAll() {
        for (const device of this.devices) {
            const lead = this._entries.get(device.did).entities[0].id;
            const state = this._entities.get(lead);
            this._keep(device, this._entities, Boolean(state) && state.s !== 'unavailable');
        }
    }

    async _refresh() {
        await this._connect();
        this._keepAll();
    }

    async _send(device, {domain, service, id, data}) {
        const client = await this._connect();
        await client.callService(domain, service, id, data);
    }
}
