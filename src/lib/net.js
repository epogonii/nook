// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Soup.Session.prototype, 'websocket_connect_async', 'websocket_connect_finish');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class TvError extends Error {
    constructor(message, code = '') {
        super(message);
        this.name = 'TvError';
        this.code = code;
    }
}

// Short timeout: a TV that is off never answers. Status reads go in parallel, and a
// Panasonic can take a second over each; Soup's default is 2 connections per host.
export function newSession() {
    return new Soup.Session({timeout: 4, idle_timeout: 15, max_conns_per_host: 6});
}

export const escape = text => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const unescape = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function tag(xml, name) {
    const match = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${name}>`).exec(xml);
    return match ? unescape(match[1]).trim() : '';
}

export async function request(session, method, url, {body = null, type = 'application/json', headers = {}} = {}) {
    const message = Soup.Message.new(method, url);
    if (!message)
        throw new TvError(`Not an address: ${url}`);
    for (const [name, value] of Object.entries(headers))
        message.get_request_headers().append(name, value);
    if (body !== null)
        message.set_request_body_from_bytes(type, new GLib.Bytes(encoder.encode(body)));
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    return {status: message.get_status(), text: decoder.decode(bytes.toArray())};
}

export async function download(session, url) {
    const message = Soup.Message.new('GET', url);
    if (!message)
        throw new TvError(`Not an address: ${url}`);
    // Self-signed, as in openSocket().
    message.connect('accept-certificate', () => true);
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK)
        throw new TvError(`HTTP ${message.get_status()}`);
    return bytes;
}

export async function soap(session, url, urn, action, params = '', {prefix = 'u', headers = {}} = {}) {
    const body = '<?xml version="1.0" encoding="utf-8"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<${prefix}:${action} xmlns:${prefix}="urn:${urn}">${params}</${prefix}:${action}>` +
        '</s:Body></s:Envelope>';
    const {status, text} = await request(session, 'POST', url, {
        body,
        type: 'text/xml; charset=utf-8',
        headers: {SOAPAction: `"urn:${urn}#${action}"`, ...headers},
    });
    if (status !== Soup.Status.OK)
        throw new TvError(tag(text, 'errorDescription') || `${action}: HTTP ${status}`, tag(text, 'errorCode'));
    return text;
}

const RENDERING = 'schemas-upnp-org:service:RenderingControl:1';
const MASTER = '<InstanceID>0</InstanceID><Channel>Master</Channel>';

export async function readVolume(session, url, prefix = 'u') {
    const [answer, mute] = await Promise.all([
        soap(session, url, RENDERING, 'GetVolume', MASTER, {prefix}),
        soap(session, url, RENDERING, 'GetMute', MASTER, {prefix}).then(text => tag(text, 'CurrentMute'), e => {
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
            return '';
        }),
    ]);
    const volume = parseInt(tag(answer, 'CurrentVolume'));
    return {
        volume: Number.isFinite(volume) ? volume : null,
        muted: mute === '' ? null : mute === '1' || mute === 'true',
    };
}

export function setVolume(session, url, level, prefix = 'u') {
    return soap(session, url, RENDERING, 'SetVolume',
        `${MASTER}<DesiredVolume>${Math.round(level)}</DesiredVolume>`, {prefix});
}

export function setMute(session, url, muted, prefix = 'u') {
    return soap(session, url, RENDERING, 'SetMute', `${MASTER}<DesiredMute>${muted ? 1 : 0}</DesiredMute>`, {prefix});
}

// From <net/if.h>.
const IFF_UP = 0x1;
const IFF_BROADCAST = 0x2;
const IFF_POINTOPOINT = 0x10;

// /proc/net/route prints addresses in host byte order.
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function routeNumber(hex) {
    const n = Number.parseInt(hex, 16) >>> 0;
    if (!LITTLE_ENDIAN)
        return n;
    return (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | (n >>> 24)) >>> 0;
}

const dotted = n => [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');

/**
 * Directly attached IPv4 networks, from /proc/net/route. Multicast and broadcast
 * go out per network: a VPN holding the default route would carry them off.
 */
export function localNetworks() {
    let text;
    try {
        text = decoder.decode(GLib.file_get_contents('/proc/net/route')[1]);
    } catch {
        return [];
    }
    const networks = new Map();
    for (const line of text.split('\n').slice(1)) {
        const [name, destination, gateway, , , , , mask] = line.trim().split(/\s+/);
        if (!mask || gateway !== '00000000')
            continue;
        const bits = routeNumber(mask);
        // Skip the default route (/0) and point-to-point peers (/31, /32).
        if (bits === 0 || bits >= 0xfffffffe)
            continue;
        let flags;
        try {
            flags = Number.parseInt(decoder.decode(GLib.file_get_contents(`/sys/class/net/${name}/flags`)[1]), 16);
        } catch {
            continue;
        }
        if ((flags & (IFF_UP | IFF_BROADCAST | IFF_POINTOPOINT)) !== (IFF_UP | IFF_BROADCAST))
            continue;
        const network = (routeNumber(destination) & bits) >>> 0;
        // UDP connect() sends nothing; it only picks this network's local address.
        const socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
        try {
            socket.connect(Gio.InetSocketAddress.new_from_string(dotted(network + 1), 9), null);
            const address = socket.get_local_address().get_address().to_string();
            networks.set(address, {address, broadcast: dotted((network | ~bits) >>> 0)});
        } catch (e) {
            console.debug(`nook: ${name}: ${e.message}`);
        } finally {
            socket.close();
        }
    }
    return [...networks.values()];
}

/**
 * Sends packet to address on each port, a few rounds apart (Wi-Fi drops broadcasts,
 * dozing units miss them), and hands every reply to take(bytes, ip) for timeout ms.
 * A broadcast also goes to each local network's own broadcast address. localPort is for
 * units that answer to a fixed port; a busy one falls back to any.
 */
export function probe(packet, ports, {address = '255.255.255.255', timeout = 3000, localPort = 0, take}) {
    const targets = address === '255.255.255.255'
        ? [address, ...localNetworks().map(network => network.broadcast)] : [address];
    const socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
    socket.set_blocking(false);
    socket.set_broadcast(true);
    try {
        socket.bind(Gio.InetSocketAddress.new_from_string('0.0.0.0', localPort), true);
    } catch (e) {
        if (!localPort)
            throw e;
        console.debug(`nook: probe: port ${localPort}: ${e.message}`);
        socket.bind(Gio.InetSocketAddress.new_from_string('0.0.0.0', 0), false);
    }
    const source = socket.create_source(GLib.IOCondition.IN, null);
    source.set_callback(() => {
        for (;;) {
            let bytes, from;
            try {
                [bytes, from] = socket.receive_bytes_from(4096, 0, null);
            } catch {
                break;
            }
            try {
                take(bytes.toArray(), from.get_address().to_string());
            } catch (e) {
                console.debug(`nook: probe: ${e.message}`);
            }
        }
        return GLib.SOURCE_CONTINUE;
    });
    source.attach(null);
    let sent = 0;
    const send = () => {
        for (const target of targets) {
            for (const port of ports) {
                try {
                    socket.send_to(Gio.InetSocketAddress.new_from_string(target, port), packet, null);
                    sent++;
                } catch (e) {
                    console.debug(`nook: probe: ${target}: ${e.message}`);
                }
            }
        }
    };
    send();
    if (sent === 0) {
        source.destroy();
        socket.close();
        return Promise.reject(new TvError(`Nothing could be sent to ${address}`));
    }
    let rounds = 1;
    let again = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        send();
        if (++rounds < 3)
            return GLib.SOURCE_CONTINUE;
        again = 0;
        return GLib.SOURCE_REMOVE;
    });
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
            if (again)
                GLib.source_remove(again);
            source.destroy();
            socket.close();
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function wake(mac) {
    const parts = String(mac ?? '').split(/[:-]/);
    if (parts.length !== 6 || !parts.every(part => /^[0-9a-f]{1,2}$/i.test(part)))
        return false;
    const address = parts.map(part => parseInt(part, 16));
    const packet = new Uint8Array(102).fill(0xff);
    for (let i = 1; i <= 16; i++)
        packet.set(address, i * 6);
    const broadcasts = localNetworks().map(network => network.broadcast);
    let sent = false;
    const socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
    try {
        socket.set_broadcast(true);
        for (const broadcast of broadcasts.length > 0 ? broadcasts : ['255.255.255.255']) {
            try {
                socket.send_to(Gio.InetSocketAddress.new_from_string(broadcast, 9), packet, null);
                sent = true;
            } catch (e) {
                console.debug(`nook: wake: ${broadcast}: ${e.message}`);
            }
        }
    } finally {
        socket.close();
    }
    return sent;
}

export class Channel {
    constructor(connection) {
        this._connection = connection;
        this._waiting = [];
        this.closed = false;
        this.onMessage = null;
        connection.max_incoming_payload_size = 4 << 20;
        connection.connect('message', (_c, type, bytes) => {
            if (type !== Soup.WebsocketDataType.TEXT)
                return;
            let message;
            try {
                message = JSON.parse(decoder.decode(bytes.toArray()));
            } catch {
                return;
            }
            const i = this._waiting.findIndex(w => w.test(message));
            if (i < 0) {
                this.onMessage?.(message);
                return;
            }
            const [waiter] = this._waiting.splice(i, 1);
            GLib.source_remove(waiter.timer);
            waiter.resolve(message);
        });
        connection.connect('closed', () => this._end(new TvError('The TV closed the connection', 'closed')));
        connection.connect('error', (_c, error) => this._end(new TvError(error.message)));
    }

    _end(error) {
        this.closed = true;
        for (const waiter of this._waiting.splice(0)) {
            GLib.source_remove(waiter.timer);
            waiter.reject(error);
        }
    }

    send(message) {
        if (this.closed)
            throw new TvError('The TV closed the connection', 'closed');
        this._connection.send_text(typeof message === 'string' ? message : JSON.stringify(message));
    }

    next(test, timeout) {
        if (this.closed)
            return Promise.reject(new TvError('The TV closed the connection', 'closed'));
        return new Promise((resolve, reject) => {
            const waiter = {test, resolve, reject};
            waiter.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeout, () => {
                const i = this._waiting.indexOf(waiter);
                if (i >= 0)
                    this._waiting.splice(i, 1);
                reject(new TvError('The TV did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._waiting.push(waiter);
        });
    }

    close() {
        if (this._connection.get_state() === Soup.WebsocketState.OPEN)
            this._connection.close(Soup.WebsocketCloseCode.NORMAL, null);
        this._end(new TvError('Closed'));
    }
}

export function openSocket(session, url) {
    const message = Soup.Message.new('GET', url);
    // Keep url out of the error: it may carry a token.
    if (!message)
        return Promise.reject(new TvError('Not an address the TV could have'));
    // TVs use self-signed certificates; nothing to verify against on a LAN.
    message.connect('accept-certificate', () => true);
    return session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT, null);
}
