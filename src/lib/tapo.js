// SPDX-License-Identifier: GPL-2.0-or-later

// Tapo cameras, LAN only (no TP-Link cloud): WS-Discovery, then RTSP with the camera
// account from the Tapo app. Video is decoded in feed.js, PTZ goes through onvif.js.
// Other ONVIF cameras answer the same discovery; each has its own login, and its
// stream and PTZ addresses come from the camera itself.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Onvif from './onvif.js';
import * as Timers from './timers.js';

const DISCOVERY = ['239.255.255.250', 3702];
const RTSP_PORT = 554;
const ONVIF_PORT = 2020;

// Back off after a refused login: each try on a locked account restarts its lockout.
const REFUSED_WAIT = 30 * 60 * 1000;
const REACH_TIMEOUT = 4;
// A camera gone from its address may have a new one from DHCP: WS-Discovery finds it
// by id, at most this often.
const RELOCATE_GAP = 10 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function probe() {
    const id = GLib.uuid_string_random();
    return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>
<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
}

const field = (xml, tag) => new RegExp(`<[^>]*:?${tag}[^>]*>([^<]*)<`).exec(xml)?.[1]?.trim() ?? '';

function scope(scopes, key) {
    const entry = scopes.split(/\s+/).find(s => s.includes(`/${key}/`));
    if (!entry)
        return null;
    const text = entry.split(`/${key}/`)[1];
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

export function discover(timeout = 3000) {
    return new Promise((resolve, reject) => {
        let socket;
        try {
            socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
            socket.set_blocking(false);
            socket.bind(Gio.InetSocketAddress.new_from_string('0.0.0.0', 0), false);
            socket.send_to(Gio.InetSocketAddress.new_from_string(...DISCOVERY), encoder.encode(probe()), null);
        } catch (e) {
            socket?.close();
            reject(e);
            return;
        }

        const found = new Map();
        const source = socket.create_source(GLib.IOCondition.IN, null);
        source.set_callback(() => {
            for (;;) {
                let bytes, from;
                try {
                    [bytes, from] = socket.receive_bytes_from(65536, 0, null);
                } catch {
                    break;
                }
                const xml = decoder.decode(bytes.toArray());
                const scopes = field(xml, 'Scopes');
                const id = field(xml, 'Address').replace(/^(urn:)?uuid:/, '');
                // Printers answer WS-Discovery too.
                if (!id || !field(xml, 'Types').includes('NetworkVideoTransmitter'))
                    continue;
                const ip = from.get_address().to_string();
                const xaddrs = field(xml, 'XAddrs').split(/\s+/).filter(url => url.startsWith('http://'));
                const xaddr = xaddrs.find(url => url.startsWith(`http://${ip}`)) ?? xaddrs[0] ?? null;
                found.set(id, {
                    id,
                    ip,
                    name: scope(scopes, 'name') ?? ip,
                    model: scope(scopes, 'hardware') ?? '',
                    xaddr,
                });
            }
            return GLib.SOURCE_CONTINUE;
        });
        source.attach(null);

        const close = () => {
            source.destroy();
            socket.close();
        };
        Timers.timeout(timeout, () => {
            close();
            resolve([...found.values()]);
            return GLib.SOURCE_REMOVE;
        }, {cleanup: close});
    });
}

export function parseCameras(json) {
    try {
        const cameras = JSON.parse(json || '[]');
        return Array.isArray(cameras) ? cameras.filter(c => c?.id && c.ip) : [];
    } catch {
        return [];
    }
}

// Tapo serves ONVIF on 2020. Cameras saved before the address was kept go by model
// name: Tapo ones are short codes like C200 or TC70.
export function isTapo(camera) {
    if (camera.xaddr) {
        try {
            return GLib.Uri.parse(camera.xaddr, GLib.UriFlags.NONE).get_port() === ONVIF_PORT;
        } catch {
            return false;
        }
    }
    return /^[a-z]{1,2}\d{2,3}[a-z\d]*$/i.test(camera.model ?? '');
}

function reach(address, cancellable) {
    return new Promise(resolve => {
        const client = new Gio.SocketClient({timeout: REACH_TIMEOUT});
        client.connect_to_host_async(address, RTSP_PORT, cancellable, (_client, result) => {
            try {
                client.connect_to_host_finish(result).close(null);
                resolve(true);
            } catch {
                resolve(false);
            }
        });
    });
}

// Module-level, not per device: devices are recreated on a menu reload.
const refusedUntil = new Map();

export function clearRefusals() {
    refusedUntil.clear();
}

export class TapoHome {
    constructor(cameras) {
        this._cancellable = new Gio.Cancellable();
        this.devices = cameras.map(camera => {
            const tapo = camera.ip === 'test' || isTapo(camera);
            const device = {
                did: `tapo:${camera.id}`,
                id: camera.id,
                name: camera.name,
                model: tapo ? `tapo ${camera.model}`.trim() : camera.model,
                tapo,
                xaddr: camera.xaddr ?? null,
                urn: null,
                room: camera.room ?? null,
                online: null,
                primary: {kind: 'camera', props: []},
                values: null,
                ip: camera.ip,
                test: camera.ip === 'test',
                about: {ip: camera.ip === 'test' ? null : camera.ip, model: null},
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            return device;
        });
        this._nextRelocate = 0;
        // Called with [{id, ip, xaddr}] of cameras found at a new address.
        this.onMoved = null;
    }

    abort() {
        this._cancellable.cancel();
    }

    // Wi-Fi cameras sometimes answer slowly: retry once before marking offline.
    async readPrimary() {
        await Promise.all(this.devices.map(async device => {
            const address = this._address(device);
            device.online = device.test || await reach(address, this._cancellable) ||
                await reach(address, this._cancellable);
        }));
        if (this.devices.some(d => d.online === false) && Date.now() >= this._nextRelocate) {
            this._nextRelocate = Date.now() + RELOCATE_GAP;
            await this._relocate().catch(e => console.debug(`nook: camera discovery: ${e.message}`));
        }
        return this.devices.length > 0;
    }

    async _relocate() {
        const found = new Map((await discover(3000)).map(camera => [camera.id, camera]));
        const moved = [];
        for (const device of this.devices) {
            const camera = found.get(device.id);
            if (device.online !== false || !camera || camera.ip === device.ip || this._cancellable.is_cancelled())
                continue;
            device.ip = camera.ip;
            device.about.ip = camera.ip;
            device.xaddr = camera.xaddr ?? device.xaddr;
            device.streams = undefined;
            device.online = await reach(this._address(device), this._cancellable);
            moved.push({id: device.id, ip: device.ip, xaddr: device.xaddr});
        }
        if (moved.length > 0 && !this._cancellable.is_cancelled())
            this.onMoved?.(moved);
    }

    _address(device) {
        if (device.tapo || !device.xaddr)
            return `${device.ip}:${RTSP_PORT}`;
        let port;
        try {
            port = GLib.Uri.parse(device.xaddr, GLib.UriFlags.NONE).get_port();
        } catch {
            port = -1;
        }
        return `${device.ip}:${port > 0 ? port : 80}`;
    }

    // Keyring entry of a camera that is not Tapo; Tapo ones share the 'tapo' one.
    secret(device) {
        return device.tapo ? 'tapo' : `onvif:${device.id}`;
    }

    // stream2 is the low-res substream: enough for the menu, cheap to decode. stream1
    // is the full one, for snapshots.
    async streams(device, camera, cancellable) {
        if (device.tapo) {
            return {
                live: `rtsp://${device.ip}:${RTSP_PORT}/stream2`,
                still: `rtsp://${device.ip}:${RTSP_PORT}/stream1`,
            };
        }
        device.streams ??= await camera.streams(cancellable);
        return device.streams;
    }

    controls(device, user, password) {
        if (device.test) {
            return {
                abilities: () => Promise.resolve({pan: true, home: true}),
                move: () => Promise.resolve(),
                stop: () => Promise.resolve(),
                home: () => Promise.resolve(),
            };
        }
        if (!device.tapo)
            return new Onvif.Camera(device.xaddr, user, password, true);
        return new Onvif.Camera(`http://${device.ip}:${ONVIF_PORT}/onvif/service`, user, password);
    }

    async abilities(device, camera, cancellable) {
        if (device.abilities)
            return device.abilities;
        if (this.isRefused(device))
            return {pan: false, home: false};
        // An ONVIF refusal is not taken as a wrong password: WS-Security also fails when
        // the camera's clock is off. The RTSP login tells.
        device.abilities = await camera.abilities(cancellable);
        return device.abilities;
    }

    refused(device) {
        refusedUntil.set(device.did, Date.now() + REFUSED_WAIT);
    }

    isRefused(device) {
        return (refusedUntil.get(device.did) ?? 0) > Date.now();
    }
}
