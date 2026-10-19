// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {GreeDevice, GreeError, MODES} from './gree.js';

export function parseUnits(json) {
    try {
        const units = JSON.parse(json || '[]');
        return Array.isArray(units) ? units.filter(u => u?.mac && u.ip && u.key) : [];
    } catch {
        return [];
    }
}

export class GreeHome {
    constructor(units) {
        this._units = new Map();
        this.devices = units.map(unit => {
            const device = {
                did: `gree:${unit.mac}`,
                name: unit.name || unit.mac,
                model: 'gree',
                urn: null,
                room: unit.room ?? null,
                online: null,
                primary: {kind: 'climate', props: []},
                values: null,
                state: null,
                about: {ip: unit.ip, mac: unit.mac, firmware: unit.version ?? null, model: null},
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            this._units.set(device.did, new GreeDevice(unit));
            return device;
        });
    }

    abort() {
        for (const unit of this._units.values())
            unit.close();
    }

    async _read(device) {
        try {
            device.state = {...await this._units.get(device.did).status()};
            device.online = true;
            device.values = [device.state.Pow === 1];
        } catch (e) {
            if (!(e instanceof GreeError) && !(e instanceof GLib.Error))
                throw e;
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

    // Re-read after: the unit may change more than was asked (Turbo turns Quiet off).
    async set(device, changes) {
        const unit = this._units.get(device.did);
        device.state = {...await unit.set(changes)};
        try {
            device.state = {...await unit.status()};
        } catch (e) {
            if (!(e instanceof GreeError) && !(e instanceof GLib.Error))
                throw e;
        }
        device.values = [device.state.Pow === 1];
    }

    setSwitch(device, on) {
        return this.set(device, {Pow: on ? 1 : 0});
    }
}

export {GreeError, MODES};
