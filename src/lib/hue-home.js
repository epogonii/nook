// SPDX-License-Identifier: GPL-2.0-or-later

// Hue lights and sensors, read from their bridges. prefs keeps the lists; the key of
// each bridge is read from the keyring on first use.

import {HueBridge, secretService} from './hue.js';
import * as Secrets from './secrets.js';
import {RO, RW, SpecError, SpecHome, WHITE, clamp, colorProp, layout, nearestRgb, prop, rgbToXy, unixTime, xyToRgb}
    from './spec-home.js';

const kelvin = mirek => Math.round(1e6 / mirek);
// 4000 K: the white a colour light takes when White is picked.
const NEUTRAL = 250;

function typeOf(entry) {
    if (entry.kind === 'plug')
        return 'outlet';
    if (entry.kind === 'light')
        return 'light';
    return {motion: 'motion-sensor', contact: 'magnet-sensor', temperature: 'temperature-humidity-sensor'}[entry.sensors?.[0]] ??
        'light-sensor';
}

function lightGroups(entry) {
    const write = body => ({type: 'light', id: entry.id, body});
    const props = [[prop(1, 'on', 'bool', RW), s => s.light?.on?.on ?? null, v => write({on: {on: v}})]];
    if (entry.dim) {
        props.push([prop(2, 'brightness', 'uint8', RW, {unit: 'percentage', range: [1, 100, 1]}),
            s => (typeof s.light?.dimming?.brightness === 'number' ? Math.max(1, Math.round(s.light.dimming.brightness)) : null),
            v => write({dimming: {brightness: clamp(v, 1, 100)}})]);
    }
    const [low, high] = entry.ct ?? [];
    const white = light => Boolean(light?.color_temperature?.mirek_valid && light.color_temperature.mirek);
    if (entry.ct) {
        props.push([prop(3, 'color-temperature', 'uint16', RW, {unit: 'kelvin', range: [kelvin(high), kelvin(low), 1]}),
            s => (white(s.light) ? kelvin(s.light.color_temperature.mirek) : null),
            v => write({color_temperature: {mirek: clamp(Math.round(1e6 / v), low, high)}})]);
    }
    if (entry.color) {
        props.push([colorProp(4), s => {
            if (!s.light)
                return null;
            if (white(s.light))
                return WHITE;
            const xy = s.light.color?.xy;
            return xy ? nearestRgb(xyToRgb(xy.x, xy.y)) : null;
        }, v => {
            if (v === WHITE && entry.ct)
                return write({color_temperature: {mirek: clamp(NEUTRAL, low, high)}});
            const [x, y] = rgbToXy(v);
            return write({color: {xy: {x, y}}});
        }]);
    }
    return [[2, entry.kind === 'plug' ? 'switch' : 'light', props]];
}

function sensorGroups(entry) {
    const has = type => entry.sensors?.includes(type);
    const groups = [];
    if (has('motion')) {
        groups.push([2, 'motion-sensor', [[prop(1, 'motion-state', 'bool', RO),
            s => (s.motion?.motion?.motion_valid === false ? null : s.motion?.motion?.motion ?? null), null,
            s => unixTime(s.motion?.motion?.motion_report?.changed)]]]);
    }
    if (has('contact')) {
        groups.push([3, 'magnet-sensor', [[prop(1, 'contact-state', 'bool', RO),
            s => ({contact: true, no_contact: false})[s.contact?.contact_report?.state] ?? null, null,
            s => unixTime(s.contact?.contact_report?.changed)]]]);
    }
    if (has('temperature')) {
        groups.push([4, 'temperature-humidity-sensor', [[prop(1, 'temperature', 'float', RO, {unit: 'celsius'}),
            s => (s.temperature?.temperature?.temperature_valid
                ? Math.round(s.temperature.temperature.temperature * 10) / 10 : null)]]]);
    }
    // light_level is 10000 log10(lux) + 1.
    if (has('light_level')) {
        groups.push([5, 'illumination-sensor', [[prop(1, 'illumination', 'float', RO, {unit: 'lux'}),
            s => (s.light_level?.light?.light_level_valid
                ? Math.round(10 ** ((s.light_level.light.light_level - 1) / 10000)) : null)]]]);
    }
    if (entry.battery) {
        groups.push([6, 'battery', [[prop(1, 'battery-level', 'uint8', RO, {unit: 'percentage'}),
            s => s.power?.power_state?.battery_level ?? null]]]);
    }
    return groups;
}

export class HueHome extends SpecHome {
    constructor(bridges, entries) {
        super('Hue', {gap: 2000, fresh: 2000, assumed: 3000});
        this._bridges = new Map(bridges.map(bridge => [bridge.id, {bridge, client: null, loading: null}]));
        this._entries = new Map();
        this._layouts = new Map();
        this._aborted = false;
        for (const entry of entries.filter(e => this._bridges.has(e.bridge))) {
            const did = `hue:${entry.id}`;
            if (this._entries.has(did))
                continue;
            this._entries.set(did, entry);
            this._layouts.set(did, layout(entry.kind === 'sensor' ? sensorGroups(entry) : lightGroups(entry)));
            this._add({
                did,
                name: entry.name || entry.model || 'Hue',
                model: 'hue',
                urn: `urn:nook:device:${typeOf(entry)}:0`,
                room: entry.room ?? null,
                about: {model: entry.model ?? null},
            });
        }
    }

    abort() {
        this._aborted = true;
        for (const slot of this._bridges.values())
            slot.client?.abort();
    }

    _layout(device) {
        return this._layouts.get(device.did);
    }

    _client(id) {
        const slot = this._bridges.get(id);
        slot.loading ??= Secrets.lookup(secretService(id)).then(saved => {
            let key;
            try {
                key = saved ? JSON.parse(saved).key : null;
            } catch {
                key = null;
            }
            if (!key)
                throw new SpecError('Pair the Hue bridge in the Nook settings', 'unpaired');
            slot.client = new HueBridge(slot.bridge, key);
            if (this._aborted)
                slot.client.abort();
            return slot.client;
        }).catch(e => {
            slot.loading = null;
            throw e;
        });
        return slot.loading;
    }

    async _refresh(devices) {
        const ids = [...new Set(devices.map(d => this._entries.get(d.did).bridge))];
        const results = await Promise.allSettled(ids.map(id => this._read(id)));
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0 && failed.length === results.length)
            throw failed[0].reason;
    }

    async _read(id) {
        const mine = this.devices.filter(d => this._entries.get(d.did).bridge === id);
        let data;
        try {
            data = await (await this._client(id)).resources();
        } catch (e) {
            for (const device of mine)
                device.online = false;
            this._troubled(id, e);
            throw e;
        }
        const byId = new Map(data.map(r => [r.id, r]));
        const owned = new Map();
        for (const r of data.filter(each => each.owner?.rid)) {
            if (!owned.has(r.owner.rid))
                owned.set(r.owner.rid, {});
            owned.get(r.owner.rid)[r.type] ??= r;
        }
        for (const device of mine) {
            const entry = this._entries.get(device.did);
            const light = entry.kind === 'sensor' ? null : byId.get(entry.id);
            const owner = entry.kind === 'sensor' ? entry.id : light?.owner?.rid;
            const parts = owned.get(owner) ?? {};
            const exists = entry.kind === 'sensor' ? byId.has(entry.id) : Boolean(light);
            const link = parts.zigbee_connectivity;
            const state = {
                light,
                motion: parts.motion,
                contact: parts.contact,
                temperature: parts.temperature,
                light_level: parts.light_level,
                power: parts.device_power,
            };
            device.about = {...device.about, firmware: byId.get(owner)?.product_data?.software_version ?? null};
            this._keep(device, exists ? state : null, exists && (!link || link.status === 'connected'));
        }
    }

    async _send(device, command) {
        const id = this._entries.get(device.did).bridge;
        try {
            await (await this._client(id)).set(command.type, command.id, command.body);
        } catch (e) {
            this._troubled(id, e);
            throw e;
        }
    }

    // The keyring is read again next time: pairing again in the settings may have fixed it.
    _troubled(id, e) {
        if (e.code !== 'unpaired' && e.code !== 'certificate')
            return;
        const slot = this._bridges.get(id);
        slot.client?.abort();
        slot.client = null;
        slot.loading = null;
        this._expired();
    }
}
