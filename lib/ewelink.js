// SPDX-License-Identifier: GPL-2.0-or-later

// eWeLink open API v2, signed in through eWeLink's own OAuth page.
// Imported by prefs; no St or Adw here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Secrets from './secrets.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const LOGIN_PAGE = 'https://c2ccdn.coolkit.cc/oauth/index.html';
export const REDIRECT_PORT = 8371;
export const REDIRECT_URL = `http://127.0.0.1:${REDIRECT_PORT}/ewelink`;

const ACCOUNT_LABEL = 'Nook: eWeLink account';

// A refresh reply carries no expiry times; the API gives at 30 days and rt 60.
const DAY = 86400 * 1000;
const AT_LIFE = 30 * DAY;
const RT_LIFE = 60 * DAY;
const REFRESH_AHEAD = 3 * DAY;
const EXPIRED = [401, 402];
// Things per by-ID request, at most.
const BATCH = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class EwelinkError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'EwelinkError';
        this.code = code;
    }
}

// Rejected headers come back quoted in the error text; never let a token through.
const scrub = text => String(text).replace(/(Bearer|Sign)\s+[^\s"']+/gi, '$1 …');

function answer(msg, bytes) {
    if (msg.get_status() !== Soup.Status.OK)
        throw new EwelinkError(`eWeLink answered HTTP ${msg.get_status()}`, msg.get_status());
    let reply;
    try {
        reply = JSON.parse(decoder.decode(bytes.toArray()));
    } catch {
        throw new EwelinkError('eWeLink answered something else');
    }
    if (reply.error !== 0)
        throw new EwelinkError(reply.msg ? scrub(reply.msg) : `eWeLink error ${reply.error}`, reply.error);
    return reply.data ?? {};
}

function randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < length; i++)
        s += chars[GLib.random_int_range(0, chars.length)];
    return s;
}

function sign(secret, text) {
    const hex = GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA256,
        new GLib.Bytes(encoder.encode(secret)), new GLib.Bytes(encoder.encode(text)));
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++)
        bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return GLib.base64_encode(bytes);
}

// The region becomes part of the API host name.
const REGIONS = ['as', 'cn', 'eu', 'us'];

function apiBase(region) {
    return `https://${region}-apia.coolkit.${region === 'cn' ? 'cn' : 'cc'}`;
}

export function newState() {
    return randomString(16);
}

// The page adds "Sign " to the signature itself.
export function loginUrl(app, state) {
    const seq = String(Date.now());
    const params = {
        clientId: app.id,
        redirectUrl: REDIRECT_URL,
        grantType: 'authorization_code',
        state,
        nonce: randomString(8),
        seq,
        authorization: sign(app.secret, `${app.id}_${seq}`),
    };
    return `${LOGIN_PAGE}?${Object.entries(params)
        .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`)
        .join('&')}`;
}

// Serves REDIRECT_URL until the login page sends the browser back to it.
// Throws right away if the port is taken, before any browser is opened.
export function waitForCode(state, cancellable) {
    const server = new Soup.Server();
    server.listen_local(REDIRECT_PORT, Soup.ServerListenOptions.IPV4_ONLY);
    return new Promise((resolve, reject) => {
        let handler = 0;
        const finish = (error, result) => {
            // Disconnecting from inside the cancelled handler would deadlock.
            if (!error)
                cancellable.disconnect(handler);
            // Let the reply reach the browser before the socket goes.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                server.disconnect();
                return GLib.SOURCE_REMOVE;
            });
            if (error)
                reject(error);
            else
                resolve(result);
        };
        server.add_handler('/ewelink', (_server, msg, _path, query) => {
            if (!query || query.state !== state || !query.code) {
                msg.set_status(Soup.Status.BAD_REQUEST, null);
                return;
            }
            msg.set_status(Soup.Status.OK, null);
            msg.set_response('text/html; charset=utf-8', Soup.MemoryUse.COPY,
                encoder.encode('<!doctype html><title>Nook</title><p>Signed in. You can close this tab.</p>'));
            finish(null, {code: query.code, region: REGIONS.includes(query.region) ? query.region : 'eu'});
        });
        handler = cancellable.connect(() =>
            finish(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled')));
    });
}

export async function getToken(app, {code, region}) {
    const body = JSON.stringify({redirectUrl: REDIRECT_URL, code, grantType: 'authorization_code'});
    const msg = Soup.Message.new('POST', `${apiBase(region)}/v2/user/oauth/token`);
    const headers = msg.get_request_headers();
    headers.append('X-CK-Appid', app.id);
    headers.append('X-CK-Nonce', randomString(8));
    headers.append('Authorization', `Sign ${sign(app.secret, body)}`);
    msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(body)));

    const session = new Soup.Session({timeout: 20});
    const data = answer(msg, await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null));
    return {
        at: data.accessToken,
        rt: data.refreshToken,
        atExpires: data.atExpiredTime,
        rtExpires: data.rtExpiredTime,
        region,
    };
}

export async function savedApp(cancellable = null) {
    const saved = await Secrets.lookup('ewelink-app', cancellable);
    if (!saved)
        return null;
    const {user, password} = JSON.parse(saved);
    return user && password ? {id: user, secret: password} : null;
}

export async function savedTokens(cancellable = null) {
    const saved = await Secrets.lookup('ewelink', cancellable);
    return saved ? JSON.parse(saved) : null;
}

export function storeTokens(tokens) {
    return Secrets.store('ewelink', ACCOUNT_LABEL, JSON.stringify(tokens));
}

// Shell and prefs each hold one; whichever refreshes first stores the new tokens, and
// the other picks them up from the keyring before trying a refresh of its own.
export class EwelinkCloud {
    static async load(cancellable = null) {
        const [app, tokens] = await Promise.all([savedApp(cancellable), savedTokens(cancellable)]);
        return app && tokens ? new EwelinkCloud(app, tokens) : null;
    }

    constructor(app, tokens) {
        this._app = app;
        this._tokens = tokens;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._refreshing = null;
        this.expired = false;
    }

    get region() {
        return this._tokens.region;
    }

    abort() {
        this._cancellable.cancel();
        this._session.abort();
    }

    async _send(method, path, body = null, signed = false) {
        const text = body ? JSON.stringify(body) : '';
        const msg = Soup.Message.new(method, `${apiBase(this._tokens.region)}${path}`);
        const headers = msg.get_request_headers();
        headers.append('X-CK-Appid', this._app.id);
        headers.append('X-CK-Nonce', randomString(8));
        headers.append('Authorization', signed ? `Sign ${sign(this._app.secret, text)}` : `Bearer ${this._tokens.at}`);
        if (body)
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(text)));
        return answer(msg, await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable));
    }

    async call(method, path, body = null) {
        // No more refresh attempts once refused; a new login in prefs lands in the keyring.
        if (this.expired) {
            if (!await this._adoptSaved())
                throw new EwelinkError('The eWeLink login has expired', EXPIRED[0]);
            this.expired = false;
        }
        if (this._tokens.atExpires - Date.now() < REFRESH_AHEAD) {
            await this._refresh().catch(e => {
                if (!(e instanceof EwelinkError) && !(e instanceof GLib.Error))
                    throw e;
                console.debug(`nook: eWeLink refresh: ${e.message}`);
            });
        }
        const used = this._tokens.at;
        try {
            return await this._send(method, path, body);
        } catch (e) {
            if (!(e instanceof EwelinkError) || !EXPIRED.includes(e.code))
                throw e;
        }
        if (this._tokens.at === used) {
            try {
                await this._refresh();
            } catch (e) {
                // Server trouble or a garbled reply says nothing about the tokens.
                if (e instanceof EwelinkError && e.code !== undefined && e.code !== 429 && !(e.code >= 500 && e.code < 600))
                    this.expired = true;
                throw e;
            }
        }
        return this._send(method, path, body);
    }

    _refresh() {
        this._refreshing ??= this._renew().finally(() => {
            this._refreshing = null;
        });
        return this._refreshing;
    }

    async _adoptSaved() {
        const saved = await savedTokens(this._cancellable);
        if (!saved?.at || saved.at === this._tokens.at)
            return false;
        this._tokens = saved;
        return true;
    }

    async _renew() {
        if (await this._adoptSaved())
            return;
        let data;
        try {
            data = await this._send('POST', '/v2/user/refresh', {rt: this._tokens.rt}, true);
        } catch (e) {
            if (e instanceof EwelinkError && await this._adoptSaved())
                return;
            throw e;
        }
        const at = data.at ?? data.accessToken;
        const rt = data.rt ?? data.refreshToken;
        if (typeof at !== 'string' || typeof rt !== 'string')
            throw new EwelinkError('eWeLink sent no new tokens');
        const now = Date.now();
        this._tokens = {
            ...this._tokens,
            at,
            rt,
            atExpires: data.atExpiredTime ?? now + AT_LIFE,
            rtExpires: data.rtExpiredTime ?? now + RT_LIFE,
        };
        if (!this._cancellable.is_cancelled())
            await storeTokens(this._tokens);
    }

    // Brand-restricted apps get an empty list here, though the same devices answer by ID.
    async listDevices() {
        const data = await this.call('GET', '/v2/device/thing?num=0');
        return (data.thingList ?? []).filter(t => t.itemType === 1 || t.itemType === 2).map(t => t.itemData);
    }

    async devicesById(ids) {
        const found = [];
        for (let i = 0; i < ids.length; i += BATCH) {
            const thingList = ids.slice(i, i + BATCH).map(id => ({itemType: 1, id}));
            const data = await this.call('POST', '/v2/device/thing', {thingList});
            found.push(...(data.thingList ?? []).map(t => t.itemData).filter(Boolean));
        }
        return found;
    }

    setParams(id, params) {
        return this.call('POST', '/v2/device/thing/status', {type: 1, id, params});
    }

    // Room names by room ID.
    async rooms() {
        const data = await this.call('GET', '/v2/family');
        const rooms = new Map();
        for (const family of data.familyList ?? []) {
            for (const room of family.roomList ?? [])
                rooms.set(room.id, room.name);
        }
        return rooms;
    }

    logOut() {
        return this._send('DELETE', '/v2/user/logout');
    }
}

// What the shell keeps of a device: nothing secret, unlike the reply's apikey and
// devicekey.
export function savedDevice(item, rooms = new Map()) {
    const params = item.params ?? {};
    return {
        id: item.deviceid,
        name: item.name || item.deviceid,
        model: [item.brandName, item.productModel].filter(Boolean).join(' ') || item.extra?.model || null,
        uiid: item.extra?.uiid ?? null,
        outlets: typeof params.switch === 'string' ? 0 : outletsOf(item),
        room: rooms.get(item.family?.roomid) ?? null,
    };
}

// Multi-channel firmware reports four outlets whatever it has, so the count comes from
// the UIID, or else from the channel names the app keeps.
const OUTLETS = {2: 2, 3: 3, 4: 4, 7: 2, 8: 3, 9: 4, 29: 2, 30: 3, 31: 4, 82: 2, 83: 3, 84: 4,
    113: 2, 114: 3, 126: 2, 139: 2, 140: 3, 141: 4, 161: 2, 162: 3};

function outletsOf(item) {
    if (!Array.isArray(item.params?.switches))
        return 0;
    const named = Object.keys(item.tags?.ck_channel_name ?? {}).length;
    return OUTLETS[item.extra?.uiid] ?? (named || 1);
}
