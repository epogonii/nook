// SPDX-License-Identifier: GPL-2.0-or-later

// Midea air conditioners and the brands built on them, on the LAN: TCP 6444, an AES-ECB
// frame inside an MD5-signed packet. V3 units wrap that in an AES-CBC session opened with
// a token and key from Midea's cloud. Byte layouts per msmart-ng, unverified on a unit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Aes from './aes.js';
import {ClimateError} from './climate.js';
import {concat, fromHex, toHex} from './hap.js';
import {probe} from './net.js';
import * as Secrets from './secrets.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export const PORT = 6444;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const digest = (type, data) => fromHex(GLib.compute_checksum_for_bytes(type, new GLib.Bytes(data)));
const md5 = data => digest(GLib.ChecksumType.MD5, data);
const sha256 = data => digest(GLib.ChecksumType.SHA256, data);
const sha256Hex = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const SIGN_KEY = encoder.encode('xhdiwjnchekd4d512chdjx5d8e4c394D2D7S');
const FRAME_KEY = md5(SIGN_KEY);
const ZERO_IV = new Uint8Array(16);

const DISCOVERY = fromHex(`5a5a011148009200${'00'.repeat(32)}7f75bd6b3e4f8b762e849c6e578d6590036e9d4342a50f1f569eb8ec918e92e5`);
const DISCOVERY_PORTS = [6445, 20086];

const AIRCON = 0xac;
const CONTROL = 0x02;
const QUERY = 0x03;
const STATE = 0xc0;
const CAPABILITIES = 0xb5;

export const secretService = id => `aircon:midea:${id}`;

export class MideaError extends ClimateError {
    constructor(message, code = '') {
        super(message, code);
        this.name = 'MideaError';
    }
}

// CRC-8/MAXIM, the table msmart-ng spells out.
const CRC8 = Array.from({length: 256}, (_v, n) => {
    let c = n;
    for (let k = 0; k < 8; k++)
        c = c & 1 ? (c >>> 1) ^ 0x8c : c >>> 1;
    return c;
});
const crc8 = bytes => bytes.reduce((c, b) => CRC8[(c ^ b) & 0xff], 0);
const checksum = bytes => (~bytes.reduce((sum, b) => sum + b, 0) + 1) & 0xff;

let messageId = 0;

export function frame(type, body) {
    const payload = concat(body, Uint8Array.of(++messageId & 0xff));
    const data = concat(payload, Uint8Array.of(crc8(payload)));
    const header = new Uint8Array(10);
    header[0] = 0xaa;
    header[1] = data.length + 10;
    header[2] = AIRCON;
    header[9] = type;
    const out = concat(header, data);
    return concat(out, Uint8Array.of(checksum(out.subarray(1))));
}

// The payload from the response id on, or null for a broken frame or another appliance.
export function framePayload(bytes) {
    if (bytes.length < 13 || bytes[0] !== 0xaa || bytes[2] !== AIRCON ||
        checksum(bytes.subarray(1, -1)) !== bytes[bytes.length - 1])
        return null;
    const payload = bytes.subarray(10, -1);
    // Some units end the payload with a CRC, others with a checksum; properties with neither.
    const body = payload.subarray(0, -1);
    const end = payload[payload.length - 1];
    if (payload[0] !== 0xb0 && payload[0] !== 0xb1 && crc8(body) !== end && checksum(body) !== end)
        return null;
    return body;
}

function timestamp() {
    const now = GLib.DateTime.new_now_utc();
    const year = now.get_year();
    return Uint8Array.of(Math.floor(now.get_microsecond() / 10000), now.get_second(), now.get_minute(),
        now.get_hour(), now.get_day_of_month(), now.get_month(), year % 100, Math.floor(year / 100));
}

function idBytes(id, length, bigEndian = false) {
    const out = new Uint8Array(length);
    let n = BigInt(id);
    for (let i = 0; i < length; i++) {
        out[bigEndian ? length - 1 - i : i] = Number(n & 0xffn);
        n >>= 8n;
    }
    return out;
}

export function encodePacket(id, frameBytes) {
    const sealed = Aes.ecbEncrypt(FRAME_KEY, frameBytes);
    const header = new Uint8Array(40);
    header.set([0x5a, 0x5a, 0x01, 0x11]);
    const length = 40 + sealed.length + 16;
    header[4] = length & 0xff;
    header[5] = length >> 8;
    header[6] = 0x20;
    header.set(timestamp(), 12);
    header.set(idBytes(id, 8), 20);
    const packet = concat(header, sealed);
    return concat(packet, md5(concat(packet, SIGN_KEY)));
}

export function decodePacket(bytes) {
    if (bytes.length < 56 || bytes[0] !== 0x5a || bytes[1] !== 0x5a)
        throw new MideaError('not a Midea packet');
    const length = bytes[4] | (bytes[5] << 8);
    if (length < 56 || bytes.length < length)
        throw new MideaError('a Midea packet was cut short');
    const packet = bytes.subarray(0, length);
    if (!same(md5(concat(packet.subarray(0, -16), SIGN_KEY)), packet.subarray(-16)))
        throw new MideaError('a Midea packet failed its signature');
    return Aes.ecbDecrypt(FRAME_KEY, packet.subarray(40, -16));
}

// The id a V3 unit's token and key are filed under in the cloud; units disagree on the
// byte order of the appliance id, so both are tried.
export function udpid(id, bigEndian = false) {
    const hash = sha256(idBytes(id, 6, bigEndian));
    return toHex(hash.subarray(0, 16).map((b, i) => b ^ hash[16 + i]));
}

export async function discover(address = '255.255.255.255', timeout = 4000) {
    const found = new Map();
    const take = (bytes, ip) => {
        let data = bytes;
        let version = 2;
        if (data[0] === 0x83 && data[1] === 0x70) {
            version = 3;
            data = data.subarray(8, -16);
        } else if (data[0] !== 0x5a || data[1] !== 0x5a) {
            return;
        }
        if (data.length < 72)
            return;
        const id = Number(data.subarray(20, 26).reduceRight((n, b) => (n << 8n) | BigInt(b), 0n));
        const info = Aes.ecbDecrypt(FRAME_KEY, data.subarray(40, -16));
        if (info.length < 41)
            return;
        const nameLength = info[40];
        const name = decoder.decode(info.subarray(41, 41 + nameLength));
        // name is the unit's SSID in AP mode, like net_ac_F7B4.
        if (Number.parseInt(name.split('_')[1], 16) !== AIRCON)
            return;
        found.set(id, {
            ip,
            port: info[4] | (info[5] << 8) || PORT,
            id: String(id),
            sn: decoder.decode(info.subarray(8, 40)).replace(/\0+$/, ''),
            name,
            version,
        });
    };
    try {
        await probe(DISCOVERY, DISCOVERY_PORTS, {address, timeout, take});
    } catch (e) {
        if (e instanceof GLib.Error)
            throw e;
        throw new MideaError(e.message);
    }
    return [...found.values()];
}

// Model code from the serial number, as the Midea app shows it; per msmart-ng's sn[9:17].
const modelOf = sn => (/^[0-9A-Z]{17}/.test(sn ?? '') ? sn.slice(9, 17) : null);

// One TCP connection. A V3 unit first gets the token; its reply, opened with the key,
// gives the session key for every packet after.
class Link {
    static async open(ip, port, secret) {
        const client = new Gio.SocketClient({timeout: 5});
        const cancellable = new Gio.Cancellable();
        const connection = await client.connect_async(Gio.NetworkAddress.new(ip, port), cancellable);
        connection.get_socket().set_timeout(0);
        const link = new Link(connection, cancellable, secret);
        if (!secret)
            return link;
        try {
            await link._handshake();
        } catch (e) {
            link.close();
            throw e;
        }
        // msmart-ng waits as long before the first request.
        await link._pause(1000);
        if (link.closed)
            throw new MideaError('closed', 'closed');
        return link;
    }

    constructor(connection, cancellable, secret) {
        this._connection = connection;
        this._cancellable = cancellable;
        this._secret = secret;
        this._session = null;
        this._buffer = new Uint8Array(0);
        this._waiting = [];
        this._count = 0;
        this._pausing = null;
        this.closed = false;
        this._read().catch(e => this.close(e));
    }

    _pause(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._pausing = null;
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._pausing = {id, resolve};
        });
    }

    async _read() {
        const input = this._connection.input_stream;
        while (!this.closed) {
            const bytes = await input.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (bytes.get_size() === 0)
                throw new MideaError('the air conditioner closed the connection', 'closed');
            this._buffer = concat(this._buffer, bytes.toArray());
            this._drain();
        }
    }

    _drain() {
        for (;;) {
            const b = this._buffer;
            const v3 = Boolean(this._secret);
            const start = v3 ? 0x83 : 0x5a;
            const at = b.findIndex((v, i) => v === start && b[i + 1] === (v3 ? 0x70 : 0x5a));
            if (at < 0) {
                this._buffer = b.length > 0 && b[b.length - 1] === start ? b.slice(-1) : new Uint8Array(0);
                return;
            }
            if (b.length < at + 6)
                return;
            const size = v3 ? ((b[at + 2] << 8) | b[at + 3]) + 8 : b[at + 4] | (b[at + 5] << 8);
            // A V2 length shorter than its own header is noise: skip the marker, or this
            // loop would never move on.
            if (!v3 && size < 56) {
                this._buffer = b.slice(at + 2);
                continue;
            }
            if (b.length < at + size)
                return;
            const packet = b.slice(at, at + size);
            this._buffer = b.slice(at + size);
            try {
                this._take(v3 ? this._open(packet) : {type: 'data', data: packet});
            } catch (e) {
                console.debug(`nook: midea: ${e.message}`);
            }
        }
    }

    _open(packet) {
        if (packet[4] !== 0x20)
            throw new MideaError('a broken packet from the air conditioner');
        const type = packet[5] & 0xf;
        if (type === 0x1)
            return {type: 'handshake', data: packet.subarray(8)};
        if (type === 0xf)
            return {type: 'error'};
        if (type !== 0x3 || !this._session)
            throw new MideaError(`an unexpected packet of type ${type}`);
        const header = packet.subarray(0, 6);
        const plain = Aes.cbcDecrypt(this._session, ZERO_IV, packet.subarray(6, -32), false);
        if (!same(sha256(concat(header, plain)), packet.subarray(-32)))
            throw new MideaError('a packet failed its hash');
        return {type: 'data', data: plain.subarray(2, plain.length - (header[5] >> 4))};
    }

    _take(message) {
        if (message.type === 'error' && this._session) {
            this.close(new MideaError('the air conditioner ended the session', 'closed'));
            return;
        }
        const i = this._waiting.findIndex(w => w.test(message));
        if (i < 0)
            return;
        const [waiter] = this._waiting.splice(i, 1);
        GLib.source_remove(waiter.timer);
        waiter.resolve(message);
    }

    next(test, timeout = 3000) {
        if (this.closed)
            return Promise.reject(new MideaError('the connection is closed', 'closed'));
        return new Promise((resolve, reject) => {
            const waiter = {test, resolve, reject};
            waiter.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._waiting.splice(this._waiting.indexOf(waiter), 1);
                reject(new MideaError('the air conditioner did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._waiting.push(waiter);
        });
    }

    async _write(data) {
        const output = this._connection.output_stream;
        for (let at = 0; at < data.length;)
            at += await output.write_bytes_async(new GLib.Bytes(data.subarray(at)), GLib.PRIORITY_DEFAULT, this._cancellable);
    }

    _header(length, type) {
        return Uint8Array.of(0x83, 0x70, length >> 8, length & 0xff, 0x20, type);
    }

    async _handshake() {
        const token = this._secret.token;
        const reply = this.next(m => m.type === 'handshake' || m.type === 'error', 5000);
        await this._write(concat(this._header(token.length, 0x0), Uint8Array.of(0, this._count++), token));
        const answer = await reply;
        if (answer.type !== 'handshake' || answer.data.length !== 64)
            throw new MideaError('the air conditioner refused the key', 'refused');
        const plain = Aes.cbcDecrypt(this._secret.key, ZERO_IV, answer.data.subarray(0, 32), false);
        if (!same(sha256(plain), answer.data.subarray(32)))
            throw new MideaError('the air conditioner refused the key', 'refused');
        this._session = plain.map((b, i) => b ^ this._secret.key[i]);
    }

    send(packet) {
        if (!this._secret)
            return this._write(packet);
        const remainder = (packet.length + 2) % 16;
        const pad = remainder ? 16 - remainder : 0;
        const header = this._header(packet.length + pad + 32, (pad << 4) | 0x6);
        const id = this._count++ & 0xfff;
        const plain = concat(Uint8Array.of(id >> 8, id & 0xff), packet,
            Uint8Array.from({length: pad}, () => GLib.random_int_range(0, 256)));
        return this._write(concat(header, Aes.cbcEncrypt(this._session, ZERO_IV, plain, false),
            sha256(concat(header, plain))));
    }

    close(error = null) {
        if (this.closed)
            return;
        this.closed = true;
        if (this._pausing) {
            GLib.source_remove(this._pausing.id);
            this._pausing.resolve();
            this._pausing = null;
        }
        this._cancellable.cancel();
        this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        for (const waiter of this._waiting.splice(0)) {
            GLib.source_remove(waiter.timer);
            waiter.reject(error instanceof MideaError ? error : new MideaError('the connection was lost', 'closed'));
        }
        if (error && !(error instanceof MideaError) && !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            console.debug(`nook: midea: ${error.message}`);
    }
}

const STATE_QUERY = Uint8Array.of(0x41, 0x81, 0x00, 0xff, 0x03, 0xff, 0x00, 0x02, ...new Array(12).fill(0), 0x03);
const DISPLAY_TOGGLE = Uint8Array.of(0x41, 0x02, 0x00, 0xff, 0x02, 0x00, 0x02, ...new Array(14).fill(0));

function parseTemperature(data, decimals, fahrenheit) {
    if (data === 0xff)
        return null;
    const t = (data - 50) / 2;
    if (!fahrenheit && decimals)
        return Math.trunc(t) + (t >= 0 ? decimals : -decimals);
    if (decimals >= 0.5)
        return Math.trunc(t) + (t >= 0 ? 0.5 : -0.5);
    return t;
}

export function parseState(p) {
    if (p.length < 17)
        throw new MideaError('a short state from the air conditioner');
    const half = p[2] & 0x10 ? 0.5 : 0;
    const fahrenheit = Boolean(p[10] & 0x04);
    const alternate = p[13] & 0x1f;
    return {
        power: Boolean(p[1] & 0x01),
        target: alternate ? alternate + 12 + half : (p[2] & 0x0f) + 16 + half,
        mode: (p[2] >> 5) & 0x07,
        fan: p[3] & 0x7f,
        swing: p[7] & 0x0f,
        turbo: Boolean(p[8] & 0x20) || Boolean(p[10] & 0x02),
        auxOnly: Boolean(p[8] & 0x40),
        followMe: Boolean(p[8] & 0x80),
        eco: Boolean(p[9] & 0x10),
        purifier: Boolean(p[9] & 0x20),
        aux: Boolean(p[9] & 0x08),
        sleep: Boolean(p[10] & 0x01),
        fahrenheit,
        indoor: parseTemperature(p[11], (p[15] & 0x0f) / 10, fahrenheit),
        outdoor: parseTemperature(p[12], (p[15] >> 4) / 10, fahrenheit),
        display: p[14] !== 0x70,
        error: p[16],
        humidity: p.length >= 20 ? p[19] & 0x7f : 40,
        freeze: p.length >= 22 ? Boolean(p[21] & 0x80) : false,
    };
}

export function stateCommand(s) {
    const whole = Math.trunc(s.target);
    const inRange = whole >= 17 && whole <= 30;
    const temperature = (inRange ? (whole - 16) & 0x0f : 0) | (s.target - whole > 0 ? 0x10 : 0);
    const body = new Uint8Array(24);
    body[0] = 0x40;
    body[1] = 0x02 | (s.power ? 0x01 : 0);
    body[2] = temperature | ((s.mode & 0x07) << 5);
    body[3] = s.fan;
    body[4] = 0x7f;
    body[5] = 0x7f;
    body[7] = 0x30 | (s.swing & 0x3f);
    body[8] = (s.followMe ? 0x80 : 0) | (s.turbo ? 0x20 : 0);
    body[9] = (s.eco ? 0x80 : 0) | (s.purifier ? 0x20 : 0) | (s.aux ? 0x08 : 0);
    body[10] = (s.sleep ? 0x01 : 0) | (s.turbo ? 0x02 : 0) | (s.fahrenheit ? 0x04 : 0);
    body[18] = inRange ? 0 : (whole - 12) & 0x1f;
    body[19] = s.humidity & 0x7f;
    body[21] = s.freeze ? 0x80 : 0;
    body[22] = s.auxOnly ? 0x08 : 0;
    return body;
}

const among = (value, list) => list.includes(value);

// What a B5 answer says the unit can do; ids and value meanings per msmart-ng.
export function parseCapabilities(p, into = {}) {
    let caps = p.subarray(2);
    for (let n = 0; n < p[1] && caps.length >= 3; n++) {
        const size = caps[2];
        const id = caps[0] | (caps[1] << 8);
        const v = caps.subarray(3, 3 + size);
        if (size > 0) {
            switch (id) {
            case 0x0214:
                into.heat = among(v[0], [1, 2, 4, 6, 7, 9, 10, 11, 12, 13]);
                into.cool = among(v[0], [0, 1, 3, 4, 5, 6, 7, 8, 9, 11, 13, 14, 15]);
                into.dry = among(v[0], [0, 1, 5, 6, 9, 11, 13, 14, 15]);
                into.auto = among(v[0], [0, 1, 2, 7, 8, 9, 13, 14]);
                break;
            case 0x0215:
                into.horizontal = among(v[0], [1, 3]);
                into.vertical = among(v[0], [0, 1]);
                break;
            case 0x0210:
                into.fans = {
                    silent: among(v[0], [6, 9]),
                    low: among(v[0], [3, 4, 5, 6, 7, 9]),
                    medium: among(v[0], [5, 6, 7]),
                    high: among(v[0], [3, 4, 5, 6, 7, 9]),
                    auto: among(v[0], [4, 5, 6, 9]),
                    custom: v[0] === 1,
                };
                break;
            case 0x0212:
                into.eco = among(v[0], [1, 2]);
                break;
            case 0x0213:
                into.freeze = v[0] === 1;
                break;
            case 0x021a:
                into.turbo = among(v[0], [1, 3]) || among(v[0], [0, 1]);
                break;
            case 0x0224:
                into.display = among(v[0], [1, 2, 100]);
                break;
            case 0x021e:
                into.anion = v[0] === 1;
                break;
            case 0x0225:
                if (size >= 6) {
                    into.min = Math.min(v[0], v[2], v[4]) / 2;
                    into.max = Math.max(v[1], v[3], v[5]) / 2;
                    into.decimals = (size > 6 ? v[6] : size) !== 0;
                }
                break;
            }
        }
        caps = caps.subarray(3 + size);
    }
    into.more = caps.length > 1 && Boolean(caps[caps.length - 2]);
    return into;
}

// Midea modes 1 auto, 2 cool, 3 dry, 4 heat, 5 fan, 6 smart dry, by MODES index.
const TO_MIDEA = [1, 2, 3, 5, 4];
const FROM_MIDEA = {1: 0, 2: 1, 3: 2, 4: 4, 5: 3, 6: 2};

const FANS = [
    ['auto', {value: 102, word: 'auto', level: 0}],
    ['silent', {value: 20, word: 'quiet', level: 1}],
    ['low', {value: 40, word: 'low', level: 2}],
    ['medium', {value: 60, word: 'medium', level: 3}],
    ['high', {value: 80, word: 'high', level: 4}],
    ['custom', {value: 100, word: 'max', level: 5}],
];

// Without a B5 answer, msmart-ng's defaults: every mode and swing, four fan speeds. With
// one, what it leaves out the unit lacks.
export function capsOf(known) {
    const c = known ?? {};
    const has = key => (known ? Boolean(c[key]) : true);
    const fans = c.fans ? FANS.filter(([key]) => c.fans[key] || c.fans.custom)
        : FANS.filter(([key]) => ['auto', 'low', 'medium', 'high'].includes(key));
    return {
        range: [c.min ?? 16, c.max ?? 30, c.decimals ? 0.5 : 1],
        modes: [0, 1, 2, 3, 4].filter(i => i === 3 || has(['auto', 'cool', 'dry', 'fan', 'heat'][i])),
        fans: fans.map(([, fan]) => fan),
        airflows: has('vertical') ? [1, 0] : [],
        sides: has('horizontal') ? [1, 0] : [],
        toggles: {SvSt: has('eco'), Tur: has('turbo'), StHt: has('freeze'), Lig: has('display'), Health: has('anion')},
    };
}

// Units with custom speeds report any percentage; the card shows the nearest named one.
function fanOf(fan, caps) {
    if (caps.fans.some(f => f.value === fan) || fan === 102)
        return fan;
    const named = caps.fans.filter(f => f.value <= 100);
    return named.reduce((best, f) => (Math.abs(f.value - fan) < Math.abs(best.value - fan) ? f : best), named[0] ?? {value: fan}).value;
}

export function stateOf(raw, caps) {
    const state = {
        Pow: raw.power ? 1 : 0,
        Mod: FROM_MIDEA[raw.mode] ?? 0,
        SetTem: raw.target,
        roomTemperature: raw.indoor,
        WdSpd: fanOf(raw.fan, caps),
        SwhSlp: raw.sleep ? 1 : 0,
    };
    if (caps.airflows.length > 0)
        state.SwUpDn = raw.swing & 0x0c ? 1 : 0;
    if (caps.sides.length > 0)
        state.SwingLfRig = raw.swing & 0x03 ? 1 : 0;
    const flags = {SvSt: raw.eco, Tur: raw.turbo, StHt: raw.freeze, Lig: raw.display, Health: raw.purifier};
    for (const [key, on] of Object.entries(flags)) {
        if (caps.toggles[key])
            state[key] = on ? 1 : 0;
    }
    return state;
}

const IDLE = 60 * 1000;

export class MideaUnit {
    constructor(unit, secret = undefined) {
        this._unit = unit;
        this._secret = secret;
        this._link = null;
        this._idle = 0;
        this._busy = Promise.resolve();
        this._closed = false;
        this._raw = null;
        this._known = null;
        this._asked = false;
        this.caps = capsOf(null);
        this.about = {ip: unit.ip, mac: null, firmware: null, model: modelOf(unit.sn)};
    }

    close() {
        this._closed = true;
        this._drop();
    }

    _drop(error = null) {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        this._link?.close(error);
        this._link = null;
    }

    // One exchange at a time: replies carry no request id.
    _queue(task) {
        const run = this._busy.then(task, task);
        this._busy = run.catch(() => {});
        return run;
    }

    // Looked up until found: the keyring may still be locked at the first poll.
    async _keys() {
        if (Number(this._unit.version) !== 3)
            return null;
        if (!this._secret) {
            const saved = await Secrets.lookup(secretService(this._unit.id));
            try {
                this._secret = saved ? JSON.parse(saved) : null;
            } catch {
                this._secret = null;
            }
        }
        const {token, key} = this._secret ?? {};
        if (typeof token !== 'string' || typeof key !== 'string')
            throw new MideaError('the key for this air conditioner is missing: remove it in the Nook settings and add it again', 'key');
        return {token: fromHex(token), key: fromHex(key)};
    }

    async _connected() {
        if (this._closed)
            throw new MideaError('closed', 'closed');
        if (this._link?.closed)
            this._link = null;
        if (!this._link) {
            const link = await Link.open(this._unit.ip, this._unit.port || PORT, await this._keys());
            // close() may have come while connecting.
            if (this._closed) {
                link.close();
                throw new MideaError('closed', 'closed');
            }
            this._link = link;
        }
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IDLE, () => {
            this._idle = 0;
            this._drop();
            return GLib.SOURCE_REMOVE;
        });
        return this._link;
    }

    // A command's answer, or null when wanted is null; unsolicited reports are skipped,
    // and a B5 counts only as the answer to a query (units also push B5 notifications).
    // A request that goes unanswered is sent once more, as msmart-ng does, unless sending
    // it twice would undo it.
    async _ask(type, body, wanted, {timeout = 3000, again = true} = {}) {
        const packet = encodePacket(this._unit.id, frame(type, body));
        const answer = m => {
            if (m.type !== 'data')
                return false;
            try {
                const bytes = decodePacket(m.data);
                return framePayload(bytes)?.[0] === wanted && (wanted !== CAPABILITIES || bytes[9] === QUERY);
            } catch {
                return false;
            }
        };
        try {
            const link = await this._connected();
            for (let attempt = 1; ; attempt++) {
                const reply = wanted === null ? null : link.next(answer, timeout);
                // A failed send leaves the waiter to be rejected by close(), unawaited.
                reply?.catch(() => {});
                await link.send(packet);
                if (!reply)
                    return null;
                try {
                    return framePayload(decodePacket((await reply).data));
                } catch (e) {
                    if (e.code !== 'timeout' || attempt === 2 || !again)
                        throw e;
                }
            }
        } catch (e) {
            this._drop(e);
            if (e instanceof GLib.Error && !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new MideaError(`the air conditioner did not answer: ${e.message}`);
            throw e;
        }
    }

    async _capabilities() {
        if (this._asked)
            return;
        this._asked = true;
        try {
            const first = await this._ask(QUERY, Uint8Array.of(0xb5, 0x01, 0x00), CAPABILITIES);
            const known = parseCapabilities(first);
            if (known.more) {
                const more = await this._ask(QUERY, Uint8Array.of(0xb5, 0x01, 0x01, 0x01), CAPABILITIES).catch(() => null);
                if (more)
                    parseCapabilities(more, known);
            }
            this._known = known;
            this.caps = capsOf(known);
        } catch (e) {
            if (!(e instanceof MideaError))
                throw e;
            console.debug(`nook: midea: capabilities: ${e.message}`);
        }
    }

    // An unanswered command may still have been carried out: read back instead.
    _lost(e) {
        if (e.code !== 'timeout')
            throw e;
        return null;
    }

    async _query() {
        this._raw = parseState(await this._ask(QUERY, STATE_QUERY, STATE));
        return this._raw;
    }

    // A unit that was unreachable is asked for its capabilities again; one that answers
    // the state but not B5 has none to give.
    status() {
        return this._queue(async () => {
            await this._capabilities();
            try {
                return stateOf(await this._query(), this.caps);
            } catch (e) {
                if (!this._known)
                    this._asked = false;
                throw e;
            }
        });
    }

    set(changes) {
        return this._queue(async () => {
            // SET_STATE carries everything: start from a fresh read, not one the remote has changed since.
            const raw = {...await this._query()};
            // The toggle's own answer is taken, so it cannot pass for a later one's.
            if ('Lig' in changes && Boolean(changes.Lig) !== raw.display)
                await this._ask(QUERY, DISPLAY_TOGGLE, STATE, {again: false}).catch(e => this._lost(e));
            const rest = Object.keys(changes).filter(key => key !== 'Lig');
            if (rest.length > 0) {
                if ('Pow' in changes)
                    raw.power = changes.Pow === 1;
                if ('Mod' in changes)
                    raw.mode = TO_MIDEA[changes.Mod] ?? raw.mode;
                if ('SetTem' in changes)
                    raw.target = changes.SetTem;
                if ('WdSpd' in changes)
                    raw.fan = changes.WdSpd;
                if ('SwUpDn' in changes || 'SwingLfRig' in changes) {
                    const vertical = 'SwUpDn' in changes ? changes.SwUpDn === 1 : Boolean(raw.swing & 0x0c);
                    const horizontal = 'SwingLfRig' in changes ? changes.SwingLfRig === 1 : Boolean(raw.swing & 0x03);
                    raw.swing = (vertical ? 0x0c : 0) | (horizontal ? 0x03 : 0);
                }
                for (const [key, field] of [['SvSt', 'eco'], ['Tur', 'turbo'], ['SwhSlp', 'sleep'], ['StHt', 'freeze'],
                    ['Health', 'purifier']]) {
                    if (key in changes)
                        raw[field] = Boolean(changes[key]);
                }
                const answer = await this._ask(CONTROL, stateCommand(raw), STATE).catch(e => this._lost(e));
                if (answer) {
                    this._raw = parseState(answer);
                    return stateOf(this._raw, this.caps);
                }
            }
            return stateOf(await this._query(), this.caps);
        });
    }
}

const CLOUD = 'https://mapp.appsmb.com';
const APP_ID = '1017';
const APP_KEY = '3742e9e5842d4ad59c2db887e12449f9';

// msmart-ng's public NetHome Plus accounts, kept for fetching LAN keys: the cloud gives a
// unit's token to any account that asks, so none of these owns or sees a unit.
const ACCOUNTS = [
    ['nethome+us@mailinator.com', 'password1'],
    ['nethome+de@mailinator.com', 'password1'],
    ['nethome+sea@mailinator.com', 'password1'],
];

class NetHomeCloud {
    constructor(cancellable) {
        this._session = new Soup.Session({timeout: 10});
        this._cancellable = cancellable;
        this._sessionId = '';
        this._deviceId = toHex(Uint8Array.from({length: 8}, () => GLib.random_int_range(0, 256)));
    }

    async _call(path, data) {
        const stamp = GLib.DateTime.new_now_utc().format('%Y%m%d%H%M%S');
        const body = {appId: APP_ID, src: APP_ID, format: '2', clientType: '1', language: 'en_US',
            deviceId: this._deviceId, stamp, sessionId: this._sessionId, ...data};
        const sorted = Object.keys(body).sort();
        body.sign = sha256Hex(`${path}${sorted.map(key => `${key}=${body[key]}`).join('&')}${APP_KEY}`);
        const form = Object.entries(body).map(([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
        const message = Soup.Message.new('POST', `${CLOUD}${path}`);
        message.set_request_body_from_bytes('application/x-www-form-urlencoded',
            new GLib.Bytes(encoder.encode(form)));
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new MideaError(`Midea's cloud answered HTTP ${message.get_status()}`);
        let reply;
        try {
            reply = JSON.parse(decoder.decode(bytes.toArray()));
        } catch {
            throw new MideaError('Midea\'s cloud gave an answer that could not be read');
        }
        if (Number(reply.errorCode) !== 0)
            throw new MideaError(`Midea's cloud: ${reply.msg ?? reply.errorCode}`, String(reply.errorCode));
        return reply.result;
    }

    async logIn(account, password) {
        const {loginId} = await this._call('/v1/user/login/id/get', {loginAccount: account});
        const {sessionId} = await this._call('/v1/user/login', {
            loginAccount: account,
            password: sha256Hex(`${loginId}${sha256Hex(password)}${APP_KEY}`),
        });
        this._sessionId = sessionId;
    }

    async token(id, bigEndian) {
        const udp = udpid(id, bigEndian);
        const {tokenlist = []} = await this._call('/v1/iot/secure/getToken', {udpid: udp, applianceCodes: String(id)});
        const found = tokenlist.find(t => t.udpId === udp);
        return found ? {token: found.token, key: found.key} : null;
    }

    abort() {
        this._session.abort();
    }
}

/**
 * Fetches a V3 unit's token and key from Midea's cloud and checks them on the unit;
 * returns {token, key} as hex. Every other step stays on the LAN.
 */
export async function fetchKeys(unit, cancellable = null) {
    const cloud = new NetHomeCloud(cancellable);
    let last = null;
    try {
        // The shared accounts see each other's sessions; 9999 can be just that, so the next
        // account is tried. A unit that refuses what the cloud gave would refuse it again.
        for (const [account, password] of ACCOUNTS) {
            try {
                await cloud.logIn(account, password);
            } catch (e) {
                if (!(e instanceof MideaError))
                    throw e;
                last = e;
                continue;
            }
            for (const bigEndian of [false, true]) {
                let secret;
                try {
                    secret = await cloud.token(unit.id, bigEndian);
                } catch (e) {
                    if (!(e instanceof MideaError))
                        throw e;
                    last = e;
                    continue;
                }
                if (!secret)
                    continue;
                const link = await Link.open(unit.ip, unit.port || PORT,
                    {token: fromHex(secret.token), key: fromHex(secret.key)}).catch(e => {
                    if (e instanceof MideaError && e.code === 'refused')
                        return null;
                    throw e;
                });
                if (link) {
                    link.close();
                    return secret;
                }
                last = new MideaError('the air conditioner took none of the keys from Midea\'s cloud', 'refused');
            }
            if (last?.code === 'refused')
                break;
        }
        throw last ?? new MideaError('Midea\'s cloud has no key for this air conditioner');
    } finally {
        cloud.abort();
    }
}

export function keepKeys(unit, secret) {
    return Secrets.store(secretService(unit.id), `Nook: the key of the Midea air conditioner ${unit.name || unit.id}`,
        JSON.stringify(secret));
}
