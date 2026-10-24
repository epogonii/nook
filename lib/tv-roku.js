// SPDX-License-Identifier: GPL-2.0-or-later

// Roku External Control Protocol on port 8060, no pairing. Needs Settings > System >
// Advanced > Control by mobile apps enabled.

import GLib from 'gi://GLib';

import {TvError, download, newSession, request, tag, unescape, wake} from './net.js';

const KEYS = {
    'power': 'Power',
    'up': 'Up',
    'down': 'Down',
    'left': 'Left',
    'right': 'Right',
    'ok': 'Select',
    'back': 'Back',
    'home': 'Home',
    'menu': 'Info',
    'play': 'Play',
    'pause': 'Play',
    'volume-up': 'VolumeUp',
    'volume-down': 'VolumeDown',
    'mute': 'VolumeMute',
    'channel-up': 'ChannelUp',
    'channel-down': 'ChannelDown',
    'tv': 'InputTuner',
    'hdmi1': 'InputHDMI1',
    'hdmi2': 'InputHDMI2',
    'hdmi3': 'InputHDMI3',
    'hdmi4': 'InputHDMI4',
};

export default class RokuTv {
    static pairing = null;

    constructor(tv) {
        this._tv = tv;
        this._session = newSession();
        this._base = `http://${tv.ip}:8060`;
        this._isTv = true;
        this.onSecret = null;
    }

    get paired() {
        return true;
    }

    async _get(path) {
        const {status, text} = await request(this._session, 'GET', `${this._base}${path}`);
        if (status !== 200)
            throw new TvError(`${path}: HTTP ${status}`);
        return text;
    }

    async _post(path) {
        const {status} = await request(this._session, 'POST', `${this._base}${path}`, {body: '', type: 'text/plain'});
        if (status !== 200 && status !== 202 && status !== 204)
            throw new TvError(`${path}: HTTP ${status}`);
    }

    // <app id="12" type="appl" version="4.1.218">Netflix</app>. The home screen comes as a bare
    // <app>Roku</app>, or on newer OS as app 562859 with ui-location="home".
    _parseApps(xml) {
        return [...xml.matchAll(/<app\b([^>]*)>([^<]*)<\/app>/g)].map(([, attrs, title]) => {
            const id = unescape(/\bid="([^"]*)"/.exec(attrs)?.[1] ?? '') || null;
            const home = !id || id === '562859' || /\bui-location="home"/.test(attrs);
            return {id: home ? null : id, type: /\btype="([^"]*)"/.exec(attrs)?.[1] ?? null, title: unescape(title).trim()};
        });
    }

    // <tv-channel><channel><number>14.3</number><name>getTV</name>…
    async _channel() {
        const xml = await this._get('/query/tv-active-channel');
        return [tag(xml, 'number'), tag(xml, 'name')].filter(Boolean).join(' ') || null;
    }

    // ECP has no volume query, only volume keys. Roku TV inputs run as tvin apps.
    async status() {
        const off = {on: false, volume: null, muted: null, source: null, app: null};
        try {
            const info = await this._get('/query/device-info');
            this._isTv = tag(info, 'is-tv') === 'true';
            const mode = tag(info, 'power-mode');
            if (mode && mode !== 'PowerOn')
                return off;
            const [active] = this._parseApps(await this._get('/query/active-app').catch(() => ''));
            const showing = {on: true, volume: null, muted: null, source: null, app: null};
            if (!active?.id)
                return showing;
            if (active.id === 'tvinput.dtv')
                return {...showing, source: active.id, title: await this._channel().catch(() => null) ?? (active.title || null)};
            if (active.type === 'tvin')
                return {...showing, source: active.id, title: active.title || null};
            return {...showing, app: active.id, title: active.title || null};
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error)
                return off;
            throw e;
        }
    }

    press(key) {
        return this._post(`/keypress/${KEYS[key] ?? key}`);
    }

    async power(on) {
        if (on)
            await wake(this._tv.mac);
        await this.press(on ? 'PowerOn' : 'PowerOff');
    }

    // The TV's own input names, renamed ones too. Limited mode refuses /query/apps with
    // HTTP 403; tuner and HDMI keys still work there.
    async sources() {
        if (!this._isTv)
            return [];
        const inputs = await this._get('/query/apps')
            .then(xml => this._parseApps(xml).filter(a => a.id && a.type === 'tvin'), e => {
                if (!(e instanceof TvError))
                    throw e;
                return [];
            });
        if (inputs.length === 0)
            return ['tv', 'hdmi1', 'hdmi2', 'hdmi3'].map(id => ({id}));
        return inputs.map(a => ({id: a.id, title: a.title || null}));
    }

    source(id) {
        return id.startsWith('tvinput.') ? this._post(`/launch/${encodeURIComponent(id)}`) : this.press(id);
    }

    async apps() {
        return this._parseApps(await this._get('/query/apps'))
            .filter(a => a.id && a.type !== 'tvin')
            .map(a => ({id: a.id, title: a.title, icon: a.id}));
    }

    icon(id) {
        return download(this._session, `${this._base}/query/icon/${encodeURIComponent(id)}`);
    }

    launch(id) {
        return this._post(`/launch/${encodeURIComponent(id)}`);
    }

    close() {
        this._session.abort();
    }
}
