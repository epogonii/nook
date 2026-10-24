// SPDX-License-Identifier: GPL-2.0-or-later

// Philips JointSPACE: JSON over HTTPS on 1926 (API 6, paired with a PIN, then digest
// auth), or plain HTTP on 1925 on older sets.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {TIMEOUT, TvError, send, wake} from './net.js';

const KEYS = {
    'power': 'Standby',
    'up': 'CursorUp',
    'down': 'CursorDown',
    'left': 'CursorLeft',
    'right': 'CursorRight',
    'ok': 'Confirm',
    'back': 'Back',
    'home': 'Home',
    'menu': 'Options',
    'play': 'Play',
    'pause': 'Pause',
    'volume-up': 'VolumeUp',
    'volume-down': 'VolumeDown',
    'mute': 'Mute',
    'channel-up': 'ChannelStepUp',
    'channel-down': 'ChannelStepDown',
    'input': 'Source',
    'tv': 'WatchTV',
};

// Signs the pairing grant; the same key in every JointSPACE client.
const SIGNING_KEY = 'ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA==';

const PLAY_TV = {packageName: 'org.droidtv.playtv', className: 'org.droidtv.playtv.PlayTvActivity'};
const LIVE_TV = new Set(['org.droidtv.playtv', 'org.droidtv.zapster']);

// HDMI inputs of Android sets, as ha-philipsjs switches them; other platforms name the
// service differently and answer 400.
const HDMI_URI = port => 'content://android.media.tv/passthrough/' +
    encodeURIComponent(`com.mediatek.tvinput/.hdmi.HDMIInputService/HW${port + 4}`);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parse(bytes) {
    try {
        return JSON.parse(decoder.decode(bytes.toArray()));
    } catch {
        return {};
    }
}

// Base64 of HMAC-SHA1 over the timestamp and the PIN.
export function signature(timestamp, pin) {
    const hex = GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA1,
        new GLib.Bytes(GLib.base64_decode(SIGNING_KEY)), new GLib.Bytes(encoder.encode(`${timestamp}${pin}`)));
    return GLib.base64_encode(Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16)));
}

export default class PhilipsTv {
    static pairing = 'pin';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._secret = secret?.user && secret.key ? secret : null;
        // One connection, one request at a time: the TV ties the digest nonce to the socket.
        this._session = new Soup.Session({timeout: TIMEOUT, idle_timeout: 15, max_conns_per_host: 1});
        this._queue = Promise.resolve();
        this._challenge = null;
        this._count = 0;
        this._api = null;
        this._apps = null;
        this._pairing = null;
        this.refused = false;
        this.onSecret = null;
    }

    get paired() {
        return this._api?.secured === false || this._secret !== null;
    }

    // RFC 2617 digest, qop=auth, MD5.
    _authorization(method, uri, {user, key}) {
        const {realm = '', nonce = '', opaque = null} = this._challenge;
        const md5 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, text, -1);
        const count = (++this._count).toString(16).padStart(8, '0');
        const cnonce = GLib.uuid_string_random().replace(/-/g, '').slice(0, 16);
        const response = md5(`${md5(`${user}:${realm}:${key}`)}:${nonce}:${count}:${cnonce}:auth:${md5(`${method}:${uri}`)}`);
        return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=MD5, ` +
            `response="${response}", qop=auth, nc=${count}, cnonce="${cnonce}"${opaque ? `, opaque="${opaque}"` : ''}`;
    }

    // Digest by hand: libsoup resends an empty body after a 401. The challenge is kept
    // and reused while the TV takes it.
    _send(method, url, body, auth) {
        const turn = this._queue.then(async () => {
            for (let attempt = 0; ; attempt++) {
                const message = Soup.Message.new(method, url);
                if (!message)
                    throw new TvError('Not an address the TV could have');
                // Self-signed by the maker; nothing to check it against on a LAN.
                message.connect('accept-certificate', () => true);
                const uri = message.get_uri();
                if (auth && this._challenge) {
                    message.get_request_headers().replace('Authorization',
                        this._authorization(method, uri.get_path() + (uri.get_query() ? `?${uri.get_query()}` : ''), auth));
                }
                if (body !== null)
                    message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
                const bytes = await send(this._session, message);
                const status = message.status_code;
                const challenge = message.get_response_headers().get_one('WWW-Authenticate') ?? '';
                if (status === 401 && auth && attempt === 0 && /^Digest\s/i.test(challenge)) {
                    this._challenge = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)]
                        .map(([, name, quoted, plain]) => [name.toLowerCase(), quoted ?? plain]));
                    this._count = 0;
                    continue;
                }
                return {status, bytes};
            }
        });
        this._queue = turn.catch(() => {});
        return turn;
    }

    // API 6 on HTTPS first; secured sets give 403 on plain HTTP. Unreachable stops the search.
    async _probe() {
        if (this._api)
            return this._api;
        for (const [base, version] of [[`https://${this._tv.ip}:1926`, 6], [`http://${this._tv.ip}:1925`, 6],
            [`http://${this._tv.ip}:1925`, 5], [`http://${this._tv.ip}:1925`, 1]]) {
            let answer;
            try {
                answer = await this._send('GET', `${base}/${version}/system`, null, null);
            } catch (e) {
                if (e instanceof GLib.Error && !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
                    throw e;
                continue;
            }
            if (answer.status !== 200)
                continue;
            const system = parse(answer.bytes);
            if (!system.name && !system.api_version)
                continue;
            const features = system.featuring?.systemfeatures ?? {};
            this._api = {
                base: `${base}/${system.api_version?.Major ?? version}`,
                version: system.api_version?.Major ?? version,
                secured: features.pairing_type === 'digest_auth_pairing' || base.startsWith('https'),
                android: /^MSAF/.test(system.os_type ?? '') ||
                    (system.featuring?.jsonfeatures?.activities ?? []).includes('intent'),
                system,
            };
            return this._api;
        }
        throw new TvError('The TV is not answering', 'timeout');
    }

    async _call(method, path, body = null) {
        const api = await this._probe();
        if (api.secured && !this._secret)
            throw new TvError('The TV is not paired yet', 'unpaired');
        const {status, bytes} = await this._send(method, `${api.base}/${path}`, body, this._secret);
        // The TV forgot this pairing (reset, or paired again elsewhere).
        if (status === 401) {
            this.refused = true;
            this._secret = null;
            throw new TvError('The TV no longer knows Nook', 'unpaired');
        }
        if (status !== 200)
            throw new TvError(`${path}: HTTP ${status}`, String(status));
        // activities/current answers a bare "NA" when nothing it tracks is in front.
        return parse(bytes);
    }

    async _powerState() {
        try {
            const {powerstate} = await this._call('GET', 'powerstate');
            return powerstate === 'On';
        } catch (e) {
            // TitanOS sets have no powerstate, only the screen.
            if (e.code !== '404')
                throw e;
            const {screenstate} = await this._call('GET', 'screenstate');
            return screenstate !== 'Off';
        }
    }

    // Live TV is PlayTV with a channel; PlayTV without one is an HDMI input, which no
    // call names.
    async _showing() {
        if (this._api.version < 5) {
            const {id = null} = await this._call('GET', 'sources/current').catch(() => ({}));
            return {source: id, app: null};
        }
        const {component} = await this._call('GET', 'activities/current').catch(() => ({}));
        if (!component?.packageName)
            return {source: null, app: null};
        if (LIVE_TV.has(component.packageName)) {
            const {channel} = await this._call('GET', 'activities/tv').catch(() => ({}));
            if (!channel?.ccid)
                return {source: null, app: null};
            return {source: 'tv', app: null, title: [channel.preset, channel.name].filter(Boolean).join(' ') || null};
        }
        const id = `${component.className}-${component.packageName}`;
        return {source: null, app: id, title: this._apps?.find(a => a.id === id)?.title ?? null};
    }

    async status() {
        const off = {on: false, volume: null, muted: null, source: null, app: null};
        try {
            const api = await this._probe();
            if (api.secured && !this._secret)
                return off;
            if (!await this._powerState())
                return off;
            const sound = await this._call('GET', 'audio/volume');
            return {
                on: true,
                volume: Number.isFinite(sound.current) ? sound.current : null,
                volumeMax: Number.isFinite(sound.max) && sound.max > 0 ? sound.max : null,
                muted: typeof sound.muted === 'boolean' ? sound.muted : null,
                ...await this._showing(),
            };
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error)
                return off;
            throw e;
        }
    }

    async setVolume(level) {
        const {muted = false} = await this._call('GET', 'audio/volume');
        return this._call('POST', 'audio/volume', {current: Math.round(level), muted});
    }

    async setMuted(muted) {
        const {current = 0} = await this._call('GET', 'audio/volume');
        return this._call('POST', 'audio/volume', {current, muted});
    }

    press(key) {
        return this._call('POST', 'input/key', {key: KEYS[key] ?? key});
    }

    // Network standby takes powerstate On; deeper sleep needs Wake-on-LAN first.
    async power(on) {
        if (!on) {
            await this._call('POST', 'powerstate', {powerstate: 'Standby'});
            return;
        }
        wake(this._tv.mac);
        for (let ask = 1; ; ask++) {
            try {
                await this._call('POST', 'powerstate', {powerstate: 'On'});
                return;
            } catch (e) {
                if ((!(e instanceof GLib.Error) && e.code !== 'timeout') || ask === 4)
                    throw e;
                this._api = null;
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
            }
        }
    }

    async sources() {
        const api = await this._probe();
        if (api.version < 5) {
            const sources = await this._call('GET', 'sources');
            return Object.entries(sources).map(([id, {name}]) => ({id, title: name || null}));
        }
        if (!api.android)
            return [];
        return [{id: 'tv'}, ...[1, 2, 3, 4].map(port => ({id: `hdmi${port}`}))];
    }

    async source(id) {
        const api = await this._probe();
        if (api.version < 5)
            return this._call('POST', 'sources/current', {id});
        if (id === 'tv')
            return this.press('tv');
        const port = /^hdmi(\d)$/.exec(id)?.[1];
        if (!port)
            throw new TvError(`No such input: ${id}`);
        return this._call('POST', 'activities/launch', {
            intent: {extras: {uri: HDMI_URI(Number(port))}, action: 'org.droidtv.playtv.SELECTURI', component: PLAY_TV},
        });
    }

    async apps() {
        const api = await this._probe();
        if (!(api.system.featuring?.jsonfeatures?.applications))
            return [];
        const {applications = []} = await this._call('GET', 'applications');
        this._apps = applications.filter(a => a.id && a.intent).map(a => ({
            id: a.id,
            title: a.label || a.id,
            icon: `applications/${a.id}/icon`,
            intent: a.intent,
        }));
        return this._apps;
    }

    async icon(path) {
        const api = await this._probe();
        const {status, bytes} = await this._send('GET', `${api.base}/${path}`, null, this._secret);
        if (status !== 200)
            throw new TvError(`HTTP ${status}`);
        return bytes;
    }

    async launch(id) {
        const app = (this._apps ?? await this.apps()).find(a => a.id === id);
        if (!app)
            throw new TvError(`No such app: ${id}`);
        return this._call('POST', 'activities/launch', {intent: app.intent});
    }

    _device() {
        return {
            device_name: 'Nook',
            device_os: 'Linux',
            app_id: 'io.github.epogonii.nook',
            app_name: 'Nook',
            type: 'native',
            id: this._pairing.user,
        };
    }

    // The TV shows a PIN; the grant is digest-authed with the key from the request.
    async pairBegin() {
        const api = await this._probe();
        if (!api.secured)
            return {done: true, secret: null};
        this._pairing = {user: GLib.uuid_string_random().replace(/-/g, '').slice(0, 16)};
        const {status, bytes} = await this._send('POST', `${api.base}/pair/request`, {
            access: {scope: ['read', 'write', 'control'], featuring: api.system.featuring ?? {}},
            device: this._device(),
        }, null);
        const answer = status === 200 ? parse(bytes) : {};
        if (answer.error_id !== 'SUCCESS' || !answer.auth_key)
            throw new TvError(`The TV did not start pairing: ${answer.error_id ?? `HTTP ${status}`}`, 'denied');
        this._pairing.key = answer.auth_key;
        this._pairing.timestamp = answer.timestamp;
        return {done: false};
    }

    async pairEnd(pin) {
        const api = await this._probe();
        const {user, key, timestamp} = this._pairing;
        const {status, bytes} = await this._send('POST', `${api.base}/pair/grant`, {
            auth: {auth_appId: '1', pin, auth_timestamp: timestamp, auth_signature: signature(timestamp, pin)},
            device: this._device(),
        }, {user, key});
        if (status !== 200 || parse(bytes).error_id !== 'SUCCESS')
            throw new TvError('The TV did not take the PIN', '600');
        this._secret = {user, key};
        this._pairing = null;
        return this._secret;
    }

    close() {
        this._session.abort();
    }
}
