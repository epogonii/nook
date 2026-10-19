// SPDX-License-Identifier: GPL-2.0-or-later

// Xiaomi gateway LAN protocol (enable it in Mi Home): Zigbee sensor events are multicast
// to 224.0.0.50:9898. Read-only here; sending commands would need the gateway's key.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const GROUP = '224.0.0.50';
const PORT = 9898;
const WHOIS_PORT = 4321;
const READ_TIMEOUT = 2000;

const decoder = new TextDecoder();

// Protocol v1 sends data as a JSON string, v2 as params, a list of one-key objects.
function readData(message) {
    if (typeof message.data === 'string') {
        try {
            return JSON.parse(message.data);
        } catch {
            return {};
        }
    }
    if (Array.isArray(message.params))
        return Object.assign({}, ...message.params);
    return {};
}

export class Listener {
    constructor(onReport) {
        this._onReport = onReport;
        this._socket = null;
        this._source = null;
        this._heard = false;
        this._gateways = new Set();
        this._states = new Map();
        this._waiting = new Map();
    }

    state(sid) {
        return this._states.get(sid) ?? null;
    }

    read(sid) {
        if (!this._socket || this._gateways.size === 0)
            return Promise.resolve(this.state(sid));
        return new Promise(resolve => {
            const finish = () => {
                GLib.source_remove(timer);
                this._waiting.get(sid)?.delete(finish);
                resolve(this.state(sid));
            };
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READ_TIMEOUT, () => {
                this._waiting.get(sid)?.delete(finish);
                resolve(this.state(sid));
                return GLib.SOURCE_REMOVE;
            });
            if (!this._waiting.has(sid))
                this._waiting.set(sid, new Set());
            this._waiting.get(sid).add(finish);
            const ask = new TextEncoder().encode(JSON.stringify({cmd: 'read', sid}));
            for (const ip of this._gateways) {
                try {
                    this._socket.send_to(Gio.InetSocketAddress.new_from_string(ip, PORT), ask, null);
                } catch (e) {
                    console.debug(`nook: gateway ${ip}: ${e.message}`);
                }
            }
        });
    }

    get running() {
        return this._socket !== null;
    }

    // Gateways with the LAN protocol on send a heartbeat every 10 s.
    get heard() {
        return this._heard;
    }

    start() {
        this.stop();
        const socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
        try {
            socket.set_blocking(false);
            socket.bind(Gio.InetSocketAddress.new(Gio.InetAddress.new_any(Gio.SocketFamily.IPV4), PORT), true);
            socket.join_multicast_group(Gio.InetAddress.new_from_string(GROUP), false, null);
        } catch (e) {
            socket.close();
            throw e;
        }
        this._socket = socket;
        this._source = socket.create_source(GLib.IOCondition.IN, null);
        this._source.set_callback(() => {
            this._receive();
            return GLib.SOURCE_CONTINUE;
        });
        this._source.attach(null);

        try {
            socket.send_to(Gio.InetSocketAddress.new_from_string(GROUP, WHOIS_PORT),
                new TextEncoder().encode(JSON.stringify({cmd: 'whois'})), null);
        } catch (e) {
            console.debug(`nook: gateway whois: ${e.message}`);
        }
    }

    _receive() {
        for (;;) {
            let bytes, from;
            try {
                [bytes, from] = this._socket.receive_bytes_from(4096, 0, null);
            } catch {
                return;
            }
            let message;
            try {
                message = JSON.parse(decoder.decode(bytes.toArray()));
            } catch {
                continue;
            }
            if (!message?.sid)
                continue;
            this._heard = true;
            if (message.model === 'gateway') {
                this._gateways.add(from.get_address().to_string());
                continue;
            }
            const data = readData(message);
            this._states.set(message.sid, {...this._states.get(message.sid), ...data});
            if (message.cmd === 'read_ack' || message.cmd === 'read_rsp') {
                for (const finish of [...this._waiting.get(message.sid) ?? []])
                    finish();
            }
            if (message.cmd === 'report' || message.cmd === 'heartbeat') {
                try {
                    this._onReport({sid: message.sid, model: message.model ?? '', data, cmd: message.cmd});
                } catch (e) {
                    logError(e, 'nook: gateway report');
                }
            }
        }
    }

    stop() {
        for (const waiting of this._waiting.values()) {
            for (const finish of [...waiting])
                finish();
        }
        this._waiting.clear();
        this._source?.destroy();
        this._source = null;
        this._socket?.close();
        this._socket = null;
    }
}
