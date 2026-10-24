// SPDX-License-Identifier: GPL-2.0-or-later

// Android TV Remote protocol v2, the one the Google TV app speaks: TLS with a client
// certificate, pairing on 6467, the remote on 6466. Each message is protobuf with a
// varint length in front. Works on Google TV and Android TV sets and boxes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {TvError, wake} from './net.js';
import {concat, decode, encode, message, number, readVarint, text, varint} from './protobuf.js';
import {sleep} from './timers.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const REMOTE_PORT = 6466;
const PAIRING_PORT = 6467;

// Android KeyEvent codes.
const KEYS = {
    'power': 26,
    'up': 19,
    'down': 20,
    'left': 21,
    'right': 22,
    'ok': 23,
    'back': 4,
    'home': 3,
    'menu': 82,
    'play': 126,
    'pause': 127,
    'volume-up': 24,
    'volume-down': 25,
    'mute': 164,
    'channel-up': 166,
    'channel-down': 167,
    'input': 178,
};

const SHORT_PRESS = 3;

// Ping, keys, IME (it carries the app in front), power, volume, app links.
const FEATURES = 1 | 2 | 4 | 32 | 64 | 512;

// Package, title, deep link. There is no call to list installed apps; launching by
// package (market://launch?id=) fails on many devices since a Play Store change.
const APPS = [
    ['com.google.android.youtube.tv', 'YouTube', 'https://www.youtube.com'],
    ['com.netflix.ninja', 'Netflix', 'netflix://'],
    ['com.amazon.amazonvideo.livingroom', 'Prime Video', 'https://app.primevideo.com'],
    ['com.disney.disneyplus', 'Disney+', 'https://www.disneyplus.com'],
    ['com.plexapp.android', 'Plex', 'plex://'],
    ['tv.twitch.android.app', 'Twitch', 'twitch://home'],
];

const HOME = new Set([
    'com.google.android.tvlauncher',
    'com.google.android.apps.tv.launcherx',
    'com.google.android.leanbacklauncher',
]);

function sha256(data) {
    const hex = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(data));
    return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}

function element(der, at) {
    let length = der[at + 1];
    let start = at + 2;
    if (length & 0x80) {
        const count = length & 0x7f;
        length = 0;
        for (let i = 0; i < count; i++)
            length = length * 256 + der[start + i];
        start += count;
    }
    return {tag: der[at], start, end: start + length};
}

function elements(der, {start, end}) {
    const out = [];
    for (let at = start; at < end; at = out.at(-1).end)
        out.push(element(der, at));
    return out;
}

// Modulus and exponent of an X.509 certificate's RSA key, big-endian without the sign byte.
function rsaKey(der) {
    let fields = elements(der, elements(der, element(der, 0))[0]);
    if (fields[0].tag === 0xa0)
        fields = fields.slice(1);
    const bits = elements(der, fields[5])[1];
    const [n, e] = elements(der, element(der, bits.start + 1)).map(({start, end}) => {
        const value = der.subarray(start, end);
        return value[0] === 0 && value.length > 1 ? value.subarray(1) : value;
    });
    return {n, e};
}

async function makeCertificate(name) {
    let process;
    try {
        process = Gio.Subprocess.new(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
            '-keyout', '-', '-out', '-', '-days', '3650', '-subj', `/CN=${name.replace(/[/=\\]/g, ' ')}`],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        throw new TvError(`openssl: ${e.message}`, 'openssl');
    }
    const [pem, errors] = await process.communicate_utf8_async(null, null);
    if (!process.get_successful() || !pem.includes('PRIVATE KEY'))
        throw new TvError(`openssl: ${errors.trim()}`, 'openssl');
    return pem;
}

// One TLS connection carrying length-prefixed messages; next() waits for a matching one.
class Link {
    static async open(host, port, pem) {
        const certificate = Gio.TlsCertificate.new_from_pem(pem, -1);
        const client = new Gio.SocketClient({tls: true, timeout: 4});
        // Gio.SocketClient.connect() is a method, so the GObject one is called directly.
        GObject.Object.prototype.connect.call(client, 'event', (_client, event, _address, connection) => {
            if (event !== Gio.SocketClientEvent.TLS_HANDSHAKING)
                return;
            connection.set_certificate(certificate);
            // Self-signed: nothing to check it against on a LAN.
            connection.connect('accept-certificate', () => true);
        });
        const cancellable = new Gio.Cancellable();
        const connection = await client.connect_async(Gio.NetworkAddress.new(host, port), cancellable);
        // The timeout is for connecting: idle, the TV only pings every 5 seconds.
        connection.get_socket().set_timeout(0);
        return new Link(connection, cancellable);
    }

    constructor(connection, cancellable) {
        this._connection = connection;
        this._cancellable = cancellable;
        this.peerCertificate = connection.base_io_stream.get_peer_certificate().certificate;
        this._buffer = new Uint8Array(0);
        this._waiting = [];
        this._writing = Promise.resolve();
        this.closed = false;
        this.onMessage = null;
        this._read().catch(e => this._end(e));
    }

    async _read() {
        const input = this._connection.input_stream;
        while (!this.closed) {
            const bytes = await input.read_bytes_async(16384, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (bytes.get_size() === 0)
                throw new TvError('The TV closed the connection', 'closed');
            this._buffer = concat([this._buffer, bytes.toArray()]);
            for (;;) {
                const length = readVarint(this._buffer, 0);
                if (!length || this._buffer.length < length[1] + length[0])
                    break;
                const fields = decode(this._buffer.subarray(length[1], length[1] + length[0]));
                this._buffer = this._buffer.slice(length[1] + length[0]);
                this._dispatch(fields);
            }
        }
    }

    _dispatch(fields) {
        this.onMessage?.(fields);
        const i = this._waiting.findIndex(w => w.test(fields));
        if (i < 0)
            return;
        const [waiter] = this._waiting.splice(i, 1);
        GLib.source_remove(waiter.timer);
        waiter.resolve(fields);
    }

    _end(error) {
        if (this.closed)
            return;
        this.closed = true;
        this._cancellable.cancel();
        // With TLS 1.3 a refused client certificate only shows on the first read.
        const tls = error instanceof GLib.Error && error.domain === Gio.tls_error_quark();
        const reason = error instanceof TvError ? error : new TvError(error.message ?? 'Closed', tls ? 'tls' : 'closed');
        for (const waiter of this._waiting.splice(0)) {
            GLib.source_remove(waiter.timer);
            waiter.reject(reason);
        }
        this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    send(fields) {
        if (this.closed)
            throw new TvError('The TV closed the connection', 'closed');
        const body = encode(fields);
        const data = concat([Uint8Array.from(varint(body.length)), body]);
        const output = this._connection.output_stream;
        this._writing = this._writing.then(async () => {
            for (let at = 0; at < data.length;) {
                at += await output.write_bytes_async(new GLib.Bytes(data.subarray(at)), GLib.PRIORITY_DEFAULT,
                    this._cancellable);
            }
        }).catch(e => this._end(e));
    }

    next(test, timeout) {
        if (this.closed)
            return Promise.reject(new TvError('The TV closed the connection', 'closed'));
        return new Promise((resolve, reject) => {
            const waiter = {test, resolve, reject};
            waiter.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._waiting.splice(this._waiting.indexOf(waiter), 1);
                reject(new TvError('The TV did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._waiting.push(waiter);
        });
    }

    close() {
        this._end(new TvError('Closed', 'closed'));
    }
}

const pairingMessage = fields => [[1, 2], [2, 200], ...fields];
const HEX_CODE = [[1, 3], [2, 6]];

export default class AndroidTv {
    static pairing = 'pin';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._pem = secret?.pem ?? null;
        this._link = null;
        this._linking = null;
        this._pairing = null;
        this._closed = false;
        this.refused = false;
        this.onSecret = null;
        this.onUpdate = null;
    }

    get paired() {
        return this._pem !== null;
    }

    _connect() {
        if (this._link && !this._link.closed)
            return Promise.resolve(this._link);
        if (!this._pem)
            return Promise.reject(new TvError('The TV is not paired yet', 'unpaired'));
        this._linking ??= this._open().finally(() => {
            this._linking = null;
        });
        return this._linking;
    }

    async _open() {
        try {
            return await this._handshake();
        } catch (e) {
            // A TLS refusal means the TV no longer knows this certificate (reset, unpaired).
            if (e.code === 'tls' || (e instanceof GLib.Error && e.domain === Gio.tls_error_quark())) {
                this.refused = true;
                this._pem = null;
                throw new TvError('The TV no longer knows Nook', 'unpaired');
            }
            throw e;
        }
    }

    // The TV speaks first: configure, set_active, then remote_start with the power state,
    // followed by the app in front and the volume.
    async _handshake() {
        const link = await Link.open(this._tv.ip, REMOTE_PORT, this._pem);
        if (this._closed) {
            link.close();
            throw new TvError('Closed', 'closed');
        }
        const state = {started: null, app: null, label: '', volume: null, max: 0, muted: null};
        let features = FEATURES;
        link.onMessage = fields => {
            if (fields.has(1)) {
                features = FEATURES & number(message(fields, 1), 1);
                link.send([[1, [[1, features], [2, [[3, 1], [4, '1'], [5, 'atvremote'], [6, '1.0.0']]]]]]);
            } else if (fields.has(2)) {
                link.send([[2, [[1, features]]]]);
            } else if (fields.has(8)) {
                link.send([[9, [[1, number(message(fields, 8), 1)]]]]);
            } else if (fields.has(40)) {
                state.started = number(message(fields, 40), 1) === 1;
            } else if (fields.has(20)) {
                const app = message(message(fields, 20), 1);
                state.app = text(app, 12) || null;
                state.label = text(app, 10);
            } else if (fields.has(50)) {
                const volume = message(fields, 50);
                state.max = number(volume, 6);
                state.volume = number(volume, 7);
                state.muted = number(volume, 8) === 1;
            } else {
                return;
            }
            if (this._link === link && link.ready)
                this.onUpdate?.();
        };
        try {
            await link.next(fields => fields.has(40), 5000);
        } catch (e) {
            link.close();
            throw e;
        }
        // The app and the volume come right behind remote_start, when the TV reports them.
        for (const field of [20, 50]) {
            if (!link.closed && (field === 20 ? state.app : state.volume) === null)
                await link.next(fields => fields.has(field), 600).catch(() => {});
        }
        link.state = state;
        link.ready = true;
        this._link = link;
        return link;
    }

    async status() {
        const off = {on: false, volume: null, muted: null, source: null, app: null};
        if (!this._pem)
            return off;
        let link;
        try {
            link = await this._connect();
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error)
                return off;
            throw e;
        }
        const {started, app, label, volume, max, muted} = link.state;
        if (!started)
            return off;
        const shown = app && !HOME.has(app) ? app : null;
        return {
            on: true,
            volume,
            volumeMax: max || null,
            muted,
            source: null,
            app: shown,
            title: shown ? label || APPS.find(([id]) => id === shown)?.[1] || null : null,
        };
    }

    async press(key) {
        const code = KEYS[key];
        if (!code)
            throw new TvError(`No such key: ${key}`);
        (await this._connect()).send([[10, [[1, code], [2, SHORT_PRESS]]]]);
    }

    // The power key toggles; press it only when the TV says it is the other way.
    async power(on) {
        if (on)
            await wake(this._tv.mac);
        for (let ask = 0; ; ask++) {
            const now = await this.status();
            if (now.on === on)
                return;
            if (this._link && !this._link.closed)
                break;
            // Off and asleep: give Wake-on-LAN time to bring the network up.
            if (!on || ask === 4)
                throw new TvError('The TV is not answering', 'timeout');
            await sleep(1500);
        }
        await this.press('power');
    }

    sources() {
        return [];
    }

    apps() {
        return APPS.map(([id, title]) => ({id, title}));
    }

    async launch(id) {
        const link = APPS.find(([app]) => app === id)?.[2] ?? `market://launch?id=${id}`;
        (await this._connect()).send([[90, [[1, link]]]]);
    }

    // The TV shows a 6-digit hex code once it has the configuration.
    async pairBegin(name) {
        const pem = await makeCertificate(name);
        const link = await Link.open(this._tv.ip, PAIRING_PORT, pem);
        this._pairing = {link, pem};
        const ask = async (fields, answer) => {
            link.send(pairingMessage(fields));
            const reply = await link.next(() => true, 10000);
            if (number(reply, 2) !== 200 || !reply.has(answer))
                throw new TvError(`The TV answered status ${number(reply, 2)}`, 'denied');
        };
        await ask([[10, [[1, 'atvremote'], [2, name]]]], 11);
        await ask([[20, [[1, HEX_CODE], [3, 1]]]], 20);
        await ask([[30, [[1, HEX_CODE], [2, 1]]]], 31);
        return {done: false};
    }

    // The secret hashes both RSA keys with the code's last four digits; its first two are
    // the hash's first byte, so a mistyped code is caught before the TV sees it.
    async pairEnd(code) {
        const {link, pem} = this._pairing;
        const hex = code.replace(/\s+/g, '').toLowerCase();
        if (!/^[0-9a-f]{6}$/.test(hex))
            throw new TvError('Not a code the TV shows', '600');
        const client = rsaKey(Gio.TlsCertificate.new_from_pem(pem, -1).certificate);
        const server = rsaKey(link.peerCertificate);
        const nonce = Uint8Array.from(hex.slice(2).match(/../g), byte => parseInt(byte, 16));
        const secret = sha256(concat([client.n, client.e, server.n, server.e, nonce]));
        if (secret[0] !== parseInt(hex.slice(0, 2), 16))
            throw new TvError('The TV did not take the code', '600');
        link.send(pairingMessage([[40, [[1, secret]]]]));
        const reply = await link.next(() => true, 10000);
        if (number(reply, 2) !== 200 || !reply.has(41))
            throw new TvError('The TV did not take the code', '600');
        link.close();
        this._pairing = null;
        this._pem = pem;
        return {pem};
    }

    close() {
        this._closed = true;
        this._link?.close();
        this._link = null;
        this._pairing?.link.close();
        this._pairing = null;
    }
}
