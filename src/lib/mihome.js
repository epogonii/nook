// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {SERVERS, XiaomiError} from './xiaomi.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const SPEC_URL = 'https://miot-spec.org/miot-spec-v2/instance?type=';

// Bump when the cached format changes, so older files are ignored.
export const CACHE_VERSION = 3;
const SPEC_VERSION = '3';

const READINGS = [
    'temperature',
    'relative-humidity',
    'contact-state',
    'motion-state',
    'submersion-state',
    'smoke-concentration',
    'status',
    'battery-level',
];

const BATCH = 20;

// Their miot spec has only the light's on/off; brightness and colour go over miIO as
// (brightness << 24) | rgb, 0 while off. Given to the card as two more properties.
const RGB_GATEWAYS = ['lumi.gateway.v2', 'lumi.gateway.v3', 'lumi.gateway.mieu01'];
const RGB_BRIGHTNESS = 101;
const RGB_COLOR = 102;
const isRgb = (device, piid) => RGB_GATEWAYS.includes(device.model) && [RGB_BRIGHTNESS, RGB_COLOR].includes(piid);

function withRgb(services) {
    return services.map(s => (s.name !== 'light' || s.properties.some(p => p.name === 'color') ? s : {
        ...s,
        properties: [
            ...s.properties,
            {piid: RGB_BRIGHTNESS, name: 'brightness', format: 'uint8', access: ['read', 'write'], unit: 'percentage',
                range: [1, 100, 1]},
            {piid: RGB_COLOR, name: 'color', format: 'uint32', access: ['read', 'write'], range: [1, 0xffffff, 1]},
        ],
    }));
}

// Pace requests to look like a phone opening Mi Home now and then, never a poller: full
// reads at least READ_GAP apart, failures back off doubling up to MAX_BACKOFF, discovery
// at most once per DISCOVER_GAP.
const READ_GAP = 15 * 1000;
const MAX_BACKOFF = 10 * 60 * 1000;
const DISCOVER_GAP = 60 * 1000;

const ONLINE_GAP = 5 * 60 * 1000;
const EVENTS_GAP = 30 * 60 * 1000;
const EVENTS_RETRY = 5 * 60 * 1000;
const BEACON_RETRY = 60 * 1000;
const HISTORY_FRESH = 5 * 60 * 1000;
// The cloud allows up to 1000 per page but tends to time out serving that many.
const HISTORY_PAGE = 300;
const SLOW_DOWN = 429;
const TOLD_SPAN = 12 * 3600;
const TOLD_FRESH = 20 * 1000;
const EVENT_LOG_FRESH = 60 * 1000;

// Cloud code for every property of a legacy device its spec mapping doesn't cover,
// online or not.
const UNSUPPORTED = -704002000;

const EVENT_HISTORY = 30 * 86400;
const MAP_HISTORY = 365 * 86400;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// urn:miot-spec-v2:property:temperature:00000020:... reads as "temperature".
const short = urn => urn?.split(':')[3] ?? '';

const propKey = p => `${p.did}/${p.siid}/${p.piid}`;

function cacheFile(...parts) {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'nook', ...parts]));
}

async function readJson(file) {
    try {
        const [contents] = await file.load_contents_async(null);
        return JSON.parse(decoder.decode(contents));
    } catch (e) {
        if (e instanceof SyntaxError || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return null;
        throw e;
    }
}

// Owner-only: the device list holds IP addresses, rooms and home names.
async function writeJson(file, data) {
    GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700);
    await file.replace_contents_bytes_async(new GLib.Bytes(encoder.encode(JSON.stringify(data))),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
}

// Network and firmware details from the device list; the device token is never kept.
// Gateway sub-devices and BLE devices report their relay's network, which is skipped.
function aboutOf(d) {
    const extra = d.extra ?? {};
    const about = {
        firmware: extra.fw_version ? String(extra.fw_version) : null,
        mcu: extra.mcu_version ? String(extra.mcu_version) : null,
        lastOnline: Number(d.last_online) || null,
    };
    if (d.parent_id)
        return {...about, parent: String(d.parent_id)};
    if (String(d.did).startsWith('blt.'))
        return {...about, mac: d.mac || null};
    return {
        ...about,
        ssid: d.ssid || null,
        rssi: Number(d.rssi) < 0 ? Number(d.rssi) : null,
        ip: d.localip || null,
        mac: d.mac || null,
    };
}

function trimSpec(spec) {
    return (spec.services ?? []).filter(s => s.iid !== 1).map(s => ({
        siid: s.iid,
        name: short(s.type),
        description: s.description ?? null,
        actions: (s.actions ?? []).map(a => ({aiid: a.iid, name: short(a.type), in: a.in ?? []})),
        properties: (s.properties ?? []).map(p => ({
            piid: p.iid,
            name: short(p.type),
            format: p.format,
            access: p.access ?? [],
            unit: p.unit,
            range: p['value-range'],
            choices: p['value-list']?.map(({value, description}) => ({value, description})),
        })),
    }));
}

function pickPrimary(services) {
    for (const service of services) {
        const on = service.properties.find(p =>
            p.name === 'on' && p.format === 'bool' && p.access.includes('write'));
        if (on)
            return {kind: 'switch', props: [{siid: service.siid, service: service.name, ...on}]};
    }

    const readable = services.flatMap(s => s.properties
        .filter(p => p.access.includes('read'))
        .map(p => ({siid: s.siid, ...p})));
    const props = READINGS.flatMap(name => readable.filter(p => p.name === name)).slice(0, 2);
    return {kind: props.length > 0 ? 'reading' : 'none', props};
}

function better(candidate, known) {
    if (candidate.online !== known.online)
        return candidate.online;
    return Boolean(candidate.room) && !known.room;
}

const cancelled = e => e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;

export async function cachedDevices(userId) {
    if (!userId)
        return [];
    try {
        const cached = await readJson(cacheFile(`xiaomi-${userId}.json`));
        return cached?.version === CACHE_VERSION ? cached.devices : [];
    } catch {
        return [];
    }
}

export class DeviceError extends XiaomiError {
    constructor(message, code) {
        super(message, code);
        this.name = 'DeviceError';
    }
}

// Module-level so pacing survives the new MiHome made after a screen lock.
const pacing = new Map();

export function clearPacing() {
    pacing.clear();
}

function pacingFor(userId) {
    if (!pacing.has(userId)) {
        pacing.set(userId, {
            nextFullRead: 0,
            nextPartialRead: 0,
            nextDiscover: 0,
            nextOnline: 0,
            quietUntil: 0,
            backoff: READ_GAP,
            events: new Map(),
            lastEvents: new Map(),
            // Gateway light as last seen on: get_rgb gives 0 while it is off.
            lights: new Map(),
        });
    }
    return pacing.get(userId);
}

export class MiHome {
    constructor(cloud) {
        this._cloud = cloud;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._kept = new Map();
        this._pace = pacingFor(String(cloud.credentials.userId));
        this._busy = false;
        this._waiting = [];
        this._discovering = false;
        this._services = new Map();
        this.devices = [];
        this.servers = [];
        this.homes = [];
        this.homeName = null;
        this.extras = [];
    }

    get loggedIn() {
        return this._cloud.loggedIn;
    }

    // Set after a failed request; nothing goes to the cloud before it.
    get quietUntil() {
        return this._pace.quietUntil;
    }

    // Non-enumerable: device.source would make the cached JSON circular.
    _adopt() {
        for (const device of this.devices) {
            Object.defineProperty(device, 'source', {value: this, enumerable: false, configurable: true});
            if (this._pace.lastEvents.has(device.did))
                device.lastEvent = this._pace.lastEvents.get(device.did);
        }
    }

    abort() {
        // An interrupted discovery must not count against DISCOVER_GAP, or the next
        // MiHome starts with nothing to show.
        if (this._discovering)
            this._pace.nextDiscover = 0;
        this._cancellable.cancel();
        this._cloud.abort();
        this._session.abort();
    }

    get _cacheFile() {
        return cacheFile(`xiaomi-${this._cloud.credentials.userId}.json`);
    }

    async load() {
        const cached = await readJson(this._cacheFile);
        if (cached?.version === CACHE_VERSION) {
            this.devices = cached.devices;
            this.servers = cached.servers;
            this.homes = cached.homes ?? [];
            this.homeName = cached.homeName;
            this._adopt();
            return;
        }
        await this.discover();
    }

    async _scan(server, homes) {
        const found = [];
        for (const home of await this._cloud.homes(server)) {
            const rooms = new Map();
            for (const room of home.rooms) {
                for (const did of room.dids ?? [])
                    rooms.set(did, room.name);
            }
            const devices = await this._cloud.devices(server, home);
            if (devices.length > 0)
                homes.push({server, homeId: home.homeId, ownerId: home.ownerId});
            for (const d of devices) {
                found.push({
                    did: d.did,
                    name: d.name,
                    model: d.model,
                    urn: d.spec_type ?? null,
                    server,
                    room: rooms.get(d.did) ?? null,
                    home: home.name ?? null,
                    online: Boolean(d.isOnline),
                    listed: Boolean(d.isOnline),
                    ...(String(d.did).startsWith('blt.') && d.mac ? {mac: d.mac} : {}),
                    about: aboutOf(d),
                });
            }
        }
        return found;
    }

    // List and values fetched side by side. The list goes first: the cloud keeps
    // answering for unplugged devices with their last values.
    readAll() {
        const pace = this._pace;
        return this._inTurn(async () => {
            const now = Date.now();
            if (now < pace.quietUntil)
                return false;
            const list = this.homes.length > 0 && now >= pace.nextOnline;
            const devices = now < pace.nextFullRead ? [] : this._readable(this.devices);
            if (!list && devices.length === 0)
                return false;
            try {
                await this._attempt(async () => {
                    if (list)
                        pace.nextOnline = Date.now() + ONLINE_GAP;
                    const [listed, values] = await Promise.all([
                        list ? this._fetchList() : null,
                        devices.length > 0 ? this._fetchValues(devices) : null,
                    ]);
                    if (listed)
                        this._applyList(listed);
                    if (values)
                        this._applyValues(devices, values);
                });
            } finally {
                if (devices.length > 0)
                    pace.nextFullRead = pace.nextPartialRead = Date.now() + READ_GAP;
            }
            return true;
        }, {background: true});
    }

    async _fetchList() {
        const lists = await Promise.all(this.homes.map(({server, homeId, ownerId}) =>
            this._cloud.devices(server, {homeId, ownerId})));
        const listed = new Map();
        const about = new Map();
        for (const d of lists.flat()) {
            listed.set(d.did, Boolean(d.isOnline) || listed.get(d.did) === true);
            if (!about.has(d.did) || d.isOnline)
                about.set(d.did, aboutOf(d));
        }
        return {listed, about};
    }

    _applyList({listed, about}) {
        for (const device of this.devices) {
            if (!listed.has(device.did))
                continue;
            device.listed = listed.get(device.did);
            device.about = about.get(device.did);
            if (!device.listed)
                device.online = false;
            else if (device.online === false && device.primary.props.length === 0)
                device.online = true;
        }
    }

    async discover() {
        this._discovering = true;
        try {
            await this._discover();
        } finally {
            this._discovering = false;
        }
    }

    async _discover() {
        const pace = this._pace;
        if (Date.now() < pace.nextDiscover)
            return;

        const homes = [];
        const scans = await this._guarded(async () => {
            // Recheck: a call queued ahead of this one may have just searched.
            if (Date.now() < pace.nextDiscover)
                return null;
            pace.nextDiscover = Date.now() + DISCOVER_GAP;
            pace.nextOnline = Date.now() + ONLINE_GAP;
            const results = await Promise.allSettled(SERVERS.map(server => this._scan(server, homes)));
            const failed = results.filter(r => r.status === 'rejected').map(r => r.reason);
            const stop = failed.find(cancelled);
            if (stop)
                throw stop;
            if (failed.length === results.length) {
                pace.nextDiscover = 0;
                throw failed[0];
            }
            return results;
        }, {background: true});

        if (!scans)
            return;
        if (!this._cloud.loggedIn) {
            pace.nextDiscover = 0;
            throw new XiaomiError('session expired, log in again');
        }

        const seen = new Map();
        const servers = [];
        scans.forEach((scan, i) => {
            const server = SERVERS[i];
            if (scan.status !== 'fulfilled') {
                homes.splice(0, homes.length, ...homes.filter(h => h.server !== server),
                    ...this.homes.filter(h => h.server === server));
                const kept = this.devices.filter(d => d.server === server);
                if (kept.length > 0)
                    servers.push(server);
                for (const device of kept) {
                    if (!seen.has(device.did))
                        seen.set(device.did, device);
                }
                return;
            }
            if (scan.value.length > 0)
                servers.push(SERVERS[i]);
            for (const device of scan.value) {
                const known = seen.get(device.did);
                if (!known || better(device, known))
                    seen.set(device.did, device);
            }
        });

        const before = new Map(this.devices.map(d => [d.did, d]));
        const devices = [...seen.values()];
        for (const device of devices) {
            const old = before.get(device.did);
            let services = null;
            try {
                services = device.urn ? await this._spec(device.urn) : [];
            } catch (e) {
                if (cancelled(e))
                    throw e;
                console.debug(`nook: spec of ${device.model}: ${e.message}`);
            }
            // A spec that failed to load this time keeps what the device had.
            device.primary = services ? pickPrimary(services) : old?.primary ?? pickPrimary([]);
            if (old) {
                device.values = old.values;
                device.extra = old.extra;
            }
        }

        const counts = new Map();
        for (const device of devices)
            counts.set(device.home, (counts.get(device.home) ?? 0) + 1);
        const homeName = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

        this.devices = devices;
        this.servers = servers;
        this.homes = homes;
        this.homeName = homeName;
        this._adopt();
        await writeJson(this._cacheFile, {version: CACHE_VERSION, servers, homes, homeName, devices});
    }

    async _spec(urn) {
        const file = cacheFile('specs', SPEC_VERSION, `${urn.replace(/[^\w.-]+/g, '_')}.json`);
        const cached = await readJson(file);
        if (cached)
            return cached;

        const msg = Soup.Message.new('GET', `${SPEC_URL}${encodeURIComponent(urn)}`);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.status_code === Soup.Status.NOT_FOUND)
            return [];
        if (msg.status_code !== Soup.Status.OK)
            throw new XiaomiError(`miot-spec answered HTTP ${msg.status_code}`);
        let services;
        try {
            services = trimSpec(JSON.parse(decoder.decode(bytes.toArray())));
        } catch (e) {
            if (!(e instanceof SyntaxError))
                throw e;
            throw new XiaomiError('miot-spec answered something else');
        }
        await writeJson(file, services);
        return services;
    }

    // Every cloud request goes through here, one at a time. A cloud or network failure
    // holds all requests back for the backoff gap; a DeviceError doesn't. A failed extra
    // (map, history) backs off only if the cloud answered SLOW_DOWN. Background requests
    // queue behind the ones a card or a tap waits on.
    _guarded(task, {extra = false, background = false} = {}) {
        return this._inTurn(() => this._attempt(task, extra), {background});
    }

    // The slot passes straight to the next in line, so nothing slips in between.
    async _inTurn(fn, {background = false} = {}) {
        if (this._busy) {
            await new Promise(resolve => {
                const at = background ? -1 : this._waiting.findIndex(w => w.background);
                this._waiting.splice(at < 0 ? this._waiting.length : at, 0, {background, resolve});
            });
        }
        this._busy = true;
        try {
            return await fn();
        } finally {
            const next = this._waiting.shift();
            if (next)
                next.resolve();
            else
                this._busy = false;
        }
    }

    // In a turn already held: readAll and readPrimary check their pacing there first.
    async _attempt(task, extra = false) {
        const pace = this._pace;
        if (Date.now() < pace.quietUntil)
            throw new XiaomiError('Xiaomi is not answering, trying again later');
        try {
            const result = await task();
            pace.backoff = READ_GAP;
            pace.quietUntil = 0;
            return result;
        } catch (e) {
            if (!cancelled(e) && !(e instanceof DeviceError) && (!extra || e.code === SLOW_DOWN)) {
                pace.backoff = Math.min(pace.backoff * 2, MAX_BACKOFF);
                pace.quietUntil = Date.now() + pace.backoff;
            }
            throw e;
        }
    }

    _extrasOf(device) {
        return this.extras.filter(e => e.did === device.did);
    }

    readPrimary(dids = null) {
        const pace = this._pace;
        return this._inTurn(async () => {
            const now = Date.now();
            if (now < pace.quietUntil || now < (dids ? pace.nextPartialRead : pace.nextFullRead))
                return false;
            const devices = this._readable(dids ? this.devices.filter(d => dids.includes(d.did)) : this.devices);
            if (devices.length === 0)
                return false;
            try {
                await this._attempt(async () => this._applyValues(devices, await this._fetchValues(devices)));
            } finally {
                pace.nextPartialRead = Date.now() + READ_GAP;
                if (!dids)
                    pace.nextFullRead = Date.now() + READ_GAP;
            }
            return true;
        }, {background: true});
    }

    _readable(devices) {
        return devices.filter(d => d.primary.props.length > 0 || this._extrasOf(d).length > 0);
    }

    async _fetchValues(devices) {
        const byServer = new Map();
        const ask = (device, p) => {
            const list = byServer.get(device.server) ?? [];
            list.push({did: device.did, siid: p.siid, piid: p.piid});
            byServer.set(device.server, list);
        };
        for (const device of devices) {
            for (const p of device.primary.props)
                ask(device, p);
            for (const extra of this._extrasOf(device))
                ask(device, extra);
        }

        const batches = [];
        for (const [server, props] of byServer) {
            for (let i = 0; i < props.length; i += BATCH)
                batches.push(this._cloud.getProperties(server, props.slice(i, i + BATCH)));
        }
        const values = new Map();
        for (const result of await Promise.all(batches)) {
            for (const r of result ?? [])
                values.set(propKey(r), r);
        }
        return values;
    }

    _applyValues(devices, values) {
        for (const device of devices) {
            device.extra = {};
            for (const extra of this._extrasOf(device)) {
                const answer = values.get(propKey(extra));
                if (answer?.code === 0)
                    device.extra[`${extra.siid}/${extra.piid}`] = answer.value;
            }
            const answers = device.primary.props.map(p => values.get(propKey({did: device.did, ...p})));
            const answered = answers.some(a => a?.code === 0) || Object.keys(device.extra).length > 0;
            device.unreadable = answers.length > 0 && answers.every(a => a?.code === UNSUPPORTED);
            device.online = device.listed !== false && (answered || device.unreadable);
            device.values = answers.map(a => (a?.code === 0 ? a.value : null));
            device.times = answers.map(a => (a?.code === 0 ? a.updateTime ?? null : null));
        }
    }

    async services(device) {
        if (!device.urn)
            return [];
        if (!this._services.has(device.urn))
            this._services.set(device.urn, await this._spec(device.urn));
        const services = this._services.get(device.urn);
        return RGB_GATEWAYS.includes(device.model) ? withRgb(services) : services;
    }

    async readProperties(device, asked) {
        if (asked.length === 0)
            return new Map();
        const rgb = asked.find(p => isRgb(device, p.piid));
        const props = asked.filter(p => !isRgb(device, p.piid));
        // An offline-listed device can stall until timeout; flag it as extra so that
        // doesn't trigger backoff.
        return this._guarded(async () => {
            const values = new Map();
            let unsupported = 0;
            if (rgb)
                await this._readRgb(device, rgb.siid, values);
            for (let i = 0; i < props.length; i += BATCH) {
                const batch = props.slice(i, i + BATCH).map(p => ({did: device.did, siid: p.siid, piid: p.piid}));
                for (const r of await this._cloud.getProperties(device.server, batch) ?? []) {
                    if (r.code === 0)
                        values.set(`${r.siid}/${r.piid}`, r.value);
                    else if (r.code === UNSUPPORTED)
                        unsupported++;
                }
            }
            device.unreadable = values.size === 0 && unsupported === props.length;
            device.online = device.listed !== false && (values.size > 0 || device.unreadable);
            return values;
        }, {extra: device.listed === false});
    }

    async _readRgb(device, siid, values) {
        let rgb;
        try {
            [rgb] = await this._cloud.call(device.server, `/home/rpc/${device.did}`, {method: 'get_rgb', params: []}) ?? [];
        } catch (e) {
            // The cloud's word about the device (offline, timed out) only leaves it unknown.
            if (!(e instanceof XiaomiError) || e.code >= 400)
                throw e;
            console.debug(`nook: ${device.name}: get_rgb: ${e.message}`);
            return;
        }
        if (typeof rgb === 'number' && rgb > 0)
            this._pace.lights.set(device.did, {brightness: Math.floor(rgb / 2 ** 24), color: rgb & 0xffffff});
        const light = this._pace.lights.get(device.did);
        if (light) {
            values.set(`${siid}/${RGB_BRIGHTNESS}`, light.brightness);
            values.set(`${siid}/${RGB_COLOR}`, light.color);
        }
    }

    _setRgb(device, piid, value) {
        return this._guarded(async () => {
            const light = {brightness: 100, color: 0xffffff, ...this._pace.lights.get(device.did)};
            if (piid === RGB_BRIGHTNESS)
                light.brightness = Math.min(100, Math.max(1, Math.round(value)));
            else
                light.color = value & 0xffffff || 0xffffff;
            const [answer] = await this._cloud.call(device.server, `/home/rpc/${device.did}`,
                {method: 'set_rgb', params: [light.brightness * 2 ** 24 + light.color]}) ?? [];
            if (answer !== 'ok')
                throw new DeviceError(`${device.name} did not take it`);
            this._pace.lights.set(device.did, light);
            // set_rgb also turns the light on.
            device.values = device.primary.props.map((p, i) =>
                (p.service === 'light' && p.name === 'on' ? true : device.values?.[i] ?? null));
        });
    }

    async readEvents(device, keys) {
        if (keys.length === 0)
            return new Map();
        return this._guarded(async () => {
            const now = Math.floor(Date.now() / 1000);
            const times = new Map();
            for (const key of keys) {
                const result = await this._cloud.call(device.server, '/user/get_user_device_data', {
                    did: device.did,
                    key,
                    type: 'event',
                    time_start: now - EVENT_HISTORY,
                    time_end: now + 60,
                    limit: 1,
                });
                if (result?.[0]?.time)
                    times.set(key, result[0].time);
            }
            return times;
        }, {background: true});
    }

    async readLastEvents(devices, keysOf) {
        const asked = this._pace.events;
        const due = devices.filter(d => d.online && Date.now() >= (asked.get(d.did) ?? 0) && keysOf(d).length > 0);
        if (due.length === 0)
            return false;
        for (const device of due)
            asked.set(device.did, Date.now() + EVENTS_GAP);
        try {
            await this._guarded(() => Promise.all(due.map(async device => {
                const now = Math.floor(Date.now() / 1000);
                const answers = await Promise.all(keysOf(device).map(key =>
                    this._cloud.call(device.server, '/user/get_user_device_data', {
                        did: device.did,
                        key,
                        type: 'event',
                        time_start: now - EVENT_HISTORY,
                        time_end: now + 60,
                        limit: 1,
                    }).then(result => [key, result?.[0]?.time ?? null, true], () => [key, null, false])));
                if (!answers.some(([, , answered]) => answered)) {
                    asked.set(device.did, Date.now() + EVENTS_RETRY);
                    return;
                }
                const [key, time] = answers.filter(([, t]) => t).sort((a, b) => b[1] - a[1])[0] ?? [null, null];
                device.lastEvent = key ? {key, time} : null;
                this._pace.lastEvents.set(device.did, device.lastEvent);
            })), {background: true});
        } catch (e) {
            // Held back (backoff) or failed as a whole: ask again soon, not in EVENTS_GAP.
            for (const device of due)
                asked.set(device.did, Date.now() + EVENTS_RETRY);
            throw e;
        }
        return true;
    }

    // Extra, so one stalled lookup doesn't hold every other request back; retries are
    // spaced per device instead, as locked adverts keep asking several times a second.
    async beaconKey(device) {
        const keys = this._pace.beaconKeys ??= new Map();
        const retry = this._pace.beaconRetry ??= new Map();
        if (!keys.has(device.did) && Date.now() >= (retry.get(device.did) ?? 0)) {
            // null placeholder so concurrent calls ask once; removed on failure to retry.
            keys.set(device.did, null);
            try {
                const result = await this._guarded(() => this._cloud.call(device.server, '/v2/device/blt_get_beaconkey',
                    {did: device.did, pdid: 1}), {extra: true, background: true});
                const hex = result?.beaconkey ?? '';
                if (/^[0-9a-f]{32}$/i.test(hex))
                    keys.set(device.did, Uint8Array.from(hex.match(/../g), h => Number.parseInt(h, 16)));
            } catch (e) {
                keys.delete(device.did);
                retry.set(device.did, Date.now() + BEACON_RETRY);
                throw e;
            }
        }
        return keys.get(device.did) ?? null;
    }

    readHistory(device, keys, since) {
        return this._recently(`history ${device.did} ${keys.join(',')} ${since}`, HISTORY_FRESH, () => this._guarded(async () => {
            const now = Math.floor(Date.now() / 1000);
            return Promise.all(keys.map(async key => {
                const result = await this._cloud.call(device.server, '/user/get_user_device_data', {
                    did: device.did,
                    key,
                    type: 'prop',
                    time_start: now - since,
                    time_end: now + 60,
                    limit: 1000,
                });
                const points = [];
                for (const entry of Array.isArray(result) ? result : []) {
                    let value = null;
                    try {
                        value = JSON.parse(entry.value)?.[0];
                    } catch {}
                    if (typeof value === 'number' && entry.time)
                        points.push({time: entry.time, value});
                }
                return points.sort((a, b) => a.time - b.time);
            }));
        }, {extra: true}));
    }

    _recently(key, fresh, ask) {
        const kept = this._kept.get(key);
        if (kept && Date.now() - kept.at < fresh)
            return kept.answer;
        const answer = ask();
        this._kept.set(key, {at: Date.now(), answer});
        answer.catch(() => this._kept.delete(key));
        return answer;
    }

    readEventLog(device, keys, count = 8) {
        if (keys.length === 0)
            return Promise.resolve([]);
        return this._recently(`events ${device.did} ${keys.join(',')} ${count}`, EVENT_LOG_FRESH, () => this._guarded(async () => {
            const now = Math.floor(Date.now() / 1000);
            const lists = await Promise.all(keys.map(key =>
                this._cloud.call(device.server, '/user/get_user_device_data', {
                    did: device.did,
                    key,
                    type: 'event',
                    time_start: now - EVENT_HISTORY,
                    time_end: now + 60,
                    limit: count,
                }).then(result => (Array.isArray(result) ? result : []).map(e => ({key, time: e.time})), () => [])));
            return lists.flat().filter(e => e.time).sort((a, b) => b.time - a.time).slice(0, count);
        }));
    }

    rpc(device, method, params = []) {
        return this._guarded(async () => {
            const answer = await this._cloud.call(device.server, `/home/rpc/${device.did}`, {method, params});
            return answer ?? null;
        });
    }

    noteEvent(device, event) {
        device.lastEvent = event;
        this._pace.lastEvents.set(device.did, event);
    }

    setProperty(device, siid, piid, value) {
        if (isRgb(device, piid))
            return this._setRgb(device, piid, value);
        return this._guarded(async () => {
            const [result] = await this._cloud.setProperties(device.server,
                [{did: device.did, siid, piid, value}]);
            if (result?.code !== 0)
                throw new DeviceError(`${device.name} did not take it (code ${result?.code})`, result?.code);
            const index = device.primary.props.findIndex(p => p.siid === siid && p.piid === piid);
            if (index >= 0)
                device.values = device.primary.props.map((_p, i) => (i === index ? value : device.values?.[i] ?? null));
            device.extra = {...device.extra, [`${siid}/${piid}`]: value};
        });
    }

    /**
     * Dreame vacuums: requests a full map (frame_type I). Acked at once; the map's file
     * name appears in the property history later, for mapFile().
     */
    requestMap(device, siid, aiid, piid) {
        return this._guarded(() => this._cloud.action(device.server, device.did, siid, aiid,
            [{piid, value: '{"frame_type":"I"}'}]), {extra: true});
    }

    async mapFile(device, siid, piid) {
        const url = await this._guarded(async () => {
            const now = Math.floor(Date.now() / 1000);
            const [last] = await this._cloud.call(device.server, '/user/get_user_device_data', {
                did: device.did,
                key: `${siid}.${piid}`,
                type: 'prop',
                time_start: now - MAP_HISTORY,
                time_end: now + 60,
                limit: 1,
            }) ?? [];
            let name = null;
            try {
                [name = null] = JSON.parse(last?.value ?? '[]');
            } catch {}
            if (typeof name !== 'string')
                return null;
            const result = await this._cloud.call(device.server, '/v2/home/get_interim_file_url', {obj_name: name});
            return result?.url ? {url: result.url, time: last.time} : null;
        }, {extra: true});
        if (!url)
            return null;
        const msg = Soup.Message.new('GET', url.url);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.status_code !== Soup.Status.OK)
            throw new XiaomiError(`the map could not be downloaded (HTTP ${msg.status_code})`, msg.status_code);
        return {text: decoder.decode(bytes.toArray()), time: url.time};
    }

    /**
     * Last value from the cloud's history, for properties a device reports on change
     * but never answers when read.
     */
    lastTold(device, siid, piid) {
        return this._recently(`told ${device.did} ${siid}.${piid}`, TOLD_FRESH, () => this._guarded(async () => {
            const now = Math.floor(Date.now() / 1000);
            const list = await this._cloud.call(device.server, '/user/get_user_device_data', {
                did: device.did,
                key: `${siid}.${piid}`,
                type: 'prop',
                time_start: now - TOLD_SPAN,
                time_end: now + 60,
                limit: 1,
            });
            const [last] = Array.isArray(list) ? list : [];
            let value = null;
            try {
                value = JSON.parse(last?.value ?? '[]')?.[0] ?? null;
            } catch {}
            return value === null ? null : {time: last.time, value};
        }, {extra: true}));
    }

    /** since is a unix timestamp in seconds, not a duration as in readHistory(). */
    async propHistory(device, siid, piid, since, pages = 10) {
        const entries = [];
        let until = Math.floor(Date.now() / 1000) + 60;
        for (let page = 0; page < pages && until >= since; page++) {
            const list = await this._guarded(() => this._cloud.call(device.server, '/user/get_user_device_data', {
                did: device.did,
                key: `${siid}.${piid}`,
                type: 'prop',
                time_start: since,
                time_end: until,
                limit: HISTORY_PAGE,
            }), {extra: true});
            const got = Array.isArray(list) ? list.filter(e => e?.time) : [];
            entries.push(...got);
            if (got.length < HISTORY_PAGE)
                break;
            until = Math.min(...got.map(e => e.time)) - 1;
        }
        const told = [];
        for (const entry of entries.sort((a, b) => a.time - b.time)) {
            let value = null;
            try {
                value = JSON.parse(entry.value)?.[0] ?? null;
            } catch {}
            if (value !== null)
                told.push({time: entry.time, value});
        }
        return told;
    }

    runAction(device, siid, aiid) {
        return this._guarded(async () => {
            const result = await this._cloud.action(device.server, device.did, siid, aiid);
            if (result?.code !== undefined && result.code !== 0)
                throw new DeviceError(`${device.name} did not do it (code ${result.code})`, result.code);
        });
    }

    async setSwitch(device, on) {
        const [p] = device.primary.kind === 'switch' ? device.primary.props : [];
        if (!p)
            throw new XiaomiError('this device has no switch');
        await this.setProperty(device, p.siid, p.piid, on);
    }
}
