// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Secrets from './secrets.js';
import {TvError} from './net.js';
import AndroidTv from './tv-android.js';
import AppleTv from './tv-apple.js';
import LgTv from './tv-lg.js';
import PanasonicTv from './tv-panasonic.js';
import PhilipsTv from './tv-philips.js';
import RokuTv from './tv-roku.js';
import SamsungTv from './tv-samsung.js';
import SonyTv from './tv-sony.js';

export const BRANDS = {
    androidtv: {title: 'Android TV', Driver: AndroidTv},
    appletv: {title: 'Apple TV', Driver: AppleTv},
    lg: {title: 'LG', Driver: LgTv},
    panasonic: {title: 'Panasonic', Driver: PanasonicTv},
    philips: {title: 'Philips', Driver: PhilipsTv},
    roku: {title: 'Roku', Driver: RokuTv},
    samsung: {title: 'Samsung', Driver: SamsungTv},
    sony: {title: 'Sony', Driver: SonyTv},
};

export function parseTvs(json) {
    try {
        const tvs = JSON.parse(json || '[]');
        return Array.isArray(tvs) ? tvs.filter(t => t?.id && t.ip && Object.hasOwn(BRANDS, t.brand)) : [];
    } catch {
        return [];
    }
}

export const secretService = id => `tv:${id}`;

function modelText(tv) {
    const brand = BRANDS[tv.brand].title;
    if (!tv.model)
        return brand;
    return tv.model.toLowerCase().startsWith(brand.toLowerCase()) ? tv.model : `${brand} ${tv.model}`;
}

export async function driverFor(tv, refused = null) {
    let saved = null, secret = null;
    try {
        saved = await Secrets.lookup(secretService(tv.id));
        if (saved && saved !== refused)
            secret = JSON.parse(saved);
    } catch (e) {
        // e.name only: the message may quote the secret.
        console.warn(`nook: tv: the pairing of ${tv.id} could not be read: ${e.name}`);
    }
    const driver = new BRANDS[tv.brand].Driver(tv, secret);
    Object.defineProperty(driver, 'saved', {value: saved, enumerable: false});
    driver.onSecret = fresh => {
        keepSecret(tv, fresh).catch(e => console.warn(`nook: tv: ${e.message}`));
    };
    return driver;
}

export function keepSecret(tv, secret) {
    return Secrets.store(secretService(tv.id), `Nook: pairing with the ${BRANDS[tv.brand].title} TV`,
        JSON.stringify(secret));
}

const quiet = e => e instanceof TvError || e instanceof GLib.Error;

// TVs report a power change seconds late, after Wake-on-LAN tens of seconds.
const POWER_WAIT = 40000;

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

export class TvHome {
    constructor(tvs) {
        this._links = new Map();
        this.onChange = null;
        this.devices = tvs.map(tv => {
            const device = {
                did: `tv:${tv.id}`,
                name: tv.name || tv.model || BRANDS[tv.brand].title,
                model: 'tv',
                brand: tv.brand,
                urn: null,
                room: tv.room ?? null,
                online: null,
                primary: {kind: 'tv', props: []},
                values: null,
                state: null,
                about: {ip: tv.ip, mac: tv.mac || null, model: modelText(tv)},
            };
            Object.defineProperty(device, 'source', {value: this, enumerable: false});
            this._links.set(device.did, {
                tv: {...tv},
                driver: null,
                refused: null,
                // Bumped by rest(); list results from an earlier round are dropped.
                round: 0,
                lists: {},
                listed: {},
                titles: new Map(),
                icons: new Map(),
            });
            return device;
        });
    }

    // Drivers that keep a connection open push changes through onUpdate.
    _driver(device) {
        const link = this._links.get(device.did);
        link.driver ??= driverFor(link.tv, link.refused).then(driver => {
            const round = link.round;
            driver.onUpdate = () => {
                if (link.round !== round)
                    return;
                this._read(device).then(() => this.onChange?.(device)).catch(e => {
                    if (!quiet(e))
                        console.warn(`nook: tv: ${e.message}`);
                });
            };
            return driver;
        });
        return link.driver;
    }

    // driver.refused: the TV rejected the saved pairing and prompted on screen.
    // That secret is not offered again until a new pairing.
    _checkRefused(device, driver) {
        if (!driver.refused)
            return;
        const link = this._links.get(device.did);
        link.refused = driver.saved;
        console.warn(`nook: tv: ${link.tv.id} no longer takes its pairing`);
    }

    async _read(device) {
        const driver = await this._driver(device);
        let state;
        try {
            state = await driver.status();
        } finally {
            this._checkRefused(device, driver);
        }
        device.state = {
            ...state,
            paired: driver.paired,
            setsVolume: typeof driver.setVolume === 'function' && state.volume !== null,
            // The remote keys it has, when not all of them.
            keys: driver.keys ?? null,
        };
        device.online = true;
        device.values = [state.on];
    }

    async readPrimary() {
        await Promise.all(this.devices.map(d => this._read(d).catch(e => {
            if (!quiet(e))
                throw e;
            d.online = false;
        })));
        return this.devices.length > 0;
    }

    readDevice(device) {
        return this._read(device).catch(e => {
            if (!quiet(e))
                throw e;
            device.online = false;
        });
    }

    rest() {
        for (const link of this._links.values()) {
            link.driver?.then(driver => driver.close()).catch(() => {});
            link.driver = null;
            link.round++;
            link.lists = {};
            link.listed = {};
        }
    }

    abort() {
        this.rest();
    }

    async _do(device, action) {
        const driver = await this._driver(device);
        try {
            await action(driver);
        } finally {
            this._checkRefused(device, driver);
        }
        await this._read(device).catch(e => {
            if (!quiet(e))
                throw e;
        });
        this.onChange?.(device);
    }

    // Reads on until the TV reports the new state, so the card doesn't show the old one
    // and a second press can't toggle it back meanwhile.
    async power(device, on) {
        const link = this._links.get(device.did);
        const round = link.round;
        await this._do(device, driver => driver.power(on));
        const until = Date.now() + POWER_WAIT;
        while (device.state?.on !== on && Date.now() < until) {
            await sleep(1000);
            if (link.round !== round)
                return;
            await this._read(device).catch(e => {
                if (!quiet(e))
                    throw e;
            });
            if (device.state?.on === on)
                this.onChange?.(device);
        }
    }

    setSwitch(device, on) {
        return this.power(device, on);
    }

    setVolume(device, level) {
        return this._do(device, driver => driver.setVolume(level));
    }

    setMuted(device, muted) {
        return this._do(device, driver => (driver.setMuted ? driver.setMuted(muted) : driver.press('mute')));
    }

    async press(device, key) {
        const driver = await this._driver(device);
        try {
            await driver.press(key);
        } finally {
            this._checkRefused(device, driver);
        }
    }

    // Lists are fetched once per round; titles persist across rounds for showing().
    async _list(device, what) {
        const link = this._links.get(device.did);
        const driver = await this._driver(device);
        const round = link.round;
        link.lists[what] ??= Promise.resolve(driver[what]()).then(items => {
            // An input's app id (LG) names it too: status() may report that instead.
            for (const item of items) {
                if (item.title)
                    link.titles.set(item.id, item.title);
                if (item.title && item.app)
                    link.titles.set(item.app, item.title);
            }
            if (link.round === round)
                link.listed[what] = items;
            return items;
        }, e => {
            if (link.round === round)
                delete link.lists[what];
            this._checkRefused(device, driver);
            throw e;
        });
        return link.lists[what];
    }

    listed(device, what) {
        return this._links.get(device.did).listed[what] ?? null;
    }

    showing(device) {
        const {titles} = this._links.get(device.did);
        const {app, source, title} = device.state ?? {};
        return title ?? titles.get(app) ?? titles.get(source) ?? null;
    }

    sources(device) {
        return this._list(device, 'sources');
    }

    // Icons outlive rounds like titles. The apps drawer looks them up when it opens, and
    // offers the first 12 apps and the running one.
    async apps(device) {
        const items = await this._list(device, 'apps');
        const link = this._links.get(device.did);
        const driver = await this._driver(device);
        const shown = items.filter((item, i) => i < 12 || item.running);
        for (const item of shown.filter(i => i.icon && !link.icons.has(i.id))) {
            link.icons.set(item.id, null);
            driver.icon(item.icon).then(bytes => {
                link.icons.set(item.id, Gio.BytesIcon.new(bytes));
            }, e => {
                link.icons.delete(item.id);
                if (!quiet(e))
                    console.warn(`nook: tv: ${e.message}`);
            });
        }
        return items;
    }

    appIcon(device, id) {
        return this._links.get(device.did).icons.get(id) ?? null;
    }

    source(device, id) {
        return this._do(device, driver => driver.source(id));
    }

    launch(device, id) {
        return this._do(device, driver => driver.launch(id));
    }
}

export {TvError};
