// SPDX-License-Identifier: GPL-2.0-or-later

// Daikin air conditioners through their Wi-Fi adapter, on the LAN. BRP069 and BRP072A
// answer plain HTTP key=value pages under /aircon; adapters on firmware 2.8 take JSON at
// /dsiot/multireq instead. Paths and values per pydaikin, unverified on a unit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {ClimateError} from './climate.js';
import {probe} from './net.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class DaikinError extends ClimateError {
    constructor(message, code = '') {
        super(message, code);
        this.name = 'DaikinError';
    }
}

// "ret=OK,key=value,…"; anything but OK is an empty answer.
export function parseReply(text) {
    const reply = {};
    for (const [, key, value] of text.matchAll(/(\w+)=([^=]*)(?:,|$)/g))
        reply[key] = value;
    if (reply.ret !== 'OK')
        return null;
    delete reply.ret;
    if (reply.name) {
        try {
            reply.name = decodeURIComponent(reply.name);
        } catch {}
    }
    return reply;
}

export async function discover(address = '255.255.255.255', timeout = 3000) {
    const found = new Map();
    const take = (bytes, ip) => {
        const reply = parseReply(decoder.decode(bytes));
        if (reply?.mac && (!reply.type || reply.type === 'aircon'))
            found.set(reply.mac.toLowerCase(), {ip, mac: reply.mac.toLowerCase(), name: reply.name || null, firmware: reply.ver ?? null});
    };
    // Adapters answer to port 30000, not to the port the question came from.
    try {
        await probe(encoder.encode('DAIKIN_UDP/common/basic_info'), [30050], {address, timeout, localPort: 30000, take});
    } catch (e) {
        if (e instanceof GLib.Error)
            throw e;
        throw new DaikinError(e.message);
    }
    return [...found.values()];
}

const number = text => (/^-?\d+(\.\d+)?$/.test(text ?? '') ? Number(text) : null);

// Ranges by MODES index; the adapters refuse a target outside the mode's own.
const RANGES = [[18, 30, 0.5], [18, 32, 0.5], [18, 32, 0.5], [18, 32, 0.5], [10, 31, 0.5]];

const FANS = [
    {value: 'A', word: 'auto', level: 0},
    {value: 'B', word: 'quiet', level: 1},
    ...['3', '4', '5', '6', '7'].map((value, i) => ({value, word: null, level: i + 1})),
];

// Classic modes: 0, 1 and 7 auto, 2 dry, 3 cool, 4 heat, 6 fan.
const FROM_CLASSIC = {0: 0, 1: 0, 7: 0, 2: 2, 3: 1, 4: 4, 6: 3};
const TO_CLASSIC = ['0', '3', '2', '6', '4'];
const NO_TARGET = ['2', '6'];

class Classic {
    constructor(session, ip) {
        this._session = session;
        this._ip = ip;
        this._model = null;
        this._control = null;
    }

    async _get(path, params = null) {
        const query = params ? `?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}` : '';
        const message = Soup.Message.new('GET', `http://${this._ip}/${path}${query}`);
        if (!message)
            throw new DaikinError('not an address');
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const status = message.get_status();
        if (status === Soup.Status.FORBIDDEN)
            throw new DaikinError('the adapter wants a key, which Nook does not support yet', 'key');
        if (status !== Soup.Status.OK)
            throw new DaikinError(`the air conditioner answered HTTP ${status}`);
        return decoder.decode(bytes.toArray());
    }

    async _read(path, params = null) {
        const reply = parseReply(await this._get(path, params));
        if (!reply)
            throw new DaikinError('the air conditioner refused the change', 'refused');
        return reply;
    }

    async info() {
        return this._read('common/basic_info');
    }

    // A model read that failed is tried again on the next poll.
    async status() {
        this._model ??= await this._read('aircon/get_model_info').catch(() => null);
        const control = this._control = await this._read('aircon/get_control_info');
        const sensors = await this._read('aircon/get_sensor_info').catch(() => ({}));
        const mode = FROM_CLASSIC[control.mode] ?? 0;
        // Dry and fan modes have no target of their own ('M', '--').
        const state = {
            Pow: control.pow === '1' ? 1 : 0,
            Mod: mode,
            SetTem: NO_TARGET.includes(control.mode) ? null : number(control.stemp) ?? number(control[`dt${control.mode}`]),
            roomTemperature: number(sensors.htemp),
        };
        if (control.f_rate)
            state.WdSpd = control.f_rate;
        const split = 'f_dir_ud' in control;
        if (control.f_dir || split) {
            const vertical = split ? control.f_dir_ud === 'S' : ['1', '3'].includes(control.f_dir);
            const horizontal = split ? control.f_dir_lr === 'S' : ['2', '3'].includes(control.f_dir);
            state.SwUpDn = vertical ? 1 : 0;
            state.SwingLfRig = horizontal ? 1 : 0;
        }
        if ('adv' in control) {
            // en_spmode bits as pydaikin's spmode_kind: 1 powerful, 2 econo, 4 streamer. A
            // mode the unit reports on is offered whatever en_spmode says (Alira X has 0).
            const special = Number(this._model?.en_spmode ?? 3);
            const on = control.adv.split('/');
            for (const [bit, key, code] of [[1, 'Tur', '2'], [2, 'SvSt', '12'], [4, 'Health', '13']]) {
                if (special & bit || on.includes(code))
                    state[key] = on.includes(code) ? 1 : 0;
            }
        }
        return state;
    }

    caps(state) {
        return {
            range: RANGES[state.Mod] ?? RANGES[1],
            modes: [0, 1, 2, 3, 4],
            fans: state.WdSpd !== undefined ? FANS : [],
            airflows: state.SwUpDn !== undefined ? [1, 0] : [],
            sides: state.SwingLfRig !== undefined && this._model?.s_fdir !== '1' ? [1, 0] : [],
        };
    }

    async set(changes) {
        const control = await this._read('aircon/get_control_info');
        const params = {pow: control.pow, mode: control.mode, stemp: control.stemp, shum: control.shum};
        if (control.f_rate)
            params.f_rate = control.f_rate;
        if ('Mod' in changes) {
            params.mode = TO_CLASSIC[changes.Mod] ?? control.mode;
            for (const [key, memory] of [['stemp', 'dt'], ['shum', 'dh'], ['f_rate', 'dfr']]) {
                if (`${memory}${params.mode}` in control && (key !== 'f_rate' || params.f_rate))
                    params[key] = control[`${memory}${params.mode}`];
            }
            // Auto has no memory slot of its own on most adapters: a mode that takes a
            // target gets a number from the auto or cool slots rather than dry's 'M'.
            if (!NO_TARGET.includes(params.mode) && number(params.stemp) === null)
                params.stemp = [control.dt1, control.dt7, control.dt3].find(t => number(t) !== null) ?? '24.0';
        }
        if ('Pow' in changes)
            params.pow = changes.Pow === 1 ? '1' : '0';
        if ('SetTem' in changes && !NO_TARGET.includes(params.mode))
            params.stemp = changes.SetTem.toFixed(1);
        if ('WdSpd' in changes)
            params.f_rate = changes.WdSpd;
        const split = 'f_dir_ud' in control;
        if (control.f_dir || split) {
            let vertical = split ? control.f_dir_ud === 'S' : ['1', '3'].includes(control.f_dir);
            let horizontal = split ? control.f_dir_lr === 'S' : ['2', '3'].includes(control.f_dir);
            if ('SwUpDn' in changes)
                vertical = changes.SwUpDn === 1;
            if ('SwingLfRig' in changes)
                horizontal = changes.SwingLfRig === 1;
            if (split) {
                params.f_dir_ud = vertical ? 'S' : '0';
                params.f_dir_lr = horizontal ? 'S' : '0';
            } else {
                params.f_dir = String((vertical ? 1 : 0) + (horizontal ? 2 : 0));
            }
        }
        const basic = ['Pow', 'Mod', 'SetTem', 'WdSpd', 'SwUpDn', 'SwingLfRig'].some(key => key in changes);
        if (basic)
            await this._read('aircon/set_control_info', params);
        for (const [key, kind] of [['Tur', '1'], ['SvSt', '2']]) {
            if (key in changes)
                await this._read('aircon/set_special_mode', {set_spmode: changes[key] ? '1' : '0', spmode_kind: kind});
        }
        if ('Health' in changes)
            await this._read('aircon/set_special_mode', {en_streamer: changes.Health ? '1' : '0'});
    }
}

const INDOOR = '/dsiot/edge/adr_0100.dgc_status';
const OUTDOOR = '/dsiot/edge/adr_0200.dgc_status';
const ADAPTER = '/dsiot/edge.adp_i';

// [to, …names down to the value]
const PATHS = {
    power: [INDOOR, 'e_1002', 'e_A002', 'p_01'],
    mode: [INDOOR, 'e_1002', 'e_3001', 'p_01'],
    indoor: [INDOOR, 'e_1002', 'e_A00B', 'p_01'],
    econo: [INDOOR, 'e_1002', 'e_3003', 'p_24'],
    powerful: [OUTDOOR, 'e_1003', 'e_3002', 'p_44'],
    mac: [ADAPTER, 'mac'],
    firmware: [ADAPTER, 'ver'],
};
const mode = name => [INDOOR, 'e_1002', 'e_3001', name];
// By MODES index: auto, cool, dry, fan, heat.
const DSIOT_MODES = ['0300', '0200', '0500', '0000', '0100'];
const TEMPERATURES = [mode('p_1D'), mode('p_02'), null, null, mode('p_03')];
const DSIOT_FANS = [mode('p_26'), mode('p_09'), null, mode('p_28'), mode('p_0A')];
const SWINGS = [
    [mode('p_20'), mode('p_21')],
    [mode('p_05'), mode('p_06')],
    [mode('p_22'), mode('p_23')],
    [mode('p_24'), mode('p_25')],
    [mode('p_07'), mode('p_08')],
];
const FAN_CODES = {'0A00': 'A', '0B00': 'B', '0300': '3', '0400': '4', '0500': '5', '0600': '6', '0700': '7'};
const FAN_HEX = Object.fromEntries(Object.entries(FAN_CODES).map(([hex, code]) => [code, hex]));

// names start below the answer's root node (dgc_status or adp_i).
function find(reply, [to, ...names]) {
    const responses = Array.isArray(reply?.responses) ? reply.responses : [];
    let level = responses.filter(r => r?.fr === to).flatMap(r => r.pc?.pch ?? []);
    let node = null;
    for (const name of names) {
        node = level.find(n => n?.pn === name) ?? null;
        if (!node)
            return null;
        level = node.pch ?? [];
    }
    return node?.pv ?? null;
}

const byte = hex => (typeof hex === 'string' && /^[0-9a-f]{2}/i.test(hex) ? Number.parseInt(hex.slice(0, 2), 16) : null);

class Dsiot {
    constructor(session, ip) {
        this._session = session;
        this._ip = ip;
        this._last = null;
    }

    async _post(body) {
        const message = Soup.Message.new('POST', `http://${this._ip}/dsiot/multireq`);
        if (!message)
            throw new DaikinError('not an address');
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        if (message.get_status() !== Soup.Status.OK)
            throw new DaikinError(`the air conditioner answered HTTP ${message.get_status()}`);
        try {
            return JSON.parse(decoder.decode(bytes.toArray()));
        } catch {
            throw new DaikinError('the air conditioner gave an answer that could not be read');
        }
    }

    async _fetch() {
        const reply = await this._post({requests: [INDOOR, OUTDOOR].map(to => ({op: 2, to: `${to}?filter=pv,pt,md`}))
            .concat({op: 2, to: ADAPTER})});
        if (find(reply, PATHS.power) === null)
            throw new DaikinError('the air conditioner gave an answer that could not be read');
        this._last = reply;
        return reply;
    }

    async info() {
        const reply = await this._fetch();
        return {mac: find(reply, PATHS.mac), ver: find(reply, PATHS.firmware)};
    }

    async status() {
        const reply = await this._fetch();
        const index = Math.max(0, DSIOT_MODES.indexOf(find(reply, PATHS.mode)));
        // Dry and fan have no target; auto has none on heat pumps without p_1D.
        const target = TEMPERATURES[index] ? byte(find(reply, TEMPERATURES[index])) : null;
        const state = {
            Pow: find(reply, PATHS.power) === '00' ? 0 : 1,
            Mod: index,
            SetTem: target === null ? null : target / 2,
            roomTemperature: byte(find(reply, PATHS.indoor)),
        };
        const fan = DSIOT_FANS[index] && FAN_CODES[find(reply, DSIOT_FANS[index])];
        if (fan)
            state.WdSpd = fan;
        const [vertical, horizontal] = SWINGS[index].map(path => find(reply, path));
        if (vertical !== null)
            state.SwUpDn = vertical.includes('F') ? 1 : 0;
        if (horizontal !== null)
            state.SwingLfRig = horizontal.includes('F') ? 1 : 0;
        const econo = find(reply, PATHS.econo);
        if (econo !== null)
            state.SvSt = econo === '01' ? 1 : 0;
        const powerful = find(reply, PATHS.powerful);
        if (powerful !== null)
            state.Tur = powerful === '01' ? 1 : 0;
        return state;
    }

    caps(state) {
        return {
            range: RANGES[state.Mod] ?? RANGES[1],
            modes: [0, 1, 2, 3, 4],
            fans: state.WdSpd !== undefined ? FANS : [],
            airflows: state.SwUpDn !== undefined ? [1, 0] : [],
            sides: state.SwingLfRig !== undefined ? [1, 0] : [],
        };
    }

    // Writes go as one dgc_status tree per address, as pydaikin builds them.
    async set(changes) {
        const reply = await this._fetch();
        const current = Math.max(0, DSIOT_MODES.indexOf(find(reply, PATHS.mode)));
        const index = 'Mod' in changes ? changes.Mod : current;
        const writes = [];
        if ('Pow' in changes)
            writes.push([PATHS.power, changes.Pow === 1 ? '01' : '00']);
        if ('Mod' in changes)
            writes.push([PATHS.mode, DSIOT_MODES[index]]);
        if ('SetTem' in changes && TEMPERATURES[index])
            writes.push([TEMPERATURES[index], Math.round(changes.SetTem * 2).toString(16).padStart(2, '0')]);
        if ('WdSpd' in changes && DSIOT_FANS[index] && FAN_HEX[changes.WdSpd])
            writes.push([DSIOT_FANS[index], FAN_HEX[changes.WdSpd]]);
        if ('SwUpDn' in changes)
            writes.push([SWINGS[index][0], changes.SwUpDn === 1 ? '0F0000' : '000000']);
        if ('SwingLfRig' in changes)
            writes.push([SWINGS[index][1], changes.SwingLfRig === 1 ? '0F0000' : '000000']);
        // Powerful and Econo exclude each other, as on the remote.
        if ('Tur' in changes) {
            writes.push([PATHS.powerful, changes.Tur ? '01' : '00']);
            if (changes.Tur && find(reply, PATHS.econo) === '01')
                writes.push([PATHS.econo, '00']);
        }
        if ('SvSt' in changes) {
            writes.push([PATHS.econo, changes.SvSt ? '01' : '00']);
            if (changes.SvSt && find(reply, PATHS.powerful) === '01')
                writes.push([PATHS.powerful, '00']);
        }
        if (writes.length === 0)
            return;
        const requests = [];
        for (const [[to, ...names], value] of writes) {
            let request = requests.find(r => r.to === to);
            if (!request) {
                request = {op: 3, pc: {pn: 'dgc_status', pch: []}, to};
                requests.push(request);
            }
            let level = request.pc.pch;
            for (const name of names.slice(0, -1)) {
                let node = level.find(n => n.pn === name);
                if (!node) {
                    node = {pn: name, pch: []};
                    level.push(node);
                }
                level = node.pch;
            }
            level.push({pn: names[names.length - 1], pv: value});
        }
        const answer = await this._post({requests});
        if ((answer.responses ?? []).some(r => r.rsc && r.rsc >= 4000))
            throw new DaikinError('the air conditioner refused the change', 'refused');
    }
}

/** Which API the adapter at ip speaks, with its MAC and firmware: {api, mac, firmware}. */
export async function identify(ip) {
    const session = new Soup.Session({timeout: 5});
    try {
        for (const [api, Api] of [['dsiot', Dsiot], ['classic', Classic]]) {
            try {
                const info = await new Api(session, ip).info();
                if (info?.mac)
                    return {api, mac: info.mac.toLowerCase(), firmware: info.ver ?? null, name: info.name ?? null};
            } catch (e) {
                if (!(e instanceof DaikinError) && !(e instanceof GLib.Error))
                    throw e;
                console.debug(`nook: daikin: ${ip}: ${api}: ${e.message}`);
            }
        }
        return null;
    } finally {
        session.abort();
    }
}

export class DaikinUnit {
    constructor(unit) {
        // One request at a time: BRP069 adapters drop concurrent ones.
        this._session = new Soup.Session({timeout: 5, max_conns_per_host: 1});
        this._api = new (unit.api === 'dsiot' ? Dsiot : Classic)(this._session, unit.ip);
        this._busy = Promise.resolve();
        this.caps = this._api.caps({Mod: 1});
        this.about = {ip: unit.ip, mac: unit.mac ?? null, firmware: unit.firmware?.replace(/_/g, '.') ?? null, model: null};
    }

    close() {
        this._session.abort();
    }

    _queue(task) {
        const run = this._busy.then(task, task);
        this._busy = run.catch(() => {});
        return run.catch(e => {
            if (e instanceof GLib.Error && !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw new DaikinError(`the air conditioner did not answer: ${e.message}`);
            throw e;
        });
    }

    _read() {
        return this._api.status().then(state => {
            this.caps = this._api.caps(state);
            return state;
        });
    }

    status() {
        return this._queue(() => this._read());
    }

    set(changes) {
        return this._queue(async () => {
            await this._api.set(changes);
            return this._read();
        });
    }
}
