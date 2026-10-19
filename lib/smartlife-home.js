// SPDX-License-Identifier: GPL-2.0-or-later

// Smart Life devices through the Tuya cloud, as prefs saved them in smartlife-devices
// with the data points each one has. The account is read from the keyring on first use.

import Gio from 'gi://Gio';

import {SmartLifeCloud, storeAccount} from './smartlife.js';
import {RO, SpecError, SpecHome, WHITE, colorProp, layout, nearestColor, prop, rgbToHsv} from './spec-home.js';

// Product categories (Tuya's own short codes) by device type.
const TYPES = {
    light: ['dj', 'dd', 'xdd', 'fwd', 'dc', 'tgq', 'tgkg', 'sxd', 'gyd', 'tyndj', 'ty'],
    switch: ['kg', 'tdq', 'clkg', 'kgq'],
    outlet: ['cz', 'pc'],
    fan: ['fs', 'fsd', 'fskg'],
    'air-conditioner': ['kt', 'ktkzq'],
    thermostat: ['wk', 'wkf'],
    heater: ['qn', 'rs'],
    humidifier: ['jsq'],
    dehumidifier: ['cs'],
    'air-purifier': ['kj'],
    curtain: ['cl', 'mc'],
    vacuum: ['sd'],
    kettle: ['bh'],
    lock: ['ms', 'jtmspro'],
    'temperature-humidity-sensor': ['wsdcg', 'wnykq'],
    'motion-sensor': ['pir', 'hps'],
    'magnet-sensor': ['mcs'],
    'submersion-sensor': ['sj'],
    'smoke-sensor': ['ywbj', 'rqbj', 'cobj'],
    'light-sensor': ['ldcg'],
    'air-monitor': ['co2bj', 'pm25', 'hjjcy', 'kqzg'],
};
const TYPE_OF = new Map(Object.entries(TYPES).flatMap(([type, categories]) => categories.map(c => [c, type])));
// Categories whose switch_1, switch_2… are channels with a tile each.
const CHANNELED = ['kg', 'tdq', 'cz', 'pc', 'clkg', 'kgq'];

const ON_CODES = ['switch_led', 'switch', 'switch_1', 'power', 'switch_fan'];

// [piid, name, codes, how]; the first code a device has is used.
const MAIN = [
    [2, 'brightness', ['bright_value_v2', 'bright_value'], 'percent'],
    [3, 'color-temperature', ['temp_value_v2', 'temp_value'], 'kelvin'],
    [4, 'color', ['colour_data_v2', 'colour_data'], 'color'],
    [5, 'target-temperature', ['temp_set'], 'number'],
    [6, 'mode', ['mode'], 'enum'],
    [7, 'fan-level', ['fan_speed_enum', 'fan_speed', 'speed'], 'enum'],
    [8, 'fan-percent', ['fan_speed_percent', 'fan_speed'], 'percent'],
    [9, 'horizontal-swing', ['switch_horizontal', 'swing'], 'bool'],
    [10, 'vertical-swing', ['switch_vertical'], 'bool'],
    [11, 'target-humidity', ['humidity_set', 'dehumidify_set_value'], 'number'],
    [12, 'target-position', ['percent_control', 'position'], 'number'],
    [13, 'current-position', ['percent_state'], 'number'],
    [14, 'status', ['status'], 'enum'],
    [15, 'physical-controls-locked', ['child_lock'], 'bool'],
];
const SENSORS = [
    [1, 'temperature', ['va_temperature', 'temp_current', 'temp_indoor'], 'number'],
    [2, 'relative-humidity', ['va_humidity', 'humidity_value', 'humidity_current', 'humidity_indoor'], 'number'],
    [3, 'motion-state', ['pir', 'presence_state'], v => v === 'pir' || v === 'presence' || v === true],
    [4, 'contact-state', ['doorcontact_state'], v => v === false],
    [5, 'submersion-state', ['watersensor_state'], v => v === 'alarm' || v === '1'],
    [6, 'smoke-status', ['smoke_sensor_status', 'smoke_sensor_state'], v => v === 'alarm' || v === '1'],
    [7, 'gas-status', ['gas_sensor_status', 'gas_sensor_state', 'co_status', 'co_state'], v => v === 'alarm' || v === '1'],
    [8, 'illumination', ['illuminance_value'], 'number'],
    [9, 'electric-power', ['cur_power'], 'number'],
    [10, 'voltage', ['cur_voltage'], 'number'],
    [11, 'electric-current', ['cur_current'], 'number'],
    [12, 'power-consumption', ['add_ele'], 'number'],
    [13, 'battery-level', ['battery_percentage', 'va_battery', 'battery_value', 'residual_electricity', 'electricity_left'], 'number'],
    [14, 'co2-density', ['co2_value'], 'number'],
    [15, 'pm2.5-density', ['pm25_value'], 'number'],
];
// [aiid, action, code, value]: kept when the code takes that value.
const ACTIONS = [
    [1, 'open-cover', 'control', 'open'],
    [2, 'close-cover', 'control', 'close'],
    [3, 'stop-cover', 'control', 'stop'],
    [4, 'start-sweep', 'power_go', true],
    [5, 'pause', 'pause', true],
    [6, 'stop-sweeping', 'power_go', false],
    [7, 'start-charge', 'switch_charge', true],
];
const MODES = {cold: 'Cool', cool: 'Cool', hot: 'Heat', heat: 'Heat', wet: 'Dry', dehumidification: 'Dry', wind: 'Fan',
    fan: 'Fan', auto: 'Auto', sleep: 'Sleep', manual: 'Manual', eco: 'Eco', smart: 'Smart'};
// vacuumMode() reads these.
const VACUUM = {standby: 'Idle', sleep: 'Idle', smart: 'Cleaning', cleaning: 'Cleaning', zone_clean: 'Cleaning',
    part_clean: 'Cleaning', wall_follow: 'Cleaning', spiral: 'Cleaning', single: 'Cleaning', mop_clean: 'Cleaning',
    goto_charge: 'Go charging', charging: 'Charging', charge_done: 'Charging completed', fault: 'Error', paused: 'Paused'};
const UNITS = {'℃': 'celsius', '°C': 'celsius', '%': 'percentage', 'W': 'watt', 'V': 'volt', 'A': 'ampere', 'kW·h': 'kWh',
    'kWh': 'kWh', 'lux': 'lux', 'lx': 'lux', 'ppm': 'ppm'};

export function parseDevices(json) {
    try {
        const devices = JSON.parse(json || '[]');
        return Array.isArray(devices)
            ? devices.filter(d => /^\w+$/.test(d?.id ?? '') && d.codes && typeof d.codes === 'object')
            : [];
    } catch {
        return [];
    }
}

export const didOf = entry => (entry.channel ? `smartlife:${entry.id}/${entry.channel}` : `smartlife:${entry.id}`);

function parseValues(values) {
    if (values && typeof values === 'object')
        return values;
    try {
        return JSON.parse(values || '{}') ?? {};
    } catch {
        return {};
    }
}

// What smartlife-devices keeps of one device: the data points Nook knows, with their
// limits; a switch with several channels becomes an entry per channel.
export function savedDevices(item, specification, room) {
    const known = new Set([...ON_CODES, 'work_mode', 'control', 'power_go', 'pause', 'switch_charge', 'bright_value',
        ...[...MAIN, ...SENSORS].flatMap(([, , codes]) => codes)]);
    const codes = {};
    const take = (list, writable) => {
        for (const point of list ?? []) {
            if (!point?.code || !(known.has(point.code) || /^switch_\d$/.test(point.code)))
                continue;
            const values = parseValues(point.values);
            const kept = codes[point.code] ?? {t: point.type};
            kept[writable ? 'w' : 'r'] = true;
            for (const key of ['min', 'max', 'scale', 'step', 'unit', 'range'])
                kept[key] ??= values[key];
            if (point.type === 'Json')
                kept.json = Object.fromEntries(['h', 's', 'v'].map(k => [k, values[k]?.max]).filter(([, max]) => max));
            codes[point.code] = kept;
        }
    };
    take(specification?.functions, true);
    take(specification?.status, false);
    if (Object.keys(codes).length === 0)
        return [];
    const base = {
        id: item.id,
        name: item.name || item.product_name || item.id,
        room: room?.name || null,
        category: item.category ?? null,
        model: item.product_name || null,
        codes,
    };
    const channels = Object.keys(codes).filter(code => /^switch_\d$/.test(code)).sort();
    if (CHANNELED.includes(item.category) && channels.length > 1)
        return channels.map((code, i) => ({...base, name: `${base.name} ${i + 1}`, channel: Number(code.slice(7))}));
    return [{...base, channel: null}];
}

export function typeOf(entry) {
    const type = TYPE_OF.get(entry.category);
    if (type)
        return type;
    const has = code => code in entry.codes;
    if (ON_CODES.some(has))
        return 'switch';
    if (has('pir') || has('presence_state'))
        return 'motion-sensor';
    if (has('doorcontact_state'))
        return 'magnet-sensor';
    if (has('va_temperature') || has('temp_current'))
        return 'temperature-humidity-sensor';
    return 'sensor';
}

const SERVICES = {outlet: 'switch', 'temperature-humidity-sensor': 'sensor', 'motion-sensor': 'sensor',
    'magnet-sensor': 'sensor', 'submersion-sensor': 'sensor', 'smoke-sensor': 'sensor', 'light-sensor': 'sensor',
    'air-monitor': 'sensor', 'sensor': 'sensor'};

function groupsOf(entry) {
    const type = typeOf(entry);
    const codes = entry.codes;
    // The type each way of reading a data point needs.
    const fits = {bool: 'Boolean', percent: 'Integer', kelvin: 'Integer', color: 'Json', number: 'Integer', enum: 'Enum'};
    const first = (list, how = null) => list.find(code => codes[code] && (typeof how !== 'string' || codes[code].t === fits[how]));
    const get = code => s => s.status.get(code) ?? null;
    const command = (code, value) => [{code, value}];
    const scale = code => 10 ** (codes[code].scale ?? 0);
    const unitOf = code => {
        const unit = codes[code].unit ?? '';
        if (unit === 'mA')
            return {unit: 'ampere'};
        if (UNITS[unit])
            return {unit: UNITS[unit]};
        return unit ? {suffix: unit === '℉' ? '°F' : unit} : {};
    };
    const access = code => [codes[code].r ? 'read' : null, codes[code].w ? 'write' : null].filter(Boolean);
    const span = code => {
        const {min = 0, max = 100} = codes[code];
        return [min, max > min ? max : min + 1];
    };

    const field = ([piid, name, list, how]) => {
        const code = first(list, how);
        if (!code)
            return null;
        const point = codes[code];
        const writable = point.w;
        const read = get(code);
        if (typeof how === 'function') {
            return [prop(piid, name, 'bool', RO), s => {
                const v = read(s);
                return v === null ? null : how(v);
            }];
        }
        switch (how) {
        case 'bool':
            return point.t === 'Boolean' ? [prop(piid, name, 'bool', access(code)), read,
                writable ? v => command(code, Boolean(v)) : null] : null;
        case 'percent': {
            if (point.t !== 'Integer')
                return null;
            const [min, max] = span(code);
            return [prop(piid, name, 'uint8', access(code), {unit: 'percentage', range: [1, 100, 1]}), s => {
                const v = read(s);
                return typeof v === 'number' ? Math.round(1 + (v - min) * 99 / (max - min)) : null;
            }, writable ? v => command(code, Math.round(min + (Math.min(100, Math.max(1, v)) - 1) * (max - min) / 99)) : null];
        }
        case 'kelvin': {
            if (point.t !== 'Integer')
                return null;
            const [min, max] = span(code);
            const white = s => !codes.work_mode || s.status.get('work_mode') === 'white';
            return [prop(piid, name, 'uint16', access(code), {unit: 'kelvin', range: [2700, 6500, 1]}), s => {
                const v = read(s);
                return typeof v === 'number' && white(s) ? Math.round(2700 + (v - min) * 3800 / (max - min)) : null;
            }, writable ? v => command(code, Math.round(min + (Math.min(6500, Math.max(2700, v)) - 2700) * (max - min) / 3800)) : null];
        }
        case 'color': {
            if (point.t !== 'Json' || !writable)
                return null;
            const {h: hMax = 360, s: sMax = 1000, v: vMax = 1000} = point.json ?? {};
            const hsv = s => {
                const v = read(s);
                try {
                    return typeof v === 'string' ? JSON.parse(v) : v;
                } catch {
                    return null;
                }
            };
            return [colorProp(piid), s => {
                if (codes.work_mode && s.status.get('work_mode') === 'white')
                    return WHITE;
                const now = hsv(s);
                return typeof now?.h === 'number' && typeof now?.s === 'number' ? nearestColor(now.h * 360 / hMax, now.s / sMax) : null;
            }, (v, s) => {
                if (v === WHITE && codes.work_mode?.w)
                    return command('work_mode', 'white');
                const [h, sat] = rgbToHsv(v);
                const level = (s && hsv(s)?.v) || vMax;
                const commands = command(code, JSON.stringify({h: Math.round(h * hMax / 360), s: Math.round(sat * sMax), v: level}));
                return codes.work_mode?.w ? [...command('work_mode', 'colour'), ...commands] : commands;
            }];
        }
        case 'number': {
            if (point.t !== 'Integer')
                return null;
            const divisor = scale(code) * (point.unit === 'mA' ? 1000 : 1);
            const [min, max] = span(code);
            const step = (point.step ?? 1) / divisor;
            return [prop(piid, name, 'float', access(code), {...unitOf(code), range: [min / divisor, max / divisor, step]}), s => {
                const v = read(s);
                return typeof v === 'number' ? Math.round(v / divisor * 100) / 100 : null;
            }, writable ? v => command(code, Math.min(max, Math.max(min, Math.round(v * divisor)))) : null];
        }
        case 'enum': {
            if (point.t !== 'Enum' || !Array.isArray(point.range))
                return null;
            const words = name === 'status' ? VACUUM : MODES;
            if (name === 'status' && type !== 'vacuum')
                return null;
            const choices = point.range.map(value => ({value,
                description: words[value] ?? (/^\d+$/.test(value) ? `Level ${value}` : String(value).replace(/_/g, ' '))}));
            return [prop(piid, name, 'string', access(code), {choices}), read, writable ? v => command(code, v) : null];
        }
        }
        return null;
    };

    const main = [];
    const onCode = entry.channel ? `switch_${entry.channel}` : first(ON_CODES);
    if (onCode && codes[onCode]?.t === 'Boolean')
        main.push([prop(1, 'on', 'bool', access(onCode)), get(onCode), codes[onCode].w ? v => command(onCode, Boolean(v)) : null]);
    // A light sensor's bright_value is its reading, not a brightness.
    if (!entry.channel)
        main.push(...MAIN.filter(([, name]) => !(entry.category === 'ldcg' && name === 'brightness')).map(field).filter(Boolean));
    const actions = entry.channel ? [] : ACTIONS.filter(([, , code, value]) => codes[code]?.w &&
        (codes[code].t === 'Boolean' || codes[code].range?.includes(value)))
        .map(([aiid, name, code, value]) => [aiid, name, () => command(code, value)]);
    const lux = entry.category === 'ldcg' && codes.bright_value ? [[8, 'illumination', ['bright_value'], 'number']] : [];
    const sensors = !entry.channel || entry.channel === Number(Object.keys(codes).filter(c => /^switch_\d$/.test(c)).sort()[0]?.slice(7))
        ? [...SENSORS, ...lux].map(field).filter(Boolean) : [];
    const groups = [];
    if (main.length > 0 || actions.length > 0)
        groups.push([2, SERVICES[type] ?? type, main, actions]);
    if (sensors.length > 0)
        groups.push([3, 'sensor', sensors]);
    return groups;
}

const READ_GAP = 10 * 1000;

export class SmartLifeHome extends SpecHome {
    constructor(entries) {
        super('Smart Life', {gap: READ_GAP, fresh: 3000, assumed: 8000});
        this._cancellable = new Gio.Cancellable();
        this._cloud = null;
        this._loading = null;
        this._entries = new Map();
        this._layouts = new Map();
        for (const entry of entries) {
            const did = didOf(entry);
            const groups = groupsOf(entry);
            if (this._entries.has(did) || groups.length === 0)
                continue;
            this._entries.set(did, entry);
            this._layouts.set(did, layout(groups));
            this._add({
                did,
                name: entry.name,
                model: 'smartlife',
                urn: `urn:nook:device:${typeOf(entry)}:0`,
                room: entry.room ?? null,
                about: {model: entry.model ?? null},
            });
        }
    }

    get loggedIn() {
        return !this._cloud?.expired;
    }

    abort() {
        this._cancellable.cancel();
        this._cloud?.abort();
    }

    _layout(device) {
        return this._layouts.get(device.did);
    }

    _adopt(cloud) {
        if (this._cancellable.is_cancelled())
            cloud.abort();
        // A renewal finishing after logout must not store the login again.
        cloud.onRefresh = account => {
            if (this._cloud === cloud && !this._cancellable.is_cancelled())
                storeAccount(account).catch(logError);
        };
        this._cloud = cloud;
        return cloud;
    }

    _account() {
        this._loading ??= SmartLifeCloud.load(this._cancellable).then(cloud => {
            if (!cloud)
                throw new SpecError('Log in to Smart Life in the Nook settings', 'expired');
            return this._adopt(cloud);
        }).catch(e => {
            this._loading = null;
            throw e;
        });
        return this._loading;
    }

    // The preferences may have renewed the login meanwhile: before giving up on it, the
    // keyring's is tried once.
    async _cloudCall(task) {
        let cloud = null;
        try {
            cloud = await this._account();
            return await task(cloud);
        } catch (e) {
            if (e.code !== 'expired' && !cloud?.expired)
                throw e;
            const fresh = await SmartLifeCloud.load(this._cancellable).catch(() => null);
            if (!fresh || fresh.account.refreshToken === cloud?.account.refreshToken || this._cancellable.is_cancelled()) {
                fresh?.abort();
                this._expired();
                throw e;
            }
            cloud?.abort();
            this._loading = Promise.resolve(this._adopt(fresh));
            try {
                return await task(fresh);
            } catch (again) {
                if (again.code === 'expired' || fresh.expired)
                    this._expired();
                throw again;
            }
        }
    }

    async _refresh(devices) {
        const ids = [...new Set(devices.map(d => this._entries.get(d.did).id))];
        const items = new Map((await this._cloudCall(cloud => cloud.details(ids))).map(item => [item.id, item]));
        for (const device of this.devices.filter(d => ids.includes(this._entries.get(d.did).id))) {
            const item = items.get(this._entries.get(device.did).id);
            const status = new Map((item?.status ?? []).filter(s => s?.code).map(s => [s.code, s.value]));
            this._keep(device, {status}, item?.online === true);
        }
    }

    _send(device, commands) {
        return this._cloudCall(cloud => cloud.commands(this._entries.get(device.did).id, commands));
    }
}

