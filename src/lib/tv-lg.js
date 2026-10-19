// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {Channel, TvError, download, newSession, openSocket, wake} from './net.js';

const KEYS = {
    'power': 'POWER',
    'up': 'UP',
    'down': 'DOWN',
    'left': 'LEFT',
    'right': 'RIGHT',
    'ok': 'ENTER',
    'back': 'BACK',
    'home': 'HOME',
    'menu': 'MENU',
    'play': 'PLAY',
    'pause': 'PAUSE',
    'volume-up': 'VOLUMEUP',
    'volume-down': 'VOLUMEDOWN',
    'mute': 'MUTE',
    'channel-up': 'CHANNELUP',
    'channel-down': 'CHANNELDOWN',
    'input': 'INPUT_HUB',
};

const LIVE_TV = 'com.webos.app.livetv';
const HOME = 'com.webos.app.home';
// Foreground app ids of external inputs: com.webos.app.hdmi1, com.webos.app.externalinput.av1.
const INPUT_APP = /^com\.webos\.app\.(hdmi\d|externalinput\.)/;

const PERMISSIONS = [
    'LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'CONTROL_AUDIO', 'CONTROL_DISPLAY',
    'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_PLAYBACK', 'CONTROL_INPUT_TV',
    'CONTROL_MOUSE_AND_KEYBOARD', 'CONTROL_POWER', 'CONTROL_TV_SCREEN', 'READ_APP_STATUS',
    'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST', 'READ_INSTALLED_APPS',
    'READ_NETWORK_STATE', 'READ_POWER_STATE', 'READ_RUNNING_APPS', 'READ_SETTINGS',
    'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST',
];

export default class LgTv {
    static pairing = 'prompt';

    constructor(tv, secret = null) {
        this._tv = tv;
        this._key = secret?.key ?? null;
        this._session = newSession();
        this._channel = null;
        this._linking = null;
        this._buttons = null;
        this._buttonsOpening = null;
        this._listing = null;
        this._asked = 0;
        this._closed = false;
        this.refused = false;
        this.onSecret = null;
    }

    get paired() {
        return this._key !== null;
    }

    // Newer firmware: wss on 3001 only; older: ws on 3000. TLS first, so the client key
    // goes in clear only to a TV that offers nothing else.
    // mayAsk: only pairing may leave a prompt on the TV.
    async _connect(key, wait, mayAsk = false) {
        let connection;
        try {
            connection = await openSocket(this._session, `wss://${this._tv.ip}:3001/`);
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            connection = await openSocket(this._session, `ws://${this._tv.ip}:3000/`);
        }
        const channel = new Channel(connection);
        try {
            channel.send({
                type: 'register',
                id: 'register_0',
                payload: {
                    'forcePairing': false,
                    'pairingType': 'PROMPT',
                    'client-key': key ?? undefined,
                    'manifest': {manifestVersion: 1, appVersion: '1.1', permissions: PERMISSIONS},
                },
            });
            let reply = await channel.next(m => m.id === 'register_0', 5000);
            // "response" before "registered": the TV is showing the pairing prompt.
            if (reply.type === 'response') {
                if (!mayAsk) {
                    this.refused = true;
                    this._key = null;
                    throw new TvError('The TV no longer knows Nook', 'unpaired');
                }
                reply = await channel.next(m => m.id === 'register_0', wait);
            }
            if (reply.type !== 'registered')
                throw new TvError(reply.error ?? 'The TV did not let Nook in', 'denied');
            return {channel, key: reply.payload?.['client-key'] ?? key};
        } catch (e) {
            channel.close();
            throw e;
        }
    }

    _link() {
        if (this._channel && !this._channel.closed)
            return Promise.resolve(this._channel);
        if (!this._key)
            return Promise.reject(new TvError('The TV is not paired yet', 'unpaired'));
        this._linking ??= this._connect(this._key, 5000).then(({channel, key}) => {
            if (this._closed) {
                channel.close();
                throw new TvError('Closed', 'closed');
            }
            if (key && key !== this._key) {
                this._key = key;
                this.onSecret?.({key});
            }
            this._channel = channel;
            return channel;
        }).finally(() => {
            this._linking = null;
        });
        return this._linking;
    }

    async _ask(uri, payload = {}, wait = 5000) {
        const channel = await this._link();
        const id = `nook_${++this._asked}`;
        channel.send({id, type: 'request', uri: `ssap://${uri}`, payload});
        const reply = await channel.next(m => m.id === id, wait);
        if (reply.type === 'error' || reply.payload?.returnValue === false)
            throw new TvError(reply.error ?? reply.payload?.errorText ?? `${uri} failed`);
        return reply.payload ?? {};
    }

    // Without a key, don't connect: it would pop the pairing prompt on the TV.
    async status() {
        const off = {on: false, volume: null, muted: null, source: null, app: null};
        if (!this._key)
            return off;
        try {
            await this._link();
            const power = await this._ask('com.webos.service.tvpower/power/getPowerState').catch(() => ({}));
            // "Screen Saver" and "Screen Off" (audio only) still count as on.
            if (power.state && !['Active', 'Screen Saver', 'Screen Off'].includes(power.state))
                return off;
            const audio = await this._ask('audio/getVolume');
            const {appId = ''} = await this._ask('com.webos.applicationManager/getForegroundAppInfo').catch(() => ({}));
            const state = {
                on: true,
                volume: audio.volumeStatus?.volume ?? audio.volume ?? null,
                muted: audio.volumeStatus?.muteStatus ?? audio.muted ?? null,
                source: null,
                app: appId && appId !== HOME ? appId : null,
            };
            if (appId === LIVE_TV)
                return {...state, app: null, source: 'tv', title: await this._currentChannel().catch(() => null)};
            if (INPUT_APP.test(appId))
                return {...state, app: null, source: appId};
            return state;
        } catch (e) {
            if (e instanceof TvError || e instanceof GLib.Error) {
                this._drop();
                return off;
            }
            throw e;
        }
    }

    _drop() {
        this._channel?.close();
        this._channel = null;
        this._buttons?.close();
        this._buttons = null;
    }

    setVolume(level) {
        return this._ask('audio/setVolume', {volume: Math.round(level)});
    }

    setMuted(muted) {
        return this._ask('audio/setMute', {mute: muted});
    }

    async press(key) {
        if (!this._buttons || this._buttons.closed) {
            this._buttonsOpening ??= this._ask('com.webos.service.networkinput/getPointerInputSocket')
                .then(async ({socketPath}) => {
                    if (typeof socketPath !== 'string')
                        throw new TvError('The TV gave no socket for buttons');
                    const channel = new Channel(await openSocket(this._session, socketPath));
                    if (this._closed) {
                        channel.close();
                        throw new TvError('Closed', 'closed');
                    }
                    return channel;
                })
                .finally(() => {
                    this._buttonsOpening = null;
                });
            this._buttons = await this._buttonsOpening;
        }
        this._buttons.send(`type:button\nname:${KEYS[key] ?? key}\n\n`);
    }

    async power(on) {
        if (on) {
            wake(this._tv.mac);
            return;
        }
        try {
            await this._ask('system/turnOff');
        } catch (e) {
            if (!(e instanceof TvError) || !['timeout', 'closed'].includes(e.code))
                throw e;
        }
        this._drop();
    }

    // {"channelNumber":"15","channelName":"BFM TV",…}. Errors off Live TV; with no channels
    // tuned the TV never answers.
    async _currentChannel() {
        const {channelNumber, channelName} = await this._ask('tv/getCurrentChannel', {}, 2000);
        return [channelNumber?.replace(/^0+(?=\d)/, ''), channelName].filter(Boolean).join(' ') || null;
    }

    _launchPoints() {
        this._listing ??= this._ask('com.webos.applicationManager/listLaunchPoints')
            .then(({launchPoints = []}) => launchPoints)
            .finally(() => {
                this._listing = null;
            });
        return this._listing;
    }

    // Live TV is an app, not an external input; offer it where the TV has it.
    async sources() {
        const [{devices = []}, points] = await Promise.all([
            this._ask('tv/getExternalInputList'),
            this._launchPoints().catch(() => []),
        ]);
        const inputs = devices.map(d => ({id: d.id, title: d.label || d.id.replace(/_/g, ' '), app: d.appId}));
        return points.some(p => p.id === LIVE_TV) ? [{id: 'tv', app: LIVE_TV}, ...inputs] : inputs;
    }

    source(id) {
        return id === 'tv' ? this.launch(LIVE_TV) : this._ask('tv/switchInput', {inputId: id});
    }

    // Icons are http(s) URLs on the TV; old firmware gives largeIcon as a file path.
    async apps() {
        const onTv = url => typeof url === 'string' && url.includes(`://${this._tv.ip}:`);
        return (await this._launchPoints())
            .filter(a => a.id !== LIVE_TV && !INPUT_APP.test(a.id))
            .map(a => ({id: a.id, title: a.title, icon: [a.largeIcon, a.icon].find(onTv) ?? null}));
    }

    icon(url) {
        return download(this._session, url);
    }

    launch(id) {
        return this._ask('system.launcher/launch', {id});
    }

    async pairBegin() {
        const {channel, key} = await this._connect(null, 60000, true);
        if (!key) {
            channel.close();
            throw new TvError('The TV gave no key');
        }
        this._key = key;
        this._channel = channel;
        return {done: true, secret: {key}};
    }

    close() {
        this._closed = true;
        this._drop();
        this._session.abort();
    }
}
