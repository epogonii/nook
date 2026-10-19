// SPDX-License-Identifier: GPL-2.0-or-later

// Sonoff in DIY mode: plain JSON over HTTP to the switch itself, found over mDNS.
// Paired the usual way with eWeLink, a switch encrypts the same API with a key only
// the eWeLink cloud hands out, so those are left alone.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {browse} from './finder.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const SERVICE = '_ewelink._tcp';
const PORT = 8081;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SonoffError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'SonoffError';
        this.code = code;
    }
}

export function parseSwitches(json) {
    try {
        const switches = JSON.parse(json || '[]');
        return Array.isArray(switches) ? switches.filter(s => s?.id && s.ip) : [];
    } catch {
        return [];
    }
}

// A long state is split over data1 to data4.
function txtState(txt) {
    try {
        return JSON.parse(['data1', 'data2', 'data3', 'data4'].map(key => txt[key] ?? '').join(''));
    } catch {
        return null;
    }
}

export async function discover(timeout = 3000) {
    const found = new Map();
    for (const {ip, port, txt} of await browse(timeout, [SERVICE])) {
        if (!txt.id || txt.encrypt === 'true' || found.has(txt.id))
            continue;
        const switches = txtState(txt)?.switches;
        found.set(txt.id, {
            id: txt.id,
            name: `Sonoff ${txt.id}`,
            ip,
            port,
            ...Array.isArray(switches) ? {outlets: switches.length} : {},
        });
    }
    return [...found.values()];
}

// A switch with "outlets" is set channel by channel and gets a tile for each.
export function channels(unit) {
    const outlets = unit.outlets > 0 ? [...Array(unit.outlets).keys()] : [null];
    const several = outlets.length > 1;
    const name = unit.name || unit.id;
    return outlets.map(outlet => ({
        did: several ? `sonoff:${unit.id}/${outlet}` : `sonoff:${unit.id}`,
        name: several ? `${name} ${outlet + 1}` : name,
        outlet,
    }));
}

export class SonoffHome {
    constructor(switches) {
        this._switches = switches;
        this._session = new Soup.Session({timeout: 5});
        this._cancellable = new Gio.Cancellable();
        this._channels = new Map();
        this.devices = switches.flatMap(unit => channels(unit).map(({did, name, outlet}) => {
            const device = {
                did,
                name,
                model: 'sonoff',
                urn: null,
                room: unit.room ?? null,
                online: null,
                primary: {kind: 'switch', props: [{service: 'switch', name: 'on'}]},
                values: null,
                state: null,
                about: {ip: unit.ip, mac: unit.mac ?? null, model: null},
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            this._channels.set(device.did, {unit, outlet});
            return device;
        }));
    }

    abort() {
        this._cancellable.cancel();
        this._session.abort();
    }

    async _post(unit, api, data) {
        const msg = Soup.Message.new('POST', `http://${unit.ip}:${unit.port || PORT}/zeroconf/${api}`);
        msg.set_request_body_from_bytes('application/json',
            new GLib.Bytes(encoder.encode(JSON.stringify({deviceid: unit.id, data}))));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.get_status() !== Soup.Status.OK)
            throw new SonoffError(`the switch answered HTTP ${msg.get_status()}`, msg.get_status());
        try {
            const reply = JSON.parse(decoder.decode(bytes.toArray()));
            if (reply.error !== 0) {
                throw new SonoffError(reply.error === 401 ? 'the switch is not in DIY mode'
                    : `the switch refused it (error ${reply.error})`, reply.error);
            }
            // Older DIY firmware sends data as a JSON string.
            const answer = typeof reply.data === 'string' ? JSON.parse(reply.data || '{}') : reply.data ?? {};
            if (typeof answer !== 'object' || answer === null)
                throw new Error('not an object');
            return answer;
        } catch (e) {
            if (e instanceof SonoffError)
                throw e;
            throw new SonoffError('the switch answered something else');
        }
    }

    async _read(unit) {
        const devices = this.devices.filter(d => this._channels.get(d.did).unit === unit);
        try {
            const info = await this._post(unit, 'info', {});
            for (const device of devices) {
                const {outlet} = this._channels.get(device.did);
                const state = outlet === null ? info.switch
                    : Array.isArray(info.switches) ? info.switches.find(s => s.outlet === outlet)?.switch : undefined;
                device.online = true;
                device.values = [state === undefined ? null : state === 'on'];
                Object.assign(device.about, {
                    ssid: info.ssid || null,
                    rssi: Number(info.signalStrength) < 0 ? Number(info.signalStrength) : null,
                    firmware: info.fwVersion || null,
                });
            }
        } catch (e) {
            if (!(e instanceof SonoffError) && !(e instanceof GLib.Error))
                throw e;
            for (const device of devices)
                device.online = false;
        }
    }

    async readPrimary() {
        await Promise.all(this._switches.map(unit => this._read(unit)));
        return this.devices.length > 0;
    }

    readDevice(device) {
        return this._read(this._channels.get(device.did).unit);
    }

    async setSwitch(device, on) {
        const {unit, outlet} = this._channels.get(device.did);
        const value = on ? 'on' : 'off';
        if (outlet === null)
            await this._post(unit, 'switch', {switch: value});
        else
            await this._post(unit, 'switches', {switches: [{switch: value, outlet}]});
        device.online = true;
        device.values = [on];
    }
}
