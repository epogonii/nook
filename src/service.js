// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import {API_VERSION} from './constants.js';
import {ERROR, EVENTS, INTERFACE_XML, MIRROR, OBJECT_PATH, WRITABLE, decode, encode, methodsOf} from './bridge.js';
import {DEVICE_KEYS, GatewayAlerts, Homes, openBeacons} from './homes.js';
import {MenuSettings} from './menu-settings.js';
import * as Secrets from './lib/secrets.js';

Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

// An import or a login changes several keys at once.
const REBUILD_DELAY = 300;

class BridgeError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

function mirrorOf(kind, object, hooks) {
    const spec = MIRROR[kind];
    if (!spec)
        return {};
    const out = {};
    for (const name of [...spec.fields ?? [], ...spec.getters ?? []])
        out[name] = encode(object[name], hooks);
    for (const [method, variants] of Object.entries(spec.perDevice ?? {})) {
        for (const arg of variants) {
            const values = {};
            for (const device of object.devices ?? []) {
                try {
                    values[device.did] = encode(object[method](device, ...arg === null ? [] : [arg]), hooks);
                } catch {
                    values[device.did] = null;
                }
            }
            out[arg === null ? method : `${method}/${arg}`] = values;
        }
    }
    return out;
}

// Homes are shared by all clients: one Home Assistant socket, not one per client.
export class Service {
    constructor(application, settings) {
        this._application = application;
        this._settings = settings;
        this._homes = new Homes(settings);
        this._built = false;
        this._objects = new Map();
        this._ids = new WeakMap();
        this._clients = new Map();
        this._cancellables = new Map();
        this._feeds = new Map();
        this._window = null;
        this._next = 0;
        this._rebuild = 0;
        this._exported = null;
        this.menu = new MenuSettings();
        this.menu.send = values => this._emit('UiChanged', '(a{sv})', [values]);
        this._uiOwner = null;
        this._uiWatch = 0;
        this._changed = settings.connect('changed', (_settings, key) => {
            if (DEVICE_KEYS.includes(key) && !this._homes.keeping)
                this._rebuildSoon();
        });
    }

    export(connection) {
        this._connection = connection;
        this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._exported.export(connection, OBJECT_PATH);
    }

    unexport() {
        for (const sender of [...this._clients.keys()])
            this._drop(sender);
        this._closeHomes();
        if (this._rebuild)
            GLib.source_remove(this._rebuild);
        this._rebuild = 0;
        this._settings.disconnect(this._changed);
        this._uiGone(this._uiOwner);
        this._exported?.unexport();
        this._exported = null;
    }

    _emit(name, signature, values) {
        this._exported?.emit_signal(name, new GLib.Variant(signature, values));
    }

    _fail(invocation, e) {
        if (!(e instanceof BridgeError))
            console.debug(`nook: ${e.message}`);
        invocation.return_dbus_error(ERROR, JSON.stringify(encode(e)));
    }

    // A client holds the app until it lets go of everything or leaves the bus.
    _client(sender) {
        let client = this._clients.get(sender);
        if (client)
            return client;
        client = {attached: false, remotes: new Set(), feeds: new Set(), watch: 0};
        this._clients.set(sender, client);
        client.watch = Gio.bus_watch_name_on_connection(this._connection, sender,
            Gio.BusNameWatcherFlags.NONE, null, () => this._drop(sender));
        this._application.hold();
        return client;
    }

    _drop(sender) {
        const client = this._clients.get(sender);
        if (!client)
            return;
        this._clients.delete(sender);
        Gio.bus_unwatch_name(client.watch);
        for (const id of client.remotes)
            this._release(id);
        for (const feed of client.feeds)
            this._closeFeed(feed);
        this._application.release();
        if (!this._attached())
            this._closeHomes();
    }

    _attached() {
        return Boolean(this._window) || [...this._clients.values()].some(c => c.attached);
    }

    // The app's own window is one more attached client, in this process.
    attachWindow(window) {
        if (!this._window)
            this._application.hold();
        this._window = window;
        return this._ensureHomes();
    }

    detachWindow() {
        if (!this._window)
            return;
        this._window = null;
        this._application.release();
        if (!this._attached())
            this._closeHomes();
    }

    _known(invocation) {
        const client = this._clients.get(invocation.get_sender());
        if (!client)
            throw new BridgeError('Attach first', 'detached');
        return client;
    }

    _register(id, kind, object, owner = null) {
        const entry = {
            object, kind, owner, methods: methodsOf(object),
            sent: {order: '', devices: new Map(), mirror: new Map(), icons: new Set()},
        };
        this._objects.set(id, entry);
        this._ids.set(object, id);
        for (const name of EVENTS) {
            if (!(name in object) || (object[name] !== null && typeof object[name] !== 'function'))
                continue;
            const own = object[name];
            object[name] = (...args) => {
                own?.(...args);
                this._event(id, name, args);
            };
        }
        return entry;
    }

    _hooks(client) {
        return {
            device: value => {
                const descriptor = Object.getOwnPropertyDescriptor(value, 'source');
                const home = descriptor && !descriptor.enumerable ? this._ids.get(descriptor.value) : null;
                return home && typeof value.did === 'string' ? {home, did: value.did} : null;
            },
            remote: value => (client ? this._remote(value, client) : null),
        };
    }

    _remote(object, client) {
        const known = this._ids.get(object);
        if (known && this._objects.has(known))
            return this._describe(known);
        const id = `r${++this._next}`;
        this._register(id, object.constructor?.name ?? 'object', object, client);
        client.remotes.add(id);
        return this._describe(id);
    }

    _describe(id) {
        const {kind, methods} = this._objects.get(id);
        return {id, kind, methods};
    }

    _snapshot(device, hooks) {
        const out = {};
        for (const [key, value] of Object.entries(device)) {
            if (value !== undefined && typeof value !== 'function')
                out[key] = encode(value, hooks);
        }
        return out;
    }

    // full: everything, for a client that has nothing yet.
    _patch(entry, full = false) {
        const {object, kind, sent} = entry;
        const hooks = this._hooks(null);
        const patch = {};
        if (Array.isArray(object.devices)) {
            const order = object.devices.map(d => d.did);
            const orderJson = JSON.stringify(order);
            if (full || orderJson !== sent.order)
                patch.devices = order;
            const set = {};
            for (const device of object.devices) {
                const snapshot = this._snapshot(device, hooks);
                const json = JSON.stringify(snapshot);
                if (full || sent.devices.get(device.did) !== json)
                    set[device.did] = snapshot;
                if (!full)
                    sent.devices.set(device.did, json);
            }
            if (!full) {
                sent.order = orderJson;
                for (const did of [...sent.devices.keys()].filter(d => !order.includes(d)))
                    sent.devices.delete(did);
            }
            if (Object.keys(set).length > 0)
                patch.set = set;
        }
        const mirror = {};
        for (const [key, value] of Object.entries(mirrorOf(kind, object, hooks))) {
            const json = JSON.stringify(value);
            if (full || sent.mirror.get(key) !== json)
                mirror[key] = value;
            if (!full)
                sent.mirror.set(key, json);
        }
        if (Object.keys(mirror).length > 0)
            patch.mirror = mirror;
        const icons = kind === 'tv' ? this._icons(entry, full) : null;
        if (icons)
            patch.icons = icons;
        return Object.keys(patch).length > 0 ? patch : null;
    }

    // Sent once each: too big for every patch.
    _icons({object, sent}, full) {
        let icons = null;
        for (const device of object.devices) {
            let items = null;
            try {
                items = object.listed(device, 'apps');
            } catch {}
            for (const {id} of items ?? []) {
                const icon = object.appIcon(device, id);
                const key = `${device.did}\n${id}`;
                if (!(icon instanceof Gio.BytesIcon) || (!full && sent.icons.has(key)))
                    continue;
                if (!full)
                    sent.icons.add(key);
                icons ??= {};
                (icons[device.did] ??= {})[id] = encode(icon).$icon;
            }
        }
        return icons;
    }

    _flush(id) {
        const entry = this._objects.get(id);
        const patch = entry ? this._patch(entry) : null;
        if (patch)
            this._emit('Changed', '(ss)', [id, JSON.stringify(patch)]);
    }

    _flushAll() {
        for (const id of this._objects.keys())
            this._flush(id);
    }

    _event(id, name, args) {
        if (!this._objects.has(id))
            return;
        this._flush(id);
        this._emit('Event', '(sss)', [id, name, JSON.stringify(encode(args, this._hooks(null)))]);
        this._window?.onEvent(id, name);
    }

    _ensureHomes() {
        if (!this._built) {
            for (const {id, kind, home} of this._homes.build())
                this._register(id, kind, home);
            this._built = true;
        }
        return this._homes.list;
    }

    _full(id) {
        const entry = this._objects.get(id);
        return {id, kind: entry.kind, methods: entry.methods, ...this._patch(entry, true)};
    }

    _closeHomes() {
        for (const {id} of this._homes.list)
            this._objects.delete(id);
        this._homes.close();
        this._built = false;
    }

    _rebuildSoon() {
        // Nothing built yet: an Import before the first Attach.
        if (!this._built)
            return;
        if (this._rebuild)
            GLib.source_remove(this._rebuild);
        this._rebuild = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DELAY, () => {
            this._rebuild = 0;
            this._closeHomes();
            this._emit('Reloaded', '()', []);
            this._window?.onReloaded();
            return GLib.SOURCE_REMOVE;
        });
    }

    AttachAsync(_params, invocation) {
        try {
            const client = this._client(invocation.get_sender());
            client.attached = true;
            const ids = this._ensureHomes().map(({id}) => id);
            this._flushAll();
            invocation.return_value(new GLib.Variant('(us)',
                [API_VERSION, JSON.stringify({homes: ids.map(id => this._full(id))})]));
        } catch (e) {
            this._fail(invocation, e);
        }
    }

    homes() {
        return this._ensureHomes();
    }

    async xiaomi() {
        this._ensureHomes();
        const found = await this._homes.xiaomi();
        for (const {id, kind, home} of found.list) {
            if (!this._objects.has(id))
                this._register(id, kind, home);
        }
        return found;
    }

    // Not part of Attach: a locked keyring waits on the user.
    async XiaomiAsync(_params, invocation) {
        try {
            this._known(invocation);
            const {state, message, list} = await this.xiaomi();
            this._flushAll();
            const homes = list.filter(({id}) => this._objects.has(id)).map(({id}) => this._full(id));
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({state, message, homes})]));
        } catch (e) {
            this._fail(invocation, e);
        }
    }

    DetachAsync(_params, invocation) {
        const client = this._clients.get(invocation.get_sender());
        if (client) {
            client.attached = false;
            if (client.remotes.size === 0 && client.feeds.size === 0)
                this._drop(invocation.get_sender());
            else if (!this._attached())
                this._closeHomes();
        }
        invocation.return_value(null);
    }

    WantsAsync(_params, invocation) {
        invocation.return_value(new GLib.Variant('(bb)', [
            !this._settings.get_boolean('imported'), !this._settings.get_boolean('secrets-imported')]));
    }

    // items: [service, label, secret]. A login the app already has is kept.
    async ImportSecretsAsync([items], invocation) {
        try {
            let taken = false;
            if (!this._settings.get_boolean('secrets-imported')) {
                for (const [service, label, secret] of items) {
                    if (await Secrets.lookup(service))
                        continue;
                    await Secrets.store(service, label, secret);
                    taken = true;
                }
                this._settings.set_boolean('secrets-imported', true);
            }
            // Mi Home looked for its login before it arrived.
            if (taken)
                this._rebuildSoon();
            invocation.return_value(new GLib.Variant('(b)', [taken]));
        } catch (e) {
            this._fail(invocation, e);
        }
    }

    // Once; a key the app has a value for already is kept.
    ImportAsync([values], invocation) {
        let taken = false;
        if (!this._settings.get_boolean('imported')) {
            for (const [key, value] of Object.entries(values)) {
                if ((!DEVICE_KEYS.includes(key) && key !== 'find-skipped') || this._settings.get_user_value(key) !== null)
                    continue;
                try {
                    this._settings.set_value(key, value);
                    taken = true;
                } catch (e) {
                    console.warn(`nook: import ${key}: ${e.message}`);
                }
            }
            this._settings.set_boolean('imported', true);
        }
        invocation.return_value(new GLib.Variant('(b)', [taken]));
    }

    async CallAsync([id, method, args, token], invocation) {
        let cancellable = null;
        try {
            const client = this._known(invocation);
            const entry = this._objects.get(id);
            if (!entry)
                throw new BridgeError(`${id} is gone`, 'gone');
            const hooks = {
                ...this._hooks(client),
                device: (home, did) => this._device(home, did),
                remote: info => this._objects.get(info?.id)?.object ?? null,
                cancellable: () => {
                    if (!cancellable && token) {
                        cancellable = new Gio.Cancellable();
                        this._cancellables.set(token, cancellable);
                    }
                    return cancellable;
                },
            };
            const decoded = decode(JSON.parse(args), hooks);
            let result = null;
            if (method === '$set') {
                const [field, value] = decoded;
                if (!WRITABLE[entry.kind]?.includes(field))
                    throw new BridgeError(`${field} can't be set`, 'refused');
                entry.object[field] = value;
            } else {
                if (!entry.methods.includes(method))
                    throw new BridgeError(`No ${method} on ${id}`, 'refused');
                result = await entry.object[method](...decoded);
            }
            this._flushAll();
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(encode(result, this._hooks(client)))]));
        } catch (e) {
            this._flushAll();
            this._fail(invocation, e);
        } finally {
            if (token)
                this._cancellables.delete(token);
        }
    }

    CancelAsync([token], invocation) {
        this._cancellables.get(token)?.cancel();
        invocation.return_value(null);
    }

    // Whether the extension's gateway listener heard a report yet; null without one.
    get gatewayHeard() {
        for (const entry of this._objects.values()) {
            if (entry.kind === 'gateway')
                return entry.object.heard;
        }
        return null;
    }

    _device(home, did) {
        const entry = this._objects.get(home);
        return entry?.object.devices?.find(d => d.did === did) ?? null;
    }

    _homeDevice(kind, did) {
        for (const {id} of this._homes.list) {
            const entry = this._objects.get(id);
            const device = entry?.kind === kind ? entry.object.devices.find(d => d.did === did) : null;
            if (device)
                return {home: entry.object, device};
        }
        throw new BridgeError(`No ${kind} device ${did}`, 'gone');
    }

    async OpenAsync([kind, args], invocation) {
        try {
            const client = this._client(invocation.get_sender());
            const id = `r${++this._next}`;
            let object;
            switch (kind) {
            case 'beacons':
                object = openBeacons((address, beacon) => this._event(id, 'onBeacon', [address, beacon]));
                break;
            case 'gateway':
                object = new GatewayAlerts(this._settings, report => this._event(id, 'onReport', [report]));
                break;
            case 'camera-api': {
                this._ensureHomes();
                const {home, device} = this._homeDevice('tapo', JSON.parse(args).did);
                object = await home.openApi(device);
                break;
            }
            default:
                throw new BridgeError(`Can't open ${kind}`, 'refused');
            }
            this._register(id, kind, object, client);
            client.remotes.add(id);
            const entry = this._objects.get(id);
            invocation.return_value(new GLib.Variant('(s)',
                [JSON.stringify({...this._describe(id), ...this._patch(entry, true)})]));
        } catch (e) {
            this._fail(invocation, e);
        }
    }

    _release(id) {
        const entry = this._objects.get(id);
        if (!entry?.owner)
            return;
        this._objects.delete(id);
        entry.owner.remotes.delete(id);
        try {
            entry.object.abort?.();
        } catch (e) {
            logError(e);
        }
    }

    ReleaseAsync([id], invocation) {
        const entry = this._objects.get(id);
        if (entry?.owner === this._clients.get(invocation.get_sender()))
            this._release(id);
        invocation.return_value(null);
    }

    // The caller reads feed.js's stdout from the passed fd; FeedEnded reports the exit.
    async OpenFeedAsync([did], invocation) {
        try {
            const client = this._known(invocation);
            const {home, device} = this._homeDevice('tapo', did);
            const process = await home.startFeed(device);
            const feed = `f${++this._next}`;
            const pipe = process.get_stdout_pipe();
            if (!(pipe instanceof GioUnix.InputStream))
                throw new BridgeError('No pipe to pass on', 'refused');
            const fds = new Gio.UnixFDList();
            fds.append(pipe.get_fd());
            pipe.close(null);
            this._feeds.set(feed, {process, client});
            client.feeds.add(feed);
            process.wait_async(null).then(() => {
                if (!this._feeds.delete(feed))
                    return;
                client.feeds.delete(feed);
                const status = process.get_if_exited() ? process.get_exit_status() : -1;
                this._emit('FeedEnded', '(si)', [feed, status]);
            }).catch(logError);
            invocation.return_value_with_unix_fd_list(new GLib.Variant('(hs)', [0, feed]), fds);
        } catch (e) {
            this._fail(invocation, e);
        }
    }

    _closeFeed(feed) {
        const known = this._feeds.get(feed);
        if (!known)
            return;
        this._feeds.delete(feed);
        known.client.feeds.delete(feed);
        known.process.force_exit();
    }

    CloseFeedAsync([feed], invocation) {
        if (this._feeds.get(feed)?.client === this._clients.get(invocation.get_sender()))
            this._closeFeed(feed);
        invocation.return_value(null);
    }

    async StillAsync([did], invocation) {
        try {
            this._known(invocation);
            const {home, device} = this._homeDevice('tapo', did);
            const jpeg = await home.still(device);
            invocation.return_value(new GLib.Variant('(ay)', [jpeg]));
        } catch (e) {
            this._fail(invocation, e);
        }
    }

    // The extension's settings, all at first and then each change; names and icons are
    // kept here too, for this window while the extension is away.
    SetUiAsync([values], invocation) {
        const sender = invocation.get_sender();
        if (this._uiOwner !== sender) {
            this._uiGone(this._uiOwner);
            this._uiOwner = sender;
            this._uiWatch = Gio.bus_watch_name_on_connection(this._connection, sender,
                Gio.BusNameWatcherFlags.NONE, null, () => this._uiGone(sender));
        }
        this.menu.update(values);
        for (const key of ['names', 'icons']) {
            const value = values[key];
            if (value?.get_type_string() === 'a{ss}' && !value.equal(this._settings.get_value(key)))
                this._settings.set_value(key, value);
        }
        invocation.return_value(null);
    }

    _uiGone(sender) {
        if (!sender || sender !== this._uiOwner)
            return;
        Gio.bus_unwatch_name(this._uiWatch);
        this._uiWatch = 0;
        this._uiOwner = null;
        this.menu.clear();
    }

    // The window opened: the extension sends everything again, with the apps that notify.
    wantUi() {
        this._emit('UiWanted', '()', []);
    }
}

