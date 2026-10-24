// SPDX-License-Identifier: GPL-2.0-or-later

// Apple TV over the Companion protocol, the one the iPhone's remote uses: HAP pairing,
// then frames sealed with ChaCha20-Poly1305 that carry OPACK requests and events.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {TvError} from './net.js';
import {AirPlayPairing, AirPlayRemote} from './airplay.js';
import {browse} from './finder.js';
import {open, seal} from './chacha.js';
import {HapError, PairSetup, fromHex, pairVerify, toHex} from './hap.js';
import {pack, unpack} from './opack.js';
import {sleep} from './timers.js';

Gio._promisify(Gio.SocketClient.prototype, 'connect_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');

const FRAME = {setupStart: 3, setupNext: 4, verifyStart: 5, verifyNext: 6, opack: 8};
const REQUEST = 2, RESPONSE = 3, EVENT = 1;

// HID buttons; there is no mute, no inputs and no menu key on an Apple TV remote.
const BUTTONS = {
    'up': 1,
    'down': 2,
    'left': 3,
    'right': 4,
    'back': 5,
    'menu': 5,
    'ok': 6,
    'home': 7,
    'volume-up': 8,
    'volume-down': 9,
    'channel-up': 15,
    'channel-down': 16,
};
const SLEEP = 12, WAKE = 13;
const MEDIA = {play: 1, pause: 2, getVolume: 5, setVolume: 6};
const VOLUME_CONTROL = 0x100;
const ASLEEP = 1;

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

// 12-byte little-endian counter.
function counterNonce(count) {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(0, BigInt(count), true);
    return nonce;
}

// Frames: type byte, 3-byte big-endian length, payload. Once verified, the payload is
// sealed with the header as associated data.
class Link {
    static async open(host, port) {
        const client = new Gio.SocketClient({timeout: 4});
        const cancellable = new Gio.Cancellable();
        const connection = await client.connect_async(Gio.NetworkAddress.new(host, port), cancellable);
        // Only connecting times out; events can be minutes apart.
        connection.get_socket().set_timeout(0);
        return new Link(connection, cancellable);
    }

    constructor(connection, cancellable) {
        this._connection = connection;
        this._cancellable = cancellable;
        this._buffer = new Uint8Array(0);
        this._waiting = [];
        this._writing = Promise.resolve();
        this._keys = null;
        this._sent = 0;
        this._received = 0;
        this.closed = false;
        this.onFrame = null;
        this._read().catch(e => this._end(e));
    }

    encrypt(output, input) {
        this._keys = {output, input};
    }

    async _read() {
        const input = this._connection.input_stream;
        while (!this.closed) {
            const bytes = await input.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (bytes.get_size() === 0)
                throw new TvError('The Apple TV closed the connection', 'closed');
            this._buffer = concat(this._buffer, bytes.toArray());
            while (this._buffer.length >= 4) {
                const length = (this._buffer[1] << 16) | (this._buffer[2] << 8) | this._buffer[3];
                if (this._buffer.length < 4 + length)
                    break;
                const header = this._buffer.slice(0, 4);
                let payload = this._buffer.slice(4, 4 + length);
                this._buffer = this._buffer.slice(4 + length);
                if (this._keys && payload.length > 0)
                    payload = open(this._keys.input, counterNonce(this._received++), payload, header);
                let data = null;
                if (header[0] >= FRAME.setupStart && header[0] <= 9 && payload.length > 0) {
                    try {
                        data = unpack(payload);
                    } catch (e) {
                        console.debug(`nook: apple tv: frame ${header[0]}: ${e.message}`);
                    }
                }
                this._dispatch({type: header[0], data});
            }
        }
    }

    _dispatch(frame) {
        this.onFrame?.(frame);
        const i = this._waiting.findIndex(w => w.test(frame));
        if (i < 0)
            return;
        const [waiter] = this._waiting.splice(i, 1);
        GLib.source_remove(waiter.timer);
        waiter.resolve(frame);
    }

    _end(error) {
        if (this.closed)
            return;
        this.closed = true;
        this._cancellable.cancel();
        const reason = error instanceof TvError ? error : new TvError(error.message ?? 'Closed', 'closed');
        for (const waiter of this._waiting.splice(0)) {
            GLib.source_remove(waiter.timer);
            waiter.reject(reason);
        }
        this._connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
    }

    send(type, value) {
        if (this.closed)
            throw new TvError('The Apple TV closed the connection', 'closed');
        let payload = pack(value);
        const length = payload.length + (this._keys ? 16 : 0);
        const header = Uint8Array.of(type, length >> 16, (length >> 8) & 0xff, length & 0xff);
        if (this._keys)
            payload = seal(this._keys.output, counterNonce(this._sent++), payload, header);
        const data = concat(header, payload);
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
            return Promise.reject(new TvError('The Apple TV closed the connection', 'closed'));
        return new Promise((resolve, reject) => {
            const waiter = {test, resolve, reject};
            waiter.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                this._waiting.splice(this._waiting.indexOf(waiter), 1);
                reject(new TvError('The Apple TV did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._waiting.push(waiter);
        });
    }

    close() {
        this._end(new TvError('Closed', 'closed'));
    }
}

// The TLV of each pairing step travels as _pd in an OPACK frame. Pair-setup marks every
// message with _pwTy; pair-verify only its first with _auTy.
function hapExchange(link, start, next, extra, everyMessage) {
    return async (step, tlv) => {
        link.send(step === 1 ? start : next, step === 1 || everyMessage ? {_pd: tlv, ...extra} : {_pd: tlv});
        const {data} = await link.next(frame => frame.type === next, 15000);
        if (!(data?._pd instanceof Uint8Array))
            throw new HapError('The Apple TV sent no pairing data');
        return data._pd;
    };
}

function hapTrouble(e, unpaired) {
    if (!(e instanceof HapError))
        return e;
    if (e.code === 'pin')
        return new TvError('The Apple TV did not take the PIN', unpaired ? 'unpaired' : '600');
    if (e.code === 'unpaired')
        return new TvError('The Apple TV no longer knows Nook', 'unpaired');
    return new TvError(e.message, e.code === '3' || e.code === '6' ? 'busy' : 'denied');
}

export default class AppleTv {
    static pairing = 'pin';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._port = tv.port ?? secret?.port ?? null;
        this._credentials = secret?.ltsk && secret.deviceId ? secret : null;
        this._airplay = secret?.airplay?.ltsk ? secret.airplay : null;
        this._remote = null;
        this._link = null;
        this._linking = null;
        this._pairing = null;
        this._airplayPairing = null;
        this._xid = GLib.random_int_range(0, 0x10000);
        this._closed = false;
        this.refused = false;
        this.onSecret = null;
        this.onUpdate = null;
    }

    get paired() {
        return this._credentials !== null;
    }

    // The Companion port is assigned at boot; ask mDNS again when the saved one fails.
    async _openLink() {
        if (this._port) {
            try {
                return await Link.open(this._tv.ip, this._port);
            } catch (e) {
                if (!(e instanceof GLib.Error) || e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            }
        }
        const service = (await browse(2000, ['_companion-link._tcp'])).find(s => s.ip === this._tv.ip);
        if (!service)
            throw new TvError('The Apple TV is not answering', 'timeout');
        this._port = service.port;
        return Link.open(this._tv.ip, this._port);
    }

    _request(link, identifier, content = {}) {
        const xid = this._xid++;
        link.send(FRAME.opack, {_i: identifier, _t: REQUEST, _c: content, _x: xid});
        return link.next(frame => frame.data?._t === RESPONSE && frame.data._x === xid, 5000).then(({data}) => {
            if (data._em)
                throw new TvError(`${identifier}: ${data._em}`);
            return data._c ?? {};
        });
    }

    _event(link, identifier, content) {
        link.send(FRAME.opack, {_i: identifier, _t: EVENT, _c: content, _x: this._xid++});
    }

    _connect() {
        if (this._link && !this._link.closed)
            return Promise.resolve(this._link);
        if (!this._credentials)
            return Promise.reject(new TvError('The Apple TV is not paired yet', 'unpaired'));
        this._linking ??= this._open().finally(() => {
            this._linking = null;
        });
        return this._linking;
    }

    async _open() {
        const link = await this._openLink();
        try {
            const verified = await pairVerify(
                hapExchange(link, FRAME.verifyStart, FRAME.verifyNext, {_auTy: 4}, false), this._credentials);
            link.encrypt(verified.keys('', 'ClientEncrypt-main'), verified.keys('', 'ServerEncrypt-main'));
        } catch (e) {
            link.close();
            const trouble = hapTrouble(e, true);
            if (trouble.code === 'unpaired') {
                this.refused = true;
                this._credentials = null;
            }
            throw trouble;
        }
        if (this._closed) {
            link.close();
            throw new TvError('Closed', 'closed');
        }
        const state = {asleep: null, volume: null};
        const readVolume = flags => {
            if (!(flags & VOLUME_CONTROL)) {
                state.volume = null;
                this._changed(link);
                return;
            }
            this._request(link, '_mcc', {_mcc: MEDIA.getVolume}).then(({_vol}) => {
                state.volume = typeof _vol === 'number' ? Math.round(_vol * 100) : null;
                this._changed(link);
            }).catch(() => {});
        };
        link.onFrame = ({data}) => {
            if (data?._t !== EVENT)
                return;
            if (['SystemStatus', 'TVSystemStatus'].includes(data._i) && typeof data._c?.state === 'number') {
                state.asleep = data._c.state === ASLEEP;
                this._changed(link);
            } else if (data._i === '_iMC' && typeof data._c?._mcF === 'number') {
                readVolume(data._c._mcF);
            }
        };
        link.state = state;
        const id = fromHex(this._credentials.clientId);
        await this._request(link, '_systemInfo', {
            _bf: 0,
            _cf: 512,
            _clFl: 128,
            _i: toHex(id.subarray(0, 6)),
            _idsID: id,
            _pubID: toHex(id.subarray(6, 12)).replace(/(..)(?!$)/g, '$1:').toUpperCase(),
            _sf: 256,
            _sv: '170.18',
            model: 'iPhone10,6',
            name: 'Nook',
        });
        await this._request(link, '_touchStart', {_height: 1000, _tFl: 0, _width: 1000}).catch(() => {});
        await this._request(link, '_sessionStart', {
            _srvT: 'com.apple.tvremoteservices', _sid: GLib.random_int_range(0, 0x7fffffff),
        });
        // tvOS answers FetchAttentionState only once a TV remote session is open.
        await this._request(link, 'TVRCSessionStart', {ProtocolVersionKey: '1.2'}).catch(() => {});
        this._event(link, '_interest', {_regEvents: ['_iMC', 'SystemStatus', 'TVSystemStatus']});
        try {
            const {state: attention} = await this._request(link, 'FetchAttentionState');
            if (typeof attention === 'number')
                state.asleep = attention === ASLEEP;
        } catch (e) {
            if (!(e instanceof TvError))
                throw e;
        }
        link.ready = true;
        this._link = link;
        return link;
    }

    _changed(link) {
        if (this._link === link && link.ready)
            this.onUpdate?.();
    }

    // MRP through AirPlay names the app playing and what it plays. Without it, or until
    // it is up, the Apple TV is just on or off.
    _startRemote() {
        if (!this._airplay || this._remote || this._closed)
            return;
        const remote = new AirPlayRemote(this._tv.ip, this._airplay);
        this._remote = remote;
        let shown = '';
        remote.onChange = () => {
            const now = JSON.stringify(remote.state);
            if (now === shown || this._remote !== remote)
                return;
            shown = now;
            this.onUpdate?.();
        };
        remote.onClose = error => {
            if (error && !this._closed)
                console.debug(`nook: apple tv: remote control channel: ${error.message}`);
        };
        remote.start().catch(e => {
            console.debug(`nook: apple tv: remote control channel: ${e.message}`);
            remote.close();
        });
    }

    // Asleep it still answers on the network, so that is off; unknown counts as on.
    async status() {
        const off = {on: false, volume: null, muted: null, source: null, app: null};
        if (!this._credentials)
            return off;
        let link;
        try {
            link = await this._connect();
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error)
                return off;
            throw e;
        }
        if (link.state.asleep)
            return off;
        this._startRemote();
        const playing = this._remote && !this._remote.closed ? this._remote.state : {};
        return {
            on: true,
            volume: link.state.volume,
            muted: null,
            source: null,
            app: playing.app ?? null,
            title: playing.name ?? null,
            media: playing.title ?? null,
        };
    }

    async press(key) {
        const link = await this._connect();
        if (key === 'play' || key === 'pause') {
            await this._request(link, '_mcc', {_mcc: MEDIA[key]});
            return;
        }
        const button = BUTTONS[key];
        if (!button)
            throw new TvError(`No such key: ${key}`);
        await this._request(link, '_hidC', {_hBtS: 1, _hidC: button});
        await this._request(link, '_hidC', {_hBtS: 2, _hidC: button});
    }

    get keys() {
        return [...Object.keys(BUTTONS), 'play', 'pause', 'power'];
    }

    async power(on) {
        const link = await this._connect();
        await this._request(link, '_hidC', {_hBtS: 2, _hidC: on ? WAKE : SLEEP});
        // The status event can trail the command.
        await sleep(300);
    }

    async setVolume(level) {
        const link = await this._connect();
        await this._request(link, '_mcc', {_mcc: MEDIA.setVolume, _vol: Math.max(0, Math.min(100, level)) / 100});
    }

    sources() {
        return [];
    }

    // {"com.netflix.Netflix": "Netflix", ...}
    async apps() {
        const link = await this._connect();
        const apps = await this._request(link, 'FetchLaunchableApplicationsEvent');
        return Object.entries(apps).map(([id, title]) => ({id, title: String(title)}))
            .sort((a, b) => a.title.localeCompare(b.title));
    }

    async launch(id) {
        await this._request(await this._connect(), '_launchApp', {_bundleID: id});
    }

    // The Apple TV shows a 4-digit PIN after the first message.
    async pairBegin() {
        const link = await this._openLink();
        const setup = new PairSetup(hapExchange(link, FRAME.setupStart, FRAME.setupNext, {_pwTy: 1}, true));
        this._pairing = {link, setup};
        try {
            await setup.begin();
        } catch (e) {
            throw hapTrouble(e, false);
        }
        return {done: false};
    }

    // Companion first; then AirPlay, which shows a PIN of its own. {again, secret} asks for
    // that second PIN; secret alone already works without it.
    async pairEnd(pin) {
        const digits = pin.replace(/\D/g, '').padStart(4, '0');
        if (this._airplayPairing) {
            const {pairing, secret} = this._airplayPairing;
            this._airplayPairing = null;
            try {
                return {...secret, airplay: await pairing.finish(digits, pack({name: 'Nook'}))};
            } catch (e) {
                throw hapTrouble(e, false);
            }
        }
        const {link, setup} = this._pairing;
        let secret;
        try {
            this._credentials = await setup.finish(digits, pack({name: 'Nook'}));
            secret = {...this._credentials, port: this._port};
        } catch (e) {
            throw hapTrouble(e, false);
        } finally {
            link.close();
            this._pairing = null;
        }
        try {
            this._airplayPairing = {pairing: await AirPlayPairing.begin(this._tv.ip), secret};
        } catch (e) {
            console.debug(`nook: apple tv: AirPlay pairing: ${e.message}`);
            return secret;
        }
        return {again: true, secret};
    }

    close() {
        this._closed = true;
        this._link?.close();
        this._link = null;
        this._pairing?.link.close();
        this._pairing = null;
        this._airplayPairing?.pairing.close();
        this._airplayPairing = null;
        this._remote?.close();
        this._remote = null;
    }
}
