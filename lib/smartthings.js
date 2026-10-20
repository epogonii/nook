// SPDX-License-Identifier: GPL-2.0-or-later

// Samsung air conditioners through SmartThings, with an OAuth app of the user's own made
// by the SmartThings CLI: its personal tokens now last a day. SmartThings takes only
// https redirects, so the app redirects to REDIRECT_URL and the user pastes the address
// it ends on. Access tokens last a day and are renewed with the refresh token.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {CloudAirconHome, call, choice, keepAccount, reading, savedAccount, temperature, toggle} from './cloud-aircon.js';
import {RW, SpecError, prop} from './spec-home.js';

export const SECRET = 'smartthings';
export const LABEL = 'Nook: SmartThings';
export const REDIRECT_URL = 'https://httpbin.org/get';
export const CLI_URL = 'https://github.com/SmartThingsCommunity/smartthings-cli#readme';

const API = 'https://api.smartthings.com';
const SCOPE = 'r:devices:* x:devices:*';

const MODES = {auto: 'Auto', cool: 'Cool', dry: 'Dry', wind: 'Fan', fan: 'Fan', heat: 'Heat', aIComfort: 'AI comfort'};
const FANS = {auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', turbo: 'Turbo', quiet: 'Quiet'};
// custom.airConditionerOptionalMode values the card has a switch for.
const OPTIONAL = [['sleep', 'sleep-mode', 9], ['quiet', 'quiet', 10], ['speed', 'turbo', 11]];

const EARLY = 60;

export function newState() {
    return GLib.uuid_string_random().replace(/-/g, '');
}

export function loginUrl(clientId, state) {
    const query = {client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URL, scope: SCOPE, state};
    return `${API}/v1/oauth/authorize?${Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** The code in the address the browser ended on, or null if it is not ours. */
export function codeFrom(address, state) {
    const uri = GLib.Uri.parse(address.trim(), GLib.UriFlags.NONE);
    const params = GLib.Uri.parse_params(uri.get_query() ?? '', -1, '&', GLib.UriParamsFlags.NONE);
    return params.state === state ? params.code ?? null : null;
}

const basic = (id, secret) => `Basic ${GLib.base64_encode(new TextEncoder().encode(`${id}:${secret}`))}`;

async function tokens(session, account, form, cancellable) {
    let reply;
    try {
        reply = await call(session, 'POST', `${API}/v1/oauth/token`, {
            form: {client_id: account.clientId, ...form},
            headers: {Authorization: basic(account.clientId, account.clientSecret)},
            cancellable,
        });
    } catch (e) {
        if (e.code === 'expired' || e.code === '400')
            throw new SpecError('SmartThings refused the login: log in again in the Nook settings', 'expired');
        throw e;
    }
    if (!reply?.access_token)
        throw new SpecError('SmartThings gave no access token');
    return {
        ...account,
        accessToken: reply.access_token,
        refreshToken: reply.refresh_token ?? account.refreshToken,
        expires: Math.floor(Date.now() / 1000) + (reply.expires_in ?? 86400),
    };
}

/** Trades the code from the login page for tokens. */
export async function logIn(account, code, cancellable = null) {
    const session = new Soup.Session({timeout: 15});
    try {
        return await tokens(session, account, {grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URL}, cancellable);
    } finally {
        session.abort();
    }
}

class StClient {
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

    // One renewal at a time: a refresh token works once, so a second renewal in parallel
    // would fail and could lose the new one.
    _renew() {
        this._renewing ??= this._renewOnce().finally(() => {
            this._renewing = null;
        });
        return this._renewing;
    }

    async _renewOnce() {
        try {
            this._account = await tokens(this._session, this._account,
                {grant_type: 'refresh_token', refresh_token: this._account.refreshToken}, this._cancellable);
        } catch (e) {
            if (e.code === 'expired')
                this.expired = true;
            throw e;
        }
        await this.onRefresh?.(this._account);
    }

    async _request(method, path, json = undefined) {
        if (this.expired)
            throw new SpecError('SmartThings refused the login: log in again in the Nook settings', 'expired');
        if (!this._account.accessToken || Date.now() / 1000 > (this._account.expires ?? 0) - EARLY)
            await this._renew();
        for (let attempt = 1; ; attempt++) {
            const token = this._account.accessToken;
            try {
                return await call(this._session, method, `${API}/${path}`, {
                    json,
                    cancellable: this._cancellable,
                    headers: {Authorization: `Bearer ${this._account.accessToken}`},
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

    async devices() {
        const items = [];
        let path = 'v1/devices?capability=airConditionerMode';
        while (path) {
            const page = await this._request('GET', path);
            items.push(...page?.items ?? []);
            const next = page?._links?.next?.href;
            path = next?.startsWith(`${API}/`) ? next.slice(API.length + 1) : null;
        }
        return items;
    }

    status(id) {
        return this._request('GET', `v1/devices/${encodeURIComponent(id)}/components/main/status`);
    }

    async state(entry) {
        const [status, health] = await Promise.all([this.status(entry.id),
            this._request('GET', `v1/devices/${encodeURIComponent(entry.id)}/health`).catch(() => null)]);
        return {...status, online: health?.state !== 'OFFLINE'};
    }

    command(entry, command) {
        return this._request('POST', `v1/devices/${encodeURIComponent(entry.id)}/commands`,
            {commands: [{component: 'main', arguments: [], ...command}]});
    }
}

const value = (s, capability, attribute) => s?.[capability]?.[attribute]?.value ?? null;
const unitOf = (s, capability, attribute) => s?.[capability]?.[attribute]?.unit ?? 'C';
const toCelsius = (v, unit) => (typeof v !== 'number' ? null : unit === 'F' ? Math.round((v - 32) * 50 / 9) / 10 : v);

export function entryOf(item, status) {
    const range = value(status, 'thermostatCoolingSetpoint', 'coolingSetpointRange');
    const fahrenheit = unitOf(status, 'thermostatCoolingSetpoint', 'coolingSetpoint') === 'F';
    const c = v => (fahrenheit ? toCelsius(v, 'F') : v);
    return {
        id: item.deviceId,
        name: item.label || item.name || 'SmartThings',
        model: item.deviceTypeName ?? item.name ?? null,
        modes: value(status, 'airConditionerMode', 'supportedAcModes') ?? [],
        fans: value(status, 'airConditionerFanMode', 'supportedAcFanModes') ?? [],
        swings: value(status, 'fanOscillationMode', 'supportedFanOscillationModes') ?? [],
        optional: value(status, 'custom.airConditionerOptionalMode', 'supportedAcOptionalMode') ?? [],
        range: range?.minimum !== undefined ? [c(range.minimum), c(range.maximum), fahrenheit ? 0.5 : range.step ?? 1] : [16, 30, 1],
    };
}

// The oscillation mode for the two axes, among those the unit lists: one with only 'all'
// swings both or neither.
function swingOf(entry, vertical, horizontal) {
    const has = mode => entry.swings.includes(mode);
    if (!vertical && !horizontal)
        return 'fixed';
    if (vertical && horizontal && has('all'))
        return 'all';
    if (vertical && has('vertical'))
        return 'vertical';
    if (horizontal && has('horizontal'))
        return 'horizontal';
    return 'all';
}

// What was just written counts before the cloud reports it: SmartThings' status lags.
const RECENT = 15 * 1000;

function groups(entry) {
    const target = s => {
        const v = value(s, 'thermostatCoolingSetpoint', 'coolingSetpoint');
        return toCelsius(v, unitOf(s, 'thermostatCoolingSetpoint', 'coolingSetpoint'));
    };
    const props = [
        [prop(1, 'on', 'bool', RW), s => (value(s, 'switch', 'switch') === null ? null : value(s, 'switch', 'switch') === 'on'),
            v => ({capability: 'switch', command: v ? 'on' : 'off'})],
        [choice(2, 'mode', entry.modes, MODES), s => value(s, 'airConditionerMode', 'airConditionerMode'),
            v => ({capability: 'airConditionerMode', command: 'setAirConditionerMode', arguments: [v]})],
        [temperature(3, entry.range), target, (v, s) => {
            const fahrenheit = unitOf(s, 'thermostatCoolingSetpoint', 'coolingSetpoint') === 'F';
            return {capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint',
                arguments: [fahrenheit ? Math.round(v * 9 / 5 + 32) : v]};
        }],
        [reading(7), s => toCelsius(value(s, 'temperatureMeasurement', 'temperature'),
            unitOf(s, 'temperatureMeasurement', 'temperature'))],
    ];
    if (entry.fans.length > 1) {
        props.push([choice(4, 'fan-level', entry.fans, FANS), s => value(s, 'airConditionerFanMode', 'fanMode'),
            v => ({capability: 'airConditionerFanMode', command: 'setFanMode', arguments: [v]})]);
    }
    const swing = s => value(s, 'fanOscillationMode', 'fanOscillationMode');
    const current = s => (entry.swung && Date.now() - entry.swung.at < RECENT ? entry.swung.mode : swing(s));
    const set = (vertical, horizontal) => {
        const mode = swingOf(entry, vertical, horizontal);
        entry.swung = {mode, at: Date.now()};
        return {capability: 'fanOscillationMode', command: 'setFanOscillationMode', arguments: [mode]};
    };
    if (entry.swings.includes('vertical') || entry.swings.includes('all')) {
        props.push([toggle(5, 'vertical-swing'), s => (swing(s) === null ? null : ['vertical', 'all'].includes(swing(s))),
            (v, s) => set(v, ['horizontal', 'all'].includes(current(s)) && entry.swings.includes('horizontal'))]);
    }
    if (entry.swings.includes('horizontal')) {
        props.push([toggle(6, 'horizontal-swing'), s => (swing(s) === null ? null : ['horizontal', 'all'].includes(swing(s))),
            (v, s) => set(['vertical', 'all'].includes(current(s)), v)]);
    }
    const optional = s => value(s, 'custom.airConditionerOptionalMode', 'acOptionalMode');
    for (const [mode, name, piid] of OPTIONAL.filter(([mode]) => entry.optional.includes(mode))) {
        props.push([toggle(piid, name), s => (optional(s) === null ? null : optional(s) === mode),
            v => ({capability: 'custom.airConditionerOptionalMode', command: 'setAcOptionalMode', arguments: [v ? mode : 'off']})]);
    }
    return props;
}

/** Reads the air conditioners with fresh tokens: {account, devices}. Renewed tokens are kept at once. */
export async function connect(account, cancellable = null) {
    const client = new StClient(account, cancellable);
    client.onRefresh = fresh => store(fresh);
    try {
        const devices = [];
        for (const item of await client.devices())
            devices.push(entryOf(item, await client.status(item.deviceId)));
        return {account: client.account, devices};
    } finally {
        client.abort();
    }
}

export const store = account => keepAccount(SECRET, LABEL, account);

export const BRAND = {
    id: 'smartthings',
    label: 'SmartThings',
    SECRET,
    gap: 10 * 1000,
    groups,
    async load(cancellable) {
        const account = await savedAccount(SECRET);
        if (!account?.refreshToken)
            return null;
        const client = new StClient(account, cancellable);
        client.onRefresh = fresh => store(fresh).catch(e => console.debug(`nook: smartthings: ${e.message}`));
        return client;
    },
};

export {CloudAirconHome};
