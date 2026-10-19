// SPDX-License-Identifier: GPL-2.0-or-later

// Xiaomi cloud client mimicking the Mi Home app; unofficial, the protocol may change.
// Imported by both the shell and prefs: no St or Adw here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

export const SERVERS = ['cn', 'de', 'us', 'ru', 'tw', 'sg', 'in', 'i2'];

const ACCOUNT = 'https://account.xiaomi.com';
const STS_CALLBACK = 'https://sts.api.io.mi.com/sts';
const SDK_VERSION = 'accountsdk-18.8.15';

const DEBUG = GLib.getenv('NOOK_DEBUG') !== null;

const TOO_MANY_REQUESTS = 429;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class XiaomiError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'XiaomiError';
        this.code = code;
    }
}

function randomString(length, first, last) {
    let s = '';
    for (let i = 0; i < length; i++)
        s += String.fromCharCode(GLib.random_int_range(first.charCodeAt(0), last.charCodeAt(0) + 1));
    return s;
}

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

function digest(type, data) {
    return hexToBytes(GLib.compute_checksum_for_bytes(type, new GLib.Bytes(data)));
}

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

const b64 = bytes => GLib.base64_encode(bytes);
const unb64 = text => GLib.base64_decode(text);

// RC4 dropping the first 1024 keystream bytes (RC4-drop1024), as Mi Home does.
function rc4(key, data) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++)
        s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) & 0xff;
        [s[i], s[j]] = [s[j], s[i]];
    }
    const out = new Uint8Array(data.length);
    let i = 0, j = 0;
    for (let n = -1024; n < data.length; n++) {
        i = (i + 1) & 0xff;
        j = (j + s[i]) & 0xff;
        [s[i], s[j]] = [s[j], s[i]];
        if (n >= 0)
            out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
    }
    return out;
}

function makeNonce() {
    const nonce = new Uint8Array(12);
    for (let i = 0; i < 8; i++)
        nonce[i] = GLib.random_int_range(0, 256);
    new DataView(nonce.buffer).setUint32(8, Math.floor(Date.now() / 60000));
    return b64(nonce);
}

function signNonce(ssecurity, nonce) {
    return b64(digest(GLib.ChecksumType.SHA256, concat(unb64(ssecurity), unb64(nonce))));
}

function encSignature(path, signedNonce, params) {
    const parts = ['POST', path];
    for (const [k, v] of Object.entries(params))
        parts.push(`${k}=${v}`);
    parts.push(signedNonce);
    return b64(digest(GLib.ChecksumType.SHA1, encoder.encode(parts.join('&'))));
}

function query(params) {
    return Object.entries(params)
        .map(([k, v]) => `${k}=${GLib.Uri.escape_string(String(v), null, false)}`)
        .join('&');
}

function accountJson(text) {
    try {
        return JSON.parse(text.replace('&&&START&&&', ''));
    } catch {
        throw new XiaomiError('the account server answered something else');
    }
}

function sleep(ms, cancellable) {
    return new Promise((resolve, reject) => {
        let handler = 0;
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (handler)
                cancellable.disconnect(handler);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        handler = cancellable?.connect(() => {
            GLib.source_remove(timer);
            reject(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled'));
        }) ?? 0;
    });
}

function apiBase(server) {
    return `https://${server === 'cn' ? '' : `${server}.`}api.io.mi.com/app`;
}

export function newCredentials() {
    return {
        deviceId: randomString(6, 'a', 'z'),
        agent: `${randomString(18, 'a', 'z')}-${randomString(13, 'A', 'E')} APP/com.xiaomi.mihome APPV/10.5.201`,
    };
}

export class XiaomiCloud {
    constructor(credentials) {
        this.credentials = {...newCredentials(), ...credentials};
        // Soup's default of 2 per host lets slow event-history calls stall the menu.
        this._api = new Soup.Session({timeout: 20, max_conns_per_host: 4});
        this._cancellable = new Gio.Cancellable();
        this.onRefresh = null;
    }

    abort() {
        this._cancellable.cancel();
        this._api.abort();
    }

    get loggedIn() {
        return Boolean(this.credentials.passToken);
    }

    _accountSession(timeout = 20) {
        const session = new Soup.Session({timeout});
        const jar = new Soup.CookieJar();
        session.add_feature(jar);
        const {userId, passToken, deviceId} = this.credentials;
        const cookies = {sdkVersion: SDK_VERSION, deviceId};
        if (userId && passToken)
            Object.assign(cookies, {userId: String(userId), passToken});
        for (const domain of ['.xiaomi.com', '.mi.com']) {
            for (const [name, value] of Object.entries(cookies))
                jar.add_cookie(Soup.Cookie.new(name, value, domain, '/', -1));
        }
        return [session, jar];
    }

    async _get(session, url, cancellable = this._cancellable) {
        const msg = Soup.Message.new('GET', url);
        msg.request_headers.append('User-Agent', this.credentials.agent);
        const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        return {status: msg.get_status(), text: decoder.decode(bytes.toArray())};
    }

    async _fetchServiceToken(session, jar, location) {
        const {status} = await this._get(session, location);
        const cookie = jar.all_cookies().find(c => c.get_name() === 'serviceToken');
        if (status !== Soup.Status.OK || !cookie)
            throw new XiaomiError(`no service token (HTTP ${status})`);
        return cookie.get_value();
    }

    _takeLogin(answer) {
        Object.assign(this.credentials, {
            userId: answer.userId,
            cUserId: answer.cUserId,
            passToken: answer.passToken ?? this.credentials.passToken,
            ssecurity: answer.ssecurity,
        });
    }

    async startQrLogin() {
        // One session (cookies) throughout: the long poll reports the scan only to the
        // client that requested the code.
        const [session, jar] = this._accountSession(30);
        const {status, text} = await this._get(session, `${ACCOUNT}/longPolling/loginUrl?${query({
            _qrsize: '480',
            qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
            callback: STS_CALLBACK,
            _hasLogo: 'false',
            sid: 'xiaomiio',
            serviceParam: '',
            _locale: 'en_GB',
            _dc: String(Date.now()),
        })}`);
        if (status !== Soup.Status.OK)
            throw new XiaomiError(`QR login refused (HTTP ${status})`);
        const answer = accountJson(text);
        if (!answer.qr)
            throw new XiaomiError(answer.desc ?? 'no QR code in the answer', answer.code);
        // Never log answer.lp: the login comes back on it.
        if (DEBUG)
            printerr(`qr login: timeout=${answer.timeout}`);

        const wait = async (cancellable = null) => {
            // The long poll can end before a scan: retry with backoff until the code
            // expires, but stop on 429.
            const deadline = Date.now() + (answer.timeout ?? 300) * 1000;
            let pause = 1000;
            while (Date.now() < deadline) {
                let reply;
                try {
                    reply = await this._get(session, answer.lp, cancellable ?? this._cancellable);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        throw e;
                    if (DEBUG)
                        printerr(`long poll: ${e.message}`);
                    await sleep(pause, cancellable ?? this._cancellable);
                    pause = Math.min(pause * 2, 10000);
                    continue;
                }
                // Status only: a successful reply carries the passToken.
                if (DEBUG)
                    printerr(`long poll: HTTP ${reply.status}`);
                if (reply.status === Soup.Status.OK) {
                    const login = accountJson(reply.text);
                    this._takeLogin(login);
                    this.credentials.serviceToken = await this._fetchServiceToken(session, jar, login.location);
                    return this.credentials;
                }
                if (reply.status === TOO_MANY_REQUESTS)
                    throw new XiaomiError('Xiaomi asks to slow down, try again later', reply.status);
                await sleep(pause, cancellable ?? this._cancellable);
                pause = Math.min(pause * 2, 10000);
            }
            throw new XiaomiError('QR code expired');
        };

        return {imageUrl: answer.qr, loginUrl: answer.loginUrl, wait};
    }

    async downloadQr(imageUrl) {
        const msg = Soup.Message.new('GET', imageUrl);
        const bytes = await this._api.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.get_status() !== Soup.Status.OK)
            throw new XiaomiError(`QR image (HTTP ${msg.get_status()})`);
        return bytes;
    }

    async refresh() {
        if (!this.loggedIn)
            throw new XiaomiError('not logged in');
        const [session, jar] = this._accountSession();
        const {status, text} = await this._get(session, `${ACCOUNT}/pass/serviceLogin?sid=xiaomiio&_json=true`);
        // Drop the passToken only on a clear refusal; an HTTP error or a captive portal
        // says nothing about it.
        if (status !== Soup.Status.OK)
            throw new XiaomiError(`the Xiaomi account server is not answering (HTTP ${status})`, status);
        let answer;
        try {
            answer = accountJson(text);
        } catch {
            throw new XiaomiError('the Xiaomi account server sent something unreadable');
        }
        if (!answer.ssecurity || !answer.location) {
            this.credentials.passToken = null;
            throw new XiaomiError('session expired, log in again', answer.code);
        }
        this._takeLogin(answer);
        this.credentials.serviceToken = await this._fetchServiceToken(session, jar, answer.location);
        this.onRefresh?.(this.credentials);
        return this.credentials;
    }

    async _call(server, path, data) {
        const {ssecurity, serviceToken, userId, agent} = this.credentials;
        const nonce = makeNonce();
        const signedNonce = signNonce(ssecurity, nonce);
        const key = unb64(signedNonce);

        const params = {data: JSON.stringify(data)};
        params.rc4_hash__ = encSignature(path, signedNonce, params);
        for (const k of Object.keys(params))
            params[k] = b64(rc4(key, encoder.encode(params[k])));
        params.signature = encSignature(path, signedNonce, params);
        params.ssecurity = ssecurity;
        params._nonce = nonce;

        // Encrypted params go in the query string; the POST body is empty.
        const msg = Soup.Message.new('POST', `${apiBase(server)}${path}?${query(params)}`);
        const headers = {
            'Accept-Encoding': 'identity',
            'User-Agent': agent,
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
            'Cookie': [
                `userId=${userId}`,
                `yetAnotherServiceToken=${serviceToken}`,
                `serviceToken=${serviceToken}`,
                'locale=en_GB',
                'timezone=GMT+02:00',
                'is_daylight=1',
                'dst_offset=3600000',
                'channel=MI_APP_STORE',
            ].join('; '),
        };
        for (const [name, value] of Object.entries(headers))
            msg.request_headers.append(name, value);

        const bytes = await this._api.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        const status = msg.get_status();
        const body = decoder.decode(bytes.toArray());
        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN)
            throw new XiaomiError('unauthorized', status);
        if (status === TOO_MANY_REQUESTS)
            throw new XiaomiError('Xiaomi asks to slow down, trying again later', status);
        if (status !== Soup.Status.OK)
            throw new XiaomiError(`HTTP ${status}: ${body.slice(0, 200)}`, status);

        let reply;
        try {
            reply = JSON.parse(decoder.decode(rc4(key, unb64(body))));
        } catch {
            throw new XiaomiError('the answer could not be read');
        }
        if (reply.code !== 0)
            throw new XiaomiError(reply.message ?? `error ${reply.code}`, reply.code);
        return reply.result;
    }

    async call(server, path, data) {
        try {
            return await this._call(server, path, data);
        } catch (e) {
            if (!(e instanceof XiaomiError) || (e.code !== Soup.Status.UNAUTHORIZED && e.code !== Soup.Status.FORBIDDEN))
                throw e;
        }
        // Concurrent calls hit the expiry together; they share one refresh.
        this._refreshing ??= this.refresh().finally(() => {
            this._refreshing = null;
        });
        await this._refreshing;
        return this._call(server, path, data);
    }

    async homes(server) {
        const own = await this.call(server, '/v2/homeroom/gethome', {
            fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7,
        });
        const homes = (own?.homelist ?? []).map(h => ({homeId: h.id, ownerId: this.credentials.userId, name: h.name, rooms: h.roomlist ?? []}));
        // Shared homes are best effort; only 429 and auth errors propagate.
        try {
            const count = await this.call(server, '/v2/user/get_device_cnt', {fetch_own: true, fetch_share: true});
            for (const h of count?.share?.share_family ?? [])
                homes.push({homeId: h.home_id, ownerId: h.home_owner, name: h.home_name, rooms: []});
        } catch (e) {
            if (!(e instanceof XiaomiError) || [TOO_MANY_REQUESTS, Soup.Status.UNAUTHORIZED, Soup.Status.FORBIDDEN].includes(e.code))
                throw e;
        }
        return homes;
    }

    async devices(server, home) {
        const result = await this.call(server, '/v2/home/home_device_list', {
            home_owner: Number(home.ownerId),
            home_id: Number(home.homeId),
            limit: 200,
            get_split_device: true,
            support_smart_home: true,
        });
        return result?.device_info ?? [];
    }

    getProperties(server, props) {
        return this.call(server, '/miotspec/prop/get', {params: props});
    }

    setProperties(server, props) {
        return this.call(server, '/miotspec/prop/set', {params: props});
    }

    action(server, did, siid, aiid, args = []) {
        return this.call(server, '/miotspec/action', {params: {did, siid, aiid, in: args}});
    }
}
