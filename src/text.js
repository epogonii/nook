// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import {gettext as _, pgettext} from 'gettext';

import {MODES} from './lib/climate.js';

// A subset of the extension's ui/text.js and ui/rows.js.

export const numberFormat = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});

// ONVIF cameras have no urn, and their model ('IPC-model') names no kind.
export const deviceType = device => device.urn?.split(':')[3] ?? (device.primary?.kind === 'camera' ? 'camera' : null);

// The device's own switch, for the power button; a socket's ring light is not it.
export function ownSwitch(device) {
    const [prop] = device.primary.props;
    return device.primary.kind === 'switch' && !(prop?.service === 'light' && deviceType(device) !== 'light');
}

// Mi Home has a Bluetooth device online only while a gateway relays it; nearby, the window
// hears its adverts instead. The last one per did, kept across device list reloads: a kettle
// advertises only every ~30 s.
export const beacons = new Map();

// Seconds. Older readings stay off tiles, where they'd look current.
const BEACON_FRESH = 10 * 60;

export const isBluetooth = device => String(device.did).startsWith('blt.');

export function heardOf(device) {
    const beacon = beacons.get(device.did);
    return beacon && Date.now() / 1000 - beacon.time < BEACON_FRESH ? beacon : null;
}

export function kettleStatus(status) {
    return [_('Idle'), _('Heating'), _('Cooling down'), _('Keeping warm')][status] ?? null;
}

function beaconText(beacon) {
    const parts = [];
    if (beacon.temperature !== undefined)
        parts.push(`${numberFormat.format(beacon.temperature)} °C`);
    if (beacon.humidity !== undefined)
        parts.push(`${numberFormat.format(beacon.humidity)} %`);
    if (beacon.status > 0 && kettleStatus(beacon.status))
        parts.push(kettleStatus(beacon.status));
    return parts.join(' · ') || null;
}

let units = null;

function unitText(unit) {
    units ??= {
        celsius: '°C',
        percentage: '%',
        lux: pgettext('unit', 'lx'),
        ppm: 'ppm',
        arcdegrees: '°',
        kelvin: 'K',
        watt: pgettext('unit', 'W'),
        volt: pgettext('unit', 'V'),
        ampere: pgettext('unit', 'A'),
        kWh: pgettext('unit', 'kWh'),
        pascal: pgettext('unit', 'Pa'),
    };
    return units[unit];
}

export function booleanText(name, value) {
    switch (name) {
    case 'contact-state':
        return value ? _('Closed') : _('Open');
    case 'motion-state':
        return value ? _('Motion') : _('No motion');
    case 'submersion-state':
        return value ? _('Leak') : _('Dry');
    case 'smoke-status':
        return value ? _('Smoke!') : _('No smoke');
    case 'gas-status':
        return value ? _('Gas!') : _('No gas');
    default:
        return value ? _('On') : _('Off');
    }
}

// Common spec words get translated, anything else is shown as is. Tables are built on
// first use, once translations are loaded; keys go through specKey().
export const specKey = text => String(text).trim().toLowerCase().replace(/[\s_]+/g, '-');

let choiceWords = null;

export function choiceText(description) {
    choiceWords ??= {
        'off': _('Off'),
        'on': _('On'),
        'idle': _('Idle'),
        'sweeping': _('Cleaning'),
        'cleaning': _('Cleaning'),
        'paused': _('Paused'),
        'error': _('Error'),
        'fault': _('Error'),
        'charging': _('Charging'),
        'not-charging': _('Not charging'),
        'go-charging': _('Returning to dock'),
        'charging-completed': _('Charged'),
        'busy': _('Busy'),
        'open': _('Open'),
        'close': _('Closed'),
        'closed': _('Closed'),
        'auto': _('Auto'),
        'sleep': _('Sleep'),
        'favorite': _('Favourite'),
        'low': _('Low'),
        'middle': _('Medium'),
        'medium': _('Medium'),
        'high': _('High'),
        'normal': _('Normal'),
        'ultralow': _('Very low'),
        'cool': _('Cool'),
        'heat': _('Heat'),
        'dry': pgettext('mode', 'Dry'),
        'fan': pgettext('mode', 'Fan'),
        'left': _('Left'),
        'right': _('Right'),
        'none': _('None'),
        'null': _('None'),
        'no-faults': _('No faults'),
        'straight-wind': _('Straight wind'),
        'natural-wind': _('Natural wind'),
        // Dreame suction levels; their spec has only these Chinese descriptions.
        '安静': _('Quiet'),
        '标准': _('Standard'),
        '中档': _('Medium'),
        '强力': _('Turbo'),
        'quiet': _('Quiet'),
        'standard': _('Standard'),
        'strong': _('Turbo'),
        'turbo': _('Turbo'),
        'delay': _('Waiting to start'),
        'cooking': _('Cooking'),
        'preheat': _('Preheating'),
        'cooking-completed': _('Done'),
        'preheat-completed': _('Preheated'),
        'preheat-paused': _('Preheat paused'),
        'turn-pot-paused': _('Paused to turn the food'),
        'keep-warm': _('Keeping warm'),
        'keep-warm-paused': _('Keeping warm, paused'),
        'keep-warm-completed': _('Kept warm'),
        'crispy-roast': _('Crispy roast'),
        'tender-roast': _('Tender roast'),
        'degrease': _('Less fat'),
        'ntc-disconnect': _('Sensor disconnected'),
        'ntc-short-circuit': _('Sensor short circuit'),
        'ntc-failure': _('Sensor failure'),
        'french-fries': _('French fries'),
        'chicken-wing': _('Chicken wings'),
        'steak': _('Steak'),
        'lamb-chops': _('Lamb chops'),
        'fish': _('Fish'),
        'shrimp': _('Shrimp'),
        'vegetables': _('Vegetables'),
        'cake': _('Cake'),
        'pizza': _('Pizza'),
        'defrost': _('Defrost'),
        'dried-fruit': _('Dried fruit'),
        'yogurt': _('Yoghurt'),
        'manual': _('Manual'),
        'no-need-turn-over-pot': _('No need to turn'),
        'need-turn-over-pot': _('Turn the food'),
        'one-layer': _('One layer'),
        'double-layer': _('Two layers'),
        'half-pot': _('Half a basket'),
        'full-pot': _('Full basket'),
        'kilogram': _('Kilograms'),
        'pound': _('Pounds'),
        'battery-enough': _('Battery fine'),
        'battery-low': _('Battery low'),
        'battery-ultra-low': _('Battery very low'),
        'white': _('White'),
        'red': _('Red'),
        'orange': _('Orange'),
        'yellow': _('Yellow'),
        'green': _('Green'),
        'cyan': _('Cyan'),
        'blue': _('Blue'),
        'purple': _('Purple'),
        'pink': _('Pink'),
        'heat-and-cool': _('Heat and cool'),
        'opening': _('Opening'),
        'closing': _('Closing'),
        'stopped': _('Stopped'),
        'locked': _('Locked'),
        'unlocked': _('Unlocked'),
        'locking': _('Locking'),
        'unlocking': _('Unlocking'),
        'jammed': _('Jammed'),
        'playing': _('Playing'),
        'standby': _('Standby'),
        'buffering': _('Buffering'),
        'humidify': _('Humidify'),
        'dehumidify': _('Dehumidify'),
        'excellent': _('Excellent'),
        'good': _('Good'),
        'fair': _('Fair'),
        'inferior': _('Inferior'),
        'poor': _('Poor'),
        'eco': _('Eco'),
        'smart': _('Smart'),
        'mid': _('Medium'),
    };
    const key = specKey(description);
    const level = /^(level|gear)-?(\d+)$/.exec(key);
    if (level)
        return _('Level %s').replace('%s', level[2]);
    const minutes = /^(\d+)-minutes?$/.exec(key);
    if (minutes)
        return _('%s min').replace('%s', minutes[1]);
    return choiceWords[key] ?? String(description).trim();
}

const WORKING = /cook|clean|sweep|mop|work|run|heat|bake|fry|boil|brew|busy|wash|rinse|spin|drying|grind/i;
// Overrides WORKING: "Cooking completed", "Preheat paused".
const NOT_WORKING = /complete|pause|finish|done|stop|wait|fault|error|charg/i;

export function statusWorking(description) {
    return Boolean(description) && WORKING.test(description) && !NOT_WORKING.test(description);
}

export function modeText(mode) {
    switch (MODES[mode]) {
    case 'auto':
        return _('Auto');
    case 'cool':
        return _('Cool');
    case 'dry':
        return pgettext('mode', 'Dry');
    case 'fan':
        return pgettext('mode', 'Fan');
    case 'heat':
        return _('Heat');
    default:
        return '';
    }
}

export function whenText(seconds) {
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const now = GLib.DateTime.new_now_local();
    const day = d => d.format('%Y-%m-%d');
    if (day(then) === day(now))
        return _('today, %s').replace('%s', then.format('%H:%M'));
    if (day(then) === day(now.add_days(-1)))
        return _('yesterday, %s').replace('%s', then.format('%H:%M'));
    return then.format('%e %b, %H:%M').trim();
}

export function spanText(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (days > 0)
        return _('%s d %s h').replace('%s', days).replace('%s', hours);
    if (hours > 0)
        return _('%s h %s min').replace('%s', hours).replace('%s', minutes);
    return _('%s min').replace('%s', minutes);
}

export function macText(mac) {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '');
    return hex.length === 12 ? hex.toUpperCase().match(/../g).join(':') : String(mac).toUpperCase();
}

export function plainString(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16))).trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text))
        return text.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
    return text.length <= 24 && /^\p{L}[\p{L}\p{M} '/._-]*$/u.test(text) ? text : null;
}

export function formatValue(prop, value) {
    if (value === null || value === undefined)
        return '';
    const choice = prop.choices?.find(c => c.value === value);
    if (choice)
        return choiceText(choice.description);
    if (typeof value === 'boolean')
        return booleanText(prop.name, value);
    if (typeof value !== 'number')
        return String(value);
    if (prop.unit === 'celsius')
        return `${numberFormat.format(value)}°`;
    const number = numberFormat.format(value);
    const unit = unitText(prop.unit);
    if (!unit)
        return number;
    return unit === '%' ? `${number}%` : `${number} ${unit}`;
}

const playing = device => ['PLAYING', 'BUFFERING'].includes(device.state?.media?.state);

// Lit on the page: switched on, running or playing.
export function isOn(device) {
    switch (device.primary.kind) {
    case 'switch':
        return device.values?.[0] === true;
    case 'climate':
        return device.state?.Pow === 1;
    case 'media':
        return playing(device);
    case 'tv':
        return device.state?.on === true;
    default:
        return false;
    }
}

export function stateText(device) {
    const {primary, values, online} = device;
    const heard = heardOf(device);
    const said = heard && beaconText(heard);
    if (said)
        return said;
    if (online === null || online === undefined)
        return '…';
    if (!online)
        return isBluetooth(device) ? _('Bluetooth') : _('Offline');
    switch (primary.kind) {
    case 'camera':
        return _('Online');
    case 'climate':
        return device.state?.Pow === 1 ? `${_('On')} · ${numberFormat.format(device.state.SetTem)}°` : _('Off');
    case 'media':
        if (playing(device))
            return device.state.media?.title ?? _('Playing');
        return device.state?.media?.state === 'PAUSED' ? _('Paused') : device.state?.app ?? _('Idle');
    case 'tv':
        if (!device.state?.paired)
            return _('Not paired');
        if (!device.state.on)
            return _('Off');
        return device.state.muted ? _('Muted') : _('On');
    case 'switch':
        if (!values)
            return '…';
        return values[0] === true ? _('On') : _('Off');
    case 'none':
        return _('Online');
    }
    const parts = primary.props.map((p, i) => formatValue(p, values?.[i])).filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : _('Online');
}
