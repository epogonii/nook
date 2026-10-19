// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CastDevice, CastError, discover} from './cast.js';
import {TvError, newSession, request} from './net.js';

export function parseSpeakers(json) {
    try {
        const speakers = JSON.parse(json || '[]');
        return Array.isArray(speakers) ? speakers.filter(s => s?.id && s.ip && s.port) : [];
    } catch {
        return [];
    }
}

const playing = state => state?.media?.state === 'PLAYING';

export class CastHome {
    constructor(speakers) {
        this._links = new Map();
        this._looking = null;
        this._rests = 0;
        this.onChange = null;
        this.onMoved = null;
        this.devices = speakers.map(speaker => {
            const device = {
                did: `cast:${speaker.id}`,
                name: speaker.name || speaker.model || speaker.id,
                model: 'cast',
                castModel: speaker.model ?? '',
                urn: null,
                room: speaker.room ?? null,
                online: null,
                primary: {kind: 'media', props: []},
                values: null,
                state: null,
                about: {ip: speaker.ip, model: speaker.model || null},
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            this._links.set(device.did, {speaker: {...speaker}, cast: null});
            return device;
        });
    }

    _cast(device) {
        const link = this._links.get(device.did);
        if (!link.cast) {
            const cast = link.cast = new CastDevice(link.speaker.ip, link.speaker.port);
            cast.onChange = () => {
                this._show(device, cast.state());
                this.onChange?.(device);
            };
        }
        return link.cast;
    }

    _show(device, state) {
        device.state = state;
        device.online = true;
        device.values = [playing(state)];
    }

    _drop(device) {
        const link = this._links.get(device.did);
        link.cast?.close();
        link.cast = null;
    }

    rest() {
        this._rests++;
        for (const device of this.devices)
            this._drop(device);
        this._looking = null;
        this._session?.abort();
        this._session = null;
    }

    abort() {
        this.rest();
    }

    async details(device) {
        const {speaker} = this._links.get(device.did);
        this._session ??= newSession();
        let info;
        try {
            const {status, text} = await request(this._session, 'GET',
                `http://${speaker.ip}:8008/setup/eureka_info?params=name,build_info,net,wifi`);
            info = status === 200 ? JSON.parse(text) : null;
        } catch (e) {
            if (!(e instanceof TvError) && !(e instanceof GLib.Error) && !(e instanceof SyntaxError))
                throw e;
        }
        if (!info)
            return;
        device.about = {
            ...device.about,
            firmware: info.cast_build_revision || device.about.firmware || null,
            mac: info.mac_address || null,
            ssid: info.ssid || null,
            uptime: Number(info.uptime) || null,
        };
    }

    // Reads in flight when rest() ran must not reopen what it closed.
    async _relocate(device, rests) {
        if (!this._looking) {
            const looking = this._looking = discover(2000).catch(() => []);
            looking.then(() => {
                if (this._looking === looking)
                    this._looking = null;
            });
        }
        const found = await this._looking;
        if (rests !== this._rests)
            return false;
        const link = this._links.get(device.did);
        const now = found.find(s => s.id === link.speaker.id);
        if (!now || (now.ip === link.speaker.ip && now.port === link.speaker.port))
            return false;
        this._drop(device);
        link.speaker = {...link.speaker, ip: now.ip, port: now.port};
        device.about = {...device.about, ip: now.ip};
        this.onMoved?.(link.speaker);
        return true;
    }

    async _read(device) {
        const rests = this._rests;
        try {
            this._show(device, await this._cast(device).status());
            return;
        } catch (e) {
            if (!(e instanceof CastError) && !(e instanceof GLib.Error))
                throw e;
            this._drop(device);
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
        }
        if (rests === this._rests && await this._relocate(device, rests)) {
            try {
                this._show(device, await this._cast(device).status());
                return;
            } catch (e) {
                if (!(e instanceof CastError) && !(e instanceof GLib.Error))
                    throw e;
                this._drop(device);
            }
        }
        device.online = false;
    }

    async readPrimary() {
        await Promise.all(this.devices.map(d => this._read(d)));
        return this.devices.length > 0;
    }

    readDevice(device) {
        return this._read(device);
    }

    async _do(device, action) {
        const cast = this._cast(device);
        await action(cast);
        this._show(device, cast.state());
    }

    setVolume(device, level) {
        return this._do(device, cast => cast.setVolume(level));
    }

    setMuted(device, muted) {
        return this._do(device, cast => cast.setMuted(muted));
    }

    play(device) {
        return this._do(device, cast => cast.play());
    }

    pause(device) {
        return this._do(device, cast => cast.pause());
    }

    skip(device, by) {
        return this._do(device, cast => cast.skip(by));
    }
}

export {CastError, discover};
