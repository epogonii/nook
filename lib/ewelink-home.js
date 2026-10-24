// SPDX-License-Identifier: GPL-2.0-or-later

// eWeLink devices through the eWeLink cloud. prefs keeps the list; the account is
// read from the keyring on first use.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EwelinkCloud, EwelinkError} from './ewelink.js';

// The API allows 300 calls in 5 minutes per IP; background reads stay well under.
const READ_GAP = 10 * 1000;
const MAX_BACKOFF = 10 * 60 * 1000;
// A card asks for services and values back to back: one read serves both.
const FRESH = 3000;

// Single-channel units are mostly relays and wall switches; plugs are S20, S26, S40...
const PLUG_MODEL = /plug|socket|outlet|\bS\d\d/i;

const onOff = value => (value === 'on' ? true : value === 'off' ? false : null);
const word = on => (on ? 'on' : 'off');

export function parseDevices(json) {
    try {
        const devices = JSON.parse(json || '[]');
        return Array.isArray(devices) ? devices.filter(d => typeof d?.id === 'string' && /^\w+$/.test(d.id)) : [];
    } catch {
        return [];
    }
}

// A unit with "outlets" is switched channel by channel and gets a tile for each.
export function channels(unit) {
    const outlets = unit.outlets > 0 ? [...Array(unit.outlets).keys()] : [null];
    const several = outlets.length > 1;
    const name = unit.name || unit.id;
    return outlets.map(outlet => ({
        did: several ? `ewelink:${unit.id}/${outlet}` : `ewelink:${unit.id}`,
        name: several ? `${name} ${outlet + 1}` : name,
        outlet,
    }));
}

function prop(piid, name, format, access, extra = {}) {
    return {piid, name, format, access, unit: null, range: null, choices: null, ...extra};
}

const RW = ['read', 'write'];
const RO = ['read'];

// Services shaped like a trimmed MIoT spec, so the card treats the device like a Mi
// Home one, with what each property reads from and writes to in the device params.
function layoutOf(outlet, params, uiid = null) {
    const services = [];
    const fields = new Map();
    const add = (siid, name, props) => {
        const service = {siid, name, description: null, actions: [], properties: []};
        for (const [p, read, write] of props) {
            service.properties.push(p);
            fields.set(`${siid}/${p.piid}`, {read, write});
        }
        services.push(service);
    };

    if (outlet !== null) {
        add(2, 'switch', [[prop(1, 'on', 'bool', RW),
            ps => onOff(ps.switches?.find(s => s.outlet === outlet)?.switch),
            v => ({switches: [{switch: word(v), outlet}]})]]);
        return {services, fields};
    }

    // Power-on state and the indicator light are left to the eWeLink app.
    add(2, 'switch', [[prop(1, 'on', 'bool', RW), ps => onOff(ps.switch), v => ({switch: word(v)})]]);
    // POW firmware sends strings; POW R3 (UIID 190) sends hundredths.
    const number = value => {
        const n = Number(value);
        if (value === undefined || value === '' || !Number.isFinite(n))
            return null;
        return uiid === 190 ? n / 100 : n;
    };
    const meters = [['power', 'electric-power', 'watt'], ['voltage', 'voltage', 'volt'],
        ['current', 'electric-current', 'ampere']].filter(([key]) => params[key] !== undefined);
    if (meters.length > 0) {
        add(4, 'power-consumption', meters.map(([key, name, unit], i) =>
            [prop(i + 1, name, 'float', RO, {unit}), ps => number(ps[key]), null]));
    }
    return {services, fields};
}

export class EwelinkHome {
    constructor(units) {
        this._units = units;
        this._cancellable = new Gio.Cancellable();
        this._cloud = null;
        this._loading = null;
        this._states = new Map();
        this._channels = new Map();
        this._nextRead = 0;
        this._backoff = 0;
        this._told = false;
        this.onExpired = null;
        this.extras = [];
        this.devices = units.flatMap(unit => channels(unit).map(({did, name, outlet}) => {
            const props = layoutOf(outlet, {}).services[0].properties;
            const device = {
                did,
                name,
                model: 'ewelink',
                urn: `urn:nook:device:${outlet === null && PLUG_MODEL.test(unit.model ?? '') ? 'outlet' : 'switch'}:0`,
                room: unit.room ?? null,
                online: null,
                primary: {kind: 'switch', props: [{siid: 2, service: 'switch', ...props[0]}]},
                values: null,
                state: null,
                about: {model: unit.model ?? null},
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            this._channels.set(did, {unit, outlet});
            return device;
        }));
    }

    get loggedIn() {
        return !this._cloud?.expired;
    }

    abort() {
        this._cancellable.cancel();
        this._cloud?.abort();
    }

    _account() {
        this._loading ??= EwelinkCloud.load(this._cancellable).then(cloud => {
            if (this._cancellable.is_cancelled())
                cloud?.abort();
            this._cloud = cloud;
            return cloud;
        }, e => {
            this._loading = null;
            throw e;
        });
        return this._loading;
    }

    _devicesOf(unit) {
        return this.devices.filter(d => this._channels.get(d.did).unit === unit);
    }

    _apply(unit, item) {
        const params = item?.params ?? {};
        this._states.set(unit.id, {params, at: Date.now()});
        for (const device of this._devicesOf(unit)) {
            const {outlet} = this._channels.get(device.did);
            const [field] = layoutOf(outlet, params, unit.uiid).fields.values();
            device.online = item?.online === true;
            device.values = [item ? field.read(params) : null];
            Object.assign(device.about, {
                ssid: params.ssid || null,
                rssi: Number(params.rssi) < 0 ? Number(params.rssi) : null,
                firmware: params.fwVersion || null,
            });
        }
    }

    async _fetch(units) {
        const cloud = await this._account();
        if (!cloud) {
            this._expired();
            throw new EwelinkError('Not logged in to eWeLink');
        }
        try {
            const items = new Map((await cloud.devicesById(units.map(u => u.id))).map(i => [i.deviceid, i]));
            for (const unit of units)
                this._apply(unit, items.get(unit.id));
        } catch (e) {
            if (cloud.expired)
                this._expired();
            throw e;
        }
    }

    _expired() {
        if (this._told)
            return;
        this._told = true;
        this.onExpired?.();
    }

    async readPrimary() {
        if (this.devices.length === 0 || Date.now() < this._nextRead)
            return false;
        this._nextRead = Date.now() + READ_GAP;
        try {
            await this._fetch(this._units);
            this._backoff = 0;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return false;
            this._backoff = Math.min(Math.max(this._backoff * 2, READ_GAP), MAX_BACKOFF);
            this._nextRead = Date.now() + this._backoff;
            for (const device of this.devices)
                device.online = false;
            if (!(e instanceof EwelinkError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: eWeLink: ${e.message}`);
        }
        return true;
    }

    async _fresh(device) {
        const {unit} = this._channels.get(device.did);
        const state = this._states.get(unit.id);
        if (!state || Date.now() - state.at > FRESH)
            await this._fetch([unit]);
        return this._states.get(unit.id).params;
    }

    async readDevice(device) {
        await this._fresh(device);
    }

    async services(device) {
        const {unit, outlet} = this._channels.get(device.did);
        return layoutOf(outlet, await this._fresh(device), unit.uiid).services;
    }

    async readProperties(device, props) {
        const params = await this._fresh(device);
        const {unit, outlet} = this._channels.get(device.did);
        const {fields} = layoutOf(outlet, params, unit.uiid);
        const values = new Map();
        for (const {siid, piid} of props) {
            const value = fields.get(`${siid}/${piid}`)?.read(params);
            if (value !== null && value !== undefined)
                values.set(`${siid}/${piid}`, value);
        }
        return values;
    }

    async setProperty(device, siid, piid, value) {
        const {unit, outlet} = this._channels.get(device.did);
        const params = this._states.get(unit.id)?.params ?? {};
        const write = layoutOf(outlet, params, unit.uiid).fields.get(`${siid}/${piid}`)?.write;
        if (!write)
            throw new EwelinkError(`${device.name} has no such setting`);
        const cloud = await this._account();
        if (!cloud)
            throw new EwelinkError('Not logged in to eWeLink');
        const change = write(value);
        await cloud.setParams(unit.id, change);
        const merged = {...params, ...change};
        if (change.switches) {
            const known = params.switches ?? [];
            merged.switches = [
                ...known.map(s => change.switches.find(c => c.outlet === s.outlet) ?? s),
                ...change.switches.filter(c => !known.some(s => s.outlet === c.outlet)),
            ];
        }
        this._apply(unit, {params: merged, online: true});
    }

    setSwitch(device, on) {
        return this.setProperty(device, 2, 1, on);
    }

    runAction() {
        return Promise.reject(new EwelinkError('eWeLink devices have no actions here'));
    }

    readEventLog() {
        return Promise.resolve([]);
    }

    readHistory() {
        return Promise.resolve([]);
    }

    noteEvent(device, event) {
        device.lastEvent = event;
    }
}
