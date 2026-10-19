// SPDX-License-Identifier: GPL-2.0-or-later

// Philips Hue bridges, over CLIP v2 on the local network. The bridge's certificate is
// pinned at pairing: nothing on a LAN can vouch for it, so the first one seen is kept.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {browse} from './finder.js';
import {SpecError} from './spec-home.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Link button not pressed.
const NOT_PRESSED = 101;

export const secretService = id => `hue:${id}`;

export function parseBridges(json) {
    try {
        const bridges = JSON.parse(json || '[]');
        return Array.isArray(bridges) ? bridges.filter(b => /^[0-9a-f]{16}$/.test(b?.id) && typeof b.ip === 'string') : [];
    } catch {
        return [];
    }
}

export function parseDevices(json) {
    try {
        const devices = JSON.parse(json || '[]');
        return Array.isArray(devices)
            ? devices.filter(d => typeof d?.id === 'string' && /^[0-9a-f-]{36}$/.test(d.id) && typeof d.bridge === 'string')
            : [];
    } catch {
        return [];
    }
}

export class HueBridge {
    // bridge: {ip, fingerprint}; key is null until paired.
    constructor(bridge, key = null) {
        this._ip = bridge.ip;
        this._key = key;
        this.fingerprint = bridge.fingerprint ?? null;
        // What a bridge showed instead of the pinned certificate, for the user to judge.
        this.offered = null;
        this._mismatch = false;
        this._session = new Soup.Session({timeout: 8, idle_timeout: 30});
        this._cancellable = new Gio.Cancellable();
    }

    abort() {
        this._cancellable.cancel();
        this._session.abort();
    }

    _accept(certificate) {
        const fingerprint = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256,
            new GLib.Bytes(certificate.certificate));
        if (!this.fingerprint)
            this.fingerprint = fingerprint;
        this._mismatch = fingerprint !== this.fingerprint;
        if (this._mismatch)
            this.offered = fingerprint;
        return !this._mismatch;
    }

    async _request(method, path, body = null) {
        const message = Soup.Message.new(method, `https://${this._ip}${path}`);
        if (!message)
            throw new SpecError(`Not an address: ${this._ip}`, 'address');
        message.connect('accept-certificate', (_message, certificate) => this._accept(certificate));
        if (this._key)
            message.get_request_headers().append('hue-application-key', this._key);
        if (body !== null)
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (this._mismatch)
                throw new SpecError('The Hue bridge answered with another certificate. Pair it again if it was replaced.', 'certificate');
            throw e;
        }
        const status = message.get_status();
        let answer;
        try {
            answer = JSON.parse(decoder.decode(bytes.toArray()));
        } catch {
            answer = null;
        }
        if (status === 401 || status === 403)
            throw new SpecError('The Hue bridge no longer knows Nook. Pair it again.', 'unpaired');
        if (status === 429 || status === 503)
            throw new SpecError('The Hue bridge is busy. Try again in a moment.', 'busy');
        if (status < 200 || status >= 300)
            throw new SpecError(answer?.errors?.[0]?.description ?? `Hue bridge: HTTP ${status}`, 'refused');
        return answer;
    }

    // Answers without pairing; the first contact is also where the certificate is pinned.
    async config() {
        const config = await this._request('GET', '/api/0/config');
        if (!/^[0-9a-f]{16}$/i.test(config?.bridgeid ?? ''))
            throw new SpecError('This is not a Hue bridge that Nook can use', 'nothue');
        return {
            id: config.bridgeid.toLowerCase(),
            name: config.name || 'Hue Bridge',
            model: config.modelid ?? null,
            fingerprint: this.fingerprint,
        };
    }

    // Null while the link button has not been pressed.
    async pair(name) {
        const answers = await this._request('POST', '/api', {devicetype: name, generateclientkey: true});
        const answer = Array.isArray(answers) ? answers[0] : null;
        if (answer?.error?.type === NOT_PRESSED)
            return null;
        if (!answer?.success?.username)
            throw new SpecError(answer?.error?.description ?? 'The Hue bridge refused the pairing', 'refused');
        this._key = answer.success.username;
        return this._key;
    }

    async resources() {
        const answer = await this._request('GET', '/clip/v2/resource');
        if (!Array.isArray(answer?.data))
            throw new SpecError(answer?.errors?.[0]?.description ?? 'The Hue bridge sent no devices', 'broken');
        return answer.data;
    }

    async set(type, id, body) {
        const answer = await this._request('PUT', `/clip/v2/resource/${type}/${id}`, body);
        if (answer?.errors?.length > 0)
            throw new SpecError(answer.errors[0].description, 'refused');
    }
}

// Devicetype is app#device, at most 20 and 19 characters.
export function pairingName() {
    return `nook#${GLib.get_host_name().slice(0, 19)}`;
}

export async function discover(timeout = 3000, looking = null) {
    const services = looking ? await looking : await browse(timeout, ['_hue._tcp']);
    const bridges = new Map();
    for (const service of services) {
        const id = service.hue?.id ?? (service.type === '_hue._tcp' ? service.txt?.bridgeid?.toLowerCase() : null);
        if (/^[0-9a-f]{16}$/.test(id ?? '') && !bridges.has(id))
            bridges.set(id, {id, ip: service.ip, name: service.hue?.name ?? service.name, model: service.hue?.model ?? service.txt?.modelid ?? null});
    }
    return [...bridges.values()];
}

// The devices of one bridge as kept in hue-devices: a light per light service (a lamp
// can have several), a sensor per device with motion, contact or climate readings.
export function savedDevices(bridgeId, data) {
    const byId = new Map(data.map(r => [r.id, r]));
    const rooms = new Map();
    for (const room of data.filter(r => r.type === 'room')) {
        for (const child of room.children ?? []) {
            if (child.rtype === 'device')
                rooms.set(child.rid, room.metadata?.name || null);
        }
    }
    const devices = [];
    for (const device of data.filter(r => r.type === 'device')) {
        const owned = (device.services ?? []).map(s => byId.get(s.rid)).filter(Boolean);
        const product = device.product_data ?? {};
        const room = rooms.get(device.id) ?? null;
        const model = product.product_name || product.model_id || null;
        const lights = owned.filter(s => s.type === 'light');
        for (const light of lights) {
            const plug = light.metadata?.archetype === 'plug' || product.product_archetype === 'plug';
            const schema = light.color_temperature?.mirek_schema;
            devices.push({
                id: light.id,
                bridge: bridgeId,
                kind: plug ? 'plug' : 'light',
                name: (lights.length > 1 ? light.metadata?.name : device.metadata?.name) || light.metadata?.name || model,
                room,
                model,
                dim: Boolean(light.dimming) && !plug,
                ct: schema?.mirek_minimum && schema?.mirek_maximum ? [schema.mirek_minimum, schema.mirek_maximum] : null,
                color: Boolean(light.color),
            });
        }
        const sensors = ['motion', 'contact', 'temperature', 'light_level'].filter(type => owned.some(s => s.type === type));
        if (sensors.length > 0) {
            devices.push({
                id: device.id,
                bridge: bridgeId,
                kind: 'sensor',
                name: device.metadata?.name || model,
                room,
                model,
                sensors,
                battery: owned.some(s => s.type === 'device_power'),
            });
        }
    }
    return devices;
}
