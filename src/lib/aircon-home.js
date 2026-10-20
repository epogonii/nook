// SPDX-License-Identifier: GPL-2.0-or-later

// Air conditioners Nook reaches on the network itself: Gree units from gree-units, other
// makers from aircons. Each brand's unit speaks the climate card's state (climate.js).

import GLib from 'gi://GLib';

import {ClimateError, GREE_CAPS, MODES} from './climate.js';
import {DaikinUnit} from './daikin.js';
import {GreeDevice, GreeError} from './gree.js';
import {MideaUnit} from './midea.js';

class GreeUnit {
    constructor(unit) {
        this._device = new GreeDevice(unit);
        this.caps = GREE_CAPS;
        this.about = {ip: unit.ip, mac: unit.mac, firmware: unit.version ?? null, model: null};
    }

    close() {
        this._device.close();
    }

    async status() {
        return {...await this._device.status()};
    }

    // Re-read after: the unit may change more than was asked (Turbo turns Quiet off).
    // Sleep wants SlpMod alongside where the unit has it.
    async set(changes) {
        const device = this._device;
        if ('SwhSlp' in changes && device.state.SlpMod !== undefined)
            changes = {...changes, SlpMod: changes.SwhSlp};
        await device.set(changes);
        try {
            return {...await device.status()};
        } catch (e) {
            if (!(e instanceof GreeError) && !(e instanceof GLib.Error))
                throw e;
            return {...device.state};
        }
    }
}

export const BRANDS = {
    gree: {title: 'Gree', Unit: GreeUnit},
    midea: {title: 'Midea', Unit: MideaUnit},
    daikin: {title: 'Daikin', Unit: DaikinUnit},
};

export function parseUnits(json) {
    try {
        const units = JSON.parse(json || '[]');
        return Array.isArray(units) ? units.filter(u => u?.mac && u.ip && u.key) : [];
    } catch {
        return [];
    }
}

export function parseAircons(json) {
    try {
        const units = JSON.parse(json || '[]');
        return Array.isArray(units)
            ? units.filter(u => u?.brand !== 'gree' && Object.hasOwn(BRANDS, u?.brand) && u.id && u.ip) : [];
    } catch {
        return [];
    }
}

export const didOf = unit => (unit.brand && unit.brand !== 'gree' ? `${unit.brand}:${unit.id}` : `gree:${unit.mac}`);

const quiet = e => e instanceof ClimateError || e instanceof GLib.Error;

export class AirconHome {
    constructor(units) {
        this._units = new Map();
        this.devices = units.map(unit => {
            const brand = unit.brand ?? 'gree';
            const made = new BRANDS[brand].Unit(unit);
            const device = {
                did: didOf(unit),
                name: unit.name || unit.mac || BRANDS[brand].title,
                model: brand,
                urn: null,
                room: unit.room ?? null,
                online: null,
                primary: {kind: 'climate', props: []},
                values: null,
                state: null,
                caps: made.caps,
                about: made.about,
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            this._units.set(device.did, made);
            return device;
        });
    }

    abort() {
        for (const unit of this._units.values())
            unit.close();
    }

    _keep(device, state) {
        const unit = this._units.get(device.did);
        device.state = state;
        device.caps = unit.caps;
        device.about = unit.about;
        device.values = [state.Pow === 1];
    }

    async _read(device) {
        try {
            this._keep(device, await this._units.get(device.did).status());
            device.online = true;
        } catch (e) {
            if (!quiet(e))
                throw e;
            console.debug(`nook: ${device.model}: ${e.message}`);
            device.online = false;
        }
    }

    async readPrimary() {
        await Promise.all(this.devices.map(d => this._read(d)));
        return this.devices.length > 0;
    }

    readDevice(device) {
        return this._read(device);
    }

    async set(device, changes) {
        this._keep(device, await this._units.get(device.did).set(changes));
        device.online = true;
    }

    setSwitch(device, on) {
        return this.set(device, {Pow: on ? 1 : 0});
    }
}

export {ClimateError, MODES};
