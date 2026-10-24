// SPDX-License-Identifier: GPL-2.0-or-later

// Sony Bravia REST API with a pre-shared key set on the TV (Network > Home network >
// IP control); remote keys go as IRCC codes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {TvError, download, newSession, request, soap, wake} from './net.js';

const KEYS = {
    'power': 'TvPower',
    'up': 'Up',
    'down': 'Down',
    'left': 'Left',
    'right': 'Right',
    'ok': 'Confirm',
    'back': 'Return',
    'home': 'Home',
    'menu': 'ActionMenu',
    'play': 'Play',
    'pause': 'Pause',
    'volume-up': 'VolumeUp',
    'volume-down': 'VolumeDown',
    'mute': 'Mute',
    'channel-up': 'ChannelUp',
    'channel-down': 'ChannelDown',
    'input': 'Input',
    'tv': 'Tv',
};

export default class SonyTv {
    static pairing = 'psk';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._psk = secret?.psk ?? null;
        this._session = newSession();
        this._codes = null;
        this._closed = false;
        this.onSecret = null;
    }

    get paired() {
        return this._psk !== null;
    }

    async _call(service, method, params = [], version = '1.0') {
        const {status, text} = await request(this._session, 'POST', `http://${this._tv.ip}/sony/${service}`, {
            body: JSON.stringify({method, id: 1, params, version}),
            headers: {'X-Auth-PSK': this._psk ?? ''},
        });
        if (status === 403)
            throw new TvError('The TV did not take the key', 'denied');
        if (status !== 200)
            throw new TvError(`${method}: HTTP ${status}`);
        let reply;
        try {
            reply = JSON.parse(text);
        } catch {
            throw new TvError(`${method}: the TV answered something else`);
        }
        if (reply?.error)
            throw new TvError(`${method}: ${reply.error[1] ?? reply.error[0]}`, String(reply.error[0]));
        return reply?.result ?? [];
    }

    async status() {
        const off = {on: false, volume: null, muted: null, source: null, app: null};
        try {
            const [power] = await this._call('system', 'getPowerStatus');
            if (power?.status !== 'active' || !this._psk)
                return off;
            const [targets = []] = await this._call('audio', 'getVolumeInformation');
            const speaker = targets.find(t => t.target === 'speaker') ?? targets[0];
            // Errors while an app is in front (7, "Illegal State") or the screen is off; no
            // call says which app.
            const [playing] = await this._call('avContent', 'getPlayingContentInfo').catch(() => []);
            // Live TV: {"source":"tv:dvbt","dispNum":"002","title":"ABC",…}; HDMI: {"uri":"extInput:hdmi?port=2",…}.
            const tuner = playing?.source?.startsWith('tv:');
            const channel = tuner ? [playing.dispNum?.replace(/^0+(?=\d)/, ''), playing.title].filter(Boolean).join(' ') : '';
            return {
                on: true,
                volume: speaker?.volume ?? null,
                muted: speaker?.mute ?? null,
                source: tuner ? 'tv' : playing?.uri ?? null,
                app: null,
                title: channel || null,
            };
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error || e instanceof SyntaxError)
                return off;
            throw e;
        }
    }

    setVolume(level) {
        return this._call('audio', 'setAudioVolume', [{target: 'speaker', volume: String(Math.round(level))}]);
    }

    setMuted(muted) {
        return this._call('audio', 'setAudioMute', [{status: muted}]);
    }

    async _remoteCodes() {
        if (!this._codes) {
            const [, codes = []] = await this._call('system', 'getRemoteControllerInfo');
            this._codes = new Map(codes.map(c => [c.name, c.value]));
        }
        return this._codes;
    }

    async press(key) {
        const codes = await this._remoteCodes();
        const code = codes.get(KEYS[key] ?? key) ?? (key === 'menu' ? codes.get('Options') : null);
        if (!code)
            throw new TvError(`No such key: ${key}`);
        await soap(this._session, `http://${this._tv.ip}/sony/IRCC`, 'schemas-sony-com:service:IRCC:1', 'X_SendIRCC',
            `<IRCCCode>${code}</IRCCCode>`, {headers: {'X-Auth-PSK': this._psk ?? ''}});
    }

    // Power-on from standby needs "Remote start" on the TV; deeper sleep needs WoL first.
    async power(on) {
        if (!on) {
            await this._call('system', 'setPowerStatus', [{status: false}]);
            return;
        }
        await wake(this._tv.mac);
        for (let ask = 1; ; ask++) {
            try {
                await this._call('system', 'setPowerStatus', [{status: true}]);
                return;
            } catch (e) {
                if (!(e instanceof GLib.Error) || e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || ask === 4 ||
                    this._closed)
                    throw e;
                await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    resolve();
                    return GLib.SOURCE_REMOVE;
                }));
            }
        }
    }

    // The tuner is not an external input; its remote key switches to it.
    async sources() {
        const [[inputs = []], codes] = await Promise.all([
            this._call('avContent', 'getCurrentExternalInputsStatus'),
            this._remoteCodes().catch(() => new Map()),
        ]);
        const external = inputs.map(i => ({id: i.uri, title: i.label || i.title}));
        return codes.has(KEYS.tv) ? [{id: 'tv'}, ...external] : external;
    }

    source(id) {
        return id === 'tv' ? this.press('tv') : this._call('avContent', 'setPlayContent', [{uri: id}]);
    }

    // "icon": "http://<tv>/DIAL/icon/com.sony.dtv….png", or "" for none.
    async apps() {
        const [apps = []] = await this._call('appControl', 'getApplicationList');
        const onTv = url => typeof url === 'string' && url.startsWith(`http://${this._tv.ip}/`);
        return apps.map(a => ({id: a.uri, title: a.title, icon: onTv(a.icon) ? a.icon : null}));
    }

    icon(url) {
        return download(this._session, url);
    }

    launch(id) {
        return this._call('appControl', 'setActiveApp', [{uri: id}]);
    }

    // Validate the PSK with a call that requires it.
    async pairEnd(psk) {
        this._psk = psk;
        try {
            await this._call('audio', 'getVolumeInformation');
        } catch (e) {
            this._psk = null;
            throw e;
        }
        return {psk};
    }

    close() {
        this._closed = true;
        this._session.abort();
    }
}
