// SPDX-License-Identifier: GPL-2.0-or-later

// Mitsubishi Electric air conditioners through MELCloud (app.melcloud.com), logged in
// with the MELCloud app's email and password. Air-to-air units only; MELCloud Home is a
// different service. Endpoints and flags per pymelcloud.

import Soup from 'gi://Soup?version=3.0';

import {CloudAirconHome, call, choice, keepAccount, reading, savedAccount, temperature, toggle} from './cloud-aircon.js';
import {RW, SpecError, prop} from './spec-home.js';

export const SECRET = 'melcloud';
export const LABEL = 'Nook: MELCloud';

const BASE = 'https://app.melcloud.com/Mitsubishi.Wifi.Client';

const MODES = {1: 'Heat', 2: 'Dry', 3: 'Cool', 7: 'Fan', 8: 'Auto'};
// EffectiveFlags: which fields of a SetAta are meant.
const POWER = 0x01;
const MODE = 0x02;
const TARGET = 0x04;
const FAN = 0x08;
const VANE_UP_DOWN = 0x10;
const VANE_SIDES = 0x100;
const SWING_UP_DOWN = 7;
const SWING_SIDES = 12;

// As the MELCloud web app sends them, after pymelcloud.
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:73.0) Gecko/20100101 Firefox/73.0',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': 'policyaccepted=true',
};

class MelClient {
    constructor(account, cancellable = null) {
        this._account = {...account};
        this._cancellable = cancellable;
        this._session = new Soup.Session({timeout: 15});
        this.expired = false;
        this.onKey = null;
    }

    abort() {
        this._session.abort();
    }

    get account() {
        return this._account;
    }

    async logIn() {
        const reply = await call(this._session, 'POST', `${BASE}/Login/ClientLogin`, {
            json: {Email: this._account.user, Password: this._account.password, Language: 0, AppVersion: '1.19.1.1',
                Persist: true, CaptchaResponse: null},
            cancellable: this._cancellable,
        });
        const key = reply?.LoginData?.ContextKey;
        if (!key) {
            this.expired = true;
            throw new SpecError('MELCloud refused the email or the password', 'expired');
        }
        this._account.contextKey = key;
        await this.onKey?.(this._account);
        return this._account;
    }

    // A saved session key is tried first; one MELCloud has dropped is renewed once. After
    // a refused login nothing more is sent: MELCloud locks accounts that keep trying.
    async _request(method, path, json = undefined) {
        if (this.expired)
            throw new SpecError('MELCloud refused the email or the password', 'expired');
        if (!this._account.contextKey)
            await this.logIn();
        for (let attempt = 1; ; attempt++) {
            try {
                return await call(this._session, method, `${BASE}/${path}`, {
                    json,
                    cancellable: this._cancellable,
                    headers: {...HEADERS, 'X-MitsContextKey': this._account.contextKey},
                });
            } catch (e) {
                if (e.code !== 'expired' || attempt === 2)
                    throw e;
                await this.logIn();
            }
        }
    }

    async devices() {
        const devices = new Map();
        for (const building of await this._request('GET', 'User/ListDevices') ?? []) {
            const s = building.Structure ?? {};
            for (const device of [s.Devices, ...(s.Areas ?? []).map(a => a.Devices),
                ...(s.Floors ?? []).flatMap(f => [f.Devices, ...(f.Areas ?? []).map(a => a.Devices)])].flat())
                if (device && !devices.has(device.DeviceID))
                    devices.set(device.DeviceID, device);
        }
        return [...devices.values()];
    }

    async state(entry) {
        const state = await this._request('GET', `Device/Get?id=${entry.id}&buildingID=${entry.building}`);
        return {...state, online: state?.Offline !== true};
    }

    command(entry, {fields, flags}, state) {
        const {online: _online, ...last} = state ?? {};
        return this._request('POST', 'Device/SetAta', {...last, ...fields, DeviceID: Number(entry.id),
            EffectiveFlags: flags, HasPendingCommand: true});
    }
}

// What melcloud-devices keeps of an air-to-air unit from ListDevices.
export function entryOf(conf) {
    const d = conf.Device ?? {};
    const lows = [d.MinTempCoolDry, d.MinTempHeat, d.MinTempAutomatic].filter(Number.isFinite);
    const highs = [d.MaxTempCoolDry, d.MaxTempHeat, d.MaxTempAutomatic].filter(Number.isFinite);
    return {
        id: String(conf.DeviceID),
        building: conf.BuildingID,
        name: conf.DeviceName || 'MELCloud',
        model: d.Units?.find(u => u.IsIndoor)?.Model ?? null,
        modes: [...d.CanHeat ? [1] : [], ...d.CanDry ? [2] : [], ...d.CanCool ? [3] : [], 7, ...d.ModelSupportsAuto ? [8] : []],
        fans: [...d.HasAutomaticFanSpeed ? [0] : [], ...Array.from({length: d.NumberOfFanSpeeds ?? 0}, (_v, i) => i + 1)],
        upDown: Boolean(d.ModelSupportsVaneVertical) && d.SwingFunction !== false && !d.HideVaneControls,
        sides: Boolean(d.ModelSupportsVaneHorizontal) && d.SwingFunction !== false && !d.HideVaneControls,
        range: [lows.length ? Math.min(...lows) : 10, highs.length ? Math.max(...highs) : 31, d.TemperatureIncrement || 0.5],
        // Each mode's own limits: cool and dry don't go down to heat's 10 °C.
        limits: {
            1: [d.MinTempHeat, d.MaxTempHeat],
            2: [d.MinTempCoolDry, d.MaxTempCoolDry],
            3: [d.MinTempCoolDry, d.MaxTempCoolDry],
            8: [d.MinTempAutomatic, d.MaxTempAutomatic],
        },
    };
}

function groups(entry) {
    const fanWords = {0: 'Auto', ...Object.fromEntries(entry.fans.filter(n => n > 0).map(n => [n, `Level ${n}`]))};
    const props = [
        [prop(1, 'on', 'bool', RW), s => s.Power ?? null, v => ({fields: {Power: v}, flags: POWER})],
        [choice(2, 'mode', entry.modes, MODES), s => s.OperationMode ?? null,
            v => ({fields: {OperationMode: v}, flags: MODE})],
        [temperature(3, entry.range), s => s.SetTemperature ?? null, (v, s) => {
            const [low, high] = entry.limits?.[s?.OperationMode] ?? [];
            const t = Math.min(Number.isFinite(high) ? high : v, Math.max(Number.isFinite(low) ? low : v, v));
            return {fields: {SetTemperature: t}, flags: TARGET};
        }],
        [reading(7), s => s.RoomTemperature ?? null],
    ];
    if (entry.fans.length > 1) {
        props.push([choice(4, 'fan-level', entry.fans, fanWords), s => s.SetFanSpeed ?? null,
            v => ({fields: {SetFanSpeed: v}, flags: FAN})]);
    }
    // A vane at a fixed position reads as not swinging; switching swing off leaves it to the unit.
    if (entry.upDown) {
        props.push([toggle(5, 'vertical-swing'), s => (s.VaneVertical === undefined ? null : s.VaneVertical === SWING_UP_DOWN),
            v => ({fields: {VaneVertical: v ? SWING_UP_DOWN : 0}, flags: VANE_UP_DOWN})]);
    }
    if (entry.sides) {
        props.push([toggle(6, 'horizontal-swing'), s => (s.VaneHorizontal === undefined ? null : s.VaneHorizontal === SWING_SIDES),
            v => ({fields: {VaneHorizontal: v ? SWING_SIDES : 0}, flags: VANE_SIDES})]);
    }
    return props;
}

/** Logs in and reads the air conditioners: {account, devices}. */
export async function connect({user, password}, cancellable = null) {
    const client = new MelClient({user, password}, cancellable);
    try {
        const account = await client.logIn();
        const devices = (await client.devices()).filter(conf => (conf.Device?.DeviceType ?? 0) === 0).map(entryOf);
        return {account, devices};
    } finally {
        client.abort();
    }
}

export const store = account => keepAccount(SECRET, LABEL, account);

export const BRAND = {
    id: 'melcloud',
    label: 'MELCloud',
    SECRET,
    // SetAta answers with the whole new state.
    replies: true,
    // MELCloud asks for a state read at most once a minute.
    gap: 60 * 1000,
    fresh: 60 * 1000,
    groups,
    async load(cancellable) {
        const account = await savedAccount(SECRET);
        if (!account?.user || !account?.password)
            return null;
        const client = new MelClient(account, cancellable);
        client.onKey = fresh => store(fresh).catch(e => console.debug(`nook: melcloud: ${e.message}`));
        return client;
    },
};

export {CloudAirconHome};
