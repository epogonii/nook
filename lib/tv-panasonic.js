// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {cbcDecrypt, cbcEncrypt} from './aes.js';
import {TvError, download, escape, newSession, readVolume, request, setMute, setVolume, soap, tag, wake} from './net.js';
import {sleep} from './timers.js';

const NRC = 'panasonic-com:service:p00NetworkControl:1';
const PAC = 'panasonic-com:service:p00ProAVControlService:1';

const KEYS = {
    'power': 'NRC_POWER-ONOFF',
    'up': 'NRC_UP-ONOFF',
    'down': 'NRC_DOWN-ONOFF',
    'left': 'NRC_LEFT-ONOFF',
    'right': 'NRC_RIGHT-ONOFF',
    'ok': 'NRC_ENTER-ONOFF',
    'back': 'NRC_RETURN-ONOFF',
    'home': 'NRC_HOME-ONOFF',
    'menu': 'NRC_MENU-ONOFF',
    'play': 'NRC_PLAY-ONOFF',
    'pause': 'NRC_PAUSE-ONOFF',
    'volume-up': 'NRC_VOLUP-ONOFF',
    'volume-down': 'NRC_VOLDOWN-ONOFF',
    'mute': 'NRC_MUTE-ONOFF',
    'channel-up': 'NRC_CH_UP-ONOFF',
    'channel-down': 'NRC_CH_DOWN-ONOFF',
    'input': 'NRC_CHG_INPUT-ONOFF',
};

const SOURCES = [
    ['tv', 'NRC_TV-ONOFF'],
    ['hdmi1', 'NRC_HDMI1-ONOFF'],
    ['hdmi2', 'NRC_HDMI2-ONOFF'],
    ['hdmi3', 'NRC_HDMI3-ONOFF'],
    ['hdmi4', 'NRC_HDMI4-ONOFF'],
];

// Product id, title, DIAL name. Only ask DIAL about apps every TV has: a 404 takes the TV
// a second to close.
const APPS = [
    ['0070000200180001', 'YouTube', 'YouTube'],
    ['0010000200000001', 'Netflix', 'Netflix'],
    ['0010000100180001', 'Prime Video', null],
    ['0077777700160002', 'Browser', null],
];

// Seconds to wait for a woken TV to answer.
const WAKE_WAIT = 20;

// PAC input codes: TV or TVA, H1, V1, C1.
function sourceId(code) {
    if (code.startsWith('TV'))
        return 'tv';
    const hdmi = /^H(\d)$/.exec(code);
    return hdmi ? `hdmi${hdmi[1]}` : code.toLowerCase();
}

// XORed with the PIN challenge into the pairing HMAC key; from Panasonic's remote app.
const MASK = [
    0x15, 0xc9, 0x5a, 0xc2, 0xb0, 0x8a, 0xa7, 0xeb, 0x4e, 0x22, 0x8f, 0x81, 0x1e, 0x34, 0xd0, 0x4f,
    0xa5, 0x4b, 0xa7, 0xdc, 0xac, 0x98, 0x79, 0xfa, 0x8a, 0xcd, 0xa3, 0xfc, 0x24, 0x4f, 0x38, 0x54,
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hmacSha256(key, data) {
    const hex = GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA256, new GLib.Bytes(key), new GLib.Bytes(data));
    return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}

// 12 random bytes, uint32 BE length, payload, zero padding; AES-CBC, then HMAC-SHA256.
function seal(text, keys) {
    const data = encoder.encode(text);
    const length = 16 + data.length;
    const plain = new Uint8Array(length + 16 - length % 16);
    for (let i = 0; i < 12; i++)
        plain[i] = GLib.random_int_range(0, 256);
    new DataView(plain.buffer).setUint32(12, data.length);
    plain.set(data, 16);
    const sealed = cbcEncrypt(keys.key, keys.iv, plain, false);
    const signed = new Uint8Array(sealed.length + 32);
    signed.set(sealed);
    signed.set(hmacSha256(keys.hmac, sealed), sealed.length);
    return GLib.base64_encode(signed);
}

// Skip the 16-byte header, read to the first NUL: the TV's length field is unreliable.
function open(text, keys) {
    const bytes = GLib.base64_decode(text);
    const whole = bytes.length - bytes.length % 16;
    if (whole < 32)
        throw new TvError('The TV sent an answer that does not open');
    const plain = cbcDecrypt(keys.key, keys.iv, bytes.subarray(0, whole), false).subarray(16);
    const end = plain.indexOf(0);
    return decoder.decode(end < 0 ? plain : plain.subarray(0, end));
}

function sessionKeys(keyword) {
    const iv = GLib.base64_decode(keyword);
    if (iv.length !== 16)
        throw new TvError('The saved TV key is not a key');
    const key = new Uint8Array(16);
    for (let i = 0; i < 16; i += 4) {
        key[i] = iv[i + 2];
        key[i + 1] = iv[i + 3];
        key[i + 2] = iv[i];
        key[i + 3] = iv[i + 1];
    }
    const hmac = new Uint8Array(32);
    hmac.set(iv);
    hmac.set(iv, 16);
    return {key, iv, hmac};
}

function pairingKeys(iv) {
    const key = new Uint8Array(16);
    for (let i = 0; i < 16; i += 4) {
        key[i] = ~iv[i + 3] & 0xff;
        key[i + 1] = ~iv[i + 2] & 0xff;
        key[i + 2] = ~iv[i + 1] & 0xff;
        key[i + 3] = ~iv[i] & 0xff;
    }
    const hmac = new Uint8Array(32);
    for (let i = 0; i < 32; i += 4) {
        hmac[i] = MASK[i] ^ iv[(i + 2) & 0xf];
        hmac[i + 1] = MASK[i + 1] ^ iv[(i + 3) & 0xf];
        hmac[i + 2] = MASK[i + 2] ^ iv[i & 0xf];
        hmac[i + 3] = MASK[i + 3] ^ iv[(i + 1) & 0xf];
    }
    return {key, iv, hmac};
}

export default class PanasonicTv {
    static pairing = 'pin';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._secret = secret?.appId && secret.key ? secret : null;
        this._session = newSession();
        this._base = `http://${tv.ip}:55000`;
        this._encrypted = null;
        this._link = null;
        this._linking = null;
        this._sequence = 0;
        this._turn = Promise.resolve();
        this._closed = false;
        this.onSecret = null;
    }

    get paired() {
        return this._encrypted === false || this._secret !== null;
    }

    async _needsKey() {
        if (this._encrypted === null) {
            const {status, text} = await request(this._session, 'GET', `${this._base}/nrc/sdd_0.xml`);
            if (status !== 200)
                throw new TvError(`The TV answered HTTP ${status}`);
            this._encrypted = text.includes('X_GetEncryptSessionId');
        }
        return this._encrypted;
    }

    // One session at a time: a second would restart the command sequence numbers.
    _login() {
        if (this._link)
            return Promise.resolve(this._link);
        this._linking ??= this._startSession().finally(() => {
            this._linking = null;
        });
        return this._linking;
    }

    async _startSession() {
        if (!this._secret)
            throw new TvError('The TV is not paired yet', 'unpaired');
        const keys = sessionKeys(this._secret.key);
        const appId = escape(this._secret.appId);
        const answer = await soap(this._session, `${this._base}/nrc/control_0`, NRC, 'X_GetEncryptSessionId',
            `<X_ApplicationId>${appId}</X_ApplicationId>` +
            `<X_EncInfo>${seal(`<X_ApplicationId>${appId}</X_ApplicationId>`, keys)}</X_EncInfo>`);
        const id = tag(open(tag(answer, 'X_EncResult'), keys), 'X_SessionId');
        if (!id)
            throw new TvError('The TV did not start a session');
        this._sequence = 1;
        this._link = {id, keys, appId};
        return this._link;
    }

    async _encryptedCommand(action, params) {
        const link = await this._login();
        this._sequence++;
        const command = `<X_SessionId>${link.id}</X_SessionId>` +
            `<X_SequenceNumber>${String(this._sequence).padStart(8, '0')}</X_SequenceNumber>` +
            `<X_OriginalCommand><u:${action} xmlns:u="urn:${NRC}">${params}</u:${action}></X_OriginalCommand>`;
        const answer = await soap(this._session, `${this._base}/nrc/control_0`, NRC, 'X_EncryptedCommand',
            `<X_ApplicationId>${link.appId}</X_ApplicationId><X_EncInfo>${seal(command, link.keys)}</X_EncInfo>`);
        return open(tag(answer, 'X_EncResult'), link.keys);
    }

    // Encrypted commands go one at a time, so sequence numbers reach the TV in order.
    async _command(action, params = '', again = true) {
        if (!await this._needsKey())
            return soap(this._session, `${this._base}/nrc/control_0`, NRC, action, params, {prefix: 'm'});
        const turn = this._turn.then(() => this._encryptedOnce(action, params, again));
        this._turn = turn.catch(() => {});
        return turn;
    }

    // Sessions expire: retry once on a fresh session, except toggles (again = false).
    async _encryptedOnce(action, params, again) {
        try {
            return await this._encryptedCommand(action, params);
        } catch (e) {
            if (!again || !(e instanceof TvError) || e.code === 'unpaired' || !this._link)
                throw e;
            this._link = null;
            return this._encryptedCommand(action, params);
        }
    }

    // Plain SOAP even on TVs that want NRC commands encrypted.
    async _inquire(command) {
        const answer = await soap(this._session, `${this._base}/pac/control_0`, PAC, 'X_SendInquiryCmd',
            `<X_InquiryCmdType>PAC_${command}</X_InquiryCmdType>`);
        const result = tag(answer, 'X_InquiryCmdResult');
        if (!result.startsWith(`${command}:`))
            throw new TvError(`The TV answered ${command} with ${result}`);
        return result.slice(command.length + 1);
    }

    async _dialRunning() {
        const running = await Promise.all(APPS.filter(([, , dial]) => dial).map(async ([id, title, dial]) => {
            try {
                const {status, text} = await request(this._session, 'GET', `${this._base}/nrc/dial/${dial}`);
                return status === 200 && tag(text, 'state') === 'running' ? {id, title} : null;
            } catch (e) {
                if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                    throw e;
                return null;
            }
        }));
        return running.find(Boolean) ?? null;
    }

    // QMI says VC for any app. The app list marks the running one but needs the key;
    // unpaired, DIAL can still name YouTube and Netflix.
    async _showing() {
        const input = await this._inquire('QMI');
        if (input !== 'VC')
            return {source: sourceId(input), app: null, title: null};
        const app = this.paired ? (await this.apps()).find(a => a.running) : await this._dialRunning();
        return {source: null, app: app?.id ?? null, title: app?.title ?? null};
    }

    // UPnP volume doubles as the power probe: it answers only while the TV is on.
    async status() {
        const showing = this._showing().catch(e => {
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
            return {source: null, app: null};
        });
        let sound;
        try {
            sound = await readVolume(this._session, `${this._base}/dmr/control_0`, 'm');
            await this._needsKey();
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error)
                return {on: false, volume: null, muted: null, source: null, app: null};
            throw e;
        }
        return {on: true, ...sound, ...await showing};
    }

    async _awake() {
        try {
            await readVolume(this._session, `${this._base}/dmr/control_0`, 'm');
            return true;
        } catch (e) {
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
            return false;
        }
    }

    setVolume(level) {
        return setVolume(this._session, `${this._base}/dmr/control_0`, level, 'm');
    }

    setMuted(muted) {
        return setMute(this._session, `${this._base}/dmr/control_0`, muted, 'm');
    }

    async press(key) {
        const code = KEYS[key] ?? SOURCES.find(([id]) => id === key)?.[1];
        if (!code)
            throw new TvError(`No such key: ${key}`);
        await this._command('X_SendKey', `<X_KeyEvent>${code}</X_KeyEvent>`);
    }

    // The power key toggles: press it only after two reads agree the TV is the other
    // way, so one lost reply can't turn off a TV asked to turn on.
    async power(on) {
        for (let ask = 0; ask < 2; ask++) {
            const {on: now} = await this.status();
            if (now === on)
                return;
        }
        // In standby this TV answers everything with HTTP 400, so only Wake-on-LAN reaches
        // it; a key sent once it wakes would turn it straight back off.
        if (on && await wake(this._tv.mac)) {
            for (let waited = 0; waited < WAKE_WAIT && !this._closed; waited++) {
                await sleep(1000);
                if (await this._awake())
                    return;
            }
            throw new TvError('The TV did not wake up', 'asleep');
        }
        await this._command('X_SendKey', `<X_KeyEvent>${KEYS.power}</X_KeyEvent>`, false);
    }

    // QIL: "TV[TV],H1[HDMI1],V1[VIDEO]". Only inputs with a key: those are what source() can pick.
    async sources() {
        try {
            const codes = (await this._inquire('QIL')).split(',').map(entry => sourceId(entry.split('[')[0]));
            const present = SOURCES.filter(([id]) => codes.includes(id));
            if (present.length > 0)
                return present.map(([id]) => ({id}));
        } catch (e) {
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
        }
        return SOURCES.map(([id]) => ({id}));
    }

    source(id) {
        return this.press(id);
    }

    // vc_app'running'product_id=0070000200180001'YouTube'http://.../nrc/app_icon/0070000200180001'Unknown>
    // The state may be missing.
    async apps() {
        try {
            const list = tag(await this._command('X_GetAppList'), 'X_AppList');
            const apps = [...list.matchAll(/vc_app'(?:([^'>]*)')?product_id=([^']+)'([^']*)'([^']*)'/g)]
                .map(([, state, id, title, icon]) => ({
                    id,
                    title,
                    icon: icon.startsWith(`${this._base}/`) ? icon : null,
                    running: state === 'running',
                }));
            if (apps.length > 0)
                return apps;
        } catch (e) {
            if (!(e instanceof TvError))
                throw e;
        }
        return APPS.map(([id, title]) => ({id, title}));
    }

    icon(url) {
        return download(this._session, url);
    }

    launch(id) {
        const what = id.length === 16 ? `product_id=${id}` : `resource_id=${id}`;
        return this._command('X_LaunchApp', `<X_AppType>vc_app</X_AppType><X_LaunchKeyword>${escape(what)}</X_LaunchKeyword>`);
    }

    async pairBegin(name) {
        if (!await this._needsKey())
            return {done: true, secret: null};
        const answer = await soap(this._session, `${this._base}/nrc/control_0`, NRC, 'X_DisplayPinCode',
            `<X_DeviceName>${escape(name)}</X_DeviceName>`);
        const challenge = GLib.base64_decode(tag(answer, 'X_ChallengeKey'));
        if (challenge.length !== 16)
            throw new TvError('The TV did not show a PIN');
        this._challenge = challenge;
        return {done: false};
    }

    async pairEnd(pin) {
        const keys = pairingKeys(this._challenge);
        const answer = await soap(this._session, `${this._base}/nrc/control_0`, NRC, 'X_RequestAuth',
            `<X_AuthInfo>${seal(`<X_PinCode>${escape(pin)}</X_PinCode>`, keys)}</X_AuthInfo>`);
        const result = open(tag(answer, 'X_AuthResult'), keys);
        const appId = tag(result, 'X_ApplicationId');
        const key = tag(result, 'X_Keyword');
        if (!appId || !key)
            throw new TvError('The TV did not take the PIN', '600');
        this._secret = {appId, key};
        this._link = null;
        return this._secret;
    }

    close() {
        this._closed = true;
        this._link = null;
        this._session.abort();
    }
}
