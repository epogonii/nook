// SPDX-License-Identifier: GPL-2.0-or-later

// Electrolux and AEG air conditioners through the Electrolux Group API, with an API key
// and a token pair from developer.electrolux.one. The refresh token changes on every
// renewal, so each renewed pair is kept. Property names per the AEG app API (homeassistant-
// aeg), which this API reports as well; unverified on a unit.

import Soup from 'gi://Soup?version=3.0';

import {CloudAirconHome, call, choice, keepAccount, reading, savedAccount, temperature, toggle} from './cloud-aircon.js';
import {RW, SpecError, prop} from './spec-home.js';

export const SECRET = 'electrolux';
export const LABEL = 'Nook: Electrolux';
export const DASHBOARD_URL = 'https://developer.electrolux.one/dashboard';

const BASE = 'https://api.developer.electrolux.one/api/v1';
const AIRCONS = ['AC', 'AC_SPLIT', 'WRAC', 'PORTABLE_AIR_CONDITIONER', 'AIR_CONDITIONER'];

const MODES = {AUTO: 'Auto', COOL: 'Cool', HEAT: 'Heat', DRY: 'Dry', FANONLY: 'Fan', FAN_ONLY: 'Fan'};
const FANS = {AUTO: 'Auto', QUIET: 'Quiet', LOW: 'Low', MIDDLE: 'Medium', MEDIUM: 'Medium', HIGH: 'High', TURBO: 'Turbo'};
const SWINGS = ['verticalSwing', 'flapOscillate'];

// Renewed a minute early: a token that runs out mid-request fails the request.
const EARLY = 60;

class ElectroluxClient {
    constructor(account, cancellable = null) {
        this._account = {...account};
        this._cancellable = cancellable;
        this._session = new Soup.Session({timeout: 15});
        this.expired = false;
        this.onRefresh = null;
    }

    abort() {
        this._session.abort();
    }

    // One renewal at a time: the refresh token changes with each, so a second one in
    // parallel would spend the token the first is renewing with.
    _renew() {
        this._renewing ??= this._renewOnce().finally(() => {
            this._renewing = null;
        });
        return this._renewing;
    }

    async _renewOnce() {
        let reply;
        try {
            reply = await call(this._session, 'POST', `${BASE}/token/refresh`, {
                json: {refreshToken: this._account.refreshToken},
                headers: {'x-api-key': this._account.apiKey},
                cancellable: this._cancellable,
            });
        } catch (e) {
            if (e.code === 'expired' || e.code === '400') {
                this.expired = true;
                throw new SpecError('Electrolux refused the tokens: make a new pair on its developer site', 'expired');
            }
            throw e;
        }
        if (!reply?.accessToken)
            throw new SpecError('Electrolux gave no access token');
        this._account.accessToken = reply.accessToken;
        this._account.refreshToken = reply.refreshToken ?? this._account.refreshToken;
        this._account.expires = Math.floor(Date.now() / 1000) + (reply.expiresIn ?? 3600);
        await this.onRefresh?.(this._account);
    }

    async _request(method, path, json = undefined) {
        if (this.expired)
            throw new SpecError('Electrolux refused the tokens: make a new pair on its developer site', 'expired');
        if (!this._account.accessToken || (this._account.expires && Date.now() / 1000 > this._account.expires - EARLY))
            await this._renew();
        for (let attempt = 1; ; attempt++) {
            const token = this._account.accessToken;
            try {
                return await call(this._session, method, `${BASE}/${path}`, {
                    json,
                    cancellable: this._cancellable,
                    headers: {'x-api-key': this._account.apiKey, 'Authorization': `Bearer ${this._account.accessToken}`},
                });
            } catch (e) {
                if (e.code !== 'expired' || attempt === 2)
                    throw e;
                // Another request may have renewed meanwhile.
                if (this._account.accessToken === token)
                    await this._renew();
            }
        }
    }

    get account() {
        return this._account;
    }

    appliances() {
        return this._request('GET', 'appliances');
    }

    info(id) {
        return this._request('GET', `appliances/${encodeURIComponent(id)}/info`);
    }

    async state(entry) {
        const state = await this._request('GET', `appliances/${encodeURIComponent(entry.id)}/state`);
        return {...state?.properties?.reported ?? {}, online: /^connected$/i.test(state?.connectionState ?? 'connected')};
    }

    command(entry, body) {
        return this._request('PUT', `appliances/${encodeURIComponent(entry.id)}/command`, body);
    }
}

// Capability values come as an object keyed by value or as a list.
const valuesOf = capability => {
    const values = capability?.values;
    return Array.isArray(values) ? values : values && typeof values === 'object' ? Object.keys(values) : [];
};

export function entryOf(item, info) {
    const caps = info?.capabilities ?? {};
    const target = caps.targetTemperatureC ?? {};
    return {
        id: item.applianceId,
        name: item.applianceName || 'Electrolux',
        model: info?.applianceInfo?.model ?? null,
        modes: valuesOf(caps.mode).filter(v => MODES[v]),
        fans: valuesOf(caps.fanSpeedSetting),
        swing: SWINGS.find(key => key in caps) ?? null,
        sleep: 'sleepMode' in caps,
        range: [target.min ?? 16, target.max ?? 32, target.step ?? 1],
    };
}

const onOff = v => (v === undefined || v === null ? null : String(v).toUpperCase() === 'ON');

function groups(entry) {
    const props = [
        [prop(1, 'on', 'bool', RW), s => (s.applianceState ? String(s.applianceState).toUpperCase() !== 'OFF' : null),
            v => ({executeCommand: v ? 'ON' : 'OFF'})],
        [choice(2, 'mode', entry.modes.length > 0 ? entry.modes : ['AUTO', 'COOL', 'DRY', 'FANONLY', 'HEAT'], MODES),
            s => (s.mode ? String(s.mode).toUpperCase() : null), v => ({mode: v})],
        [temperature(3, entry.range), s => s.targetTemperatureC ?? null, v => ({targetTemperatureC: v})],
        [reading(7), s => s.ambientTemperatureC ?? null],
    ];
    if (entry.fans.length > 1) {
        props.push([choice(4, 'fan-level', entry.fans, FANS), s => (s.fanSpeedSetting ? String(s.fanSpeedSetting).toUpperCase() : null),
            v => ({fanSpeedSetting: v})]);
    }
    if (entry.swing)
        props.push([toggle(5, 'vertical-swing'), s => onOff(s[entry.swing]), v => ({[entry.swing]: v ? 'ON' : 'OFF'})]);
    if (entry.sleep)
        props.push([toggle(9, 'sleep-mode'), s => onOff(s.sleepMode), v => ({sleepMode: v ? 'ON' : 'OFF'})]);
    return props;
}

/** Checks the key and tokens and reads the air conditioners: {account, devices}. */
// Renewed tokens are kept at once: the old pair no longer works.
export async function connect({apiKey, accessToken, refreshToken}, cancellable = null) {
    const client = new ElectroluxClient({apiKey, accessToken, refreshToken}, cancellable);
    client.onRefresh = account => store(account);
    try {
        const devices = [];
        for (const item of await client.appliances() ?? []) {
            // An air conditioner's capabilities must be read; another appliance may have none.
            const aircon = AIRCONS.includes(String(item.applianceType).toUpperCase());
            const info = await client.info(item.applianceId).catch(e => {
                if (aircon)
                    throw e;
                return null;
            });
            const caps = info?.capabilities ?? {};
            if (aircon || ('targetTemperatureC' in caps && 'mode' in caps && 'fanSpeedSetting' in caps))
                devices.push(entryOf(item, info));
        }
        return {account: client.account, devices};
    } finally {
        client.abort();
    }
}

export const store = account => keepAccount(SECRET, LABEL, account);

export const BRAND = {
    id: 'electrolux',
    label: 'Electrolux',
    SECRET,
    // Electrolux asks not to poll often.
    gap: 30 * 1000,
    fresh: 30 * 1000,
    groups,
    async load(cancellable) {
        const account = await savedAccount(SECRET);
        if (!account?.apiKey || !account?.refreshToken)
            return null;
        const client = new ElectroluxClient(account, cancellable);
        client.onRefresh = fresh => store(fresh).catch(e => console.debug(`nook: electrolux: ${e.message}`));
        return client;
    },
};

export {CloudAirconHome};
