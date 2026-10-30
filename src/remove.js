// SPDX-License-Identifier: GPL-2.0-or-later

import {didOf as airconDid, parseAircons, parseUnits} from './lib/aircon-home.js';
import {parseSpeakers} from './lib/cast-home.js';
import * as HomeKit from './lib/homekit.js';
import * as Midea from './lib/midea.js';
import * as Secrets from './lib/secrets.js';
import * as Shelly from './lib/shelly.js';
import * as Sonoff from './lib/sonoff.js';
import * as Tapo from './lib/tapo.js';
import {parseTvs, secretService as tvSecret} from './lib/tv-home.js';
import {setSkipped} from './pages/common.js';

// Devices added by hand, by did prefix. Account devices come back with the account.
const BY_HAND = ['tv', 'cast', 'tapo', 'sonoff', 'shelly', 'homekit', 'gree', 'midea', 'daikin'];

const prefixOf = did => did.slice(0, Math.max(0, did.indexOf(':')));

export const removable = device => BY_HAND.includes(prefixOf(device.did));

// Channels of a Sonoff or Shelly and the accessories of a HomeKit bridge go as one.
export const unitOf = did => did.split('/')[0];

function save(settings, key, list) {
    const json = JSON.stringify(list);
    if (json !== settings.get_string(key))
        settings.set_string(key, json);
}

export function dropTv(settings, id) {
    save(settings, 'tvs', parseTvs(settings.get_string('tvs')).filter(t => t.id !== id));
    Secrets.clear(tvSecret(id)).catch(logError);
    setSkipped(settings, [`tv:${id}`], true);
}

export function dropSpeaker(settings, id) {
    save(settings, 'cast-speakers', parseSpeakers(settings.get_string('cast-speakers')).filter(s => s.id !== id));
    setSkipped(settings, [`cast:${id}`], true);
}

export function dropCamera(settings, id) {
    save(settings, 'tapo-cameras', Tapo.parseCameras(settings.get_string('tapo-cameras')).filter(c => c.id !== id));
    Secrets.clear(`onvif:${id}`).catch(logError);
    setSkipped(settings, [`tapo:${id}`], true);
}

export function dropSonoff(settings, id) {
    save(settings, 'sonoff-switches', Sonoff.parseSwitches(settings.get_string('sonoff-switches')).filter(s => s.id !== id));
    setSkipped(settings, [`sonoff:${id}`], true);
}

export function dropShelly(settings, id) {
    save(settings, 'shelly-devices', Shelly.parseDevices(settings.get_string('shelly-devices')).filter(u => u.id !== id));
    setSkipped(settings, [`shelly:${id}`], true);
    Secrets.clear(Shelly.secretService(id)).catch(logError);
}

export function airconUnits(settings) {
    return [...parseUnits(settings.get_string('gree-units')).map(u => ({...u, brand: 'gree'})),
        ...parseAircons(settings.get_string('aircons'))];
}

export async function dropAircon(settings, unit) {
    const did = airconDid(unit);
    save(settings, 'gree-units', parseUnits(settings.get_string('gree-units')).filter(u => airconDid(u) !== did));
    save(settings, 'aircons', parseAircons(settings.get_string('aircons')).filter(u => airconDid(u) !== did));
    setSkipped(settings, [did], true);
    if (unit.brand === 'midea')
        await Secrets.clear(Midea.secretService(unit.id)).catch(e => console.debug(`nook: keyring: ${e.message}`));
}

export async function homeKitCredentials(host) {
    try {
        return JSON.parse(await Secrets.lookup(HomeKit.secretService(host.id)) ?? 'null');
    } catch {
        return null;
    }
}

// Tells the accessory to forget Nook, so another home can pair it; removed here either way.
// false: it could not be reached, and needs a reset before it pairs again.
export async function dropHomeKit(settings, host) {
    const credentials = await homeKitCredentials(host);
    let freed = !credentials;
    if (credentials) {
        const client = new HomeKit.HapHost(host, credentials);
        try {
            await client.unpair();
            freed = true;
        } catch (e) {
            console.debug(`nook: HomeKit unpair: ${e.message}`);
        } finally {
            client.close();
        }
    }
    await Secrets.clear(HomeKit.secretService(host.id)).catch(logError);
    save(settings, 'homekit-accessories', HomeKit.parseHosts(settings.get_string('homekit-accessories')).filter(h => h.id !== host.id));
    return freed;
}

// As the trash button on the device's account page. false as dropHomeKit.
export async function removeDevice(settings, device) {
    const unit = unitOf(device.did);
    const id = unit.slice(unit.indexOf(':') + 1);
    switch (prefixOf(unit)) {
    case 'tv':
        dropTv(settings, id);
        return true;
    case 'cast':
        dropSpeaker(settings, id);
        return true;
    case 'tapo':
        dropCamera(settings, id);
        return true;
    case 'sonoff':
        dropSonoff(settings, id);
        return true;
    case 'shelly':
        dropShelly(settings, id);
        return true;
    case 'homekit': {
        const host = HomeKit.parseHosts(settings.get_string('homekit-accessories')).find(h => h.id === id);
        return host ? dropHomeKit(settings, host) : true;
    }
    default: {
        const found = airconUnits(settings).find(u => airconDid(u) === device.did);
        if (found)
            await dropAircon(settings, found);
        return true;
    }
    }
}
