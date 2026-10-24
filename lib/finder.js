// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {localNetworks, readText, tag} from './net.js';
import * as Timers from './timers.js';

const AVAHI = 'org.freedesktop.Avahi';
const ANY = -1;
const IPV4 = 0;

const SSDP = ['239.255.255.250', 1900];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const SERVICES = {
    '_hap._tcp': 'HomeKit',
    '_matter._tcp': 'Matter',
    '_matterc._udp': 'Matter',
    '_hue._tcp': 'Philips Hue',
    '_shelly._tcp': 'Shelly',
    '_esphomelib._tcp': 'ESPHome',
    '_wled._tcp': 'WLED',
    '_miio._udp': 'Mi Home',
    '_ewelink._tcp': 'eWeLink',
    '_yandexio._tcp': 'Yandex',
    '_sonos._tcp': 'Sonos',
    '_airplay._tcp': 'AirPlay',
    '_spotify-connect._tcp': 'Spotify Connect',
    '_androidtvremote2._tcp': 'Android TV',
    '_companion-link._tcp': 'Apple TV',
    '_philipstv_s_rpc._tcp': 'Philips TV',
    '_philipstv_rpc._tcp': 'Philips TV',
    '_home-assistant._tcp': 'Home Assistant',
    '_mqtt._tcp': 'MQTT',
};

const BORING = /InternetGatewayDevice|WANDevice|WANConnectionDevice|LANDevice/;

function txtRecord(entries) {
    const record = {};
    for (const entry of entries) {
        const text = decoder.decode(entry);
        const equals = text.indexOf('=');
        if (equals > 0)
            record[text.slice(0, equals).toLowerCase()] = text.slice(equals + 1);
    }
    return record;
}

export function browse(timeout, types = Object.keys(SERVICES)) {
    return new Promise(resolve => {
        const bus = Gio.DBus.system;
        const browsers = new Map();
        const early = [];
        const found = [];
        let over = false;

        const look = ([iface, protocol, name, type, domain]) => {
            bus.call(AVAHI, '/', 'org.freedesktop.Avahi.Server', 'ResolveService',
                new GLib.Variant('(iisssiu)', [iface, protocol, name, type, domain, IPV4, 0]),
                null, Gio.DBusCallFlags.NONE, timeout, null, (connection, result) => {
                    try {
                        const [, , , , , host, , address, port, txt] = connection.call_finish(result).deepUnpack();
                        if (!over && address && !address.includes(':'))
                            found.push({type, name, host, ip: address, port, txt: txtRecord(txt)});
                    } catch (e) {
                        console.debug(`nook: finder: ${name}: ${e.message}`);
                    }
                });
        };

        // Subscribe first: Avahi can emit ItemNew before ServiceBrowserNew returns the
        // path, so early items are buffered until it is known.
        const subscription = bus.signal_subscribe(AVAHI, 'org.freedesktop.Avahi.ServiceBrowser', 'ItemNew',
            null, null, Gio.DBusSignalFlags.NONE, (_bus, _sender, path, _iface, _signal, params) => {
                if (over)
                    return;
                if (browsers.has(path))
                    look(params.deepUnpack());
                else
                    early.push([path, params.deepUnpack()]);
            });

        for (const type of types) {
            bus.call(AVAHI, '/', 'org.freedesktop.Avahi.Server', 'ServiceBrowserNew',
                new GLib.Variant('(iissu)', [ANY, IPV4, type, '', 0]),
                null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                    let path;
                    try {
                        [path] = connection.call_finish(result).deepUnpack();
                    } catch (e) {
                        console.debug(`nook: finder: ${type}: ${e.message}`);
                        return;
                    }
                    if (over) {
                        bus.call(AVAHI, path, 'org.freedesktop.Avahi.ServiceBrowser', 'Free', null, null,
                            Gio.DBusCallFlags.NONE, -1, null, null);
                        return;
                    }
                    browsers.set(path, type);
                    for (const [at, item] of early) {
                        if (at === path)
                            look(item);
                    }
                });
        }

        const end = () => {
            over = true;
            bus.signal_unsubscribe(subscription);
            for (const path of browsers.keys()) {
                bus.call(AVAHI, path, 'org.freedesktop.Avahi.ServiceBrowser', 'Free', null, null,
                    Gio.DBusCallFlags.NONE, -1, null, null);
            }
        };
        Timers.timeout(timeout, () => {
            end();
            resolve(found);
            return GLib.SOURCE_REMOVE;
        }, {cleanup: end});
    });
}

// Up to 6 answers per IP: a TV is several UPnP devices, not all naming the maker alike.
async function search(timeout) {
    // One socket per local address: with a VPN on the default route, an unbound
    // search would go out through the VPN.
    const local = (await localNetworks()).map(network => network.address);
    return new Promise(resolve => {
        const request = encoder.encode([
            'M-SEARCH * HTTP/1.1',
            `HOST: ${SSDP.join(':')}`,
            'MAN: "ssdp:discover"',
            'MX: 2',
            'ST: upnp:rootdevice',
            '', '',
        ].join('\r\n'));
        const found = new Map();
        const perAddress = new Map();
        const listen = socket => {
            for (;;) {
                let bytes, from;
                try {
                    [bytes, from] = socket.receive_bytes_from(8192, 0, null);
                } catch {
                    break;
                }
                const ip = from.get_address().to_string();
                const headers = {};
                for (const line of decoder.decode(bytes.toArray()).split('\r\n')) {
                    const colon = line.indexOf(':');
                    if (colon > 0)
                        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
                }
                const count = perAddress.get(ip) ?? 0;
                if (!headers.location || found.has(headers.location) || count >= 6)
                    continue;
                perAddress.set(ip, count + 1);
                found.set(headers.location, {ip, location: headers.location, server: headers.server ?? ''});
            }
            return GLib.SOURCE_CONTINUE;
        };

        const open = [];
        for (const address of local.length > 0 ? local : ['0.0.0.0']) {
            let socket;
            try {
                socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
                socket.set_blocking(false);
                socket.bind(Gio.InetSocketAddress.new_from_string(address, 0), false);
                socket.send_to(Gio.InetSocketAddress.new_from_string(...SSDP), request, null);
            } catch (e) {
                console.debug(`nook: finder: ssdp: ${address}: ${e.message}`);
                socket?.close();
                continue;
            }
            const source = socket.create_source(GLib.IOCondition.IN, null);
            source.set_callback(() => listen(socket));
            source.attach(null);
            open.push([socket, source]);
        }
        if (open.length === 0) {
            resolve([]);
            return;
        }

        const close = () => {
            for (const [socket, source] of open) {
                source.destroy();
                socket.close();
            }
        };
        Timers.timeout(timeout, () => {
            close();
            resolve([...found.values()]);
            return GLib.SOURCE_REMOVE;
        }, {cleanup: close});
    });
}

// Fetches LOCATION only if it points at the IP that answered, never at another host.
async function describe(session, {ip, location}) {
    try {
        const uri = GLib.Uri.parse(location, GLib.UriFlags.NONE);
        if (uri.get_host() !== ip)
            return null;
        const message = Soup.Message.new('GET', location);
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        if (message.status_code !== Soup.Status.OK)
            return null;
        const xml = decoder.decode(bytes.toArray());
        return {
            type: tag(xml, 'deviceType'),
            name: tag(xml, 'friendlyName'),
            maker: tag(xml, 'manufacturer'),
            model: tag(xml, 'modelName'),
            udn: tag(xml, 'UDN'),
        };
    } catch (e) {
        console.debug(`nook: finder: ${ip}: ${e.message}`);
        return null;
    }
}

/** Returns a brand key of tv-home.js, or null. */
export function brandOf({maker = '', model = '', type = '', location = ''}) {
    const port = /^\w+:\/\/[^/]+:(\d+)/.exec(location)?.[1];
    if (/panasonic/i.test(maker) && port === '55000')
        return 'panasonic';
    if (/roku/i.test(maker))
        return 'roku';
    if (/samsung/i.test(maker) && /MediaRenderer|RemoteControlReceiver|MainTVServer|dial/i.test(type))
        return 'samsung';
    if (/^LG/i.test(maker) && /webos|MediaRenderer|dial/i.test(`${type} ${model}`))
        return 'lg';
    if (/sony/i.test(maker) && /MediaRenderer|dial|ScalarWebAPI|IRCC/i.test(type))
        return 'sony';
    if (/philips|tp ?vision/i.test(maker) && /MediaRenderer|dial/i.test(type))
        return 'philips';
    return null;
}

// MACs from the kernel ARP table. Call after describe(): its requests populate it.
async function neighbours() {
    const table = new Map();
    try {
        const text = await readText('/proc/net/arp');
        for (const line of text.split('\n').slice(1)) {
            const [ip, , flags, mac] = line.trim().split(/\s+/);
            if ((parseInt(flags, 16) & 0x2) && mac && mac !== '00:00:00:00:00:00')
                table.set(ip, mac.toLowerCase());
        }
    } catch (e) {
        console.debug(`nook: finder: arp: ${e.message}`);
    }
    return table;
}

export async function survey(timeout = 3000) {
    const session = new Soup.Session({timeout: 3});
    const [services, answers] = await Promise.all([browse(timeout), search(timeout)]);
    const devices = new Map();
    const at = ip => {
        if (!devices.has(ip))
            devices.set(ip, {ip, name: '', model: '', kinds: new Set(), how: new Set()});
        return devices.get(ip);
    };
    for (const service of services) {
        // Macs, iPhones and HomePods announce Companion too; rpmd is the model, like AppleTV6,2.
        if (service.type === '_companion-link._tcp' && !/^AppleTV/i.test(service.txt.rpmd ?? ''))
            continue;
        const device = at(service.ip);
        device.kinds.add(SERVICES[service.type]);
        device.how.add('mDNS');
        const miio = /^(.+)_miio(\d+)$/.exec(service.name);
        if (service.type === '_miio._udp' && miio) {
            device.model ||= miio[1].replace(/-/g, '.');
            device.did = miio[2];
            continue;
        }
        if (service.type === '_ewelink._tcp') {
            device.model ||= service.txt.type ? `eWeLink ${service.txt.type}` : '';
            device.name ||= service.txt.id ?? service.name;
            // A switch in DIY mode answers unencrypted and is Sonoff's, not the cloud's.
            if (service.txt.id && service.txt.encrypt === 'true')
                device.ewelink = service.txt.id;
            continue;
        }
        if (service.type === '_hue._tcp' && /^[0-9a-f]{16}$/i.test(service.txt.bridgeid ?? ''))
            device.hue = {id: service.txt.bridgeid.toLowerCase(), model: service.txt.modelid ?? null, name: service.name};
        if (service.type === '_hap._tcp')
            device.hap = {name: service.name, port: service.port, txt: service.txt};
        if (service.type === '_androidtvremote2._tcp')
            device.androidTv = {name: service.name, mac: service.txt.bt?.toLowerCase() || null};
        else if (service.type === '_companion-link._tcp')
            device.appleTv = {name: service.name, port: service.port, hd: /^AppleTV5,/i.test(service.txt.rpmd)};
        else if (service.type.startsWith('_philipstv'))
            device.philips = service.name;
        device.name ||= service.txt.fn || service.txt.name || service.name;
        device.model ||= service.txt.md || service.txt.model || '';
    }
    const described = await Promise.all(answers.map(answer => describe(session, answer)));
    session.abort();
    answers.forEach((answer, i) => {
        const description = described[i];
        if (!description || BORING.test(description.type))
            return;
        const device = at(answer.ip);
        device.how.add('UPnP');
        device.name ||= description.name;
        const {maker, model} = description;
        device.model ||= model.toLowerCase().startsWith(maker.toLowerCase())
            ? model : [maker, model].filter(Boolean).join(' ');
        if (device.kinds.size === 0)
            device.kinds.add(/MediaRenderer/.test(description.type) ? 'UPnP media' : 'UPnP');
        const brand = brandOf({...description, location: answer.location});
        // Lowest UDN wins, so the choice doesn't depend on which device answered first.
        if (brand && !(device.tv?.udn <= description.udn))
            device.tv = {brand, model, udn: description.udn};
    });
    // A maker's own protocol beats the generic Android TV remote its sets also run.
    for (const device of devices.values()) {
        if (device.tv)
            continue;
        if (device.appleTv)
            device.tv = {brand: 'appletv', model: device.appleTv.hd ? 'Apple TV HD' : 'Apple TV 4K',
                udn: `mdns:${device.appleTv.name}`, port: device.appleTv.port};
        else if (device.philips)
            device.tv = {brand: 'philips', model: device.model, udn: `mdns:${device.philips}`};
        else if (device.androidTv)
            device.tv = {brand: 'androidtv', model: device.model, udn: `mdns:${device.androidTv.name}`};
    }
    const macs = await neighbours();
    return [...devices.values()]
        .filter(d => d.kinds.size > 0)
        .map(d => ({
            ...d,
            mac: macs.get(d.ip) ?? d.androidTv?.mac ?? null,
            name: d.name || d.model || d.ip,
            kinds: [...d.kinds],
            how: [...d.how],
        }));
}
