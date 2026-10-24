// SPDX-License-Identifier: GPL-2.0-or-later

// Smart Life (Tuya) accounts, signed in the way Home Assistant's own Tuya integration
// does: its client id, the user code from the Smart Life app, then a QR code scanned
// with the app. Each request is signed and sealed with AES-GCM under a key made for it
// from a random request id and the refresh token.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {gcmDecrypt, gcmEncrypt} from './aes.js';
import * as Secrets from './secrets.js';
import {SpecError} from './spec-home.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const CLIENT_ID = 'HA_3y9q4ak7g4ephrvke';
const SCHEMA = 'haauthorize';
const LOGIN_URL = 'https://apigw.iotbing.com/v1.0/m/life/home-assistant/qrcode/tokens';
const SIGNED = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token'];
const NONCE_LETTERS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
// Token errors: invalid, expired. A refresh token renewed elsewhere or revoked fails the
// signature instead, as "sign invalid" under the generic code -9999999.
const TOKEN_CODES = ['1010', '1011', 'sign'];
const REFRESH_EARLY = 60 * 1000;
const DETAILS_AT_ONCE = 20;

export const SECRET = 'smartlife';
const SECRET_LABEL = 'Nook: Smart Life account';

const hmac = (key, text) => GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA256,
    new GLib.Bytes(encoder.encode(key)), new GLib.Bytes(encoder.encode(text)));

function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

export function requestKeys(requestId, refreshToken) {
    const hashKey = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, requestId + refreshToken, -1);
    return {hashKey, secret: hmac(requestId, hashKey).slice(0, 16)};
}

export function sign(hashKey, headers, query, body) {
    const head = SIGNED.filter(name => headers[name]).map(name => `${name}=${headers[name]}`).join('||');
    return hmac(hashKey, head + query + body);
}

// Sealed as the SDK does: base64 of the nonce, then base64 of ciphertext and tag.
export function seal(text, secret) {
    const nonce = encoder.encode(Array.from({length: 12}, () => NONCE_LETTERS[GLib.random_int_range(0, NONCE_LETTERS.length)]).join(''));
    const [ciphertext, tag] = gcmEncrypt(encoder.encode(secret), nonce, new Uint8Array(0), encoder.encode(text));
    return GLib.base64_encode(nonce) + GLib.base64_encode(concat(ciphertext, tag));
}

// Answers are one base64: nonce, ciphertext, tag.
export function unseal(text, secret) {
    const data = GLib.base64_decode(text);
    if (data.length < 28)
        throw new SpecError('Smart Life sent a broken answer', 'broken');
    try {
        return decoder.decode(gcmDecrypt(encoder.encode(secret), data.subarray(0, 12), new Uint8Array(0),
            data.subarray(12, data.length - 16), data.subarray(data.length - 16)));
    } catch {
        throw new SpecError('Smart Life sent a broken answer', 'broken');
    }
}

async function fetchJson(session, method, url, cancellable, {headers = {}, body = null} = {}) {
    const message = Soup.Message.new(method, url);
    if (!message)
        throw new SpecError('Not an address Smart Life could have', 'address');
    for (const [name, value] of Object.entries(headers))
        message.get_request_headers().append(name, value);
    if (body !== null)
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(body)));
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.status_code;
    if (status !== 200)
        throw new SpecError(`Smart Life answered HTTP ${status}`, 'refused');
    try {
        return JSON.parse(decoder.decode(bytes.toArray()));
    } catch {
        throw new SpecError('Smart Life sent a broken answer', 'broken');
    }
}

const trouble = answer => new SpecError(answer?.msg || 'Smart Life refused it',
    /sign invalid/i.test(answer?.msg ?? '') ? 'sign' : String(answer?.code ?? ''));

// The QR code's text and the token to ask about it with.
export async function startLogin(userCode, cancellable = null) {
    const session = new Soup.Session({timeout: 15});
    const url = `${LOGIN_URL}?clientid=${CLIENT_ID}&usercode=${encodeURIComponent(userCode)}&schema=${SCHEMA}`;
    const answer = await fetchJson(session, 'POST', url, cancellable);
    const token = answer?.result?.qrcode;
    if (!answer?.success || !token)
        throw trouble(answer);
    return {token, text: `tuyaSmart--qrLogin?token=${token}`};
}

// The account once the code is scanned and the login confirmed in the app; null before.
export async function loginResult(token, userCode, cancellable = null) {
    const session = new Soup.Session({timeout: 15});
    const url = `${LOGIN_URL}/${encodeURIComponent(token)}?clientid=${CLIENT_ID}&usercode=${encodeURIComponent(userCode)}`;
    const answer = await fetchJson(session, 'GET', url, cancellable);
    const result = answer?.result;
    if (!answer?.success || !result?.access_token)
        return null;
    return {
        userCode,
        uid: result.uid,
        terminalId: result.terminal_id,
        endpoint: result.endpoint,
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expires: Number(answer.t) + Number(result.expire_time) * 1000,
    };
}

export async function savedAccount(cancellable = null) {
    const saved = await Secrets.lookup(SECRET, cancellable);
    try {
        const account = saved ? JSON.parse(saved) : null;
        return account?.refreshToken && account?.endpoint ? account : null;
    } catch {
        return null;
    }
}

export const storeAccount = account => Secrets.store(SECRET, SECRET_LABEL, JSON.stringify(account));

export class SmartLifeCloud {
    static async load(cancellable = null) {
        const account = await savedAccount(cancellable);
        return account ? new SmartLifeCloud(account) : null;
    }

    constructor(account) {
        this.account = account;
        this.expired = false;
        this.onRefresh = null;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._refreshing = null;
    }

    abort() {
        this._cancellable.cancel();
        this._session.abort();
    }

    async _send(method, path, params = null, body = null) {
        const requestId = GLib.uuid_string_random();
        const {hashKey, secret} = requestKeys(requestId, this.account.refreshToken);
        const query = params ? seal(JSON.stringify(params), secret) : '';
        const sealed = body ? seal(JSON.stringify(body), secret) : '';
        const headers = {
            'X-appKey': CLIENT_ID,
            'X-requestId': requestId,
            'X-sid': '',
            'X-time': String(Date.now()),
        };
        if (this.account.accessToken)
            headers['X-token'] = this.account.accessToken;
        headers['X-sign'] = sign(hashKey, headers, query, sealed);
        const url = `${this.account.endpoint}${path}${query ? `?encdata=${encodeURIComponent(query)}` : ''}`;
        const answer = await fetchJson(this._session, method, url, this._cancellable,
            {headers, body: sealed ? JSON.stringify({encdata: sealed}) : null});
        if (!answer?.success)
            throw trouble(answer);
        let result = null;
        if (answer.result) {
            const text = unseal(answer.result, secret);
            try {
                result = JSON.parse(text);
            } catch {
                result = text;
            }
        }
        return {result, t: answer.t};
    }

    _refresh() {
        this._refreshing ??= this._send('GET', `/v1.0/m/token/${this.account.refreshToken}`).then(({result, t}) => {
            if (!result?.accessToken)
                throw new SpecError('Smart Life refused to renew the login', 'expired');
            this.account = {
                ...this.account,
                uid: result.uid ?? this.account.uid,
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expires: Number(t) + Number(result.expireTime) * 1000,
            };
            this.onRefresh?.(this.account);
        }).finally(() => {
            this._refreshing = null;
        });
        return this._refreshing;
    }

    // Renews the token before it runs out, and once more if it is refused anyway.
    async request(method, path, params = null, body = null) {
        if (this.expired)
            throw new SpecError('The Smart Life login has expired', 'expired');
        try {
            if (Date.now() > this.account.expires - REFRESH_EARLY)
                await this._refresh();
            return (await this._send(method, path, params, body)).result;
        } catch (e) {
            if (!TOKEN_CODES.includes(e.code))
                throw this._checked(e);
            try {
                await this._refresh();
                return (await this._send(method, path, params, body)).result;
            } catch (again) {
                throw this._checked(again, true);
            }
        }
    }

    _checked(e, after = false) {
        if (e.code === 'expired' || (after && TOKEN_CODES.includes(e.code))) {
            this.expired = true;
            return new SpecError('The Smart Life login has expired', 'expired');
        }
        return e;
    }

    async homes() {
        return await this.request('GET', '/v1.0/m/life/users/homes') ?? [];
    }

    async homeDevices(homeId) {
        return await this.request('GET', '/v1.0/m/life/ha/home/devices', {homeId: String(homeId)}) ?? [];
    }

    specifications(id) {
        return this.request('GET', `/v1.1/m/life/${id}/specifications`);
    }

    room(id) {
        return this.request('GET', `/v1.0/m/thing/ha/${id}/room`);
    }

    async details(ids) {
        const out = [];
        for (let at = 0; at < ids.length; at += DETAILS_AT_ONCE) {
            const part = await this.request('GET', '/v1.0/m/life/ha/devices/detail',
                {devIds: ids.slice(at, at + DETAILS_AT_ONCE).join(',')});
            out.push(...part ?? []);
        }
        return out;
    }

    commands(id, commands) {
        return this.request('POST', `/v1.1/m/thing/${id}/commands`, null, {commands});
    }

    logOut() {
        return this.request('POST', '/v1.0/m/token/terminal/expire', null,
            {accessToken: this.account.accessToken, terminalId: this.account.terminalId});
    }
}
