// SPDX-License-Identifier: GPL-2.0-or-later

// Paired HomeKit accessories, as prefs saved them in homekit-accessories. A card's
// service and property ids are the accessory's own instance ids.

import * as Secrets from './secrets.js';
import {HapHost, UNREACHABLE, secretService} from './homekit.js';
import {RW, SpecError, SpecHome, WHITE, clamp, colorProp, hsvToRgb, layout, prop, rgbToHsv} from './spec-home.js';

export {parseHosts} from './homekit.js';

// Kinds in the order the first one names the device, with its type and service name.
const KINDS = [
    ['light', 'light', 'light'],
    ['outlet', 'outlet', 'switch'],
    ['switch', 'switch', 'switch'],
    ['fan', 'fan', 'fan'],
    ['fan2', 'fan', 'fan'],
    ['thermostat', 'thermostat', 'thermostat'],
    ['heater-cooler', 'air-conditioner', 'air-conditioner'],
    ['humidifier', 'humidifier', 'humidifier'],
    ['purifier', 'air-purifier', 'air-purifier'],
    ['covering', 'curtain', 'curtain'],
    ['lock', 'lock', 'lock'],
    ['garage', 'garage-door', 'garage-door'],
    ['motion', 'motion-sensor', 'motion-sensor'],
    ['occupancy', 'motion-sensor', 'motion-sensor'],
    ['contact', 'magnet-sensor', 'magnet-sensor'],
    ['leak', 'submersion-sensor', 'submersion-sensor'],
    ['smoke', 'smoke-sensor', 'smoke-sensor'],
    ['carbon-monoxide', 'smoke-sensor', 'smoke-sensor'],
    ['temperature', 'temperature-humidity-sensor', 'temperature-humidity-sensor'],
    ['humidity', 'temperature-humidity-sensor', 'temperature-humidity-sensor'],
    ['light-level', 'light-sensor', 'illumination-sensor'],
    ['air-quality', 'air-monitor', 'air-monitor'],
    ['battery', 'sensor', 'battery'],
];
const RANK = new Map(KINDS.map(([kind], i) => [kind, i]));

const ACTIVE = v => (v === null || v === undefined ? null : v === true || v === 1);
const number = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const kelvin = mireds => Math.round(1e6 / mireds);
// A property id of our own beside the accessory's: one characteristic, two properties.
const BESIDE = 100000;

const options = (map, valid) => Object.entries(map)
    .filter(([value]) => !valid || valid.includes(Number(value)))
    .map(([value, description]) => ({value: Number(value), description}));

function serviceProps(aid, service) {
    const c = type => service.chars.find(ch => ch.type === type);
    const readable = ch => ch?.perms.includes('pr');
    const writable = ch => ch?.perms.includes('pw');
    const get = ch => s => (ch ? s.values.get(ch.iid) ?? null : null);
    const put = (ch, value) => [{aid, iid: ch.iid, value}];
    const props = [];
    const actions = [];
    // read and write take and give Nook's value; either may be left out.
    const add = (ch, name, format, extra = {}, read = get(ch), write = v => put(ch, v)) => {
        if (!ch || !(readable(ch) || writable(ch)))
            return;
        const access = [readable(ch) ? 'read' : null, writable(ch) ? 'write' : null].filter(Boolean);
        props.push([prop(ch.iid, name, format, access, extra), readable(ch) ? read : null, writable(ch) ? write : null]);
    };
    const range = (ch, [min, max, step]) => [ch?.min ?? min, ch?.max ?? max, ch?.step ?? step];
    const on = ch => add(ch, 'on', 'bool', {}, s => ACTIVE(get(ch)(s)), v => put(ch, ch.type === 'B0' ? Number(v) : v));
    const percent = (ch, name) => add(ch, name, 'uint8', {unit: 'percentage', range: [Math.max(1, ch?.min ?? 0), ch?.max ?? 100, Math.max(1, ch?.step ?? 1)]},
        s => (number(get(ch)(s)) === null ? null : Math.round(get(ch)(s))), v => put(ch, clamp(Math.round(v), 0, 100)));
    const reading = (ch, name, extra, map = v => v) => add(ch, name, 'float', extra, s => {
        const v = number(get(ch)(s));
        return v === null ? null : map(v);
    });
    const state = (ch, name, test, write = v => put(ch, v)) => add(ch, name, 'bool', {}, s => {
        const v = get(ch)(s);
        return v === null ? null : test(v);
    }, write);
    const choice = (ch, name, map) => add(ch, name, 'uint8', {choices: options(map, ch?.valid)}, get(ch));
    const round = v => Math.round(v * 10) / 10;

    switch (service.kind) {
    case 'light': {
        on(c('25'));
        percent(c('8'), 'brightness');
        const hue = c('13');
        const saturation = c('2F');
        const ct = c('CE');
        const colored = writable(hue) && writable(saturation);
        // Without a colour mode in HAP, low saturation is taken for white.
        const white = s => !colored || (number(get(saturation)(s)) ?? 0) < 25;
        if (ct) {
            const [low, high] = [ct.min ?? 140, ct.max ?? 500];
            add(ct, 'color-temperature', 'uint16', {unit: 'kelvin', range: [kelvin(high), kelvin(low), 1]},
                s => (white(s) && number(get(ct)(s)) ? kelvin(get(ct)(s)) : null),
                v => put(ct, clamp(Math.round(1e6 / v), low, high)));
        }
        if (colored) {
            props.push([colorProp(hue.iid), s => {
                const [h, sat] = [number(get(hue)(s)), number(get(saturation)(s))];
                if (h === null || sat === null)
                    return null;
                return white(s) ? WHITE : hsvToRgb(h, sat / 100);
            }, v => {
                if (v === WHITE && writable(ct))
                    return put(ct, clamp(250, ct.min ?? 140, ct.max ?? 500));
                if (v === WHITE)
                    return put(saturation, 0);
                const [h, sat] = rgbToHsv(v);
                return [...put(hue, Math.round(h)), ...put(saturation, Math.round(sat * 100))];
            }]);
        }
        break;
    }
    case 'outlet':
    case 'switch':
        on(c('25'));
        break;
    case 'fan':
        on(c('25'));
        percent(c('29'), 'fan-percent');
        break;
    case 'fan2':
        on(c('B0'));
        percent(c('29'), 'fan-percent');
        state(c('B6'), 'horizontal-swing', v => v === 1, v => put(c('B6'), v ? 1 : 0));
        break;
    case 'thermostat': {
        const target = c('33');
        if (target && writable(target)) {
            const valid = target.valid ?? [0, 1, 2, 3];
            const onMode = [3, 1, 2].find(m => valid.includes(m));
            if (valid.includes(0) && onMode !== undefined) {
                props.push([prop(target.iid + BESIDE, 'on', 'bool', RW), s => {
                    const v = get(target)(s);
                    return v === null ? null : v !== 0;
                }, v => put(target, v ? onMode : 0)]);
            }
        }
        choice(target, 'mode', {0: 'Off', 1: 'Heat', 2: 'Cool', 3: 'Auto'});
        add(c('35'), 'target-temperature', 'float', {unit: 'celsius', range: range(c('35'), [10, 38, 0.5]).map((v, i) => (i === 2 ? Math.max(v, 0.5) : v))},
            s => (number(get(c('35'))(s)) === null ? null : round(get(c('35'))(s))));
        reading(c('11'), 'temperature', {unit: 'celsius'}, round);
        reading(c('10'), 'relative-humidity', {unit: 'percentage'}, Math.round);
        break;
    }
    case 'heater-cooler': {
        on(c('B0'));
        const mode = c('B2');
        choice(mode, 'mode', {0: 'Auto', 1: 'Heat', 2: 'Cool'});
        const [heat, cool] = [c('12'), c('D')];
        const pick = s => (get(mode)(s) === 2 ? cool ?? heat : heat ?? cool);
        const either = heat ?? cool;
        if (either) {
            const span = [heat, cool].filter(Boolean);
            props.push([prop(either.iid, 'target-temperature', 'float', RW, {unit: 'celsius',
                range: [Math.min(...span.map(ch => ch.min ?? 10)), Math.max(...span.map(ch => ch.max ?? 35)), 0.5]}),
            s => (number(get(pick(s))(s)) === null ? null : round(get(pick(s))(s))),
            (v, s) => put(pick(s ?? {values: new Map()}), v)]);
        }
        reading(c('11'), 'temperature', {unit: 'celsius'}, round);
        percent(c('29'), 'fan-percent');
        state(c('B6'), 'vertical-swing', v => v === 1, v => put(c('B6'), v ? 1 : 0));
        break;
    }
    case 'humidifier': {
        on(c('B0'));
        reading(c('10'), 'relative-humidity', {unit: 'percentage'}, Math.round);
        choice(c('B4'), 'mode', {0: 'Auto', 1: 'Humidify', 2: 'Dehumidify'});
        const target = c('CA') ?? c('C9');
        percent(target, 'target-humidity');
        percent(c('29'), 'fan-percent');
        break;
    }
    case 'purifier':
        on(c('B0'));
        choice(c('A8'), 'mode', {0: 'Manual', 1: 'Auto'});
        percent(c('29'), 'fan-percent');
        break;
    case 'air-quality':
        add(c('95'), 'air-quality', 'uint8', {choices: options({1: 'Excellent', 2: 'Good', 3: 'Fair', 4: 'Inferior', 5: 'Poor'})},
            s => (get(c('95'))(s) ? get(c('95'))(s) : null));
        reading(c('C6'), 'pm2.5-density', {suffix: 'µg/m³'}, Math.round);
        reading(c('93'), 'co2-density', {unit: 'ppm'}, Math.round);
        break;
    case 'covering': {
        add(c('6D'), 'current-position', 'uint8', {unit: 'percentage', range: [0, 100, 1]});
        add(c('7C'), 'target-position', 'uint8', {unit: 'percentage', range: [0, 100, 1]}, get(c('7C')),
            v => put(c('7C'), clamp(Math.round(v), 0, 100)));
        add(c('72'), 'status', 'uint8', {choices: options({0: 'Closing', 1: 'Opening', 2: 'Stopped'})});
        const hold = c('6F');
        if (writable(hold))
            actions.push([1, 'stop-cover', () => put(hold, true)]);
        break;
    }
    // Locking only: unlocking from a menu is one stray click too easy.
    case 'lock': {
        add(c('1D'), 'status', 'uint8', {choices: options({0: 'Unlocked', 1: 'Locked', 2: 'Jammed'})});
        const target = c('1E');
        if (writable(target))
            actions.push([1, 'lock-door', () => put(target, 1)]);
        break;
    }
    // The state only: a garage door is not opened from a menu.
    case 'garage':
        add(c('E'), 'status', 'uint8', {choices: options({0: 'Open', 1: 'Closed', 2: 'Opening', 3: 'Closing', 4: 'Stopped'})});
        break;
    case 'motion':
        state(c('22'), 'motion-state', v => v === true || v === 1);
        break;
    case 'occupancy':
        state(c('71'), 'motion-state', v => v === 1);
        break;
    case 'contact':
        state(c('6A'), 'contact-state', v => v === 0);
        break;
    case 'leak':
        state(c('70'), 'submersion-state', v => v === 1);
        break;
    case 'smoke':
        state(c('76'), 'smoke-status', v => v === 1);
        break;
    case 'carbon-monoxide':
        state(c('69'), 'gas-status', v => v === 1);
        break;
    case 'temperature':
        reading(c('11'), 'temperature', {unit: 'celsius'}, round);
        break;
    case 'humidity':
        reading(c('10'), 'relative-humidity', {unit: 'percentage'}, Math.round);
        break;
    case 'light-level':
        reading(c('6B'), 'illumination', {unit: 'lux'}, Math.round);
        break;
    case 'battery':
        add(c('68'), 'battery-level', 'uint8', {unit: 'percentage'});
        break;
    }
    return {props, actions};
}

const ranked = accessory => [...accessory.services].sort((a, b) => (RANK.get(a.kind) ?? 99) - (RANK.get(b.kind) ?? 99));

export function typeOf(accessory) {
    const [first] = ranked(accessory);
    return KINDS.find(([kind]) => kind === first?.kind)?.[1] ?? 'sensor';
}

function groupsOf(accessory) {
    const groups = [];
    for (const service of ranked(accessory)) {
        const {props, actions} = serviceProps(accessory.aid, service);
        const name = KINDS.find(([kind]) => kind === service.kind)?.[2] ?? service.kind;
        if (props.length > 0 || actions.length > 0)
            groups.push([service.iid, name, props, actions]);
    }
    return groups;
}

export class HomeKitHome extends SpecHome {
    constructor(hosts) {
        super('HomeKit', {gap: 2000, fresh: 2000, assumed: 4000});
        this._hosts = new Map(hosts.map(host => [host.id, {host, client: null, loading: null}]));
        this._entries = new Map();
        this._layouts = new Map();
        this._aborted = false;
        for (const host of hosts) {
            for (const accessory of host.accessories) {
                const did = `homekit:${host.id}/${accessory.aid}`;
                const groups = groupsOf(accessory);
                if (groups.length === 0 || this._entries.has(did))
                    continue;
                this._entries.set(did, {host: host.id, accessory});
                this._layouts.set(did, layout(groups));
                this._add({
                    did,
                    name: accessory.name || host.name || 'HomeKit',
                    model: 'homekit',
                    urn: `urn:nook:device:${typeOf(accessory)}:0`,
                    room: host.room ?? null,
                    about: {model: accessory.model ?? host.model ?? null, firmware: accessory.firmware ?? null, ip: host.ip},
                });
            }
        }
    }

    abort() {
        this._aborted = true;
        for (const slot of this._hosts.values())
            slot.client?.close();
    }

    _layout(device) {
        return this._layouts.get(device.did);
    }

    _client(id) {
        const slot = this._hosts.get(id);
        slot.loading ??= Secrets.lookup(secretService(id)).then(saved => {
            let credentials;
            try {
                credentials = saved ? JSON.parse(saved) : null;
            } catch {
                credentials = null;
            }
            if (!credentials?.ltsk)
                throw new SpecError('Pair the accessory in the Nook settings', 'unpaired');
            slot.client = new HapHost(slot.host, credentials);
            if (this._aborted)
                slot.client.close();
            return slot.client;
        }).catch(e => {
            slot.loading = null;
            throw e;
        });
        return slot.loading;
    }

    async _refresh(devices) {
        const ids = [...new Set(devices.map(d => this._entries.get(d.did).host))];
        const results = await Promise.allSettled(ids.map(id => this._read(id)));
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0 && failed.length === results.length)
            throw failed[0].reason;
    }

    async _read(id) {
        const mine = this.devices.filter(d => this._entries.get(d.did).host === id);
        const wanted = mine.flatMap(device => {
            const {aid, services} = this._entries.get(device.did).accessory;
            return services.flatMap(s => s.chars.filter(ch => ch.perms.includes('pr')).map(ch => [aid, ch.iid]));
        });
        let answers;
        try {
            answers = await (await this._client(id)).read(wanted);
        } catch (e) {
            for (const device of mine)
                device.online = false;
            if (e.code === 'unpaired')
                this._expired();
            throw e;
        }
        for (const device of mine) {
            const {aid} = this._entries.get(device.did).accessory;
            const values = new Map();
            let unreachable = false;
            for (const answer of answers.filter(a => a.aid === aid)) {
                if (answer.status === UNREACHABLE)
                    unreachable = true;
                else if (answer.value !== undefined && (!answer.status || answer.status === 0))
                    values.set(answer.iid, answer.value);
            }
            this._keep(device, {values}, !unreachable);
        }
    }

    async _send(device, list) {
        try {
            await (await this._client(this._entries.get(device.did).host)).write(list);
        } catch (e) {
            if (e.code === 'unpaired')
                this._expired();
            throw e;
        }
    }
}
