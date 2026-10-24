// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {Channel, TvError, newSession, openSocket, readVolume, request, setMute, setVolume, wake} from './net.js';

const KEYS = {
    'power': 'KEY_POWER',
    'up': 'KEY_UP',
    'down': 'KEY_DOWN',
    'left': 'KEY_LEFT',
    'right': 'KEY_RIGHT',
    'ok': 'KEY_ENTER',
    'back': 'KEY_RETURN',
    'home': 'KEY_HOME',
    'menu': 'KEY_MENU',
    'play': 'KEY_PLAY',
    'pause': 'KEY_PAUSE',
    'volume-up': 'KEY_VOLUP',
    'volume-down': 'KEY_VOLDOWN',
    'mute': 'KEY_MUTE',
    'channel-up': 'KEY_CHUP',
    'channel-down': 'KEY_CHDOWN',
    'input': 'KEY_SOURCE',
    'tv': 'KEY_TV',
    'hdmi1': 'KEY_HDMI1',
    'hdmi2': 'KEY_HDMI2',
    'hdmi3': 'KEY_HDMI3',
    'hdmi4': 'KEY_HDMI4',
};

// Store ids for REST lookups; several apps changed id on 2020+ models, so both are asked.
const KNOWN_APPS = [
    ['111299001912', 'YouTube'],
    ['3201907018807', 'Netflix'],
    ['11101200001', 'Netflix'],
    ['3201910019365', 'Prime Video'],
    ['3201512006785', 'Prime Video'],
    ['3201901017640', 'Disney+'],
    ['3202009021709', 'Disney+'],
    ['3202204027038', 'Disney+'],
    ['3201807016597', 'Apple TV'],
    ['3201606009684', 'Spotify'],
    ['3201512006963', 'Plex'],
    ['3202203026841', 'Twitch'],
];

const encoder = new TextEncoder();

export default class SamsungTv {
    static pairing = 'prompt';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._secret = secret?.token || secret?.allowed ? secret : null;
        this._session = newSession();
        this._channel = null;
        this._linking = null;
        this._appTypes = new Map();
        this._listed = [];
        this._shown = null;
        this._looking = null;
        this._closed = false;
        this.refused = false;
        this.onSecret = null;
    }

    get paired() {
        return this._secret !== null;
    }

    async _info() {
        const {status, text} = await request(this._session, 'GET', `http://${this._tv.ip}:8001/api/v2/`);
        if (status !== 200)
            throw new TvError(`The TV answered HTTP ${status}`);
        try {
            return JSON.parse(text).device ?? {};
        } catch {
            throw new TvError('The TV answered something else');
        }
    }

    // The first ms.channel.* event is the TV's verdict: immediate for a known token,
    // otherwise after the on-screen prompt, which only pairing waits for.
    async _connect(token, wait, mayAsk = false) {
        const info = await this._info();
        const name = GLib.base64_encode(encoder.encode('Nook'));
        const url = info.TokenAuthSupport === 'true'
            ? `wss://${this._tv.ip}:8002/api/v2/channels/samsung.remote.control?name=${name}${token ? `&token=${token}` : ''}`
            : `ws://${this._tv.ip}:8001/api/v2/channels/samsung.remote.control?name=${name}`;
        const channel = new Channel(await openSocket(this._session, url));
        try {
            let hello;
            try {
                hello = await channel.next(m => m.event?.startsWith('ms.channel.'), wait);
            } catch (e) {
                // Timeout on a saved token: it was rejected and the TV is prompting.
                if (!mayAsk && e.code === 'timeout') {
                    this.refused = true;
                    this._secret = null;
                    throw new TvError('The TV no longer knows Nook', 'unpaired');
                }
                throw e;
            }
            if (hello.event !== 'ms.channel.connect') {
                if (!mayAsk) {
                    this.refused = true;
                    this._secret = null;
                }
                throw new TvError('The TV did not let Nook in', 'denied');
            }
            return {channel, token: hello.data?.token ?? null};
        } catch (e) {
            channel.close();
            throw e;
        }
    }

    _link() {
        if (this._channel && !this._channel.closed)
            return Promise.resolve(this._channel);
        if (!this._secret)
            return Promise.reject(new TvError('The TV is not paired yet', 'unpaired'));
        this._linking ??= this._connect(this._secret.token, 5000).then(({channel, token}) => {
            if (this._closed) {
                channel.close();
                throw new TvError('Closed', 'closed');
            }
            if (token && token !== this._secret?.token) {
                this._secret = {token};
                this.onSecret?.(this._secret);
            }
            this._channel = channel;
            return channel;
        }).finally(() => {
            this._linking = null;
        });
        return this._linking;
    }

    _volumeUrl() {
        return `http://${this._tv.ip}:9197/upnp/control/RenderingControl1`;
    }

    // {"id":"111299001912","name":"YouTube","running":true,"version":"2.1.498","visible":true};
    // 404 if not installed. Answers without the token, also where the websocket lists no apps.
    async _appState(id) {
        try {
            const {status, text} = await request(this._session, 'GET',
                `http://${this._tv.ip}:8001/api/v2/applications/${encodeURIComponent(id)}`);
            return status === 200 ? JSON.parse(text) : null;
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error || e instanceof SyntaxError)
                return null;
            throw e;
        }
    }

    // visible is the app in front; running alone is one left in the background.
    async _visibleApp() {
        const listed = this._listed.length > 0 ? this._listed.slice(0, 12) : KNOWN_APPS.map(([id]) => id);
        const ids = [...new Set([this._shown?.id, ...listed].filter(Boolean))];
        const states = await Promise.all(ids.map(id => this._appState(id)));
        this._shown = states.find(state => state?.visible === true) ?? null;
        return this._shown;
    }

    // Each lookup can take seconds; past 4 the last answer stands in for this read and
    // the lookup still lands for the next.
    _visibleAppSoon() {
        this._looking ??= this._visibleApp().finally(() => {
            this._looking = null;
        });
        let timer = 0;
        const late = new Promise(resolve => {
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                timer = 0;
                resolve(this._shown);
                return GLib.SOURCE_REMOVE;
            });
        });
        return Promise.race([this._looking, late]).finally(() => {
            if (timer)
                GLib.source_remove(timer);
        });
    }

    async status() {
        let info;
        try {
            info = await this._info();
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error || e instanceof SyntaxError)
                return {on: false, volume: null, muted: null, source: null, app: null};
            throw e;
        }
        // Older models have no PowerState and can't report standby.
        const on = (info.PowerState ?? 'on') === 'on';
        if (!on)
            return {on, volume: null, muted: null, source: null, app: null};
        const [sound, app] = await Promise.all([
            readVolume(this._session, this._volumeUrl()).catch(e => {
                if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                    throw e;
                return {volume: null, muted: null};
            }),
            this._visibleAppSoon(),
        ]);
        // Tizen tells no input locally, only SmartThings does.
        return {on, ...sound, source: null, app: app?.id ?? null, title: app?.name ?? null};
    }

    setVolume(level) {
        return setVolume(this._session, this._volumeUrl(), level);
    }

    setMuted(muted) {
        return setMute(this._session, this._volumeUrl(), muted);
    }

    async press(key) {
        const channel = await this._link();
        channel.send({
            method: 'ms.remote.control',
            params: {Cmd: 'Click', DataOfCmd: KEYS[key] ?? key, Option: 'false', TypeOfRemote: 'SendRemoteKey'},
        });
    }

    // Standby TVs still answer and wake on KEY_POWER; deeper sleep needs WoL first.
    // KEY_POWER toggles, so two reads must agree the TV is the other way.
    async power(on) {
        for (let ask = 0; ask < 2; ask++) {
            const now = await this.status();
            if (now.on === on)
                return;
        }
        if (on) {
            wake(this._tv.mac);
            try {
                await this._info();
            } catch {
                return;
            }
        }
        await this.press('power');
    }

    sources() {
        return ['tv', 'hdmi1', 'hdmi2', 'hdmi3', 'hdmi4'].map(id => ({id}));
    }

    source(id) {
        return this.press(id);
    }

    // Many 2020+ models ignore ed.installedApp.get or answer ms.error; then the known apps
    // that the REST lookup finds stand in, without icons.
    async apps() {
        const channel = await this._link();
        channel.send({method: 'ms.channel.emit', params: {event: 'ed.installedApp.get', to: 'host'}});
        const reply = await channel.next(m => m.event === 'ed.installedApp.get' || m.event === 'ms.error', 3000)
            .catch(e => {
                if (!(e instanceof TvError) || e.code !== 'timeout')
                    throw e;
                return null;
            });
        const apps = reply?.event === 'ed.installedApp.get' ? reply.data?.data ?? [] : [];
        if (apps.length > 0) {
            for (const app of apps)
                this._appTypes.set(app.appId, app.app_type);
            this._listed = apps.map(app => app.appId);
            return apps.map(app => ({id: app.appId, title: app.name, icon: app.icon || null}));
        }
        const states = await Promise.all(KNOWN_APPS.map(([id]) => this._appState(id)));
        const found = states.filter(Boolean);
        this._listed = found.map(state => state.id);
        return found.map(state => ({id: state.id, title: state.name || KNOWN_APPS.find(([id]) => id === state.id)[1]}));
    }

    // {"event":"ed.apps.icon","data":{"iconPath":"/opt/share/…/250x250.png","imageBase64":"iVBOR…"}}
    async icon(path) {
        const channel = await this._link();
        channel.send({method: 'ms.channel.emit', params: {event: 'ed.apps.icon', to: 'host', data: {iconPath: path}}});
        const reply = await channel.next(m => m.event === 'ed.apps.icon' && m.data?.iconPath === path, 5000);
        if (!reply.data?.imageBase64)
            throw new TvError('The TV sent no icon');
        return new GLib.Bytes(GLib.base64_decode(reply.data.imageBase64));
    }

    // Apps found only by the REST lookup have no launch type; REST launches those.
    async launch(id) {
        if (!this._appTypes.has(id)) {
            const {status} = await request(this._session, 'POST',
                `http://${this._tv.ip}:8001/api/v2/applications/${encodeURIComponent(id)}`, {body: ''});
            if (status !== 200)
                throw new TvError(`The TV answered HTTP ${status}`);
            return;
        }
        const channel = await this._link();
        channel.send({
            method: 'ms.channel.emit',
            params: {
                event: 'ed.apps.launch',
                to: 'host',
                data: {appId: id, action_type: this._appTypes.get(id) === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH'},
            },
        });
    }

    async pairBegin() {
        const {channel, token} = await this._connect(null, 30000, true);
        this._secret = token ? {token} : {allowed: true};
        this._channel = channel;
        return {done: true, secret: this._secret};
    }

    close() {
        this._closed = true;
        this._channel?.close();
        this._channel = null;
        this._session.abort();
    }
}
