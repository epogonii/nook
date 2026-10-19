// SPDX-License-Identifier: GPL-2.0-or-later

// Passive BlueZ scan for Xiaomi MiBeacon adverts; nothing is paired or connected.
// Encrypted adverts need the device's beacon key, which Mi Home keeps in the cloud.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ccmDecrypt} from './aes.js';

const BLUEZ = 'org.bluez';
const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';
const MIBEACON = '0000fe95-0000-1000-8000-00805f9b34fb';

const ENCRYPTED = 0x08;
const HAS_MAC = 0x10;
const HAS_CAPABILITY = 0x20;
const HAS_OBJECT = 0x40;
const HAS_IO = 0x20;

function call(path, iface, method, args) {
    return new Promise((resolve, reject) => {
        Gio.DBus.system.call(BLUEZ, path, iface, method, args, null, Gio.DBusCallFlags.NONE, -1, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function readBeacon(bytes, address, key = null) {
    if (bytes.length < 5)
        return null;
    const frame = bytes[0] | bytes[1] << 8;
    const product = bytes[2] | bytes[3] << 8;
    if (!(frame & HAS_OBJECT))
        return null;
    let at = 5;
    if (frame & HAS_MAC)
        at += 6;
    if (frame & HAS_CAPABILITY) {
        if (bytes[at] & HAS_IO)
            at += 2;
        at += 1;
    }
    let payload = bytes.subarray(at);
    if (frame & ENCRYPTED) {
        // v4/v5, AES-CCM. Nonce: reversed MAC + product id + frame counter + the 3-byte
        // extended counter that, with a 4-byte MIC, ends the advert.
        if (!key || frame >> 12 < 4 || bytes.length < at + 3 + 7)
            return null;
        const mac = address.split(':').reverse().map(h => Number.parseInt(h, 16));
        const nonce = Uint8Array.of(...mac, bytes[2], bytes[3], bytes[4], ...bytes.subarray(bytes.length - 7, bytes.length - 4));
        try {
            payload = ccmDecrypt(key, nonce, Uint8Array.of(0x11), bytes.subarray(at, bytes.length - 7),
                bytes.subarray(bytes.length - 4));
        } catch {
            return null;
        }
    }
    if (payload.length < 3)
        return null;
    const type = payload[0] | payload[1] << 8;
    const data = payload.slice(3, 3 + payload[2]);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    switch (type) {
    case 0x1005:
        // Kettle: status (0 idle, 1 heating, 2 cooling to keep-warm, 3 keep-warm), then
        // water temperature. Both read 0 at times (off its base?); 0 °C is no reading.
        if (data.length < 2)
            return null;
        return data[1] > 0 ? {product, status: data[0], temperature: data[1]} : {product, status: data[0]};
    case 0x1004:
        return data.length >= 2 ? {product, temperature: view.getInt16(0, true) / 10} : null;
    case 0x1006:
        return data.length >= 2 ? {product, humidity: view.getUint16(0, true) / 10} : null;
    case 0x100a:
        return data.length >= 1 ? {product, battery: data[0]} : null;
    case 0x100d:
        return data.length >= 4
            ? {product, temperature: view.getInt16(0, true) / 10, humidity: view.getUint16(2, true) / 10}
            : null;
    }
    return null;
}

export class BeaconScan {
    constructor(onBeacon) {
        this._onBeacon = onBeacon;
        this.keys = new Map();
        this.onLocked = null;
        this.off = false;
        this._adapter = null;
        this._subscriptions = [];
        this._wanted = false;
    }

    // No-op without a powered adapter. _wanted is rechecked after each await, so a
    // concurrent stop() wins and nothing is left scanning.
    async start() {
        this._wanted = true;
        if (this._adapter)
            return;
        const [objects] = (await call('/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null)).deepUnpack();
        const adapter = Object.entries(objects).find(([, ifaces]) => ifaces[ADAPTER]?.Powered?.deepUnpack())?.[0];
        this.off = !adapter;
        if (!adapter || !this._wanted || this._adapter)
            return;
        this._adapter = adapter;

        const bus = Gio.DBus.system;
        this._subscriptions.push(bus.signal_subscribe(BLUEZ, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            null, DEVICE, Gio.DBusSignalFlags.NONE, (_bus, _sender, path, _iface, _signal, params) => {
                const [, changed] = params.deepUnpack();
                this._look(path, changed);
            }));
        this._subscriptions.push(bus.signal_subscribe(BLUEZ, 'org.freedesktop.DBus.ObjectManager', 'InterfacesAdded',
            null, null, Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, _signal, params) => {
                const [path, ifaces] = params.deepUnpack();
                if (ifaces[DEVICE])
                    this._look(path, ifaces[DEVICE]);
            }));
        for (const [path, ifaces] of Object.entries(objects)) {
            if (ifaces[DEVICE])
                this._look(path, ifaces[DEVICE]);
        }

        // No UUIDs filter: BlueZ matches advertised service UUIDs, and MiBeacon's
        // appears only in service data.
        await call(adapter, ADAPTER, 'SetDiscoveryFilter', new GLib.Variant('(a{sv})', [{
            Transport: new GLib.Variant('s', 'le'),
            DuplicateData: new GLib.Variant('b', true),
        }]));
        if (this._wanted)
            await call(adapter, ADAPTER, 'StartDiscovery', null);
    }

    _look(path, props) {
        const services = props.ServiceData?.deepUnpack?.();
        const data = services?.[MIBEACON];
        if (!data)
            return;
        const bytes = data.deepUnpack?.() ?? data;
        const address = path.split('/').pop().replace(/^dev_/, '').replaceAll('_', ':');
        const raw = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        const beacon = readBeacon(raw, address, this.keys.get(address));
        const rssi = props.RSSI?.deepUnpack?.() ?? props.RSSI;
        if (beacon && typeof rssi === 'number')
            beacon.rssi = rssi;
        if (beacon)
            this._onBeacon(address, beacon);
        else if (raw.length > 1 && raw[0] & ENCRYPTED && !this.keys.has(address))
            this.onLocked?.(address);
    }

    stop() {
        this._wanted = false;
        for (const id of this._subscriptions)
            Gio.DBus.system.signal_unsubscribe(id);
        this._subscriptions = [];
        if (this._adapter) {
            call(this._adapter, ADAPTER, 'StopDiscovery', null).catch(() => {});
            this._adapter = null;
        }
    }
}
