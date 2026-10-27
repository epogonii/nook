// SPDX-License-Identifier: GPL-2.0-or-later

// Shelly relays, plugs, dimmers, RGB lights and covers, straight over HTTP on this
// network. Gen 1 has REST paths and basic auth; Gen 2 to 4 take RPC calls and SHA-256
// digest auth, the user always admin. mDNS has Gen 2 on as _shelly._tcp and Gen 1 only
// as _http._tcp under a shelly… name.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {browse} from './finder.js';
import * as Secrets from './secrets.js';
import {RO, RW, SpecError, SpecHome, clamp, colorProp, layout, prop} from './spec-home.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const secretService = id => `shelly:${id}`;

export function parseDevices(json) {
    try {
        const devices = JSON.parse(json || '[]');
        return Array.isArray(devices)
            ? devices.filter(d => /^[0-9a-f]{12}$/.test(d?.id ?? '') && typeof d.ip === 'string' && Array.isArray(d.channels))
            : [];
    } catch {
        return [];
    }
}

const COVER = {open: 'Open', closed: 'Closed', close: 'Closed', opening: 'Opening', closing: 'Closing', stopped: 'Stopped', stop: 'Stopped'};

const channelOf = key => {
    const [kind, n] = key.split(':');
    return [kind, Number(n)];
};

const packRgb = ([r, g, b]) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
const unpackRgb = rgb => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];

export const didOf = (unit, key) => `shelly:${unit.id}/${key}`;

// Its own name, else the unit's, numbered when the unit has several.
export function channelName(unit, {key, name}) {
    const base = unit.name || unit.model || 'Shelly';
    return name || (unit.channels.length > 1 ? `${base} ${channelOf(key)[1] + 1}` : base);
}

export function typeOf(unit, key) {
    const [kind] = channelOf(key);
    if (kind === 'cover')
        return 'curtain';
    if (kind !== 'switch')
        return 'light';
    // Gen 1 plugs are SHPLG-….
    return /plug|^shplg/i.test(unit.model ?? '') ? 'outlet' : 'switch';
}

export class ShellyClient {
    // unit: {ip, gen, user}; password null when it has none.
    constructor(unit, password = null) {
        this._ip = unit.ip;
        this._gen = unit.gen ?? 1;
        this._user = unit.user || 'admin';
        this._model = unit.model ?? '';
        this._password = password;
        this._count = 0;
        this._session = new Soup.Session({timeout: 6});
        this._cancellable = new Gio.Cancellable();
    }

    abort() {
        this._cancellable.cancel();
        this._session.abort();
    }

    // Gen 1 sends basic auth up front; Gen 2 answers 401 with the digest's nonce first.
    async _get(path) {
        let message = Soup.Message.new('GET', `http://${this._ip}${path}`);
        if (!message)
            throw new SpecError(`Not an address: ${this._ip}`, 'address');
        if (this._gen === 1 && this._password !== null) {
            message.get_request_headers().append('Authorization',
                `Basic ${GLib.base64_encode(encoder.encode(`${this._user}:${this._password}`))}`);
        }
        let bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (message.status_code === 401 && this._gen > 1 && this._password !== null) {
            const challenge = message.get_response_headers().get_one('WWW-Authenticate');
            message = Soup.Message.new('GET', `http://${this._ip}${path}`);
            message.get_request_headers().append('Authorization', this._digest('GET', path, challenge));
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
        }
        const status = message.status_code;
        if (status === 401)
            throw new SpecError(this._password === null ? 'This Shelly asks for its password' : 'The Shelly refused the password', 'unpaired');
        let answer;
        try {
            answer = JSON.parse(decoder.decode(bytes.toArray()));
        } catch {
            answer = null;
        }
        if (status !== 200)
            throw new SpecError(answer?.message ?? `Shelly: HTTP ${status}`, 'refused');
        // A command's RPC result can be null.
        return answer;
    }

    async _read(path) {
        const answer = await this._get(path);
        if (answer === null || typeof answer !== 'object')
            throw new SpecError('The Shelly answered something else', 'broken');
        return answer;
    }

    // RFC 7616 with SHA-256, as Gen 2 asks for it.
    _digest(method, uri, challenge) {
        const field = name => new RegExp(`${name}\\s*=\\s*"?([^",]*)"?`).exec(challenge ?? '')?.[1] ?? '';
        const sha = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
        const realm = field('realm');
        const nonce = field('nonce');
        const count = (++this._count).toString(16).padStart(8, '0');
        const cnonce = GLib.uuid_string_random().replace(/-/g, '').slice(0, 16);
        const response = sha(`${sha(`admin:${realm}:${this._password}`)}:${nonce}:${count}:${cnonce}:auth:${sha(`${method}:${uri}`)}`);
        return `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=SHA-256, ` +
            `qop=auth, nc=${count}, cnonce="${cnonce}", response="${response}"`;
    }

    // Channels by key (switch:0, light:0, rgb:0, cover:0): on, power, brightness, rgb,
    // position, state.
    async status() {
        const channels = {};
        if (this._gen > 1) {
            for (const [key, c] of Object.entries(await this._read('/rpc/Shelly.GetStatus'))) {
                const [kind] = channelOf(key);
                if (kind === 'switch')
                    channels[key] = {on: c.output, power: c.apower ?? null};
                else if (kind === 'light')
                    channels[key] = {on: c.output, brightness: c.brightness};
                else if (kind === 'rgb' || kind === 'rgbw')
                    channels[key] = {on: c.output, brightness: c.brightness, rgb: Array.isArray(c.rgb) ? packRgb(c.rgb) : null};
                else if (kind === 'cover')
                    channels[key] = {state: c.state, position: c.current_pos ?? null, power: c.apower ?? null};
            }
            return channels;
        }
        const s = await this._read('/status');
        (s.relays ?? []).forEach((r, i) => {
            channels[`switch:${i}`] = {on: r.ison, power: s.meters?.[i]?.power ?? null};
        });
        (s.rollers ?? []).forEach((r, i) => {
            channels[`cover:${i}`] = {state: r.state, position: r.current_pos ?? null, power: r.power ?? null};
        });
        (s.lights ?? []).forEach((l, i) => {
            if (l.mode === 'color')
                channels[`rgb:${i}`] = {on: l.ison, brightness: l.gain, rgb: packRgb([l.red, l.green, l.blue])};
            else
                channels[`light:${i}`] = {on: l.ison, brightness: l.brightness};
        });
        return channels;
    }

    // What it has, read once when added: channel keys and the names given in its app.
    async channels() {
        const status = await this.status();
        if (this._gen > 1) {
            const config = await this._read('/rpc/Shelly.GetConfig');
            return Object.keys(status).map(key => ({key, name: config[key]?.name || null}));
        }
        const settings = await this._read('/settings');
        // A Shelly 2 in roller mode still lists its relays.
        const roller = settings.mode === 'roller';
        const keys = Object.keys(status).filter(key => (channelOf(key)[0] === 'cover') === roller);
        return keys.map(key => {
            const [kind, n] = channelOf(key);
            const list = {switch: settings.relays, cover: settings.rollers}[kind] ?? settings.lights;
            // Gen 1 keeps the unit's own name here only.
            return {key, name: list?.[n]?.name || (keys.length === 1 ? settings.name : null) || null};
        });
    }

    // command: {key, on, brightness, rgb, position, go}.
    set({key, on, brightness, rgb, position, go}) {
        const [kind, n] = channelOf(key);
        const query = params => Object.entries(params).filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v))}`).join('&');
        if (this._gen > 1) {
            if (kind === 'cover') {
                const method = position !== undefined ? 'GoToPosition' : {open: 'Open', close: 'Close', stop: 'Stop'}[go];
                return this._get(`/rpc/Cover.${method}?${query({id: n, pos: position})}`);
            }
            const method = {switch: 'Switch', light: 'Light', rgb: 'RGB', rgbw: 'RGBW'}[kind];
            return this._get(`/rpc/${method}.Set?${query({id: n, on, brightness, rgb: rgb === undefined ? undefined : unpackRgb(rgb)})}`);
        }
        const turn = on === undefined ? undefined : on ? 'on' : 'off';
        if (kind === 'cover')
            return this._get(`/roller/${n}?${query(position !== undefined ? {go: 'to_pos', roller_pos: position} : {go})}`);
        if (kind === 'rgb') {
            const [red, green, blue] = rgb === undefined ? [] : unpackRgb(rgb);
            return this._get(`/color/${n}?${query({turn, red, green, blue, gain: brightness})}`);
        }
        let path = kind === 'light' ? 'light' : 'relay';
        // An RGBW2 in white mode has its four channels under /white.
        if (kind === 'light' && this._model === 'SHRGBW2')
            path = 'white';
        return this._get(`/${path}/${n}?${query({turn, brightness})}`);
    }
}

// The one call that answers without a password.
export async function describe(ip) {
    const session = new Soup.Session({timeout: 4});
    const message = Soup.Message.new('GET', `http://${ip}/shelly`);
    if (!message)
        return null;
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.status_code !== 200)
        return null;
    let info;
    try {
        info = JSON.parse(decoder.decode(bytes.toArray()));
    } catch {
        return null;
    }
    const id = (info?.mac ?? '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(id))
        return null;
    const gen = Number(info.gen) || 1;
    return {
        id,
        ip,
        gen,
        model: (gen > 1 ? info.app || info.model : info.type) ?? null,
        name: info.name || null,
        auth: Boolean(gen > 1 ? info.auth_en : info.auth),
    };
}

export async function discover(timeout = 3000) {
    const services = await browse(timeout, ['_shelly._tcp', '_http._tcp']);
    const ips = [...new Set(services.filter(s => s.type === '_shelly._tcp' || /^shelly/i.test(s.name) ||
        /^shelly/i.test(s.host ?? '')).map(s => s.ip))];
    const found = await Promise.allSettled(ips.map(ip => describe(ip)));
    const units = new Map();
    for (const result of found) {
        if (result.status === 'fulfilled' && result.value && !units.has(result.value.id))
            units.set(result.value.id, result.value);
    }
    return [...units.values()];
}

function groupsOf(unit, key) {
    const [kind] = channelOf(key);
    const write = body => ({key, ...body});
    if (kind === 'cover') {
        return [[2, 'curtain', [
            [prop(1, 'current-position', 'uint8', RO, {unit: 'percentage', range: [0, 100, 1]}), s => s?.position ?? null],
            [prop(2, 'target-position', 'uint8', RW, {unit: 'percentage', range: [0, 100, 1]}), s => s?.position ?? null,
                v => write({position: clamp(Math.round(v), 0, 100)})],
            [prop(3, 'status', 'string', RO, {choices: Object.entries(COVER).map(([value, description]) => ({value, description}))}),
                s => (COVER[s?.state] ? s.state : null)],
            [prop(4, 'electric-power', 'float', RO, {unit: 'watt'}), s => s?.power ?? null],
        ], [
            [1, 'open-cover', () => write({go: 'open'})],
            [2, 'close-cover', () => write({go: 'close'})],
            [3, 'stop-cover', () => write({go: 'stop'})],
        ]]];
    }
    const props = [[prop(1, 'on', 'bool', RW), s => s?.on ?? null, v => write({on: v})]];
    if (kind === 'switch') {
        props.push([prop(2, 'electric-power', 'float', RO, {unit: 'watt'}), s => s?.power ?? null]);
        return [[2, typeOf(unit, key) === 'outlet' ? 'outlet' : 'switch', props]];
    }
    props.push([prop(2, 'brightness', 'uint8', RW, {unit: 'percentage', range: [1, 100, 1]}), s => s?.brightness ?? null,
        v => write({brightness: clamp(Math.round(v), 1, 100)})]);
    if (kind === 'rgb' || kind === 'rgbw')
        props.push([colorProp(3), s => s?.rgb ?? null, v => write({on: true, rgb: v})]);
    return [[2, 'light', props]];
}

export class ShellyHome extends SpecHome {
    constructor(units) {
        super('Shelly', {gap: 2000, fresh: 2000, assumed: 3000});
        this._units = new Map(units.map(unit => [unit.id, {unit, client: null, loading: null}]));
        this._channels = new Map();
        this._layouts = new Map();
        this._aborted = false;
        for (const unit of units) {
            for (const channel of unit.channels) {
                const {key} = channel;
                const did = didOf(unit, key);
                this._channels.set(did, {unit, key});
                this._layouts.set(did, layout(groupsOf(unit, key)));
                this._add({
                    did,
                    name: channelName(unit, channel),
                    model: 'shelly',
                    urn: `urn:nook:device:${typeOf(unit, key)}:0`,
                    room: unit.room ?? null,
                    about: {model: unit.model ?? null, ip: unit.ip, mac: unit.id},
                });
            }
        }
    }

    abort() {
        this._aborted = true;
        for (const slot of this._units.values())
            slot.client?.abort();
    }

    _layout(device) {
        return this._layouts.get(device.did);
    }

    _client(id) {
        const slot = this._units.get(id);
        slot.loading ??= (slot.unit.auth ? Secrets.lookup(secretService(id)) : Promise.resolve(null)).then(password => {
            slot.client = new ShellyClient(slot.unit, password ?? null);
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
        const ids = [...new Set(devices.map(d => this._channels.get(d.did).unit.id))];
        const results = await Promise.allSettled(ids.map(id => this._read(id)));
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0 && failed.length === results.length)
            throw failed[0].reason;
    }

    async _read(id) {
        const mine = this.devices.filter(d => this._channels.get(d.did).unit.id === id);
        let status;
        try {
            status = await (await this._client(id)).status();
        } catch (e) {
            for (const device of mine)
                device.online = false;
            this._troubled(id, e);
            throw e;
        }
        for (const device of mine) {
            const {key} = this._channels.get(device.did);
            // A bulb switched between colour and white since it was added answers under the other.
            const state = status[key] ?? status[key.replace(/^(rgb|light):/, (_all, kind) => (kind === 'rgb' ? 'light:' : 'rgb:'))];
            this._keep(device, state ?? null, Boolean(state));
        }
    }

    async _send(device, command) {
        const {unit} = this._channels.get(device.did);
        try {
            await (await this._client(unit.id)).set(command);
        } catch (e) {
            this._troubled(unit.id, e);
            throw e;
        }
    }

    // A password set in Nook again is read next time.
    _troubled(id, e) {
        if (e.code !== 'unpaired')
            return;
        const slot = this._units.get(id);
        slot.client?.abort();
        slot.client = null;
        slot.loading = null;
        this._expired();
    }
}
