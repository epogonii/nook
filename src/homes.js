// SPDX-License-Identifier: GPL-2.0-or-later

import {gettext as _} from 'gettext';

import {AirconHome, parseAircons, parseUnits} from './lib/aircon-home.js';
import {BeaconScan} from './lib/ble.js';
import {CastHome, parseSpeakers} from './lib/cast-home.js';
import {CloudAirconHome, parseEntries} from './lib/cloud-aircon.js';
import {BRAND as ELECTROLUX} from './lib/electrolux.js';
import {EwelinkHome, parseDevices as parseEwelinkDevices} from './lib/ewelink-home.js';
import * as Gateway from './lib/gateway.js';
import {HassHome, parseDevices as parseHassDevices} from './lib/hass-home.js';
import {HomeKitHome, parseHosts as parseHomeKitHosts} from './lib/homekit-home.js';
import {HueHome} from './lib/hue-home.js';
import {parseBridges as parseHueBridges, parseDevices as parseHueDevices} from './lib/hue.js';
import {BRAND as LG} from './lib/lg.js';
import {BRAND as MELCLOUD} from './lib/melcloud.js';
import {MiHome, cachedDevices} from './lib/mihome.js';
import {MiScenes} from './lib/mi-scenes.js';
import * as Secrets from './lib/secrets.js';
import {ShellyHome, parseDevices as parseShelly} from './lib/shelly.js';
import {SmartLifeHome, parseDevices as parseSmartLifeDevices} from './lib/smartlife-home.js';
import {BRAND as SMARTTHINGS} from './lib/smartthings.js';
import {SonoffHome, parseSwitches} from './lib/sonoff.js';
import * as Tapo from './lib/tapo.js';
import {TvHome, parseTvs} from './lib/tv-home.js';
import {XiaomiCloud} from './lib/xiaomi.js';
import {Cameras} from './cameras.js';

const SECRET_LABEL = 'Nook: Xiaomi account';

export const CLOUD_AIRCONS = [LG, SMARTTHINGS, MELCLOUD, ELECTROLUX];

// A change to any of these rebuilds every home.
export const DEVICE_KEYS = ['xiaomi-user-id', 'gree-units', 'aircons', 'tapo-cameras', 'cast-speakers', 'tvs',
    'sonoff-switches', 'shelly-devices', 'ewelink-devices', 'ewelink-region', 'hue-bridges', 'hue-devices',
    'hass-server', 'hass-devices', 'homekit-accessories', 'smartlife-user', 'smartlife-devices',
    ...CLOUD_AIRCONS.map(brand => `${brand.id}-devices`)];

function read(settings, key) {
    return settings.get_value(key).deepUnpack();
}

// keys come as {did: [key]}: a function can't cross D-Bus.
class AppMiHome extends MiHome {
    readLastEvents(devices, keys) {
        return super.readLastEvents(devices, device => keys?.[device.did] ?? []);
    }
}

class AppBeaconScan extends BeaconScan {
    setKey(address, key) {
        this.keys.set(address, key);
    }

    abort() {
        this.stop();
    }
}

// Names from the device cache: no cloud requests, this runs on the lock screen.
export class GatewayAlerts {
    constructor(settings, onReport) {
        this._settings = settings;
        this._listener = new Gateway.Listener(report => this._report(report, onReport).catch(logError));
    }

    async _report(report, onReport) {
        const devices = await cachedDevices(this._settings.get_string('xiaomi-user-id'));
        const device = devices.find(d => d.did === `lumi.${report.sid}`);
        onReport({...report, name: device?.name ?? null, room: device?.room ?? null});
    }

    get states() {
        return this._listener.states();
    }

    get heard() {
        return this._listener.heard;
    }

    get running() {
        return this._listener.running;
    }

    read(sid) {
        return this._listener.read(sid);
    }

    start() {
        this._listener.start();
    }

    stop() {
        this._listener.stop();
    }

    abort() {
        this.stop();
    }
}

export function openBeacons(onBeacon) {
    return new AppBeaconScan(onBeacon);
}

// ids carry a generation: a call racing a rebuild can't reach the new home.
export class Homes {
    constructor(settings) {
        this._settings = settings;
        this._generation = 0;
        this.list = [];
        // A home saving a moved camera or speaker must not rebuild the homes.
        this.keeping = false;
        this._xiaomiState = null;
    }

    // Mi Home waits on the keyring: see xiaomi().
    build() {
        const settings = this._settings;
        const generation = ++this._generation;
        const list = [];
        const add = (kind, home) => list.push({id: `${kind}.${generation}`, kind, home});

        const aircons = [...parseUnits(read(settings, 'gree-units')), ...parseAircons(read(settings, 'aircons'))];
        if (aircons.length > 0)
            add('aircon', new AirconHome(aircons));
        const cameras = Tapo.parseCameras(read(settings, 'tapo-cameras'));
        if (cameras.length > 0) {
            const tapo = new Cameras(cameras);
            tapo.onMoved = moved => this._keepCameras(moved);
            add('tapo', tapo);
        }
        const speakers = parseSpeakers(read(settings, 'cast-speakers'));
        if (speakers.length > 0) {
            const cast = new CastHome(speakers);
            cast.onMoved = speaker => this._keepSpeaker(speaker);
            add('cast', cast);
        }
        const tvs = parseTvs(read(settings, 'tvs'));
        if (tvs.length > 0)
            add('tv', new TvHome(tvs));
        const switches = parseSwitches(read(settings, 'sonoff-switches'));
        if (switches.length > 0)
            add('sonoff', new SonoffHome(switches));
        const shellies = parseShelly(read(settings, 'shelly-devices'));
        if (shellies.length > 0)
            add('shelly', new ShellyHome(shellies));
        const ewelink = parseEwelinkDevices(read(settings, 'ewelink-devices'));
        if (ewelink.length > 0 && read(settings, 'ewelink-region'))
            add('ewelink', new EwelinkHome(ewelink));
        const hue = parseHueDevices(read(settings, 'hue-devices'));
        if (hue.length > 0)
            add('hue', new HueHome(parseHueBridges(read(settings, 'hue-bridges')), hue));
        const hass = parseHassDevices(read(settings, 'hass-devices'));
        if (hass.length > 0 && read(settings, 'hass-server'))
            add('hass', new HassHome(hass));
        const accessories = parseHomeKitHosts(read(settings, 'homekit-accessories'));
        if (accessories.length > 0)
            add('homekit', new HomeKitHome(accessories));
        const smartlife = parseSmartLifeDevices(read(settings, 'smartlife-devices'));
        if (smartlife.length > 0 && read(settings, 'smartlife-user'))
            add('smartlife', new SmartLifeHome(smartlife));
        for (const brand of CLOUD_AIRCONS) {
            const entries = parseEntries(read(settings, `${brand.id}-devices`));
            if (entries.length > 0)
                list.push({id: `cloud:${brand.id}.${generation}`, kind: 'cloud', home: new CloudAirconHome(brand, entries)});
        }

        this.list = list;
        this._xiaomiState = null;
        return list;
    }

    xiaomi() {
        const generation = this._generation;
        this._xiaomiState ??= this._xiaomi(generation).then(state => {
            const list = generation === this._generation ? state.list : [];
            if (generation !== this._generation)
                close(state.list);
            this.list.push(...list);
            return {...state, list};
        });
        return this._xiaomiState;
    }

    // state: 'ok', 'none', 'unreadable' or 'keyring' (with message).
    async _xiaomi(generation) {
        let saved;
        try {
            saved = await Secrets.lookup('xiaomi');
        } catch (e) {
            return {state: 'keyring', message: e.message, list: []};
        }
        if (!saved)
            return {state: 'none', list: []};
        let credentials;
        try {
            credentials = JSON.parse(saved);
        } catch {
            return {state: 'unreadable', list: []};
        }
        const cloud = new XiaomiCloud(credentials);
        const home = new AppMiHome(cloud);
        // A token refresh finishing after logout must not re-store the login.
        cloud.onRefresh = fresh => {
            if (this.list.some(entry => entry.home === home))
                Secrets.store('xiaomi', SECRET_LABEL, JSON.stringify(fresh)).catch(logError);
        };
        return {
            state: 'ok',
            list: [
                {id: `xiaomi.${generation}`, kind: 'xiaomi', home},
                {id: `scenes.${generation}`, kind: 'scenes', home: new MiScenes(cloud, home, _('Scene'))},
            ],
        };
    }

    close() {
        this._generation++;
        close(this.list);
        this.list = [];
        this._xiaomiState = null;
    }

    _keepCameras(moved) {
        const cameras = Tapo.parseCameras(read(this._settings, 'tapo-cameras'))
            .map(camera => ({...camera, ...moved.find(m => m.id === camera.id)}));
        this._keep('tapo-cameras', JSON.stringify(cameras));
    }

    _keepSpeaker(speaker) {
        const speakers = parseSpeakers(read(this._settings, 'cast-speakers'))
            .map(s => (s.id === speaker.id ? {...s, ip: speaker.ip, port: speaker.port} : s));
        this._keep('cast-speakers', JSON.stringify(speakers));
    }

    _keep(key, value) {
        this.keeping = true;
        try {
            this._settings.set_string(key, value);
        } finally {
            this.keeping = false;
        }
    }
}

function close(list) {
    for (const {home} of list) {
        try {
            home.abort?.();
        } catch (e) {
            logError(e);
        }
    }
}
