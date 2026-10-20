// SPDX-License-Identifier: GPL-2.0-or-later

// LG ThinQ air conditioners through LG's ThinQ Connect API, with a personal access token
// from connect-pat.lgthinq.com. The device list and each unit's profile are read when
// the account is added; the shell reads states and sends commands.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {CloudAirconHome, call, choice, keepAccount, reading, savedAccount, temperature, toggle} from './cloud-aircon.js';
import {RW, SpecError, prop} from './spec-home.js';

export const SECRET = 'lg';
export const LABEL = 'Nook: LG ThinQ';
export const TOKEN_URL = 'https://connect-pat.lgthinq.com';

// Public: LG's own ThinQ Connect SDK carries it.
const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3';

// Countries by API region, per the SDK's country.py; the rest of the world is eic.
const KIC = 'AU BD CN HK ID IN JP KH KR LA LK MM MY NP NZ PH SG TH TW VN';
const AIC = 'AG AR AW BB BO BR BS BZ CA CL CO CR CU DM DO EC GD GT GY HN HT JM KN LC MX NI PA PE PR PY SR SV TT US UY VC VE';
const region = country => (KIC.includes(country) ? 'kic' : AIC.includes(country) ? 'aic' : 'eic');

const MODES = {COOL: 'Cool', AIR_DRY: 'Dry', HEAT: 'Heat', AUTO: 'Auto', FAN: 'Fan', AIR_CLEAN: 'Air clean',
    ENERGY_SAVING: 'Energy saving'};
const FANS = {AUTO: 'Auto', SLOW: 'Quiet', LOW: 'Low', MID: 'Medium', HIGH: 'High', POWER: 'Turbo'};

// Codes for a token that no longer works, and for a unit that is offline.
const EXPIRED = ['1103', '1201', '1202', '1218', '1302', '1303'];
const OFFLINE = ['1222', '2205', '2209'];

const randomId = () => GLib.base64_encode(Uint8Array.from({length: 16}, () => GLib.random_int_range(0, 256)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class LgClient {
    constructor(account, cancellable = null) {
        this._account = account;
        this._cancellable = cancellable;
        this._session = new Soup.Session({timeout: 15});
        this.expired = false;
    }

    abort() {
        this._session.abort();
    }

    get account() {
        return this._account;
    }

    async _request(method, path, json = undefined) {
        if (this.expired)
            throw new SpecError('LG ThinQ refused the access token', 'expired');
        const {token, country, clientId} = this._account;
        try {
            const reply = await call(this._session, method, `https://api-${region(country)}.lgthinq.com/${path}`, {
                json,
                cancellable: this._cancellable,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'x-country': country,
                    'x-message-id': randomId(),
                    'x-client-id': clientId,
                    'x-api-key': API_KEY,
                    'x-service-phase': 'OP',
                    ...method === 'POST' ? {'x-conditional-control': 'true'} : {},
                },
            });
            return reply?.response ?? null;
        } catch (e) {
            const code = e.reply?.error?.code;
            if (e.code === 'expired' || EXPIRED.includes(code)) {
                this.expired = true;
                throw new SpecError('LG ThinQ refused the access token', 'expired');
            }
            if (code)
                throw new SpecError(`LG ThinQ: ${e.reply.error.message ?? code}`, OFFLINE.includes(code) ? 'offline' : code);
            throw e;
        }
    }

    devices() {
        return this._request('GET', 'devices');
    }

    profile(id) {
        return this._request('GET', `devices/${encodeURIComponent(id)}/profile`);
    }

    async state(entry) {
        try {
            return await this._request('GET', `devices/${encodeURIComponent(entry.id)}/state`);
        } catch (e) {
            if (e.code === 'offline')
                return {online: false};
            throw e;
        }
    }

    command(entry, payload) {
        return this._request('POST', `devices/${encodeURIComponent(entry.id)}/control`, payload);
    }
}

const writable = node => node?.mode?.includes('w');
const TARGETS = {target: 'targetTemperature', cool: 'coolTargetTemperature', heat: 'heatTargetTemperature',
    auto: 'autoTargetTemperature'};
const values = node => node?.value?.w ?? node?.value?.r ?? [];

// What lg-devices keeps of a unit: the choices and the temperature keys its profile allows.
export function entryOf(item, profile) {
    const p = profile?.property ?? profile ?? {};
    const units = Array.isArray(p.temperatureInUnits) ? p.temperatureInUnits.find(u => u.unit === 'C') : null;
    const resource = units ? 'temperatureInUnits' : 'temperature';
    const table = units ?? p.temperature ?? {};
    const targets = Object.fromEntries(Object.entries(TARGETS).filter(([, key]) => writable(table[key])));
    const range = Object.values(targets).map(key => table[key].value?.w).find(Boolean);
    return {
        id: item.deviceId,
        name: item.deviceInfo?.alias || item.deviceInfo?.modelName || 'LG',
        model: item.deviceInfo?.modelName ?? null,
        modes: writable(p.airConJobMode?.currentJobMode) ? values(p.airConJobMode.currentJobMode) : [],
        // Newer units take the finer windStrengthDetail, as LG's SDK prefers it.
        fanKey: writable(p.airFlow?.windStrengthDetail) ? 'windStrengthDetail' : 'windStrength',
        fans: values(p.airFlow?.windStrengthDetail).length > 0 && writable(p.airFlow?.windStrengthDetail)
            ? values(p.airFlow.windStrengthDetail) : writable(p.airFlow?.windStrength) ? values(p.airFlow.windStrength) : [],
        upDown: writable(p.windDirection?.rotateUpDown),
        leftRight: writable(p.windDirection?.rotateLeftRight),
        powerSave: writable(p.powerSave?.powerSaveEnabled),
        resource,
        targets,
        range: range ? [range.min ?? 16, range.max ?? 30, range.step ?? 1] : [16, 30, 1],
    };
}

function celsius(state) {
    const units = Array.isArray(state.temperatureInUnits) ? state.temperatureInUnits.find(u => u.unit === 'C') : null;
    return units ?? (state.temperature?.unit === 'F' ? {} : state.temperature ?? {});
}

// A mode just written counts before the cloud reports it.
const RECENT = 15 * 1000;
const modeOf = (entry, s) => (entry.wrote && Date.now() - entry.wrote.at < RECENT ? entry.wrote.mode : s?.airConJobMode?.currentJobMode);

function targetKey(entry, mode) {
    const kind = {COOL: 'cool', HEAT: 'heat', AUTO: 'auto'}[mode];
    return entry.targets[kind] ?? entry.targets.target ?? Object.values(entry.targets)[0] ?? 'targetTemperature';
}

function groups(entry) {
    const props = [
        [prop(1, 'on', 'bool', RW), s => (s.operation ? s.operation.airConOperationMode === 'POWER_ON' : null),
            v => ({operation: {airConOperationMode: v ? 'POWER_ON' : 'POWER_OFF'}})],
        [temperature(3, entry.range), s => {
            const t = celsius(s);
            const mode = s.airConJobMode?.currentJobMode;
            return t.targetTemperature ?? t[targetKey(entry, mode)] ?? null;
        }, (v, s) => ({[entry.resource]: {[targetKey(entry, modeOf(entry, s))]: v, unit: 'C'}})],
        [reading(7), s => celsius(s).currentTemperature ?? null],
    ];
    if (entry.modes.length > 0) {
        props.push([choice(2, 'mode', entry.modes, MODES), s => s.airConJobMode?.currentJobMode ?? null, v => {
            entry.wrote = {mode: v, at: Date.now()};
            return {airConJobMode: {currentJobMode: v}};
        }]);
    }
    if (entry.fans.length > 0) {
        const key = entry.fanKey ?? 'windStrength';
        props.push([choice(4, 'fan-level', entry.fans, FANS), s => s.airFlow?.[key] ?? null,
            v => ({airFlow: {[key]: v}})]);
    }
    if (entry.upDown) {
        props.push([toggle(5, 'vertical-swing'), s => s.windDirection?.rotateUpDown ?? null,
            v => ({windDirection: {rotateUpDown: v}})]);
    }
    if (entry.leftRight) {
        props.push([toggle(6, 'horizontal-swing'), s => s.windDirection?.rotateLeftRight ?? null,
            v => ({windDirection: {rotateLeftRight: v}})]);
    }
    if (entry.powerSave) {
        props.push([toggle(8, 'eco'), s => s.powerSave?.powerSaveEnabled ?? null,
            v => ({powerSave: {powerSaveEnabled: v}})]);
    }
    return props;
}

/** Checks the token and reads the air conditioners: {account, devices}. */
export async function connect({token, country}, cancellable = null) {
    if (!/^[a-z]{2}$/i.test(country))
        throw new SpecError('The country code is two letters, like DE or MD', 'country');
    const saved = await savedAccount(SECRET);
    const account = {token, country: country.toUpperCase(), clientId: saved?.clientId ?? `nook-${randomId()}`};
    const client = new LgClient(account, cancellable);
    try {
        const items = (await client.devices() ?? []).filter(item => item.deviceInfo?.deviceType === 'DEVICE_AIR_CONDITIONER');
        const devices = [];
        for (const item of items)
            devices.push(entryOf(item, await client.profile(item.deviceId)));
        return {account, devices};
    } finally {
        client.abort();
    }
}

export const store = account => keepAccount(SECRET, LABEL, account);

export const BRAND = {
    id: 'lg',
    label: 'LG ThinQ',
    SECRET,
    gap: 20 * 1000,
    groups,
    async load(cancellable) {
        const account = await savedAccount(SECRET);
        return account?.token ? new LgClient(account, cancellable) : null;
    },
};

export {CloudAirconHome};
