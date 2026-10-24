// SPDX-License-Identifier: GPL-2.0-or-later

// Gree LAN protocol over UDP 7000: scan by broadcast, bind for a per-unit key, then
// encrypted JSON. Old firmware uses AES-ECB, newer AES-GCM, each with a bootstrap key
// shared by all units; only a bind reply tells which, so both are tried.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Aes from './aes.js';
import {ClimateError} from './climate.js';
import {localNetworks} from './net.js';

export const PORT = 7000;

const ECB_KEY = 'a3K8Bx%2r8Y7#xDh';
const GCM_KEY = '{yxAHAY_Lm6pbC/<';
const GCM_NONCE = Uint8Array.of(0x54, 0x40, 0x78, 0x44, 0x49, 0x67, 0x5a, 0x51, 0x6c, 0x5e, 0x63, 0x13);
const GCM_AAD = new TextEncoder().encode('qualcomm-test');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const COLUMNS = [
    'Pow', 'Mod', 'SetTem', 'TemUn', 'WdSpd', 'Air', 'Blo', 'Health', 'SwhSlp',
    'Lig', 'SwingLfRig', 'SwUpDn', 'Quiet', 'Tur', 'SvSt', 'TemSen', 'TemRec', 'StHt', 'SlpMod',
];

// Most firmware reports TemSen as °C + 40 so it never goes negative; v4 sends plain °C,
// and 0 means no reading. Per greeclimate, not verified on a real unit.
const SENSOR_OFFSET = 40;

// Version like "3.31", from hid (a firmware file name ending V3.31.bin), else from ver.
// Per greeclimate; unverified.
function firmwareVersion(info) {
    const match = /V(\d+(?:\.\d+)*)\.bin$/.exec(info.hid ?? '') ?? /(\d+(?:\.\d+)*)/.exec(info.ver ?? '');
    return match?.[1] ?? null;
}

export class GreeError extends ClimateError {
    constructor(message) {
        super(message);
        this.name = 'GreeError';
    }
}

function seal(cipher, key, payload) {
    const data = encoder.encode(JSON.stringify(payload));
    if (cipher === 'gcm') {
        const [sealed, tag] = Aes.gcmEncrypt(encoder.encode(key), GCM_NONCE, GCM_AAD, data);
        return {pack: GLib.base64_encode(sealed), tag: GLib.base64_encode(tag)};
    }
    return {pack: GLib.base64_encode(Aes.ecbEncrypt(encoder.encode(key), data))};
}

function open(cipher, key, packet) {
    const sealed = GLib.base64_decode(packet.pack);
    const data = cipher === 'gcm'
        ? Aes.gcmDecrypt(encoder.encode(key), GCM_NONCE, GCM_AAD, sealed, GLib.base64_decode(packet.tag ?? ''))
        : Aes.ecbDecrypt(encoder.encode(key), sealed);
    // Some units append stray bytes after the JSON; cut at the last brace.
    const text = decoder.decode(data);
    return JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
}

class Channel {
    constructor() {
        this._socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
        this._socket.set_blocking(false);
        this._socket.set_broadcast(true);
        this._socket.bind(Gio.InetSocketAddress.new_from_string('0.0.0.0', 0), false);
        this._cancellable = new Gio.Cancellable();
        this._listener = null;
        this._finish = null;
        this._source = this._socket.create_source(GLib.IOCondition.IN, this._cancellable);
        this._source.set_callback(() => {
            this._drain();
            return GLib.SOURCE_CONTINUE;
        });
        this._source.attach(null);
    }

    send(ip, packet) {
        try {
            this._socket.send_to(Gio.InetSocketAddress.new_from_string(ip, PORT),
                encoder.encode(JSON.stringify(packet)), null);
        } catch (e) {
            console.debug(`nook: gree: ${e.message}`);
        }
    }

    close() {
        this._finish?.(undefined);
        this._cancellable.cancel();
        this._source.destroy();
        this._socket.close();
    }

    _drain() {
        for (;;) {
            let bytes, from;
            try {
                [bytes, from] = this._socket.receive_bytes_from(4096, 0, null);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.WOULD_BLOCK))
                    console.debug(`nook: gree: ${e.message}`);
                return;
            }
            let packet;
            try {
                packet = JSON.parse(decoder.decode(bytes.toArray()));
            } catch {
                continue;
            }
            if (typeof packet !== 'object' || packet === null)
                continue;
            const ip = from.get_address().to_string();
            try {
                this._listener?.(packet, ip);
            } catch (e) {
                console.debug(`nook: gree: ${e.message}`);
            }
        }
    }

    exchange(ip, packet, timeout, take) {
        return new Promise((resolve, reject) => {
            // Send before arming the listener and timer: a failed send (no network, bad
            // address) then leaves no stale state for the next exchange.
            try {
                this._socket.send_to(Gio.InetSocketAddress.new_from_string(ip, PORT),
                    encoder.encode(JSON.stringify(packet)), null);
            } catch (e) {
                reject(e);
                return;
            }
            let timer = 0;
            const finish = result => {
                if (this._finish === finish) {
                    this._listener = null;
                    this._finish = null;
                }
                if (timer)
                    GLib.source_remove(timer);
                timer = 0;
                resolve(result);
            };
            this._finish = finish;
            this._listener = (reply, from) => {
                const result = take(reply, from);
                if (result !== undefined)
                    finish(result);
            };
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                timer = 0;
                finish(undefined);
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}

export async function discover(broadcast = '255.255.255.255', timeout = 4000) {
    const channel = new Channel();
    const found = new Map();
    // Wi-Fi drops broadcasts and dozing units miss them: scan a few times, also to each
    // local network's own broadcast address.
    const targets = broadcast === '255.255.255.255'
        ? [broadcast, ...(await localNetworks()).map(network => network.broadcast)] : [broadcast];
    for (const target of targets.slice(1))
        channel.send(target, {t: 'scan'});
    let rounds = 0;
    let again = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        for (const target of targets)
            channel.send(target, {t: 'scan'});
        if (++rounds < 3)
            return GLib.SOURCE_CONTINUE;
        again = 0;
        return GLib.SOURCE_REMOVE;
    });
    const take = (reply, ip) => {
        if (reply.t !== 'pack' || !reply.pack)
            return undefined;
        let info;
        try {
            info = open(reply.tag ? 'gcm' : 'ecb', reply.tag ? GCM_KEY : ECB_KEY, reply);
        } catch {
            return undefined;
        }
        if (info.t === 'dev' && info.mac)
            found.set(info.mac, {ip, mac: info.mac, name: info.name || info.mac, version: firmwareVersion(info), info});
        return undefined;
    };
    try {
        // Listen through the first target that can be sent to: behind a VPN, sending to
        // 255.255.255.255 may fail.
        for (const [i, target] of targets.entries()) {
            try {
                await channel.exchange(target, {t: 'scan'}, timeout, take);
                break;
            } catch (e) {
                if (!(e instanceof GLib.Error) || i === targets.length - 1)
                    throw e;
                console.debug(`nook: gree: ${target}: ${e.message}`);
            }
        }
    } finally {
        if (again)
            GLib.source_remove(again);
        channel.close();
    }
    return [...found.values()];
}

export class GreeDevice {
    constructor(unit) {
        this.ip = unit.ip;
        this.mac = unit.mac;
        this.key = unit.key ?? null;
        this.cipher = unit.cipher ?? null;
        this.version = unit.version ?? null;
        this.state = {};
        this._channel = null;
        this._closed = false;
        this._busy = Promise.resolve();
    }

    // Final: queued requests then fail rather than open a socket nobody closes.
    close() {
        this._closed = true;
        this._channel?.close();
        this._channel = null;
    }

    // One exchange at a time: replies carry no request id.
    _queue(task) {
        const run = this._busy.then(task, task);
        this._busy = run.catch(() => {});
        return run;
    }

    async _send(cipher, key, payload, timeout = 2500) {
        if (this._closed)
            throw new GreeError('closed');
        this._channel ??= new Channel();
        const packet = {cid: 'app', i: payload.t === 'bind' ? 1 : 0, t: 'pack', uid: 0, tcid: this.mac, ...seal(cipher, key, payload)};
        // A late reply to an earlier, timed-out request must not answer this one.
        const expect = {bind: 'bindok', status: 'dat', cmd: 'res'}[payload.t];
        const reply = await this._channel.exchange(this.ip, packet, timeout, (r, ip) => {
            if (ip !== this.ip || r.t !== 'pack' || !r.pack)
                return undefined;
            try {
                const pack = open(cipher, key, r);
                return !expect || pack?.t === expect ? pack : undefined;
            } catch {
                return undefined;
            }
        });
        if (!reply)
            throw new GreeError('the air conditioner did not answer');
        return reply;
    }

    bind() {
        return this._queue(async () => {
            for (const [cipher, key] of [['ecb', ECB_KEY], ['gcm', GCM_KEY]]) {
                const payload = cipher === 'gcm'
                    ? {cid: this.mac, mac: this.mac, t: 'bind', uid: 0}
                    : {mac: this.mac, t: 'bind', uid: 0};
                let reply;
                try {
                    reply = await this._send(cipher, key, payload);
                } catch (e) {
                    if (e instanceof GreeError)
                        continue;
                    throw e;
                }
                if (reply.t === 'bindok' && reply.key) {
                    this.key = reply.key;
                    this.cipher = cipher;
                    return {key: this.key, cipher};
                }
            }
            throw new GreeError('the air conditioner would not bind');
        });
    }

    status() {
        return this._queue(async () => {
            const reply = await this._send(this.cipher, this.key, {cols: COLUMNS, mac: this.mac, t: 'status'});
            if (reply.t !== 'dat' || !Array.isArray(reply.cols) || !Array.isArray(reply.dat))
                throw new GreeError('unexpected answer to a status request');
            const state = {};
            reply.cols.forEach((col, i) => {
                state[col] = reply.dat[i];
            });
            if (typeof state.TemSen === 'number' && state.TemSen !== 0) {
                // Firmware 4 sends plain °C. With the version unknown, a result far below
                // freezing means there was no offset.
                const major = Number.parseInt(this.version ?? '', 10);
                const shifted = state.TemSen - SENSOR_OFFSET;
                state.roomTemperature = major === 4 || (Number.isNaN(major) && shifted < -5) ? state.TemSen : shifted;
            } else {
                state.roomTemperature = null;
            }
            this.state = state;
            return state;
        });
    }

    set(changes) {
        return this._queue(async () => {
            const opt = Object.keys(changes);
            const p = opt.map(k => changes[k]);
            const reply = await this._send(this.cipher, this.key, {opt, p, t: 'cmd'});
            if (reply.t !== 'res' || reply.r !== 200)
                throw new GreeError('the air conditioner refused the change');
            const values = reply.val ?? reply.p ?? p;
            (reply.opt ?? opt).forEach((k, i) => {
                this.state[k] = values[i];
            });
            return this.state;
        });
    }
}
