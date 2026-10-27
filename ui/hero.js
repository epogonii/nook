// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Glyphs from '../lib/glyphs.js';
import * as Scenes from '../lib/scenes.js';
import {WHITE} from '../lib/spec-home.js';
import {climateLook, climateMode} from './climate.js';
import {colorName, rgbOf} from './color.js';
import {whenText} from './events.js';
import {BEACON_FRESH, beaconOf, eventText, kettleStatus, liveText, onlyStops, playingNow, stateText} from './rows.js';
import {booleanText, choiceText, deviceType, formatValue, numberFormat, statusWorking} from './text.js';
import {CardSlider} from './widgets.js';

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

export const ALARM = [0.9, 0.3, 0.3];
const RESTING = [0.52, 0.52, 0.57];

const APP_COLORS = [
    [/spotify/i, [0.12, 0.73, 0.33]],
    [/youtube/i, [0.9, 0.22, 0.2]],
    [/apple/i, [0.98, 0.3, 0.42]],
    [/deezer/i, [0.64, 0.3, 0.95]],
];
const SPEAKER = [0.66, 0.46, 0.95];
const SILENT = [0.4, 0.44, 0.52];

export function castToggle(home, device) {
    if (onlyStops(device))
        return home.stop(device);
    return playingNow(device) ? home.pause(device) : home.play(device);
}

export function showCastPlay(button, device) {
    let look = ['media-playback-start-symbolic', _('Play')];
    if (onlyStops(device))
        look = ['media-playback-stop-symbolic', _('Stop')];
    else if (playingNow(device))
        look = ['media-playback-pause-symbolic', _('Pause')];
    [button.child.icon_name, button.accessible_name] = look;
    button.reactive = Boolean(device.state?.media) || onlyStops(device);
}

// Cast supportedMediaCommands bits: 64 next, 128 previous. A media status
// without the field allows everything.
export function castAllows(media, bit) {
    return Boolean(media) && (typeof media.commands !== 'number' || (media.commands & bit) !== 0);
}

export function mediaColor(device) {
    const app = device.state?.app ?? '';
    if (!app && !playingNow(device))
        return SILENT;
    return APP_COLORS.find(([pattern]) => pattern.test(app))?.[1] ?? SPEAKER;
}

export function speakerKind(model) {
    if (/group/i.test(model))
        return 'group';
    if (/mini|l05|lx01/i.test(model))
        return 'puck';
    if (/hub|display|tv|chromecast|lx04|x08|x10/i.test(model))
        return 'display';
    return 'tower';
}

export function freeze(actor) {
    if (actor instanceof St.Button || actor instanceof CardSlider) {
        actor.reactive = false;
        actor.can_focus = false;
    }
    for (const child of actor.get_children())
        freeze(child);
}

// Never ellipsized: the label may be allocated less than the room it really has.
export function wordLabel(text) {
    const label = new St.Label({style_class: 'nook-vacuum-word', text, x_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
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

export function heroOf(device, services, values) {
    const [glyph, color] = Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model);
    const scene = deviceType(device) === 'gateway' ? 'gateway' : HERO_SCENES[glyph] ?? 'glyph';
    // Smoke detectors' type colour is red; keep red for an actual alarm.
    const calm = scene === 'smoke' ? [0.45, 0.5, 0.58] : color;
    const hero = {scene, state: {glyph}, color: calm, big: null, small: null, alarm: false};
    const find = name => {
        const index = device.primary.props.findIndex(p => p.name === name);
        if (index >= 0 && device.values?.[index] !== null && device.values?.[index] !== undefined)
            return {prop: device.primary.props[index], value: device.values[index]};
        for (const service of services) {
            const prop = service.properties.find(p => p.name === name);
            const key = prop ? `${service.siid}/${prop.piid}` : null;
            if (key && values.has(key))
                return {prop, value: values.get(key)};
        }
        return null;
    };
    const live = device.live ?? {};
    const heard = beaconOf(device);
    const beacon = heard && Date.now() / 1000 - heard.time < BEACON_FRESH ? heard : {};
    const degrees = value => `${numberFormat.format(value)}°`;
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
        const time = device.times?.[device.primary.props.findIndex(p => p.name === 'motion-state')];
        if (time)
            hero.small = _('Last seen %s').replace('%s', whenText(time));
        break;
    }
    case 'door': {
        const closed = find('contact-state')?.value;
        if (typeof closed === 'boolean') {
            hero.state = {open: !closed};
            hero.big = booleanText('contact-state', closed);
            const time = device.times?.[device.primary.props.findIndex(p => p.name === 'contact-state')];
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
        hero.state = {kind: speakerKind(device.model), playing, muted, volume: typeof volume === 'number' ? volume / 100 : 0.5};
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
