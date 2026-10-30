// SPDX-License-Identifier: GPL-2.0-or-later

// A Proxy per app object: methods become Call, devices are mirrored and patched
// before each call returns.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Shell from 'gi://Shell';

import * as Timers from '../lib/timers.js';
import {BUS_NAME, ERROR, EVENTS, INTERFACE, MIRROR, OBJECT_PATH, WRITABLE, decode, encode, reviveError} from './bridge.js';
import {ERRORS} from './errors.js';

// Wrapped by hand, not with Gio._promisify(): the shell promisifies these for its own
// use, and re-patching them would change them shell-wide.
function busCall(bus, ...args) {
    return new Promise((resolve, reject) => {
        bus.call(...args, (_bus, result) => {
            try {
                resolve(bus.call_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function busCallWithFds(bus, ...args) {
    return new Promise((resolve, reject) => {
        bus.call_with_unix_fd_list(...args, (_bus, result) => {
            try {
                resolve(bus.call_with_unix_fd_list_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export const API_VERSION = 1;

// Longest the homes are kept for a flash to restore its light.
const RESTORE_MS = 10000;

// Handed to the app once by Import; every other key is the menu's, which the app's
// window edits through SetUi and UiChanged.
export const DEVICE_KEYS = ['xiaomi-user-id', 'gree-units', 'aircons', 'tapo-cameras', 'cast-speakers', 'tvs',
    'sonoff-switches', 'shelly-devices', 'ewelink-devices', 'ewelink-region', 'hue-bridges', 'hue-devices',
    'hass-server', 'hass-devices', 'homekit-accessories', 'smartlife-user', 'smartlife-devices', 'lg-devices',
    'smartthings-devices', 'melcloud-devices', 'electrolux-devices', 'find-skipped'];

const TARGET = Symbol('remote');

// Logins the extension kept before the app existed.
function savedLogins() {
    const schema = new Secret.Schema('io.github.epogonii.nook', Secret.SchemaFlags.NONE, {
        service: Secret.SchemaAttributeType.STRING,
    });
    const flags = Secret.SearchFlags.ALL | Secret.SearchFlags.UNLOCK | Secret.SearchFlags.LOAD_SECRETS;
    return new Promise((resolve, reject) => {
        Secret.password_search(schema, {}, flags, null, (_source, result) => {
            try {
                resolve(Secret.password_search_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    }).then(items => Promise.all(items.map(item => new Promise((resolve, reject) => {
        item.retrieve_secret(null, (_item, result) => {
            try {
                const secret = item.retrieve_secret_finish(result)?.get_text();
                const {service} = item.get_attributes();
                resolve(service && secret ? [service, item.get_label(), secret] : null);
            } catch (e) {
                reject(e);
            }
        });
    })))).then(found => found.filter(Boolean));
}
const APP_PATH = '/io/github/epogonii/nook_app';

export function homeKind(source) {
    return source?.[TARGET]?.kind ?? null;
}

export class App {
    constructor() {
        this._bus = Gio.DBus.session;
        this._targets = new Map();
        this._feeds = new Map();
        this._next = 0;
        this._attached = 0;
        this.onReloaded = null;
        this.onLost = null;
        this.onUi = null;
        this.onUiWanted = null;
        this.onAppeared = null;
        this._signals = [
            this._subscribe('Changed', ([id, patch]) => this._changed(id, patch)),
            this._subscribe('Event', ([id, name, args]) => this._event(id, name, args)),
            this._subscribe('FeedEnded', ([feed, status]) => this._feeds.get(feed)?.(status)),
            this._subscribe('Reloaded', () => this.onReloaded?.()),
            this._subscribe('UiChanged', ([values]) => this.onUi?.(values)),
            this._subscribe('UiWanted', () => this.onUiWanted?.()),
        ];
        this._owned = false;
        this._watch = Gio.bus_watch_name_on_connection(this._bus, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => {
                this._owned = true;
                this.onAppeared?.();
            }, () => {
                // Stopped or crashed in use: every handle is dead.
                const lost = this._owned && this._targets.size > 0;
                this._owned = false;
                if (!lost)
                    return;
                this._targets.clear();
                for (const [feed, onEnded] of this._feeds) {
                    this._feeds.delete(feed);
                    onEnded?.(-1);
                }
                this.onLost?.();
            });
    }

    _subscribe(name, callback) {
        return this._bus.signal_subscribe(BUS_NAME, INTERFACE, name, OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, _name, params) => {
                try {
                    callback(params.deepUnpack());
                } catch (e) {
                    logError(e);
                }
            });
    }

    destroy() {
        for (const id of this._signals)
            this._bus.signal_unsubscribe(id);
        this._signals = [];
        Gio.bus_unwatch_name(this._watch);
        for (const feed of this._feeds.keys())
            this.closeFeed(feed);
        for (const [id, target] of this._targets) {
            if (target.remote)
                this._void('Release', new GLib.Variant('(s)', [id]));
        }
        this._targets.clear();
        this._void('Detach', null);
    }

    async installed() {
        const [names] = (await busCall(this._bus, 'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListActivatableNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null)).deepUnpack();
        return this._owned || names.includes(BUS_NAME);
    }

    _call(method, params, type, cancellable = null) {
        return busCall(this._bus, BUS_NAME, OBJECT_PATH, INTERFACE, method, params,
            type ? new GLib.VariantType(type) : null, Gio.DBusCallFlags.NONE, GLib.MAXINT32, cancellable)
            .then(reply => reply.deepUnpack(), e => {
                throw this._error(e);
            });
    }

    _void(method, params) {
        this._call(method, params, null).catch(e => console.debug(`nook: app: ${e.message}`));
    }

    _error(e) {
        if (!(e instanceof GLib.Error) || Gio.DBusError.get_remote_error(e) !== ERROR)
            return e;
        Gio.DBusError.strip_remote_error(e);
        let fields;
        try {
            fields = JSON.parse(e.message).$error;
        } catch {
            return e;
        }
        // A home gone after a rebuild is as soft as a lost connection for the cards.
        if (fields.name === 'BridgeError') {
            return new GLib.Error(Gio.IOErrorEnum,
                fields.code === 'gone' ? Gio.IOErrorEnum.NOT_FOUND : Gio.IOErrorEnum.FAILED, fields.message);
        }
        return reviveError(fields, ERRORS);
    }

    // The settings and logins from before the app, handed over once.
    async migrate(settings) {
        const [wantsSettings, wantsSecrets] = await this._call('Wants', null, '(bb)');
        if (wantsSettings)
            await this.import(settings);
        if (wantsSecrets)
            await this._call('ImportSecrets', new GLib.Variant('(a(sss))', [await savedLogins()]), '(b)');
    }

    async import(settings) {
        const values = {};
        for (const key of DEVICE_KEYS) {
            if (settings.settings_schema.has_key(key) && settings.get_user_value(key) !== null)
                values[key] = settings.get_value(key);
        }
        const [taken] = await this._call('Import', new GLib.Variant('(a{sv})', [values]), '(b)');
        return taken;
    }

    async attach() {
        this._attached++;
        const [version, json] = await this._call('Attach', null, '(us)');
        if (version !== API_VERSION)
            return {version, homes: []};
        return {version, homes: JSON.parse(json).homes.map(info => this._remote(info))};
    }

    // state: 'ok', 'none', 'unreadable' or 'keyring' (with message).
    async xiaomi() {
        const [json] = await this._call('Xiaomi', null, '(s)');
        const {state, message, homes} = JSON.parse(json);
        return {state, message, homes: homes.map(info => this._remote(info))};
    }

    detach() {
        for (const [id, target] of this._targets) {
            if (!target.remote)
                this._targets.delete(id);
        }
        this._void('Detach', null);
    }

    // Skipped if the menu attached again meanwhile.
    detachAfter(waits) {
        const attached = this._attached;
        if (waits.length === 0) {
            this.detach();
            return;
        }
        let done = false;
        const finish = () => {
            if (!done && this._attached === attached)
                this.detach();
            done = true;
        };
        const deadline = Timers.timeout(RESTORE_MS, () => {
            finish();
            return GLib.SOURCE_REMOVE;
        }, {cleanup: finish});
        Promise.allSettled(waits).then(() => {
            Timers.remove(deadline);
            finish();
        }).catch(logError);
    }

    async open(kind, args = {}) {
        const [json] = await this._call('Open', new GLib.Variant('(ss)', [kind, JSON.stringify(args)]), '(s)');
        return this._remote({...JSON.parse(json), remote: true});
    }

    release(proxy) {
        const target = proxy?.[TARGET];
        if (!target || !this._targets.has(target.id))
            return;
        this._targets.delete(target.id);
        this._void('Release', new GLib.Variant('(s)', [target.id]));
    }

    // onEnded(status) only for an exit the caller didn't ask for.
    async openFeed(did, onEnded) {
        const [reply, fds] = await busCallWithFds(this._bus, BUS_NAME, OBJECT_PATH, INTERFACE, 'OpenFeed',
            new GLib.Variant('(s)', [did]), new GLib.VariantType('(hs)'), Gio.DBusCallFlags.NONE, GLib.MAXINT32,
            null, null).catch(e => {
            throw this._error(e);
        });
        const [index, feed] = reply.deepUnpack();
        this._feeds.set(feed, onEnded);
        return {stream: new GioUnix.InputStream({fd: fds.get(index), close_fd: true}), feed};
    }

    closeFeed(feed) {
        if (!this._feeds.delete(feed))
            return;
        this._void('CloseFeed', new GLib.Variant('(s)', [feed]));
    }

    // values: {key: GLib.Variant}.
    setUi(values) {
        this._void('SetUi', new GLib.Variant('(a{sv})', [values]));
    }

    // target: "find", "accounts-hue", "accounts-tapo <did>"... false when not installed.
    openWindow(target) {
        const app = Shell.AppSystem.get_default().lookup_app(`${BUS_NAME}.desktop`);
        if (!app)
            return false;
        app.activate();
        busCall(this._bus, BUS_NAME, APP_PATH, 'org.freedesktop.Application', 'ActivateAction',
            new GLib.Variant('(sava{sv})', ['show-page', [new GLib.Variant('s', target)], {}]), null,
            Gio.DBusCallFlags.NONE, -1, null).catch(e => console.debug(`nook: app: ${e.message}`));
        return true;
    }

    async still(did) {
        const [jpeg] = await this._call('Still', new GLib.Variant('(s)', [did]), '(ay)');
        return jpeg;
    }

    _hooks() {
        return {
            device: (home, did) => this._targets.get(home)?.byDid.get(did) ?? null,
            remote: info => this._remote({...info, remote: true}),
            error: fields => reviveError(fields, ERRORS),
        };
    }

    _remote(info) {
        const known = this._targets.get(info.id);
        if (known) {
            this._apply(known, info);
            return known.proxy;
        }
        const target = {
            id: info.id,
            kind: info.kind,
            remote: Boolean(info.remote),
            methods: new Set(info.methods),
            devices: [],
            byDid: new Map(),
            owned: new Map(),
            mirror: {},
            icons: new Map(),
            handlers: {},
            local: {},
        };
        target.proxy = new Proxy(target, {
            get: (t, name) => this._get(t, name),
            set: (t, name, value) => this._set(t, name, value),
        });
        this._targets.set(info.id, target);
        this._apply(target, info);
        return target.proxy;
    }

    _device(target, did) {
        let device = target.byDid.get(did);
        if (!device) {
            device = {did};
            Object.defineProperty(device, 'source', {value: target.proxy, enumerable: false});
            target.byDid.set(did, device);
        }
        return device;
    }

    // Only keys the app set are dropped: the menu's own writes (optimistic values,
    // extra readings) stay.
    _apply(target, patch) {
        if (patch.devices) {
            const order = patch.devices;
            for (const did of [...target.byDid.keys()].filter(d => !order.includes(d))) {
                target.byDid.delete(did);
                target.owned.delete(did);
            }
            const same = order.length === target.devices.length && order.every((did, i) => target.devices[i].did === did);
            if (!same)
                target.devices = order.map(did => this._device(target, did));
        }
        const hooks = this._hooks();
        for (const [did, snapshot] of Object.entries(patch.set ?? {})) {
            const device = this._device(target, did);
            for (const key of target.owned.get(did) ?? []) {
                if (!(key in snapshot))
                    delete device[key];
            }
            Object.assign(device, decode(snapshot, hooks));
            target.owned.set(did, Object.keys(snapshot));
        }
        for (const [key, value] of Object.entries(patch.mirror ?? {}))
            target.mirror[key] = decode(value, hooks);
        for (const [did, icons] of Object.entries(patch.icons ?? {})) {
            for (const [id, data] of Object.entries(icons))
                target.icons.set(`${did}\n${id}`, decode({$icon: data}));
        }
    }

    _changed(id, json) {
        const target = this._targets.get(id);
        if (target)
            this._apply(target, JSON.parse(json));
    }

    _event(id, name, json) {
        const handler = this._targets.get(id)?.handlers[name];
        if (handler)
            handler(...decode(JSON.parse(json), this._hooks()));
    }

    _get(target, name) {
        if (name === TARGET)
            return target;
        if (typeof name === 'symbol' || name === 'then')
            return undefined;
        if (name === 'devices')
            return target.devices;
        if (EVENTS.includes(name))
            return target.handlers[name] ?? null;
        if (name in target.local)
            return target.local[name];
        const spec = MIRROR[target.kind] ?? {};
        if (spec.fields?.includes(name) || spec.getters?.includes(name))
            return target.mirror[name];
        if (spec.perDevice && name in spec.perDevice) {
            return (device, arg = null) =>
                target.mirror[arg === null ? name : `${name}/${arg}`]?.[device?.did] ?? null;
        }
        const own = this._sync(target, name);
        if (own)
            return own;
        if (target.methods.has(name))
            return (...args) => this.call(target, name, args);
        return undefined;
    }

    _sync(target, name) {
        if (target.kind === 'tv' && name === 'appIcon')
            return (device, id) => target.icons.get(`${device.did}\n${id}`) ?? null;
        if (target.kind === 'tapo' && name === 'refused') {
            return device => {
                (target.mirror.isRefused ??= {})[device.did] = true;
                this.call(target, 'refused', [device]).catch(logError);
            };
        }
        if (target.kind === 'gateway' && name === 'state')
            return sid => target.mirror.states?.get(sid) ?? null;
        return null;
    }

    _set(target, name, value) {
        if (EVENTS.includes(name)) {
            target.handlers[name] = value;
        } else {
            target.local[name] = value;
            if (WRITABLE[target.kind]?.includes(name))
                this.call(target, '$set', [name, value]).catch(logError);
        }
        return true;
    }

    async call(target, method, args) {
        let token = '';
        let cancellable = null;
        let handler = 0;
        const hooks = {
            device: value => {
                const owner = Object.getOwnPropertyDescriptor(value, 'source')?.value?.[TARGET];
                return owner ? {home: owner.id, did: value.did} : null;
            },
            handle: value => {
                const owner = value?.[TARGET];
                return owner ? {id: owner.id} : null;
            },
            cancellable: value => {
                cancellable = value;
                token = `t${++this._next}`;
                handler = value.connect(() => this._void('Cancel', new GLib.Variant('(s)', [token])));
                return token;
            },
        };
        const json = JSON.stringify(encode(args, hooks));
        try {
            const [result] = await this._call('Call', new GLib.Variant('(ssss)', [target.id, method, json, token]), '(s)');
            return decode(JSON.parse(result), this._hooks());
        } finally {
            if (handler)
                cancellable.disconnect(handler);
        }
    }
}

// Usable before Open returns: the menu reads off and may stop() it right away.
export class Beacons {
    constructor(app, onBeacon) {
        this._app = app;
        this._onBeacon = onBeacon;
        this._remote = null;
        this._stopped = false;
        this.onLocked = null;
        this.off = false;
    }

    async start() {
        const remote = await this._app.open('beacons');
        if (this._stopped) {
            this._app.release(remote);
            return;
        }
        this._remote = remote;
        remote.onBeacon = (address, beacon) => this._onBeacon(address, beacon);
        remote.onLocked = address => this.onLocked?.(address);
        await remote.start();
        this.off ||= remote.off;
    }

    setKey(address, key) {
        this._remote?.setKey(address, key).catch(logError);
    }

    stop() {
        this._stopped = true;
        if (!this._remote)
            return;
        this._remote.stop().catch(e => console.debug(`nook: bluetooth: ${e.message}`));
        this._app.release(this._remote);
        this._remote = null;
    }
}
