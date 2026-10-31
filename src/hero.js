// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import {gettext as _} from 'gettext';

import * as Glyphs from './lib/glyphs.js';
import * as Scenes from './lib/scenes.js';
import {MODES} from './lib/climate.js';
import {WHITE} from './lib/spec-home.js';
import {colorName, rgbOf} from './color.js';
import {booleanText, choiceText, deviceType, formatValue, heardOf, kettleStatus, numberFormat, stateText, statusWorking,
    whenText} from './text.js';

// The picture on top of a device page: the extension's card heroes (ui/hero.js,
// ui/card-climate.js, ui/card-media.js, ui/card-tv.js), drawn by lib/scenes.js.

const HERO_SCENES = {
    thermometer: 'thermo',
    motion: 'motion',
    door: 'door',
    drop: 'leak',
    smoke: 'smoke',
    fan: 'fan',
    kettle: 'kettle',
    vacuum: 'vacuum',
    scale: 'scale',
    hub: 'gateway',
    wifi: 'repeater',
    button: 'button',
    pot: 'fryer',
    scooter: 'scooter',
    aircon: 'aircon',
    speaker: 'speaker',
    bulb: 'light',
    plug: 'plug',
    rocker: 'plug',
    washer: 'washer',
    dishwasher: 'dishwasher',
    purifier: 'purifier',
    humidifier: 'humidifier',
    dehumidifier: 'dehumidifier',
    heater: 'heater',
    curtain: 'curtain',
    lock: 'lock',
    fridge: 'fridge',
    coffee: 'coffee',
    thermostat: 'thermostat',
    doorbell: 'doorbell',
    plant: 'plant',
    cooker: 'cooker',
    filter: 'water',
};

export const ALARM = [0.9, 0.3, 0.3];
const RESTING = [0.52, 0.52, 0.57];
const OFFLINE = [0.42, 0.42, 0.46];

// PM2.5 in µg/m³, banded like purifiers' ring lights.
function airQuality(pm) {
    if (pm <= 35)
        return [0.36, 0.8, 0.5];
    if (pm <= 75)
        return [0.95, 0.78, 0.3];
    if (pm <= 115)
        return [0.98, 0.55, 0.25];
    return [0.9, 0.3, 0.3];
}

const APP_COLORS = [
    [/spotify/i, [0.12, 0.73, 0.33]],
    [/youtube/i, [0.9, 0.22, 0.2]],
    [/apple/i, [0.98, 0.3, 0.42]],
    [/deezer/i, [0.64, 0.3, 0.95]],
];
const SPEAKER = [0.66, 0.46, 0.95];
const SILENT = [0.4, 0.44, 0.52];

// An app with no media session and no playing group takes no pause, only a receiver STOP.
const onlyStops = device => Boolean(device.state?.app) && !device.state.media;
const playingNow = device => ['PLAYING', 'BUFFERING'].includes(device.state?.media?.state) || onlyStops(device);

function mediaColor(device) {
    const app = device.state?.app ?? '';
    if (!app && !playingNow(device))
        return SILENT;
    return APP_COLORS.find(([pattern]) => pattern.test(app))?.[1] ?? SPEAKER;
}

function speakerKind(model) {
    if (/group/i.test(model))
        return 'group';
    if (/mini|l05|lx01/i.test(model))
        return 'puck';
    if (/hub|display|tv|chromecast|lx04|x08|x10/i.test(model))
        return 'display';
    return 'tower';
}

const TV_APPS = [
    [/youtube/i, 'YouTube'],
    [/netflix/i, 'Netflix'],
    [/amazon|primevideo/i, 'Prime Video'],
    [/disney/i, 'Disney+'],
    [/spotify/i, 'Spotify'],
    [/kinopoisk/i, 'Kinopoisk'],
    [/browser/i, 'Browser'],
];

export function tvShowing(device) {
    const named = device.source?.showing?.(device);
    if (named)
        return named;
    const {source, app} = device.state ?? {};
    if (!app && source === 'tv')
        return _('TV');
    const id = String(app ?? source ?? '');
    const hdmi = /hdmi[\W_]*(\d)/i.exec(id);
    if (hdmi)
        return `HDMI ${hdmi[1]}`;
    return TV_APPS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

export function choiceOf(prop, value) {
    return prop?.choices?.find(c => c.value === value)?.description ?? null;
}

// Dreame fault codes; their spec describes only "No faults".
const DREAME_FAULTS = () => ({
    1: _('The wheels are off the floor'),
    2: _('A cliff sensor is dirty or blocked'),
    3: _('The bumper is stuck'),
    4: _('The robot is tilted'),
    5: _('The bumper keeps getting stuck'),
    6: _('The wheels keep coming off the floor'),
    7: _('The floor sensor underneath is dirty'),
    8: _('The dust bin is missing'),
    9: _('The water tank is missing'),
    10: _('The water tank is empty'),
    11: _('The dust bin is full'),
    12: _('The main brush is stuck'),
    13: _('The side brush is stuck'),
    14: _('The fan is blocked'),
    15: _('The left wheel is stuck'),
    16: _('The right wheel is stuck'),
    17: _('The robot is stuck and cannot turn'),
    18: _('The robot is stuck and cannot go on'),
    19: _('The robot cannot find its dock'),
    20: _('The battery is low'),
    21: _('It is not charging'),
    22: _('The battery is too low to start'),
    23: _('Something is wrong inside the robot'),
    24: _('The camera is covered'),
    25: _('The camera does not work'),
    26: _('Something is wrong with the battery'),
    27: _('The front sensor is dirty'),
    28: _('The gyroscope does not work'),
});

function faultText(device, prop, value) {
    const own = choiceOf(prop, value);
    if (own)
        return choiceText(own);
    if (String(device.model).startsWith('dreame.'))
        return DREAME_FAULTS()[value] ?? null;
    return null;
}

// Matched on the spec's status words; the numbers differ per model.
export function vacuumMode(description) {
    const text = description ?? '';
    if (/go charging|return/i.test(text))
        return 'returning';
    if (/charging/i.test(text) && !/not charging|charging not/i.test(text))
        return 'charging';
    if (/sweep|clean|mop/i.test(text))
        return 'cleaning';
    if (/error|fault/i.test(text))
        return 'error';
    return 'idle';
}

// Cloud event-history keys by device type.
const EVENT_KEYS = () => ({
    'submersion-sensor': [['leak', _('Leak')], ['no_leak', _('Dry again')]],
    'remote-control': [['click', _('Pressed')], ['double_click', _('Pressed twice')], ['long_click_press', _('Held')]],
    'motion-sensor': [['motion', _('Motion')]],
    'magnet-sensor': [['open', _('Opened')], ['close', _('Closed')]],
});

// Both the gateway's model names ("magnet", "sensor_wleak.aq1") and Mi Home's ("lumi.sensor_magnet").
function sensorKind(model) {
    if (/wleak/.test(model))
        return 'leak';
    if (/smoke/.test(model))
        return 'smoke';
    if (/natgas/.test(model))
        return 'gas';
    return null;
}

function shortWhen(seconds) {
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const now = GLib.DateTime.new_now_local();
    if (then.format('%Y-%m-%d') === now.format('%Y-%m-%d'))
        return then.format('%H:%M');
    return then.format('%e %b').trim();
}

function liveText(device) {
    const data = device.live;
    if (!data)
        return null;
    const kind = sensorKind(device.model);
    if ((kind === 'smoke' || kind === 'gas') && data.alarm !== undefined) {
        const alarm = String(data.alarm);
        if (alarm === '0')
            return kind === 'smoke' ? _('No smoke') : _('No gas');
        if (alarm === '1' || alarm === '2')
            return kind === 'smoke' ? _('Smoke!') : _('Gas!');
        return _('Fault');
    }
    if (data.status === 'leak')
        return _('Leak!');
    if (data.status === 'no_leak')
        return _('No leak');
    return null;
}

function eventText(device) {
    const last = device.lastEvent;
    if (sensorKind(device.model) === 'leak') {
        const live = liveText(device);
        if (live)
            return live;
        if (last === undefined)
            return null;
        // null: the history answered empty (undefined: not loaded yet).
        return last?.key === 'leak' ? `${_('Leak!')} · ${shortWhen(last.time)}` : _('No leak');
    }
    if (!last)
        return null;
    const label = (EVENT_KEYS()[deviceType(device)] ?? []).find(([key]) => key === last.key)?.[1];
    return label ? `${label} · ${shortWhen(last.time)}` : null;
}

// The colour scale; a unit's own range is in its caps.
const CLIMATE_MIN = 16;
const CLIMATE_MAX = 30;
const COOL = [0.21, 0.52, 0.89];
const TEAL = [0.22, 0.66, 0.62];
const ICE = [0.14, 0.42, 0.98];
const MILD = [0.3, 0.6, 0.84];
const AMBER = [0.97, 0.64, 0.24];
const EMBER = [0.93, 0.34, 0.2];
const VIOLET = [0.56, 0.44, 0.88];
const SAND = [0.78, 0.66, 0.42];

function climateLook(mode, temperature) {
    const depth = Math.min(1, Math.max(0, (temperature - CLIMATE_MIN) / (CLIMATE_MAX - CLIMATE_MIN)));
    let color = COOL;
    if (mode === 'heat')
        color = Scenes.mix(AMBER, EMBER, depth);
    else if (mode === 'fan')
        color = TEAL;
    else if (mode === 'dry')
        color = SAND;
    else if (mode === 'auto')
        color = VIOLET;
    else if (mode === 'cool')
        color = Scenes.mix(ICE, MILD, depth);
    return {color, air: mode === 'fan' ? [0.86, 0.9, 0.96] : color};
}

function climateMode(description) {
    const text = description ?? '';
    if (/cool/i.test(text))
        return 'cool';
    if (/heat|warm/i.test(text))
        return 'heat';
    if (/dry|dehumid/i.test(text))
        return 'dry';
    if (/fan|wind|vent|air/i.test(text))
        return 'fan';
    return 'auto';
}

function climateStatus(mode) {
    switch (MODES[mode]) {
    case 'cool':
        return _('Cooling');
    case 'heat':
        return _('Heating');
    case 'dry':
        return _('Drying');
    case 'fan':
        return _('Fan only');
    default:
        return _('Auto');
    }
}

function climateSpeed(state, caps) {
    if (state.Tur)
        return 1.8;
    if (state.Quiet)
        return 0.55;
    const level = caps?.fans?.find(f => f.value === state.WdSpd)?.level ?? 0;
    return level > 0 ? 0.6 + level * 0.18 : 1;
}

const degrees = value => `${numberFormat.format(value)}°`;

// Air conditioners the app drives itself (Gree, Midea, Daikin and the clouds).
function climateHero(device) {
    const state = device.state ?? {};
    const on = state.Pow === 1;
    const target = state.SetTem;
    const known = typeof target === 'number';
    const {color, air} = climateLook(MODES[state.Mod], known ? target : 24);
    const room = typeof state.roomTemperature === 'number' ? _('Room %s°').replace('%s', numberFormat.format(state.roomTemperature)) : null;
    return {
        scene: 'aircon',
        state: {
            on,
            color,
            air,
            target: known ? numberFormat.format(target) : '–',
            swing: state.SwUpDn ?? 0,
            side: state.SwingLfRig ?? 0,
            speed: climateSpeed(state, device.caps),
            light: state.Lig !== 0,
        },
        color: on ? color : RESTING,
        big: known && on ? degrees(target) : on ? _('On') : _('Off'),
        small: [on && state.Mod !== null && state.Mod !== undefined ? climateStatus(state.Mod) : null, room]
            .filter(Boolean).join(' · ') || null,
        alarm: false,
    };
}

function mediaHero(device) {
    const state = device.state ?? {};
    const media = state.media;
    const playing = playingNow(device);
    const color = mediaColor(device);
    return {
        scene: 'speaker',
        state: {kind: speakerKind(device.castModel ?? device.model ?? ''), playing, volume: state.volume ?? 0, muted: state.muted, color},
        color,
        big: media?.title ?? state.app ?? _('Nothing playing'),
        small: [media?.artist, media?.title ? state.app : null].filter(Boolean).join(' · ') || null,
        alarm: false,
    };
}

function tvHero(device) {
    const state = device.state ?? {};
    const on = state.on === true;
    const showing = on ? tvShowing(device) : null;
    const [, color] = Glyphs.kindOf(null, null, 'tv');
    return {
        scene: 'tv',
        state: {
            on,
            volume: typeof state.volume === 'number' ? state.volume / (state.volumeMax || 100) : null,
            muted: state.muted === true,
            label: showing ?? '',
        },
        color: on ? color : RESTING,
        big: on ? showing ?? stateText(device) : stateText(device),
        // As the extension's card: the volume itself is in the card's controls.
        small: on ? (state.muted ? _('Muted') : state.media) || null : null,
        alarm: false,
    };
}

// {scene, state, color, big, small, alarm}. services and values: a Mi Home spec read, when there is one.
export function heroOf(device, services = [], values = new Map()) {
    const hero = kindHero(device, services, values);
    // Its last state isn't news once it stopped answering; the card says Offline.
    if (device.online === false && !heardOf(device)) {
        hero.big = null;
        hero.small = null;
    }
    return hero;
}

// A Home tile's second line: what the device is doing now, where stateText would only say On.
export function tileText(device) {
    if ((device.online !== true && !heardOf(device)) || ['media', 'camera'].includes(device.primary.kind))
        return stateText(device);
    const hero = heroOf(device);
    const props = device.primary.props ?? [];
    const find = name => {
        const index = props.findIndex(p => p.name === name);
        const value = device.values?.[index];
        return index >= 0 && value !== null && value !== undefined ? {prop: props[index], value} : null;
    };
    if (device.primary.kind === 'climate') {
        const {Pow, Mod, SetTem} = device.state ?? {};
        if (Pow !== 1)
            return stateText(device);
        return [Mod !== null && Mod !== undefined ? climateStatus(Mod) : null,
            typeof SetTem === 'number' ? degrees(SetTem) : null].filter(Boolean).join(' · ') || stateText(device);
    }
    switch (hero.scene) {
    case 'aircon':
        if (hero.state.on && typeof hero.state.target === 'number')
            return `${hero.big} · ${degrees(hero.state.target)}`;
        break;
    case 'light': {
        const brightness = find('brightness');
        return hero.state.on && brightness ? formatValue(brightness.prop, brightness.value) : stateText(device);
    }
    case 'plug': {
        const power = find('electric-power');
        return hero.state.on && power?.value > 0 ? formatValue(power.prop, power.value) : stateText(device);
    }
    case 'fan':
        if (hero.state.on && hero.small)
            return hero.small;
        break;
    case 'thermo': {
        const {humidity} = hero.state;
        if (hero.big && typeof humidity === 'number')
            return `${hero.big} · ${numberFormat.format(humidity)}%`;
        break;
    }
    case 'kettle':
        if (hero.big)
            return [hero.big, hero.small].filter(Boolean).join(' · ');
        break;
    case 'motion': {
        const time = device.times?.[props.findIndex(p => p.name === 'motion-state')];
        if (!hero.state.active && time)
            return _('Last seen %s').replace('%s', shortWhen(time));
        break;
    }
    }
    return hero.big ?? stateText(device);
}

function kindHero(device, services, values) {
    switch (device.primary?.kind) {
    case 'climate':
        return climateHero(device);
    case 'media':
        return mediaHero(device);
    case 'tv':
        return tvHero(device);
    }
    const [glyph, color] = Glyphs.kindOf(deviceType(device), device.primary?.props?.[0]?.service ?? null, device.model ?? '');
    const scene = deviceType(device) === 'gateway' ? 'gateway' : HERO_SCENES[glyph] ?? 'glyph';
    // Smoke detectors' type colour is red; keep red for an actual alarm.
    const calm = scene === 'smoke' ? [0.45, 0.5, 0.58] : color;
    const hero = {scene, state: {glyph}, color: calm, big: null, small: null, alarm: false};
    const props = device.primary?.props ?? [];
    const find = name => {
        const index = props.findIndex(p => p.name === name);
        if (index >= 0 && device.values?.[index] !== null && device.values?.[index] !== undefined)
            return {prop: props[index], value: device.values[index]};
        for (const service of services) {
            const prop = service.properties.find(p => p.name === name);
            const key = prop ? `${service.siid}/${prop.piid}` : null;
            if (key && values.has(key))
                return {prop, value: values.get(key)};
        }
        return null;
    };
    const live = device.live ?? {};
    const beacon = heardOf(device) ?? {};
    // Gateway values are hundredths, as strings; anything non-numeric is no reading.
    const hundredths = value => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) / 100 : null);

    switch (hero.scene) {
    case 'thermo': {
        let temperature = find('temperature')?.value ?? null;
        let humidity = find('relative-humidity')?.value ?? null;
        temperature = hundredths(live.temperature) ?? temperature;
        humidity = hundredths(live.humidity) ?? humidity;
        temperature = beacon.temperature ?? temperature;
        humidity = beacon.humidity ?? humidity;
        hero.state = {temperature, humidity};
        if (typeof temperature === 'number')
            hero.big = degrees(temperature);
        if (typeof humidity === 'number')
            hero.small = _('Humidity %s %').replace('%s', numberFormat.format(humidity));
        break;
    }
    case 'motion': {
        const motion = find('motion-state');
        const occupancy = find('occupancy-status');
        const presence = choiceOf(occupancy?.prop, occupancy?.value);
        const active = motion || !presence ? motion?.value === true : !/^\s*(no|un)/i.test(presence);
        hero.state = {active};
        hero.big = motion || !presence ? booleanText('motion-state', active) : choiceText(presence);
        const time = device.times?.[props.findIndex(p => p.name === 'motion-state')];
        if (time)
            hero.small = _('Last seen %s').replace('%s', whenText(time));
        break;
    }
    case 'door': {
        const closed = find('contact-state')?.value;
        if (typeof closed === 'boolean') {
            hero.state = {open: !closed};
            hero.big = booleanText('contact-state', closed);
            const time = device.times?.[props.findIndex(p => p.name === 'contact-state')];
            if (time)
                hero.small = _('Since %s').replace('%s', whenText(time));
        }
        break;
    }
    case 'leak': {
        const submersion = find('submersion-state')?.value;
        const told = live.status !== undefined || Boolean(device.lastEvent);
        const wet = live.status === 'leak' || (live.status === undefined && device.lastEvent?.key === 'leak') ||
            (!told && submersion === true);
        hero.state = {wet};
        hero.alarm = wet;
        hero.big = eventText(device) ?? (typeof submersion === 'boolean' ? booleanText('submersion-state', submersion) : null);
        break;
    }
    case 'smoke': {
        const said = ['smoke-status', 'gas-status'].map(name => find(name)).find(Boolean);
        const alarm = live.alarm !== undefined ? ['1', '2'].includes(String(live.alarm)) : said?.value === true;
        hero.state = {alarm};
        hero.alarm = alarm;
        hero.big = liveText(device);
        if (!hero.big && live.alarm === undefined && said) {
            if (said.prop.name === 'gas-status')
                hero.big = alarm ? _('Gas!') : _('No gas');
            else
                hero.big = alarm ? _('Smoke!') : _('No smoke');
        }
        const concentration = find('smoke-concentration');
        if (concentration && typeof concentration.value === 'number')
            hero.small = _('Smoke %s').replace('%s', formatValue(concentration.prop, concentration.value));
        break;
    }
    case 'fan': {
        const on = device.values?.[0] === true;
        const level = find('fan-level');
        hero.state = {on, level: typeof level?.value === 'number' ? level.value : 1};
        hero.big = on ? _('On') : _('Off');
        if (!on)
            hero.color = RESTING;
        const speed = choiceOf(level?.prop, level?.value);
        const wind = choiceOf(find('mode')?.prop, find('mode')?.value);
        const parts = [];
        if (speed)
            parts.push(/\d/.test(speed) ? _('Speed %s').replace('%s', speed.replace(/\D+/g, '')) : choiceText(speed));
        if (wind)
            parts.push(choiceText(wind));
        hero.small = parts.join(' · ') || null;
        break;
    }
    case 'kettle': {
        const water = find('temperature')?.value;
        const doing = choiceOf(find('status')?.prop, find('status')?.value) ?? '';
        let status = beacon.status;
        if (status === undefined && doing)
            status = /heat|boil/i.test(doing) ? 1 : /cool/i.test(doing) ? 2 : /warm|keep/i.test(doing) ? 3 : 0;
        const temperature = beacon.temperature ?? (typeof water === 'number' ? water : null);
        hero.state = {temperature, status: status ?? 0};
        if (temperature !== null)
            hero.big = degrees(temperature);
        if (status !== undefined)
            hero.small = kettleStatus(status);
        break;
    }
    case 'aircon': {
        const on = device.values?.[0] === true;
        const mode = find('mode');
        const description = choiceOf(mode?.prop, mode?.value);
        const target = find('target-temperature')?.value;
        const room = find('temperature')?.value;
        const known = typeof target === 'number';
        const look = climateLook(climateMode(description), known ? target : 24);
        const level = choiceOf(find('fan-level')?.prop, find('fan-level')?.value) ?? '';
        const step = Number(/\d+/.exec(level)?.[0]);
        hero.state = {
            on,
            ...look,
            target: known ? Math.round(target) : null,
            swing: find('vertical-swing')?.value === true || find('horizontal-swing')?.value === true ? 1 : 0,
            speed: /auto/i.test(level) || !step ? 1 : 0.6 + Math.min(step, 5) * 0.18,
            light: known,
        };
        hero.color = on ? look.color : RESTING;
        hero.big = on ? (description ? choiceText(description) : _('On')) : _('Off');
        hero.small = [
            known ? _('Set to %s').replace('%s', degrees(target)) : null,
            typeof room === 'number' ? _('Room %s°').replace('%s', numberFormat.format(room)) : null,
        ].filter(Boolean).join(' · ') || null;
        break;
    }
    case 'speaker': {
        const playing = /^\s*play/i.test(choiceOf(find('playing-state')?.prop, find('playing-state')?.value) ?? '');
        const volume = find('volume')?.value;
        const muted = find('mute')?.value === true;
        hero.state = {kind: speakerKind(device.model ?? ''), playing, muted, volume: typeof volume === 'number' ? volume / 100 : 0.5};
        hero.color = playing ? SPEAKER : SILENT;
        hero.big = playing ? _('Playing') : _('Nothing playing');
        if (typeof volume === 'number')
            hero.small = _('Volume %s %').replace('%s', volume);
        break;
    }
    case 'light': {
        const on = device.values?.[0] === true;
        const brightness = find('brightness')?.value;
        const kelvin = find('color-temperature')?.value;
        const rgb = find('color')?.value;
        const colored = typeof rgb === 'number' && rgb > 0 && rgb !== WHITE && !(kelvin > 0);
        let color = [1, 0.84, 0.55];
        if (typeof kelvin === 'number' && kelvin > 0)
            color = Scenes.kelvinColor(kelvin);
        else if (typeof rgb === 'number' && rgb > 0)
            color = rgbOf(rgb);
        hero.state = {on, color, brightness: typeof brightness === 'number' ? brightness : 100};
        hero.color = on ? Scenes.mix(color, [0.97, 0.66, 0.26], 0.2) : RESTING;
        hero.big = on ? _('On') : _('Off');
        if (on) {
            hero.small = [
                colored ? colorName(rgb) : null,
                typeof brightness === 'number' ? _('Brightness %s %').replace('%s', brightness) : null,
                typeof kelvin === 'number' && kelvin > 0 ? `${kelvin} K` : null,
            ].filter(Boolean).join(' · ') || null;
        }
        break;
    }
    case 'plug': {
        const on = device.values?.[0] === true;
        const power = find('electric-power');
        hero.state = {on, kind: glyph === 'rocker' ? 'switch' : 'outlet'};
        hero.color = on ? [0.24, 0.62, 0.46] : RESTING;
        // Never read: stateText says "Offline" or "…" rather than a made-up "Off".
        if (device.values)
            hero.big = on ? _('On') : _('Off');
        if (on && typeof power?.value === 'number')
            hero.small = _('Drawing %s').replace('%s', formatValue(power.prop, power.value));
        break;
    }
    case 'vacuum': {
        const status = find('status');
        const description = choiceOf(status?.prop, status?.value);
        hero.state = {mode: vacuumMode(description)};
        hero.alarm = hero.state.mode === 'error';
        hero.color = {
            cleaning: [0.3, 0.55, 0.98],
            charging: [0.3, 0.72, 0.5],
            returning: [0.96, 0.62, 0.26],
        }[hero.state.mode] ?? hero.color;
        if (description)
            hero.big = choiceText(description);
        const fault = find('fault');
        const trouble = fault && fault.value !== 0 ? faultText(device, fault.prop, fault.value) : null;
        if (trouble)
            hero.big = trouble;
        const battery = find('battery-level');
        if (typeof battery?.value === 'number')
            hero.small = _('Battery %s %').replace('%s', battery.value);
        if (battery?.value <= 15 && !['charging', 'returning', 'error'].includes(hero.state.mode)) {
            hero.small = _('Battery %s %, needs charging').replace('%s', battery.value);
            hero.color = [0.96, 0.62, 0.26];
        }
        break;
    }
    case 'fryer': {
        const status = find('status');
        const description = choiceOf(status?.prop, status?.value);
        const cooking = /^\s*(cooking|preheat)\s*$/i.test(description ?? '');
        const target = find('target-temperature')?.value;
        hero.state = {cooking, temperature: cooking && typeof target === 'number' ? target : null};
        if (!cooking)
            hero.color = RESTING;
        if (description)
            hero.big = choiceText(description);
        if (typeof target === 'number')
            hero.small = _('Set to %s').replace('%s', degrees(target));
        break;
    }
    case 'gateway': {
        const light = device.values?.[0] === true;
        const rgb = find('color')?.value;
        const brightness = find('brightness')?.value;
        const known = typeof rgb === 'number' && rgb > 0;
        hero.state = known ? {light, color: rgbOf(rgb)} : {light};
        hero.big = light ? _('Light on') : _('Light off');
        hero.color = light ? (known ? Scenes.mix(rgbOf(rgb), [0.97, 0.66, 0.26], 0.2) : [0.97, 0.62, 0.26]) : [0.45, 0.5, 0.58];
        if (light && known) {
            hero.small = [colorName(rgb),
                typeof brightness === 'number' ? _('Brightness %s %').replace('%s', brightness) : null].filter(Boolean).join(' · ');
        }
        break;
    }
    case 'repeater': {
        hero.state = {online: device.online !== false};
        const rssi = device.info?.ap?.rssi ?? device.about?.rssi;
        hero.big = device.info?.ap?.ssid ?? device.about?.ssid ?? null;
        if (rssi !== undefined && rssi !== null)
            hero.small = _('Signal %s dBm').replace('%s', rssi);
        break;
    }
    case 'button':
        hero.big = eventText(device);
        break;
    case 'washer':
    case 'dishwasher':
    case 'coffee':
    case 'cooker': {
        const status = find('status');
        const description = choiceOf(status?.prop, status?.value);
        const power = find('on')?.value;
        const working = statusWorking(description);
        hero.state = {working, cooking: working};
        if (!working)
            hero.color = RESTING;
        if (description)
            hero.big = choiceText(description);
        else if (typeof power === 'boolean')
            hero.big = power ? _('On') : _('Off');
        const left = find('left-time');
        if (working && typeof left?.value === 'number' && left.value > 0)
            hero.small = _('%s left').replace('%s', formatValue(left.prop, left.value));
        break;
    }
    case 'purifier': {
        const on = find('on')?.value === true;
        const pm = find('pm2.5-density');
        const level = find('fan-level')?.value;
        const filter = find('filter-life-level')?.value;
        const quality = typeof pm?.value === 'number' ? airQuality(pm.value) : null;
        hero.state = {on, level: typeof level === 'number' ? level : 1, color: quality ?? undefined};
        hero.color = on ? quality ?? hero.color : RESTING;
        hero.big = typeof pm?.value === 'number' ? formatValue(pm.prop, pm.value) : on ? _('On') : _('Off');
        hero.small = [typeof pm?.value === 'number' ? 'PM2.5' : null,
            typeof filter === 'number' ? _('Filter %s %').replace('%s', filter) : null].filter(Boolean).join(' · ') || null;
        break;
    }
    case 'humidifier':
    case 'dehumidifier': {
        const on = find('on')?.value === true;
        const humidity = find('relative-humidity')?.value;
        const target = find('target-humidity')?.value;
        const water = find('water-level');
        const most = water?.prop.range?.[1];
        hero.state = {on, water: typeof water?.value === 'number' && most ? water.value / most : null};
        if (!on)
            hero.color = RESTING;
        hero.big = typeof humidity === 'number' ? `${numberFormat.format(humidity)} %` : on ? _('On') : _('Off');
        if (typeof target === 'number')
            hero.small = _('Set to %s').replace('%s', `${target} %`);
        break;
    }
    case 'heater':
    case 'thermostat': {
        // Some thermostats have no power switch; treat them as on.
        const power = find('on')?.value;
        const on = typeof power === 'boolean' ? power : true;
        const target = find('target-temperature')?.value;
        const temperature = find('temperature')?.value ?? find('indoor-temperature')?.value;
        hero.state = {
            on,
            target: typeof target === 'number' ? target : null,
            temperature: typeof temperature === 'number' ? temperature : null,
        };
        if (!on)
            hero.color = RESTING;
        if (typeof temperature === 'number')
            hero.big = degrees(temperature);
        else if (typeof power === 'boolean')
            hero.big = on ? _('On') : _('Off');
        if (typeof target === 'number')
            hero.small = _('Set to %s').replace('%s', degrees(target));
        break;
    }
    case 'curtain': {
        const position = find('current-position') ?? find('target-position');
        const share = typeof position?.value === 'number' ? position.value / (position.prop.range?.[1] || 100) : null;
        hero.state = {position: share};
        if (share !== null && share >= 0.98)
            hero.big = _('Open');
        else if (share !== null && share <= 0.02)
            hero.big = _('Closed');
        else if (share !== null)
            hero.big = _('Open %s %').replace('%s', Math.round(share * 100));
        break;
    }
    case 'lock':
        // Most locks don't report their state to the cloud; show the last event.
        hero.state = {locked: null};
        hero.big = eventText(device);
        break;
    case 'fridge': {
        const part = name => {
            const service = services.find(s => s.name === name);
            const prop = service?.properties.find(p => p.name === 'target-temperature') ??
                service?.properties.find(p => p.name === 'temperature');
            const value = prop ? values.get(`${service.siid}/${prop.piid}`) : undefined;
            return typeof value === 'number' ? degrees(value) : null;
        };
        hero.state = {fridge: part('fridge-chamber'), freezer: part('freezer-chamber')};
        hero.big = hero.state.fridge;
        if (hero.state.freezer)
            hero.small = _('Freezer %s').replace('%s', hero.state.freezer);
        break;
    }
    case 'doorbell': {
        const last = device.lastEvent;
        hero.state = {ringing: Boolean(last?.time) && Date.now() / 1000 - last.time < 60};
        hero.big = eventText(device);
        break;
    }
    case 'plant': {
        const moisture = find('soil-moisture');
        hero.state = {moisture: typeof moisture?.value === 'number' ? moisture.value : null};
        if (typeof moisture?.value === 'number')
            hero.big = _('Soil %s %').replace('%s', moisture.value);
        hero.small = ['temperature', 'illumination'].map(find).filter(f => typeof f?.value === 'number')
            .map(f => formatValue(f.prop, f.value)).join(' · ') || null;
        break;
    }
    case 'water': {
        const tds = find('tds-out');
        hero.state = {tds: typeof tds?.value === 'number' ? tds.value : null};
        if (hero.state.tds !== null)
            hero.big = `${hero.state.tds} TDS`;
        break;
    }
    case 'scale': {
        const weight = find('weight');
        const text = weight ? formatValue(weight.prop, weight.value) : null;
        hero.state = {weight: text || null};
        if (text)
            hero.big = text;
        break;
    }
    case 'scooter': {
        const battery = find('ble-battery-level');
        if (typeof battery?.value === 'number')
            hero.big = `${battery.value} %`;
        break;
    }
    }
    hero.big ??= stateText(device);
    return hero;
}

// The card's colour: an alarm's red, a reading's own tint, grey while offline.
export function heroColor(device, hero) {
    if (device.online === false && !heardOf(device))
        return OFFLINE;
    return hero.alarm ? ALARM : Scenes.tint(hero.scene, hero.state) ?? hero.color;
}

// Off, closed, dry, quiet, docked, or with nothing to say but Online: nothing on a tile worth
// a look. A reading is never at rest.
export function atRest(hero) {
    if (hero.alarm)
        return false;
    return ['on', 'active', 'open', 'playing', 'light', 'working', 'cooking', 'ringing', 'wet', 'alarm']
        .some(key => hero.state[key] === false) ||
        ['idle', 'charging'].includes(hero.state.mode) || hero.scene === 'glyph' ||
        hero.color === RESTING || hero.color === SILENT;
}
