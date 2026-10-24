// SPDX-License-Identifier: GPL-2.0-or-later

// HomeKit accessories over IP: pair-setup with the eight-digit code on the accessory,
// pair-verify on each connection, then JSON over the encrypted HTTP it speaks. An
// accessory takes one owner: one in the Home app refuses until removed there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {browse} from './finder.js';
import {HapError, PairSetup, TLV, concat, findBytes, fromHex, openFrames, pairVerify, readTlv, sealFrames, writeTlv} from './hap.js';
import {SpecError} from './spec-home.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const ANSWER_TIMEOUT = 10000;
const REMOVE_PAIRING = 4;
// Status of a bridged accessory the bridge cannot reach.
export const UNREACHABLE = -70402;

export const secretService = id => `homekit:${id}`;

export function parseHosts(json) {
    try {
        const hosts = JSON.parse(json || '[]');
        return Array.isArray(hosts)
            ? hosts.filter(h => /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(h?.id ?? '') && typeof h.ip === 'string' &&
                Number.isInteger(h.port) && Array.isArray(h.accessories))
            : [];
    } catch {
        return [];
    }
}

// "00000043-0000-1000-8000-0026BB765291" and "43" are the same type.
export function shortType(type) {
    const text = String(type ?? '').toUpperCase();
    const full = /^([0-9A-F]{8})-0000-1000-8000-0026BB765291$/.exec(text);
    return (full ? full[1] : text).replace(/^0+(?=.)/, '');
}

const CRLF = encoder.encode('\r\n');
const BLANK_LINE = encoder.encode('\r\n\r\n');

// One HTTP message off the front: [{start, status, headers, body}, rest], or null while
// it is incomplete. Bodies come with a length or chunked.
export function parseResponse(buffer) {
    const end = findBytes(buffer, BLANK_LINE);
    if (end < 0)
        return null;
    const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0)
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const head = {start: lines[0], status: parseInt(lines[0].split(' ')[1]) || 0, headers};
    let at = end + 4;
    if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
        const parts = [];
        for (;;) {
            const line = findBytes(buffer, CRLF, at);
            if (line < 0)
                return null;
            const size = parseInt(decoder.decode(buffer.subarray(at, line)).split(';')[0], 16);
            if (Number.isNaN(size))
                throw new SpecError('The accessory sent a broken answer', 'broken');
            at = line + 2;
            if (size === 0) {
                const last = findBytes(buffer, CRLF, at);
                if (last < 0)
                    return null;
                return [{...head, body: concat(...parts)}, buffer.slice(last + 2)];
            }
            if (buffer.length < at + size + 2)
                return null;
            parts.push(buffer.subarray(at, at + size));
            at += size + 2;
        }
    }
    const length = parseInt(headers['content-length'] ?? '0') || 0;
    if (buffer.length < at + length)
        return null;
    return [{...head, body: buffer.slice(at, at + length)}, buffer.slice(at + length)];
}

// HTTP to an accessory, one request at a time, HAP-framed once pair-verify sets the keys.
class HapConnection {
    static async open(ip, port) {
        const client = new Gio.SocketClient({timeout: 5});
        const cancellable = new Gio.Cancellable();
        const connection = await client.connect_async(Gio.NetworkAddress.new(ip, port), cancellable);
        connection.get_socket().set_timeout(0);
        return new HapConnection(connection, cancellable, `${ip.includes(':') ? `[${ip}]` : ip}:${port}`);
    }

    constructor(connection, cancellable, host) {
        this._connection = connection;
        this._cancellable = cancellable;
        this._host = host;
        this._keys = null;
        this._sealed = new Uint8Array(0);
        this._buffer = new Uint8Array(0);
        this._waiting = null;
        this._queue = Promise.resolve();
        this._writing = Promise.resolve();
        this.closed = false;
        this.onClose = null;
        this._read().catch(e => this._end(e));
    }

    encrypt(output, input) {
        this._keys = {output, input, sent: 0, received: 0};
    }

    async _read() {
        const input = this._connection.input_stream;
        while (!this.closed) {
            const bytes = await input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (bytes.get_size() === 0)
                throw new SpecError('The accessory closed the connection', 'closed');
            const chunk = bytes.toArray();
            if (!this._keys) {
                this._take(chunk);
                continue;
            }
            const [plain, rest] = openFrames(this._keys, concat(this._sealed, chunk));
            this._sealed = rest;
            if (plain.length > 0)
                this._take(plain);
        }
    }

    // Events (EVENT/1.0) are never asked for, so any that come are dropped.
    _take(data) {
        this._buffer = concat(this._buffer, data);
        for (;;) {
            const parsed = parseResponse(this._buffer);
            if (!parsed)
                return;
            const [message, rest] = parsed;
            this._buffer = rest;
            if (message.start.startsWith('EVENT/'))
                continue;
            const waiter = this._waiting;
            this._waiting = null;
            waiter?.resolve(message);
        }
    }

    _write(data) {
        if (this._keys)
            data = sealFrames(this._keys, data);
        const output = this._connection.output_stream;
        this._writing = this._writing.then(async () => {
            for (let at = 0; at < data.length;) {
                at += await output.write_bytes_async(new GLib.Bytes(data.subarray(at)), GLib.PRIORITY_DEFAULT,
                    this._cancellable);
            }
        }).catch(e => this._end(e));
    }

    request(method, path, type = null, body = null) {
        const turn = this._queue.then(() => new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new SpecError('The accessory closed the connection', 'closed'));
                return;
            }
            let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANSWER_TIMEOUT, () => {
                timer = 0;
                this._waiting = null;
                reject(new SpecError('The accessory did not answer', 'timeout'));
                this._end(new SpecError('The accessory did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            const settle = () => {
                if (timer)
                    GLib.source_remove(timer);
                timer = 0;
            };
            this._waiting = {
                resolve: answer => {
                    settle();
                    resolve(answer);
                },
                reject: error => {
                    settle();
                    reject(error);
                },
            };
            const lines = [`${method} ${path} HTTP/1.1`, `Host: ${this._host}`];
            if (type)
                lines.push(`Content-Type: ${type}`);
            lines.push(`Content-Length: ${body?.length ?? 0}`, '', '');
            this._write(concat(encoder.encode(lines.join('\r\n')), body ?? new Uint8Array(0)));
        }));
        this._queue = turn.catch(() => {});
        return turn;
    }

    // For PairSetup and pairVerify: each step's TLV is a POST body.
    exchange(path) {
        return async (_step, tlv) => {
            const answer = await this.request('POST', path, 'application/pairing+tlv8', tlv);
            if (answer.status !== 200)
                throw new SpecError(`The accessory answered ${answer.start}`, 'refused');
            return answer.body;
        };
    }

    _end(error) {
        if (this.closed)
            return;
        this.closed = true;
        this._cancellable.cancel();
        this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this._waiting?.reject(error instanceof SpecError ? error : new SpecError(error.message, 'closed'));
        this._waiting = null;
        this.onClose?.(error);
    }

    close() {
        this._end(new SpecError('Closed', 'closed'));
    }
}

// A plain Error is a seal that did not open: the answer was not made with the keys.
function pairingTrouble(e) {
    if (e?.constructor === Error)
        return new SpecError(e.message, 'broken');
    if (!(e instanceof HapError))
        return e;
    switch (e.code) {
    case 'pin':
        return new SpecError('The setup code is wrong', 'pin');
    case '3':
    case '5':
        return new SpecError('The accessory refuses pairing for a while after wrong codes. Wait, or restart it.', 'backoff');
    case '4':
        return new SpecError('The accessory has as many owners as it takes', 'full');
    case '6':
        return new SpecError('The accessory is paired with another home. Remove it from the Home app, or reset it, then pair again.', 'taken');
    case '7':
        return new SpecError('The accessory is busy pairing with something else', 'busy');
    case 'unpaired':
        return new SpecError('The accessory no longer knows Nook. Pair it again.', 'unpaired');
    default:
        return new SpecError(e.message, e.code);
    }
}

// "12345678" or "123-45-678" to the dashed form the SRP secret is made of; null if not a code.
export function setupCode(text) {
    const digits = String(text ?? '').replace(/\D/g, '');
    return digits.length === 8 ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` : null;
}

// Resolves with the credentials to keep: the accessory's id and key and ours.
export async function pair({ip, port, ff = 0}, code) {
    const connection = await HapConnection.open(ip, port);
    try {
        const setup = new PairSetup(connection.exchange('/pair-setup'), ff & 1 ? 1 : 0);
        await setup.begin();
        return await setup.finish(code, null);
    } catch (e) {
        throw pairingTrouble(e);
    } finally {
        connection.close();
    }
}

export class HapHost {
    // host: {ip, port}; credentials from pair().
    constructor(host, credentials) {
        this._host = host;
        this._credentials = credentials;
        this._connection = null;
        this._opening = null;
        this._closed = false;
    }

    _open() {
        this._opening ??= (async () => {
            const connection = await HapConnection.open(this._host.ip, this._host.port);
            try {
                const verified = await pairVerify(connection.exchange('/pair-verify'), this._credentials);
                connection.encrypt(verified.keys('Control-Salt', 'Control-Write-Encryption-Key'),
                    verified.keys('Control-Salt', 'Control-Read-Encryption-Key'));
            } catch (e) {
                connection.close();
                // An authentication error here means the accessory forgot this pairing.
                throw pairingTrouble(e instanceof HapError && e.code === 'pin' ? new HapError(e.message, 'unpaired') : e);
            }
            if (this._closed)
                connection.close();
            connection.onClose = () => {
                if (this._connection === connection) {
                    this._connection = null;
                    this._opening = null;
                }
            };
            this._connection = connection;
            return connection;
        })().catch(e => {
            this._opening = null;
            throw e;
        });
        return this._opening;
    }

    // An idle connection the accessory has dropped is reopened once.
    async _request(method, path, type = null, body = null) {
        const reused = Boolean(this._connection);
        const connection = await this._open();
        try {
            return await connection.request(method, path, type, body);
        } catch (e) {
            if (!reused || e.code !== 'closed' || this._closed)
                throw e;
            return (await this._open()).request(method, path, type, body);
        }
    }

    async _json(method, path, body = null) {
        const answer = await this._request(method, path, body ? 'application/hap+json' : null,
            body ? encoder.encode(JSON.stringify(body)) : null);
        if (![200, 204, 207].includes(answer.status))
            throw new SpecError(`The accessory answered ${answer.start}`, 'refused');
        if (answer.body.length === 0)
            return null;
        try {
            return JSON.parse(decoder.decode(answer.body));
        } catch {
            throw new SpecError('The accessory sent a broken answer', 'broken');
        }
    }

    async accessories() {
        const answer = await this._json('GET', '/accessories');
        if (!Array.isArray(answer?.accessories))
            throw new SpecError('The accessory sent no description of itself', 'broken');
        return answer.accessories;
    }

    // ids: [[aid, iid]...]; resolves with {aid, iid, value, status}.
    async read(ids) {
        if (ids.length === 0)
            return [];
        const answer = await this._json('GET', `/characteristics?id=${ids.map(([aid, iid]) => `${aid}.${iid}`).join(',')}`);
        return answer?.characteristics ?? [];
    }

    async write(list) {
        const answer = await this._json('PUT', '/characteristics', {characteristics: list});
        const failed = answer?.characteristics?.find(c => c.status && c.status !== 0);
        if (failed)
            throw new SpecError(failed.status === UNREACHABLE ? 'The accessory cannot be reached' : `The accessory refused it (${failed.status})`,
                failed.status === UNREACHABLE ? 'unreachable' : 'refused');
    }

    // Frees the accessory for another owner.
    async unpair() {
        const tlv = writeTlv([[TLV.state, Uint8Array.of(1)], [TLV.method, Uint8Array.of(REMOVE_PAIRING)],
            [TLV.identifier, fromHex(this._credentials.clientId)]]);
        const answer = await this._request('POST', '/pairings', 'application/pairing+tlv8', tlv);
        if (answer.status !== 200)
            throw new SpecError(`The accessory answered ${answer.start}`, 'refused');
        readTlv(answer.body);
    }

    close() {
        this._closed = true;
        this._connection?.close();
        this._connection = null;
    }
}

// Accessories announced on the network; unpaired ones (status flag 1) can be paired.
export async function discover(timeout = 3000, looking = null) {
    const services = looking ? await looking : await browse(timeout, ['_hap._tcp']);
    const found = new Map();
    for (const service of services) {
        const hap = hapOf(service.hap ?? (service.type === '_hap._tcp' ? service : null));
        if (hap && !found.has(hap.id))
            found.set(hap.id, {...hap, ip: service.ip});
    }
    return [...found.values()];
}

function hapOf(service) {
    const id = String(service?.txt?.id ?? '').toUpperCase();
    if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(id))
        return null;
    return {
        id,
        name: service.name,
        port: service.port,
        model: service.txt.md ?? null,
        category: Number(service.txt.ci) || null,
        config: Number(service.txt['c#']) || null,
        ff: Number(service.txt.ff) || 0,
        unpaired: (Number(service.txt.sf) & 1) === 1,
    };
}

// What homekit-accessories keeps of an accessory database: the services Nook shows and
// the characteristics it reads and writes, with their limits.
const SERVICES = {
    '43': 'light', '47': 'outlet', '49': 'switch', '40': 'fan', 'B7': 'fan2', '4A': 'thermostat',
    'BC': 'heater-cooler', 'BD': 'humidifier', 'BB': 'purifier', '8C': 'covering', '45': 'lock',
    '41': 'garage', '85': 'motion', '86': 'occupancy', '80': 'contact', '83': 'leak', '87': 'smoke',
    '7F': 'carbon-monoxide', '8A': 'temperature', '82': 'humidity', '84': 'light-level', '96': 'battery',
    '8D': 'air-quality',
};
const CHARACTERISTICS = ['25', '8', 'CE', '13', '2F', '11', '35', '33', '10', '22', '71', '6A', '70', '76', '69',
    '68', '6B', 'B0', '29', 'B6', '6D', '7C', '72', '6F', '1D', '1E', 'B2', '12', 'D', 'B4', 'CA', 'C9', 'A8', '95',
    'C6', '93', 'E'];

export function savedAccessories(accessories) {
    const kept = [];
    for (const accessory of accessories) {
        const services = [];
        const info = {};
        for (const service of accessory.services ?? []) {
            const type = shortType(service.type);
            if (type === '3E') {
                for (const c of service.characteristics ?? [])
                    info[shortType(c.type)] = c.value;
                continue;
            }
            const kind = SERVICES[type];
            if (!kind)
                continue;
            const chars = (service.characteristics ?? [])
                .filter(c => CHARACTERISTICS.includes(shortType(c.type)) && Number.isInteger(c.iid))
                .map(c => ({
                    iid: c.iid,
                    type: shortType(c.type),
                    perms: (c.perms ?? []).filter(p => ['pr', 'pw'].includes(p)),
                    ...(typeof c.minValue === 'number' ? {min: c.minValue} : {}),
                    ...(typeof c.maxValue === 'number' ? {max: c.maxValue} : {}),
                    ...(typeof c.minStep === 'number' ? {step: c.minStep} : {}),
                    ...(Array.isArray(c['valid-values']) ? {valid: c['valid-values']} : {}),
                }));
            if (chars.length > 0)
                services.push({iid: service.iid, kind, chars});
        }
        if (services.length > 0) {
            kept.push({
                aid: accessory.aid,
                name: typeof info['23'] === 'string' ? info['23'] : null,
                model: [info['20'], info['21']].filter(v => typeof v === 'string' && v).join(' ') || null,
                firmware: typeof info['52'] === 'string' ? info['52'] : null,
                services,
            });
        }
    }
    return kept;
}
