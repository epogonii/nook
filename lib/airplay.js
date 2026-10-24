// SPDX-License-Identifier: GPL-2.0-or-later

// The remote control channel AirPlay 2 opens on an Apple TV (tvOS 13 and later): HAP
// pairing and RTSP on port 7000, then MRP protobuf over an encrypted data stream. It is
// what tells which app plays what. Paired apart from Companion, with a PIN of its own.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {TvError} from './net.js';
import {decode as fromPlist, encode as toPlist} from './bplist.js';
import {open, seal} from './chacha.js';
import {PairSetup, concat, pairVerify, randomBytes, toHex} from './hap.js';
import {decode, encode, message, number, readVarint, text, varint} from './protobuf.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const PORT = 7000;
const FEEDBACK_EVERY = 2000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PAIRING_HEADERS = {
    'User-Agent': 'AirPlay/320.20',
    'Connection': 'keep-alive',
    'X-Apple-HKP': '3',
    'Content-Type': 'application/octet-stream',
};

// MRP ProtocolMessage types and the extension field each one's body sits in.
const MRP = {
    setState: [4, 9],
    deviceInfo: [15, 20],
    updatesConfig: [16, 21],
    connectionState: [38, 42],
    nowPlayingClient: [46, 50],
    removeClient: [53, 57],
    updateClient: [55, 59],
};
const PLAYING = 1;

const uuid = () => GLib.uuid_string_random().toUpperCase();

// 4 zero bytes, then an 8-byte little-endian counter.
function counterNonce(count) {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, BigInt(count), true);
    return nonce;
}

function indexOf(bytes, pattern) {
    outer: for (let i = 0; i + pattern.length <= bytes.length; i++) {
        for (let j = 0; j < pattern.length; j++) {
            if (bytes[i + j] !== pattern[j])
                continue outer;
        }
        return i;
    }
    return -1;
}

const BLANK_LINE = encoder.encode('\r\n\r\n');

// One HTTP or RTSP message off the front: [{start, headers, body}, rest], or null.
function parseMessage(buffer) {
    const end = indexOf(buffer, BLANK_LINE);
    if (end < 0)
        return null;
    const lines = decoder.decode(buffer.subarray(0, end)).split('\r\n');
    const headers = {};
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0)
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const length = parseInt(headers['content-length'] ?? '0') || 0;
    if (buffer.length < end + 4 + length)
        return null;
    return [{start: lines[0], headers, body: buffer.slice(end + 4, end + 4 + length)}, buffer.slice(end + 4 + length)];
}

function formatMessage(start, headers, body) {
    const lines = [start, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        `Content-Length: ${body?.length ?? 0}`, '', ''];
    return concat(encoder.encode(lines.join('\r\n')), body ?? new Uint8Array(0));
}

// A TCP connection; once keys are set, HAP framing: blocks of up to 1024 bytes, each a
// 2-byte little-endian length (also the associated data), then the sealed block.
class Socket {
    static async open(host, port) {
        const client = new Gio.SocketClient({timeout: 4});
        const cancellable = new Gio.Cancellable();
        const connection = await client.connect_async(Gio.NetworkAddress.new(host, port), cancellable);
        connection.get_socket().set_timeout(0);
        return new Socket(connection, cancellable);
    }

    constructor(connection, cancellable) {
        this._connection = connection;
        this._cancellable = cancellable;
        this._keys = null;
        this._sealed = new Uint8Array(0);
        this._writing = Promise.resolve();
        this.closed = false;
        this.onData = null;
        this.onClose = null;
        this._read().catch(e => this._end(e));
    }

    get localAddress() {
        return this._connection.get_local_address().get_address().to_string();
    }

    encrypt(output, input) {
        this._keys = {output, input, sent: 0, received: 0};
    }

    async _read() {
        const input = this._connection.input_stream;
        while (!this.closed) {
            const bytes = await input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (bytes.get_size() === 0)
                throw new TvError('The Apple TV closed the connection', 'closed');
            const chunk = bytes.toArray();
            if (!this._keys) {
                this.onData?.(chunk);
                continue;
            }
            this._sealed = concat(this._sealed, chunk);
            const plain = [];
            while (this._sealed.length >= 2) {
                const length = this._sealed[0] | (this._sealed[1] << 8);
                if (this._sealed.length < 2 + length + 16)
                    break;
                plain.push(open(this._keys.input, counterNonce(this._keys.received++),
                    this._sealed.subarray(2, 2 + length + 16), this._sealed.subarray(0, 2)));
                this._sealed = this._sealed.slice(2 + length + 16);
            }
            if (plain.length > 0)
                this.onData?.(concat(...plain));
        }
    }

    write(data) {
        if (this.closed)
            throw new TvError('The Apple TV closed the connection', 'closed');
        if (this._keys) {
            const blocks = [];
            for (let at = 0; at < data.length; at += 1024) {
                const block = data.subarray(at, at + 1024);
                const header = Uint8Array.of(block.length & 0xff, block.length >> 8);
                blocks.push(header, seal(this._keys.output, counterNonce(this._keys.sent++), block, header));
            }
            data = concat(...blocks);
        }
        const output = this._connection.output_stream;
        this._writing = this._writing.then(async () => {
            for (let at = 0; at < data.length;) {
                at += await output.write_bytes_async(new GLib.Bytes(data.subarray(at)), GLib.PRIORITY_DEFAULT,
                    this._cancellable);
            }
        }).catch(e => this._end(e));
    }

    _end(error) {
        if (this.closed)
            return;
        this.closed = true;
        this._cancellable.cancel();
        this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this.onClose?.(error);
    }

    close() {
        this._end(new TvError('Closed', 'closed'));
    }
}

// Requests answered in order, one at a time.
class Control {
    static async open(host) {
        return new Control(await Socket.open(host, PORT));
    }

    constructor(socket) {
        this.socket = socket;
        this._buffer = new Uint8Array(0);
        this._waiting = null;
        this._queue = Promise.resolve();
        socket.onData = data => {
            this._buffer = concat(this._buffer, data);
            const parsed = parseMessage(this._buffer);
            if (!parsed)
                return;
            [, this._buffer] = parsed;
            const waiter = this._waiting;
            this._waiting = null;
            waiter?.resolve(parsed[0]);
        };
        socket.onClose = error => this._waiting?.reject(error instanceof TvError ? error : new TvError(error.message, 'closed'));
    }

    request(method, uri, protocol, headers, body = null) {
        const turn = this._queue.then(() => new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
                this._waiting = null;
                reject(new TvError(`${method} ${uri}: no answer`, 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._waiting = {
                resolve: answer => {
                    GLib.source_remove(timer);
                    const status = parseInt(answer.start.split(' ')[1]);
                    if (status !== 200)
                        reject(new TvError(`${method} ${uri}: ${answer.start}`, String(status)));
                    else
                        resolve(answer);
                },
                reject: error => {
                    GLib.source_remove(timer);
                    reject(error);
                },
            };
            this.socket.write(formatMessage(`${method} ${uri} ${protocol}`, headers, body));
        }));
        this._queue = turn.catch(() => {});
        return turn;
    }

    // The TLV of each pairing step is a POST body.
    exchange(path) {
        return async (step, tlv) => (await this.request('POST', path, 'HTTP/1.1', PAIRING_HEADERS, tlv)).body;
    }

    close() {
        this.socket.close();
    }
}

/** AirPlay pair-setup: the Apple TV shows a PIN once begin() resolves. */
export class AirPlayPairing {
    static async begin(host) {
        const control = await Control.open(host);
        try {
            await control.request('POST', '/pair-pin-start', 'HTTP/1.1', PAIRING_HEADERS);
            const setup = new PairSetup(control.exchange('/pair-setup'));
            await setup.begin();
            return new AirPlayPairing(control, setup);
        } catch (e) {
            control.close();
            throw e;
        }
    }

    constructor(control, setup) {
        this._control = control;
        this._setup = setup;
    }

    async finish(pin, name) {
        try {
            return await this._setup.finish(pin, name);
        } finally {
            this._control.close();
        }
    }

    close() {
        this._control.close();
    }
}

// Data stream frames: a 32-byte header (total size, "sync" or "rply" padded to 12 bytes,
// a 4-byte command, a sequence number, padding), then a plist of {params: {data}}.
function dataFrame(kind, command, sequence, payload) {
    const header = new Uint8Array(32);
    const view = new DataView(header.buffer);
    view.setUint32(0, 32 + payload.length);
    header.set(encoder.encode(kind), 4);
    header.set(encoder.encode(command), 16);
    view.setBigUint64(20, BigInt(sequence));
    return concat(header, payload);
}

export class AirPlayRemote {
    constructor(host, credentials, name = 'Nook') {
        this._host = host;
        this._credentials = credentials;
        this._name = name;
        this._sockets = [];
        this._timer = 0;
        this._waiting = new Map();
        this._players = new Map();
        this._names = new Map();
        this._active = null;
        this._sequence = GLib.random_int_range(1, 0x7fffffff);
        this.closed = false;
        this.onChange = null;
        this.onClose = null;
    }

    // The app in front of the media: its bundle id and name, and the title it plays.
    get state() {
        const app = this._active ?? [...this._players.entries()].find(([, p]) => p.playing)?.[0] ?? null;
        if (!app)
            return {app: null, name: null, title: null};
        const player = this._players.get(app);
        return {app, name: this._names.get(app) ?? player?.name ?? null, title: player?.title ?? null};
    }

    _keys(salt, info) {
        return this._verified.keys(salt, info);
    }

    async start() {
        const control = await Control.open(this._host);
        this._control = control;
        this._sockets.push(control.socket);
        control.socket.onClose = this._closed(control.socket.onClose);
        this._verified = await pairVerify(control.exchange('/pair-verify'), this._credentials);
        control.socket.encrypt(this._keys('Control-Salt', 'Control-Write-Encryption-Key'),
            this._keys('Control-Salt', 'Control-Read-Encryption-Key'));

        const id = this._credentials.clientId;
        const mac = id.slice(0, 12).replace(/(..)(?!$)/g, '$1:').toUpperCase();
        let sequence = 0;
        const uri = `rtsp://${control.socket.localAddress}/${GLib.random_int_range(1, 0x7fffffff)}`;
        const dacp = toHex(await randomBytes(8)).toUpperCase();
        const remote = String(GLib.random_int_range(1, 0x7fffffff));
        const ask = (method, path, body = null) => control.request(method, path, 'RTSP/1.0', {
            'CSeq': String(++sequence),
            'DACP-ID': dacp,
            'Active-Remote': remote,
            'User-Agent': 'AirPlay/550.10',
            ...(body ? {'Content-Type': 'application/x-apple-binary-plist'} : {}),
        }, body);

        const events = fromPlist((await ask('SETUP', uri, toPlist({
            isRemoteControlOnly: true,
            osName: 'iPhone OS',
            sourceVersion: '550.10',
            timingProtocol: 'None',
            model: 'iPhone10,6',
            deviceID: mac,
            osVersion: '14.7.1',
            osBuildVersion: '18G82',
            macAddress: mac,
            sessionUUID: uuid(),
            name: this._name,
        }))).body);
        await this._openEvents(events.eventPort);
        await ask('RECORD', uri);
        // Below 2^53: plists here carry it as a plain number.
        const seed = GLib.random_int_range(1, 0x7fffffff) * 0x100000 + GLib.random_int_range(0, 0x100000);
        const stream = fromPlist((await ask('SETUP', uri, toPlist({
            streams: [{
                controlType: 2,
                channelID: uuid(),
                seed,
                clientUUID: uuid(),
                type: 130,
                wantsDedicatedSocket: true,
                clientTypeUUID: '1910A70F-DBC0-4242-AF95-115DB30604E1',
            }],
        }))).body);
        await this._openData(stream.streams[0].dataPort, seed);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FEEDBACK_EVERY, () => {
            ask('POST', '/feedback').catch(e => this.close(e));
            return GLib.SOURCE_CONTINUE;
        });

        await this._mrp(MRP.deviceInfo, [
            [1, decoder.decode(Uint8Array.from(id.match(/../g), b => parseInt(b, 16)))],
            [2, this._name],
            [3, 'iPhone'],
            [4, '18G82'],
            [5, 'com.apple.TVRemote'],
            [6, '344.28'],
            [7, 1],
            [8, 108],
            [9, true],
            [10, true],
            [12, 'com.apple.TVMusic'],
            [13, true],
            [14, true],
            [15, true],
            [17, 2],
            [21, 1],
            [22, 1],
        ], true);
        this._mrp(MRP.connectionState, [[1, 2]]);
        await this._mrp(MRP.updatesConfig, [[1, true], [2, false], [3, true], [4, true], [5, true]], true);
    }

    _closed(previous) {
        return error => {
            previous?.(error);
            this.close(error);
        };
    }

    // The Apple TV sends requests here; each only wants a 200.
    async _openEvents(port) {
        const socket = await Socket.open(this._host, port);
        this._sockets.push(socket);
        socket.encrypt(this._keys('Events-Salt', 'Events-Read-Encryption-Key'),
            this._keys('Events-Salt', 'Events-Write-Encryption-Key'));
        let buffer = new Uint8Array(0);
        socket.onData = data => {
            buffer = concat(buffer, data);
            for (let parsed; (parsed = parseMessage(buffer));) {
                [, buffer] = parsed;
                const [, , protocol = 'RTSP/1.0'] = parsed[0].start.split(' ');
                const headers = {'Audio-Latency': '0'};
                for (const name of ['server', 'cseq']) {
                    if (parsed[0].headers[name])
                        headers[name === 'cseq' ? 'CSeq' : 'Server'] = parsed[0].headers[name];
                }
                socket.write(formatMessage(`${protocol} 200 OK`, headers, null));
            }
        };
        socket.onClose = error => this.close(error);
    }

    async _openData(port, seed) {
        const socket = await Socket.open(this._host, port);
        this._sockets.push(socket);
        this._data = socket;
        socket.encrypt(this._keys(`DataStream-Salt${seed}`, 'DataStream-Output-Encryption-Key'),
            this._keys(`DataStream-Salt${seed}`, 'DataStream-Input-Encryption-Key'));
        let buffer = new Uint8Array(0);
        socket.onData = data => {
            buffer = concat(buffer, data);
            while (buffer.length >= 32) {
                const view = new DataView(buffer.buffer, buffer.byteOffset, 32);
                const size = view.getUint32(0);
                if (size < 32 || buffer.length < size)
                    break;
                const kind = decoder.decode(buffer.subarray(4, 8));
                const sequence = view.getBigUint64(20);
                const payload = buffer.slice(32, size);
                buffer = buffer.slice(size);
                if (kind === 'sync')
                    socket.write(dataFrame('rply', '\0\0\0\0', sequence, new Uint8Array(0)));
                if (payload.length > 0)
                    this._payload(payload);
            }
        };
        socket.onClose = error => this.close(error);
    }

    _payload(payload) {
        let data;
        try {
            data = fromPlist(payload)?.params?.data;
        } catch (e) {
            console.debug(`nook: apple tv: data stream: ${e.message}`);
            return;
        }
        if (!(data instanceof Uint8Array))
            return;
        // Length-prefixed messages, or one bare message.
        while (data.length > 0) {
            let body = data;
            if (data[0] !== 0x08) {
                const length = readVarint(data, 0);
                if (!length || data.length < length[1] + length[0])
                    return;
                body = data.subarray(length[1], length[1] + length[0]);
                data = data.subarray(length[1] + length[0]);
            } else {
                data = new Uint8Array(0);
            }
            try {
                this._message(decode(body));
            } catch (e) {
                console.debug(`nook: apple tv: mrp: ${e.message}`);
            }
        }
    }

    _mrp([type, field], fields, wait = false) {
        const identifier = uuid();
        const body = encode([[1, type], [2, identifier], [4, 0], [85, uuid()], [field, fields]]);
        const data = concat(Uint8Array.from(varint(body.length)), body);
        this._data.write(dataFrame('sync', 'comm', this._sequence++, toPlist({params: {data}})));
        if (!wait)
            return Promise.resolve(null);
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                this._waiting.delete(identifier);
                reject(new TvError('The Apple TV did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._waiting.set(identifier, {resolve, reject, timer});
        });
    }

    _message(fields) {
        const waiter = this._waiting.get(text(fields, 2));
        if (waiter) {
            this._waiting.delete(text(fields, 2));
            GLib.source_remove(waiter.timer);
            waiter.resolve(fields);
        }
        const type = number(fields, 1);
        const client = (inner, at) => {
            const found = message(inner, at);
            return {app: text(found, 2) || null, name: text(found, 7) || null};
        };
        if (type === MRP.setState[0]) {
            const state = message(fields, MRP.setState[1]);
            const {app, name} = client(message(state, 9), 2);
            if (!app)
                return;
            const queue = message(state, 3);
            const items = queue.get(2) ?? [];
            const item = items[number(queue, 1)] ?? items[0];
            const old = this._players.get(app) ?? {};
            this._players.set(app, {
                name: name || text(state, 5) || old.name || null,
                title: text(message(state, 1), 9) || (item ? text(message(decode(item), 2), 1) : '') || old.title || null,
                playing: state.has(6) ? number(state, 6) === PLAYING : old.playing ?? false,
            });
        } else if (type === MRP.nowPlayingClient[0]) {
            const {app, name} = client(message(fields, MRP.nowPlayingClient[1]), 1);
            this._active = app;
            if (app && name)
                this._names.set(app, name);
        } else if (type === MRP.updateClient[0]) {
            const {app, name} = client(message(fields, MRP.updateClient[1]), 1);
            if (app && name)
                this._names.set(app, name);
        } else if (type === MRP.removeClient[0]) {
            const {app} = client(message(fields, MRP.removeClient[1]), 1);
            this._players.delete(app);
            if (this._active === app)
                this._active = null;
        } else {
            return;
        }
        this.onChange?.();
    }

    close(error = null) {
        if (this.closed)
            return;
        this.closed = true;
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        for (const socket of this._sockets)
            socket.close();
        for (const {reject, timer} of this._waiting.values()) {
            GLib.source_remove(timer);
            reject(new TvError('Closed', 'closed'));
        }
        this._waiting.clear();
        this.onClose?.(error);
    }
}

