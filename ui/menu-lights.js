// SPDX-License-Identifier: GPL-2.0-or-later

// Lights switched on at login, and lights that flash a colour for a notification.

import GLib from 'gi://GLib';

import {WHITE} from '../lib/spec-home.js';
import * as Timers from '../lib/timers.js';
import {paintOf} from './color.js';
import {troubleText} from './tiles.js';

// Login races the device lists loading and the network coming up: a few tries.
const LIGHT_UP_TRIES = 12;
const LIGHT_UP_EVERY = 10;
const FLASH_MS = 2000;
// Longest a dropped source is kept for a flash to put its light back.
const RESTORE_MS = 10000;

const switchable = device => device.primary.kind === 'switch' && typeof device.source?.setSwitch === 'function';

function report(device, e) {
    try {
        console.debug(`nook: ${device.name}: ${troubleText(device, e)}`);
    } catch {
        logError(e);
    }
}

// Read now: what the menu read last can be hours old. Null when the light doesn't say.
async function switchedOn(device) {
    const source = device.source;
    const prop = device.primary.props?.[0];
    let on;
    if (prop?.piid !== undefined && typeof source.readProperties === 'function') {
        on = (await source.readProperties(device, [{siid: prop.siid, piid: prop.piid}])).get(`${prop.siid}/${prop.piid}`);
    } else {
        await source.readDevice?.(device);
        on = device.values?.[0];
    }
    return device.online === false || typeof on !== 'boolean' ? null : on;
}

async function blink(device, on) {
    await device.source.setSwitch(device, !on);
    await Timers.sleep(FLASH_MS / 2);
    await device.source.setSwitch(device, on);
}

// The colour for FLASH_MS, then the light as it was: off or on, in its colour or white.
// A light without colour blinks instead, and so does one whose colour can't be read
// back to put it back.
async function flashLight(device, rgb) {
    const source = device.source;
    const paint = typeof source.services === 'function' ? paintOf(await source.services(device)) : null;
    if (!paint) {
        const on = await switchedOn(device);
        if (on !== null)
            await blink(device, on);
        return;
    }
    const {service, color, on, temperature} = paint;
    const key = p => `${service.siid}/${p.piid}`;
    const before = await source.readProperties(device,
        [color, on, temperature].filter(Boolean).map(p => ({siid: service.siid, piid: p.piid})));
    if (device.online === false)
        return;
    const wasOn = on ? before.get(key(on)) ?? null : await switchedOn(device);
    const oldColor = before.get(key(color));
    // Home Assistant tells no colour while a light is off.
    if (typeof oldColor !== 'number') {
        if (wasOn !== null)
            await blink(device, wasOn);
        return;
    }
    // Some bridges keep a colour set on an unlit light unlit: switch it on first.
    if (on && wasOn === false)
        await source.setProperty(device, service.siid, on.piid, true);
    await source.setProperty(device, service.siid, color.piid, rgb);
    await Timers.sleep(FLASH_MS);
    if (oldColor === WHITE && temperature && before.has(key(temperature)))
        await source.setProperty(device, service.siid, temperature.piid, before.get(key(temperature)));
    else
        await source.setProperty(device, service.siid, color.piid, oldColor);
    if (wasOn === false)
        await (on ? source.setProperty(device, service.siid, on.piid, false) : source.setSwitch(device, false));
}

export class MenuLights {
    lightUp(dids) {
        this._stopLightUp();
        this._lightUpLeft = new Set(dids);
        this._lightUpTries = 0;
        this._lightUpStep();
    }

    // Also run on a network change, since at login that is often what was missing. An
    // offline mark may date from before it, so each try tries them all.
    _lightUpStep() {
        const left = this._lightUpLeft;
        if (!left || left.size === 0)
            return;
        if (this._lightUpTimer)
            GLib.source_remove(this._lightUpTimer);
        this._lightUpTimer = 0;
        const devices = this._devices().filter(d => left.has(d.did) && switchable(d));
        Promise.allSettled(devices.map(device => device.source.setSwitch(device, true).then(() => left.delete(device.did),
            e => report(device, e)))).then(() => {
            if (this._lightUpLeft !== left)
                return;
            for (const tile of this._tiles)
                tile.sync();
            if (left.size === 0 || ++this._lightUpTries >= LIGHT_UP_TRIES) {
                this._lightUpLeft = null;
                return;
            }
            // A network change can start a try while one is out.
            if (this._lightUpTimer)
                GLib.source_remove(this._lightUpTimer);
            this._lightUpTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, LIGHT_UP_EVERY, () => {
                this._lightUpTimer = 0;
                this._lightUpStep();
                return GLib.SOURCE_REMOVE;
            });
        }).catch(logError);
    }

    _stopLightUp() {
        if (this._lightUpTimer)
            GLib.source_remove(this._lightUpTimer);
        this._lightUpTimer = 0;
        this._lightUpLeft = null;
    }

    // One flash per light at a time: a second would read the first one's colour as the
    // light's own.
    flash(dids, rgb) {
        this._flashes ??= new Map();
        const flashes = this._flashes;
        for (const device of this._devices().filter(d => dids.includes(d.did) && switchable(d))) {
            if (flashes.has(device.did))
                continue;
            const done = flashLight(device, rgb).catch(e => report(device, e)).finally(() => {
                flashes.delete(device.did);
                if (this._gone)
                    return;
                for (const tile of this._tiles) {
                    if (tile.device?.did === device.did)
                        tile.sync();
                }
            });
            flashes.set(device.did, {source: device.source, done});
            done.catch(logError);
        }
    }

    // Aborted at once, the source of a light mid-flash (screen locked, settings changed)
    // would leave it in the notification's colour. disable() aborts it at once anyway.
    _abortAfterFlash(source) {
        const flashes = [...this._flashes?.values() ?? []].filter(f => f.source === source);
        if (flashes.length === 0) {
            source.abort();
            return;
        }
        let aborted = false;
        const abort = () => {
            if (!aborted)
                source.abort();
            aborted = true;
        };
        const deadline = Timers.timeout(RESTORE_MS, () => {
            abort();
            return GLib.SOURCE_REMOVE;
        }, {cleanup: abort});
        Promise.allSettled(flashes.map(f => f.done)).then(() => {
            Timers.remove(deadline);
            abort();
        }).catch(logError);
    }
}
