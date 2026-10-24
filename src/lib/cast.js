// SPDX-License-Identifier: GPL-2.0-or-later

// Cast v2 on the LAN: Avahi mDNS discovery, then TLS to port 8009 (groups have their
// own port), length-prefixed CastMessage protobufs with JSON payloads. No Google account.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const AVAHI = 'org.freedesktop.Avahi';
const SERVICE = '_googlecast._tcp';
const ANY = -1;
const IPV4 = 0;

const CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const MEDIA = 'urn:x-cast:com.google.cast.media';
const MULTIZONE = 'urn:x-cast:com.google.cast.multizone';
const PLATFORM = 'receiver-0';
const SENDER = 'sender-nook';

const PING_EVERY = 5;
const ANSWER_TIMEOUT = 5000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_MESSAGE = 1 << 20;

export class CastError extends Error {}

// mDNS gives "187c469c37cb…", multizone "187c469c-37cb-…".
export function speakerId(id) {
    return String(id ?? '').replaceAll('-', '').toLowerCase();
}

export function discover(timeout = 3000) {
    return new Promise((resolve, reject) => {
        const bus = Gio.DBus.system;
        const found = new Map();
        const waiting = [];
        let path = null;
        let timer = 0;
        let pending = 0;
        let allForNow = false;

        const finish = () => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
            bus.signal_unsubscribe(subscription);
            if (path) {
                bus.call(AVAHI, path, 'org.freedesktop.Avahi.ServiceBrowser', 'Free', null, null,
                    Gio.DBusCallFlags.NONE, -1, null, null);
            }
            resolve([...found.values()]);
        };
        const settle = () => {
            if (allForNow && pending === 0 && timer)
                finish();
        };
        const look = ([iface, protocol, name, type, domain]) => {
            pending++;
            bus.call(AVAHI, '/', 'org.freedesktop.Avahi.Server', 'ResolveService',
                new GLib.Variant('(iisssiu)', [iface, protocol, name, type, domain, IPV4, 0]),
                null, Gio.DBusCallFlags.NONE, timeout, null, (connection, result) => {
                    pending--;
                    try {
                        const [, , , , , , , address, port, txt] = connection.call_finish(result).deepUnpack();
                        const record = {};
                        for (const entry of txt) {
                            const text = decoder.decode(entry);
                            const equals = text.indexOf('=');
                            if (equals > 0)
                                record[text.slice(0, equals)] = text.slice(equals + 1);
                        }
                        if (record.id && address && !address.includes(':')) {
                            found.set(`${record.id}:${port}`, {
                                id: record.id,
                                name: record.fn || name,
                                model: record.md || '',
                                ip: address,
                                port,
                            });
                        }
                    } catch (e) {
                        console.debug(`nook: cast: ${name}: ${e.message}`);
                    }
                    settle();
                });
        };

        // Subscribe first: Avahi can emit ItemNew before ServiceBrowserNew returns the
        // path, so early items are buffered until it is known.
        const subscription = bus.signal_subscribe(AVAHI, 'org.freedesktop.Avahi.ServiceBrowser', null, null, null,
            Gio.DBusSignalFlags.NONE, (_bus, _sender, signalPath, _iface, signal, params) => {
                if (signal === 'ItemNew') {
                    if (path === signalPath)
                        look(params.deepUnpack());
                    else if (!path)
                        waiting.push([signalPath, params.deepUnpack()]);
                } else if (signal === 'AllForNow' && signalPath === path) {
                    allForNow = true;
                    settle();
                }
            });

        bus.call(AVAHI, '/', 'org.freedesktop.Avahi.Server', 'ServiceBrowserNew',
            new GLib.Variant('(iissu)', [ANY, IPV4, SERVICE, '', 0]),
            null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    [path] = connection.call_finish(result).deepUnpack();
                } catch (e) {
                    bus.signal_unsubscribe(subscription);
                    reject(new CastError(`Avahi is not answering: ${e.message}`));
                    return;
                }
                for (const [early, item] of waiting.splice(0)) {
                    if (early === path)
                        look(item);
                }
                timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                    timer = 0;
                    finish();
                    return GLib.SOURCE_REMOVE;
                });
            });
    });
}

// Minimal CastMessage protobuf: 1 protocol_version = 0, 2 source_id, 3 destination_id,
// 4 namespace, 5 payload_type = 0 (STRING), 6 payload_utf8 holding JSON.
function varint(value) {
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value)
            byte |= 0x80;
        bytes.push(byte);
    } while (value);
    return bytes;
}

function encode(source, destination, namespace, payload) {
    const bytes = [0x08, 0x00];
    const text = (number, string) => {
        const data = encoder.encode(string);
        bytes.push(...varint(number << 3 | 2), ...varint(data.length), ...data);
    };
    text(2, source);
    text(3, destination);
    text(4, namespace);
    bytes.push(0x28, 0x00);
    text(6, JSON.stringify(payload));
    const framed = new Uint8Array(4 + bytes.length);
    new DataView(framed.buffer).setUint32(0, bytes.length);
    framed.set(bytes, 4);
    return framed;
}

function decode(bytes) {
    const message = {};
    let at = 0;
    const read = () => {
        let value = 0;
        let shift = 0;
        let byte;
        do {
            byte = bytes[at++];
            value += (byte & 0x7f) * 2 ** shift;
            shift += 7;
        } while (byte & 0x80 && at < bytes.length);
        return value;
    };
    while (at < bytes.length) {
        const key = read();
        if ((key & 7) === 0) {
            read();
        } else if ((key & 7) === 2) {
            const length = read();
            const value = decoder.decode(bytes.subarray(at, at + length));
            at += length;
            const name = {2: 'source', 3: 'destination', 4: 'namespace', 6: 'payload'}[key >>> 3];
            if (name)
                message[name] = value;
        } else {
            throw new CastError('the speaker sent something that is not a Cast message');
        }
    }
    return message;
}

function readBytes(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let have = 0;
        const next = () => {
            stream.read_bytes_async(count - have, GLib.PRIORITY_DEFAULT, cancellable, (source, result) => {
                try {
                    const data = source.read_bytes_finish(result).toArray();
                    if (data.length === 0) {
                        reject(new CastError('the speaker closed the connection'));
                        return;
                    }
                    chunks.push(data);
                    have += data.length;
                    if (have < count) {
                        next();
                        return;
                    }
                    const all = new Uint8Array(count);
                    let at = 0;
                    for (const chunk of chunks) {
                        all.set(chunk, at);
                        at += chunk.length;
                    }
                    resolve(all);
                } catch (e) {
                    reject(e);
                }
            });
        };
        next();
    });
}

export class CastDevice {
    constructor(ip, port) {
        this.ip = ip;
        this.port = port;
        this.onChange = null;
        this.receiver = null;
        this.media = null;
        this._connection = null;
        this._opening = null;
        this._cancellable = null;
        this._requests = new Map();
        this._requestId = 0;
        this._transport = null;
        this._writing = Promise.resolve();
        this._ping = 0;
        this._mediaAt = 0;
    }

    _open() {
        this._opening ??= (async () => {
            const cancellable = this._cancellable = new Gio.Cancellable();
            const client = new Gio.SocketClient({tls: true, timeout: 5});
            // Speakers use self-signed certificates; trust rests on the address
            // mDNS resolved. connect_after(): Gio.SocketClient.connect() shadows
            // GObject's signal connect().
            client.connect_after('event', (_client, event, _connectable, connection) => {
                if (event === Gio.SocketClientEvent.TLS_HANDSHAKING)
                    connection.connect('accept-certificate', () => true);
            });
            const connection = await new Promise((resolve, reject) => {
                client.connect_to_host_async(`${this.ip}:${this.port}`, this.port, cancellable, (source, result) => {
                    try {
                        resolve(source.connect_to_host_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (cancellable.is_cancelled()) {
                connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
                throw new CastError('the connection was closed');
            }
            this._connection = connection;
            this._listen(cancellable);
            this._send(PLATFORM, CONNECTION, {type: 'CONNECT'});
            this._ping = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PING_EVERY, () => {
                this._send(PLATFORM, HEARTBEAT, {type: 'PING'});
                return GLib.SOURCE_CONTINUE;
            });
        })();
        return this._opening.catch(e => {
            this.close();
            throw e;
        });
    }

    async _listen(cancellable) {
        const input = this._connection.get_input_stream();
        try {
            for (;;) {
                const head = await readBytes(input, 4, cancellable);
                const length = new DataView(head.buffer).getUint32(0);
                if (length > MAX_MESSAGE)
                    throw new CastError(`a message of ${length} bytes`);
                this._receive(decode(await readBytes(input, length, cancellable)));
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`nook: cast ${this.ip}: ${e.message}`);
            // A newer connection may have replaced this one; leave it alone.
            if (this._cancellable === cancellable)
                this.close();
        }
    }

    _receive(message) {
        let payload;
        try {
            payload = JSON.parse(message.payload ?? '');
        } catch {
            return;
        }
        if (!payload || typeof payload !== 'object')
            return;
        if (message.namespace === HEARTBEAT && payload.type === 'PING') {
            this._send(message.source, HEARTBEAT, {type: 'PONG'});
            return;
        }
        if (message.namespace === CONNECTION && payload.type === 'CLOSE') {
            if (message.source === this._transport)
                this._transport = null;
            return;
        }
        if (payload.type === 'RECEIVER_STATUS')
            this.receiver = payload.status ?? null;
        if (payload.type === 'MEDIA_STATUS') {
            this.media = payload.status?.[0] ?? null;
            this._mediaAt = GLib.get_monotonic_time();
        }
        const request = this._requests.get(payload.requestId);
        if (request) {
            this._requests.delete(payload.requestId);
            GLib.source_remove(request.timer);
            if (/^(INVALID|LOAD_FAILED|LOAD_CANCELLED)/.test(payload.type ?? ''))
                request.reject(new CastError(payload.reason ?? payload.type));
            else
                request.resolve(payload);
        } else if (payload.type === 'RECEIVER_STATUS' || payload.type === 'MEDIA_STATUS') {
            this.onChange?.();
        }
    }

    _send(destination, namespace, payload) {
        const bytes = encode(SENDER, destination, namespace, payload);
        const output = this._connection?.get_output_stream();
        if (!output)
            return;
        this._writing = this._writing.then(() => new Promise(resolve => {
            output.write_all_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (source, result) => {
                try {
                    source.write_all_finish(result);
                } catch (e) {
                    console.debug(`nook: cast ${this.ip}: ${e.message}`);
                }
                resolve();
            });
        }));
    }

    async _ask(destination, namespace, payload) {
        await this._open();
        const requestId = ++this._requestId;
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANSWER_TIMEOUT, () => {
                this._requests.delete(requestId);
                reject(new CastError('the speaker did not answer'));
                return GLib.SOURCE_REMOVE;
            });
            this._requests.set(requestId, {resolve, reject, timer});
            this._send(destination, namespace, {...payload, requestId});
        });
    }

    async status() {
        await this._ask(PLATFORM, RECEIVER, {type: 'GET_STATUS'});
        const app = this._app();
        if (!app?.namespaces?.some(n => n.name === MEDIA)) {
            this.media = null;
            return this.state();
        }
        if (this._transport !== app.transportId) {
            this._transport = app.transportId;
            this._send(app.transportId, CONNECTION, {type: 'CONNECT'});
        }
        await this._ask(app.transportId, MEDIA, {type: 'GET_STATUS'});
        return this.state();
    }

    _app() {
        return this.receiver?.applications?.find(a => !a.isIdleScreen) ?? null;
    }

    state() {
        const volume = this.receiver?.volume ?? {};
        const app = this._app();
        const media = this.media;
        const metadata = media?.media?.metadata ?? {};
        return {
            volume: typeof volume.level === 'number' ? volume.level : null,
            muted: volume.muted === true,
            app: app?.displayName ?? null,
            text: app?.statusText ?? null,
            media: media ? {
                title: metadata.title ?? metadata.subtitle ?? null,
                artist: metadata.artist ?? metadata.albumArtist ?? metadata.subtitle ?? null,
                album: metadata.albumName ?? null,
                state: media.playerState ?? null,
                duration: media.media?.duration ?? null,
                position: media.currentTime ?? null,
                at: this._mediaAt,
                commands: media.supportedMediaCommands ?? null,
                image: metadata.images?.[0]?.url ?? null,
            } : null,
        };
    }

    setVolume(level) {
        return this._ask(PLATFORM, RECEIVER, {type: 'SET_VOLUME', volume: {level: Math.min(1, Math.max(0, level))}});
    }

    setMuted(muted) {
        return this._ask(PLATFORM, RECEIVER, {type: 'SET_VOLUME', volume: {muted}});
    }

    _command(payload) {
        if (!this._transport || this.media?.mediaSessionId === undefined)
            return Promise.reject(new CastError('nothing is playing'));
        return this._ask(this._transport, MEDIA, {...payload, mediaSessionId: this.media.mediaSessionId});
    }

    play() {
        return this._command({type: 'PLAY'});
    }

    pause() {
        return this._command({type: 'PAUSE'});
    }

    skip(by) {
        return this._command({type: by > 0 ? 'QUEUE_NEXT' : 'QUEUE_PREV'});
    }

    async stop() {
        const app = this._app();
        if (!app)
            throw new CastError('nothing is playing');
        await this._ask(PLATFORM, RECEIVER, {type: 'STOP', sessionId: app.sessionId});
        this.media = null;
    }

    async members() {
        const reply = await this._ask(PLATFORM, MULTIZONE, {type: 'GET_STATUS'});
        return (reply.status?.devices ?? []).map(d => speakerId(d.deviceId));
    }

    close() {
        if (this._ping)
            GLib.source_remove(this._ping);
        this._ping = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const request of this._requests.values()) {
            GLib.source_remove(request.timer);
            request.reject(new CastError('the connection was closed'));
        }
        this._requests.clear();
        this._connection?.close_async(GLib.PRIORITY_DEFAULT, null, null);
        this._connection = null;
        this._opening = null;
        this._transport = null;
    }
}
