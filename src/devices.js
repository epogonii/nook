// SPDX-License-Identifier: GPL-2.0-or-later

import {gettext as _} from 'gettext';

import {BRANDS as AIRCONS, didOf as airconDid, parseAircons, parseUnits} from './lib/aircon-home.js';
import {parseSpeakers} from './lib/cast-home.js';
import {parseEntries} from './lib/cloud-aircon.js';
import * as EwelinkHome from './lib/ewelink-home.js';
import * as Hass from './lib/hass.js';
import * as HomeKit from './lib/homekit.js';
import * as Hue from './lib/hue.js';
import {cacheFile, cachedDevices, readJson} from './lib/mihome.js';
import * as Shelly from './lib/shelly.js';
import * as SmartLifeHome from './lib/smartlife-home.js';
import * as Sonoff from './lib/sonoff.js';
import * as Tapo from './lib/tapo.js';
import {BRANDS, parseTvs} from './lib/tv-home.js';
import {CLOUD_AIRCONS} from './homes.js';

async function cachedScenes(userId) {
    if (!userId)
        return [];
    let scenes = null;
    try {
        scenes = (await readJson(cacheFile(`xiaomi-scenes-${userId}.json`)))?.scenes;
    } catch {}
    return Array.isArray(scenes) ? scenes.map(scene => ({
        did: `miscene:${scene.id}`,
        name: scene.name || _('Scene'),
        room: null,
        type: 'scene',
        primary: {kind: 'scene', props: []},
    })) : [];
}

export function hueDevices(settings) {
    const bridges = new Set(Hue.parseBridges(settings.get_string('hue-bridges')).map(b => b.id));
    return Hue.parseDevices(settings.get_string('hue-devices')).filter(d => bridges.has(d.bridge));
}

// For the extension's Devices page: settings and caches only, no device is asked.
export async function listDevices(settings) {
    const conditioners = [...parseUnits(settings.get_string('gree-units')),
        ...parseAircons(settings.get_string('aircons'))].map(unit => ({
        did: airconDid(unit),
        name: unit.name || unit.mac || AIRCONS[unit.brand ?? 'gree'].title,
        room: unit.room ?? null,
        primary: {kind: 'climate', props: []},
    }));
    const cameras = Tapo.parseCameras(settings.get_string('tapo-cameras')).map(camera => ({
        did: `tapo:${camera.id}`,
        name: camera.name,
        room: camera.room ?? null,
        primary: {kind: 'camera', props: []},
    }));
    const speakers = parseSpeakers(settings.get_string('cast-speakers')).map(speaker => ({
        did: `cast:${speaker.id}`,
        name: speaker.name || speaker.model || speaker.id,
        room: speaker.room ?? null,
        primary: {kind: 'media', props: []},
    }));
    const tvs = parseTvs(settings.get_string('tvs')).map(tv => ({
        did: `tv:${tv.id}`,
        name: tv.name || tv.model || BRANDS[tv.brand].title,
        room: tv.room ?? null,
        primary: {kind: 'tv', props: []},
    }));
    const switches = Sonoff.parseSwitches(settings.get_string('sonoff-switches')).flatMap(unit =>
        Sonoff.channels(unit).map(({did, name}) => ({
            did,
            name,
            room: unit.room ?? null,
            type: 'switch',
            primary: {kind: 'switch', props: []},
        })));
    const shellies = Shelly.parseDevices(settings.get_string('shelly-devices')).flatMap(unit =>
        unit.channels.map(channel => ({
            did: Shelly.didOf(unit, channel.key),
            name: Shelly.channelName(unit, channel),
            room: unit.room ?? null,
            type: Shelly.typeOf(unit, channel.key),
            primary: {kind: channel.key.startsWith('cover:') ? 'reading' : 'switch', props: []},
        })));
    const ewelink = EwelinkHome.parseDevices(settings.get_string('ewelink-devices')).flatMap(unit =>
        EwelinkHome.channels(unit).map(({did, name}) => ({
            did,
            name,
            room: unit.room ?? null,
            type: 'switch',
            primary: {kind: 'switch', props: []},
        })));
    const hue = hueDevices(settings).map(entry => ({
        did: `hue:${entry.id}`,
        name: entry.name || entry.model || 'Hue',
        room: entry.room ?? null,
        type: {light: 'light', plug: 'outlet'}[entry.kind] ?? 'sensor',
        primary: {kind: entry.kind === 'sensor' ? 'reading' : 'switch', props: []},
    }));
    const hass = Hass.parseDevices(settings.get_string('hass-devices')).map(entry => ({
        did: `hass:${entry.id}`,
        name: entry.name || entry.id,
        room: entry.room ?? null,
        type: entry.type,
        primary: {kind: entry.type === 'scene' ? 'scene' : entry.type.endsWith('sensor') ? 'reading' : 'switch', props: []},
    }));
    const switching = ['light', 'outlet', 'switch', 'fan', 'fan2', 'thermostat', 'heater-cooler', 'humidifier', 'purifier'];
    const homekit = HomeKit.parseHosts(settings.get_string('homekit-accessories')).flatMap(host =>
        host.accessories.map(accessory => ({
            did: `homekit:${host.id}/${accessory.aid}`,
            name: accessory.name || host.name || 'HomeKit',
            room: null,
            type: ['light', 'outlet', 'switch'].find(kind => accessory.services.some(s => s.kind === kind)) ?? null,
            primary: {kind: accessory.services.some(s => switching.includes(s.kind)) ? 'switch' : 'reading', props: []},
        })));
    const smartlife = SmartLifeHome.parseDevices(settings.get_string('smartlife-devices')).map(entry => ({
        did: SmartLifeHome.didOf(entry),
        name: entry.name,
        room: entry.room ?? null,
        type: SmartLifeHome.typeOf(entry),
        primary: {kind: SmartLifeHome.typeOf(entry).endsWith('sensor') ? 'reading' : 'switch', props: []},
    }));
    const clouds = CLOUD_AIRCONS.flatMap(({id}) => parseEntries(settings.get_string(`${id}-devices`)).map(entry => ({
        did: `${id}:${entry.id}`,
        name: entry.name || entry.model || id,
        room: entry.room ?? null,
        primary: {kind: 'switch', props: []},
    })));
    const xiaomi = settings.get_string('xiaomi-user-id');
    return [...await cachedDevices(xiaomi), ...await cachedScenes(xiaomi), ...conditioners, ...cameras, ...speakers, ...tvs,
        ...switches, ...shellies, ...ewelink, ...hue, ...hass, ...homekit, ...smartlife, ...clouds];
}
