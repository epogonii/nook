// SPDX-License-Identifier: GPL-2.0-or-later

// Tapo local HTTPS API (no cloud): user "admin" with the TP-Link account password,
// sent only as digests. The camera proves the password first, so a wrong one fails
// here instead of counting toward its login lockout, which would also block RTSP.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {cbcDecrypt, cbcEncrypt} from './aes.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const TIMEOUT = 8;

const SESSION_OVER = -40401;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class TapoError extends Error {
    constructor(message, code = null) {
        super(message);
        this.code = code;
    }
}

export const WRONG_PASSWORD = 'wrong-password';

const sha256 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1).toUpperCase();
const md5 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, text, -1).toUpperCase();

function sha256Raw(text) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
    return Uint8Array.from(hex.match(/../g), h => Number.parseInt(h, 16));
}

function randomHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes; i++)
        out += GLib.random_int_range(0, 256).toString(16).padStart(2, '0');
    return out.toUpperCase();
}

function resultOf(reply, method) {
    const answer = reply?.result?.responses?.find(r => r.method === method);
    return answer?.error_code === 0 ? answer.result ?? {} : null;
}

const onOff = value => (value === undefined || value === null ? null : value === 'on');

export class CameraApi {
    constructor(ip, password, port = 443) {
        this._ip = port === 443 ? ip : `${ip}:${port}`;
        this._password = password;
        this._session = new Soup.Session({timeout: TIMEOUT});
        this._cancellable = new Gio.Cancellable();
        this._login = null;
    }

    abort() {
        this._cancellable.cancel();
        this._session.abort();
    }

    async _post(path, body, headers = {}) {
        const msg = Soup.Message.new('POST', `https://${this._ip}${path}`);
        // Self-signed cert; the camera is authenticated by device_confirm instead.
        msg.connect('accept-certificate', () => true);
        const requestHeaders = msg.get_request_headers();
        requestHeaders.append('Accept', 'application/json');
        requestHeaders.append('Referer', `https://${this._ip}`);
        for (const [name, value] of Object.entries(headers))
            requestHeaders.append(name, value);
        msg.set_request_body_from_bytes('application/json; charset=UTF-8', new GLib.Bytes(encoder.encode(body)));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        try {
            return JSON.parse(decoder.decode(bytes.toArray()));
        } catch {
            throw new TapoError(`HTTP ${msg.status_code}`);
        }
    }

    async _signIn() {
        const cnonce = randomHex(8);
        const login = params => this._post('/', JSON.stringify({
            method: 'login',
            params: {cnonce, encrypt_type: '3', username: 'admin', ...params},
        }));
        const first = await login({});
        const data = first?.result?.data ?? {};
        const wait = Number(data.sec_left ?? first?.data?.sec_left ?? 0);
        if (wait > 0)
            throw new TapoError(`The camera is locked for another ${Math.ceil(wait / 60)} min.`, first?.error_code);
        const {nonce, device_confirm: confirm} = data;
        if (!nonce || !confirm)
            throw new TapoError('This camera signs in some other way, not supported yet.', first?.error_code);

        // Firmware keeps either a SHA-256 or an MD5 of the password.
        const hashed = [sha256(this._password), md5(this._password)]
            .find(candidate => confirm === sha256(cnonce + candidate + nonce) + nonce + cnonce);
        if (!hashed)
            throw new TapoError('The TP-Link password is not the one the camera knows.', WRONG_PASSWORD);

        const second = await login({digest_passwd: sha256(hashed + cnonce + nonce) + cnonce + nonce});
        const result = second?.result ?? {};
        if (!result.stok || result.start_seq === undefined)
            throw new TapoError('The camera turned the login down.', second?.error_code);
        const key = sha256(cnonce + hashed + nonce);
        this._login = {
            stok: result.stok,
            seq: result.start_seq,
            tagKey: sha256(hashed + cnonce),
            lsk: sha256Raw(`lsk${cnonce}${nonce}${key}`).subarray(0, 16),
            ivb: sha256Raw(`ivb${cnonce}${nonce}${key}`).subarray(0, 16),
        };
    }

    // Serialised: parallel requests would each sign in, ending each other's
    // session, and race on seq.
    _send(request) {
        const turn = (this._queue ?? Promise.resolve()).then(() => this._sendNow(request));
        this._queue = turn.catch(() => {});
        return turn;
    }

    async _sendNow(request, again = false) {
        if (!this._login)
            await this._signIn();
        const login = this._login;
        const sealed = GLib.base64_encode(cbcEncrypt(login.lsk, login.ivb, encoder.encode(JSON.stringify(request))));
        const body = JSON.stringify({method: 'securePassthrough', params: {request: sealed}});
        const seq = login.seq++;
        const reply = await this._post(`/stok=${login.stok}/ds`, body, {
            Seq: String(seq),
            Tapo_tag: sha256(login.tagKey + body + seq),
        });
        const response = reply?.result?.response;
        if (!response) {
            if (reply?.error_code === SESSION_OVER && !again) {
                this._login = null;
                return this._sendNow(request, true);
            }
            throw new TapoError(`The camera answered with error ${reply?.error_code}.`, reply?.error_code);
        }
        try {
            return JSON.parse(decoder.decode(cbcDecrypt(login.lsk, login.ivb, GLib.base64_decode(response))));
        } catch {
            throw new TapoError('The camera answered something that could not be read.');
        }
    }

    async read() {
        const reply = await this._send({
            method: 'multipleRequest',
            params: {
                requests: [
                    {method: 'getLensMaskConfig', params: {lens_mask: {name: ['lens_mask_info']}}},
                    {method: 'getLedStatus', params: {led: {name: ['config']}}},
                    {method: 'getDayNightModeConfig', params: {image: {name: 'common'}}},
                    {method: 'getDetectionConfig', params: {motion_detection: {name: ['motion_det']}}},
                    {method: 'getLastAlarmInfo', params: {msg_alarm: {name: ['chn1_msg_alarm_info']}}},
                    {method: 'getDeviceInfo', params: {device_info: {name: ['basic_info']}}},
                ],
            },
        });
        const basic = resultOf(reply, 'getDeviceInfo')?.device_info?.basic_info;
        return {
            about: basic ? {
                firmware: basic.sw_version?.replace(/\s+Rel\..*$/, '') || null,
                hardware: basic.hw_version || null,
                mac: basic.mac || null,
            } : null,
            privacy: onOff(resultOf(reply, 'getLensMaskConfig')?.lens_mask?.lens_mask_info?.enabled),
            light: onOff(resultOf(reply, 'getLedStatus')?.led?.config?.enabled),
            night: resultOf(reply, 'getDayNightModeConfig')?.image?.common?.inf_type ?? null,
            motion: onOff(resultOf(reply, 'getDetectionConfig')?.motion_detection?.motion_det?.enabled),
            alarm: onOff(resultOf(reply, 'getLastAlarmInfo')?.msg_alarm?.chn1_msg_alarm_info?.enabled),
        };
    }

    async _set(method, params) {
        const reply = await this._send({method: 'multipleRequest', params: {requests: [{method, params}]}});
        if (!resultOf(reply, method))
            throw new TapoError(`The camera did not take ${method}.`);
    }

    setPrivacy(on) {
        return this._set('setLensMaskConfig', {lens_mask: {lens_mask_info: {enabled: on ? 'on' : 'off'}}});
    }

    setLight(on) {
        return this._set('setLedStatus', {led: {config: {enabled: on ? 'on' : 'off'}}});
    }

    setNight(mode) {
        return this._set('setDayNightModeConfig', {image: {common: {inf_type: mode}}});
    }

    setMotion(on) {
        return this._set('setDetectionConfig', {motion_detection: {motion_det: {enabled: on ? 'on' : 'off'}}});
    }

    async setAlarm(on) {
        const reply = await this._send({
            method: 'set',
            msg_alarm: {
                chn1_msg_alarm_info: {
                    alarm_type: '0',
                    light_type: '0',
                    enabled: on ? 'on' : 'off',
                    alarm_mode: ['sound', 'light'],
                },
            },
        });
        if (reply?.error_code !== 0)
            throw new TapoError(`The camera answered with error ${reply?.error_code}.`, reply?.error_code);
    }

    async siren(on) {
        const reply = await this._send({method: 'do', msg_alarm: {manual_msg_alarm: {action: on ? 'start' : 'stop'}}});
        if (reply?.error_code !== 0)
            throw new TapoError(`The camera answered with error ${reply?.error_code}.`, reply?.error_code);
    }
}
