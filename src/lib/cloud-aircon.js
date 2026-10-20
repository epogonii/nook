// SPDX-License-Identifier: GPL-2.0-or-later

// Air conditioners behind a maker's cloud account (LG ThinQ, SmartThings, MELCloud,
// Electrolux), as prefs saved them in <brand>-devices with what each one can do. A brand
// module gives the account from the keyring, state reads, commands and the spec layout;
// the card then treats them like Mi Home ones (climate.js specClimate).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Secrets from './secrets.js';
import {RO, RW, SpecError, SpecHome, layout, prop} from './spec-home.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function parseEntries(json) {
    try {
        const entries = JSON.parse(json || '[]');
        return Array.isArray(entries) ? entries.filter(e => e?.id && typeof e.id === 'string') : [];
    } catch {
        return [];
    }
}

export async function savedAccount(service) {
    const saved = await Secrets.lookup(service);
    try {
        return saved ? JSON.parse(saved) : null;
    } catch {
        return null;
    }
}

export function keepAccount(service, label, account) {
    return Secrets.store(service, label, JSON.stringify(account));
}

/**
 * One HTTP call; JSON in and out. Throws SpecError 'expired' on 401, and with the HTTP
 * status as code and the answer as reply otherwise: a 403 can be a rate limit or a missing
 * permission, not a lost login.
 */
export async function call(session, method, url, {json = undefined, form = null, headers = {}, cancellable = null} = {}) {
    const message = Soup.Message.new(method, url);
    if (!message)
        throw new SpecError('not an address');
    for (const [name, value] of Object.entries(headers))
        message.get_request_headers().append(name, value);
    if (form) {
        const body = Object.entries(form).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        message.set_request_body_from_bytes('application/x-www-form-urlencoded', new GLib.Bytes(encoder.encode(body)));
    } else if (json !== undefined) {
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(json))));
    }
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.get_status();
    const text = decoder.decode(bytes.toArray());
    let reply = null;
    try {
        reply = text ? JSON.parse(text) : null;
    } catch {}
    if (status === Soup.Status.UNAUTHORIZED)
        throw new SpecError('the account was refused', 'expired');
    if (status < 200 || status >= 300) {
        const error = new SpecError(`the cloud answered HTTP ${status}`, String(status));
        error.reply = reply;
        throw error;
    }
    return reply;
}

// Mode, fan and the rest by a brand's own values, with the words climate.js maps.
export const choice = (piid, name, values, words) => prop(piid, name, 'string', RW,
    {choices: values.map(value => ({value, description: words[value] ?? String(value).replace(/_/g, ' ').toLowerCase()}))});

export const temperature = (piid, range) => prop(piid, 'target-temperature', 'float', RW, {unit: 'celsius', range});

export const reading = piid => prop(piid, 'temperature', 'float', RO, {unit: 'celsius'});

export const toggle = (piid, name) => prop(piid, name, 'bool', RW);

export class CloudAirconHome extends SpecHome {
    // brand: {id, label, gap, fresh, replies, SECRET, load(cancellable), groups(entry)};
    // load gives a client with account, state(entry), command(entry, command, state),
    // abort() and expired. fresh also spaces the reads of an open card; a write is read
    // back at once all the same, unless the brand replies to a command with the new state.
    constructor(brand, entries) {
        super(brand.label, {gap: brand.gap, fresh: brand.fresh ?? 3000, assumed: 8000});
        this._brand = brand;
        this._cancellable = new Gio.Cancellable();
        this._client = null;
        this._loading = null;
        this._given = null;
        this.onBack = null;
        this._entries = new Map();
        this._layouts = new Map();
        for (const entry of entries) {
            const did = `${brand.id}:${entry.id}`;
            if (this._entries.has(did))
                continue;
            this._entries.set(did, entry);
            this._layouts.set(did, layout([[2, 'air-conditioner', brand.groups(entry)]]));
            this._add({
                did,
                name: entry.name || brand.label,
                model: brand.id,
                urn: 'urn:nook:device:air-conditioner:0',
                room: entry.room ?? null,
                about: {model: entry.model ?? null},
            });
        }
    }

    get loggedIn() {
        return !this._client?.expired;
    }

    abort() {
        this._cancellable.cancel();
        this._client?.abort();
    }

    _layout(device) {
        return this._layouts.get(device.did);
    }

    // Each client has a cancellable of its own: Soup's abort() cancels the ones its requests
    // were given, and a shared one would leave every later client cancelled.
    _account() {
        this._loading ??= this._brand.load(new Gio.Cancellable()).then(client => {
            if (!client)
                throw new SpecError(`Log in to ${this._brand.label} in the Nook settings`, 'expired');
            if (this._cancellable.is_cancelled()) {
                client.abort();
                throw new SpecError('closed', 'closed');
            }
            this._client = client;
            return client;
        }).catch(e => {
            this._loading = null;
            throw e;
        });
        return this._loading;
    }

    // A refused login is retried only with another one the settings have saved since;
    // the same one would just be refused again, by the network each time. Errors name
    // the account for the card.
    async _call(task) {
        const client = await this._account();
        try {
            const result = await task(client);
            this._back();
            return result;
        } catch (e) {
            if (e.code !== 'expired' || this._cancellable.is_cancelled())
                throw this._named(e);
            const saved = await savedAccount(this._brand.SECRET).catch(() => null);
            if (!saved || JSON.stringify(saved) === JSON.stringify(client.account)) {
                this._expired();
                throw this._named(e);
            }
            if (this._client === client) {
                this._client = null;
                this._loading = null;
            }
            try {
                const result = await task(await this._account());
                this._back();
                return result;
            } catch (again) {
                if (again.code === 'expired')
                    this._expired();
                throw this._named(again);
            }
        }
    }

    _back() {
        if (!this._told)
            return;
        this._told = false;
        this.onBack?.();
    }

    _named(e) {
        if (e instanceof SpecError)
            e.label = this._brand.label;
        return e;
    }

    // One unit the account answers about with an error doesn't take the others offline;
    // all of them failing backs off as any failed read does.
    async _refresh(devices) {
        let failed = 0;
        let last = null;
        for (const device of devices) {
            const entry = this._entries.get(device.did);
            let state;
            try {
                state = await this._call(client => client.state(entry));
            } catch (e) {
                if (devices.length === 1 || e.code === 'expired' || !(e instanceof SpecError))
                    throw e;
                console.debug(`nook: ${this.label}: ${device.name}: ${e.message}`);
                device.online = false;
                failed++;
                last = e;
                continue;
            }
            this._keep(device, state, state?.online !== false);
        }
        if (failed === devices.length && last)
            throw last;
    }

    async _send(device, command, state) {
        const reply = await this._call(client => client.command(this._entries.get(device.did), command, state));
        if (this._brand.replies && reply && typeof reply === 'object')
            this._given = {did: device.did, state: {...reply, online: true}};
        return reply;
    }

    // A command answered with the whole new state needs no read after it.
    _stale(device) {
        const given = this._given;
        this._given = null;
        if (given?.did === device.did) {
            this._keep(device, given.state);
            return;
        }
        super._stale(device);
    }
}
