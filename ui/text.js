// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {MODES} from '../lib/climate.js';
import {SonoffError} from './errors.js';

export const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);

// St.BoxLayout gained "orientation" in GNOME 48; earlier versions use "vertical: true".
export const VERTICAL = SHELL_MAJOR >= 48
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

// GNOME 51 renamed St.ButtonMask.ONE and THREE, and the old names log a warning there.
export const PRIMARY_SECONDARY = (St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE) |
    (St.ButtonMask.SECONDARY ?? St.ButtonMask.THREE);

const DEFAULTS = {
    'view': 'tabs',
    'type-colors': true,
    'scenes-compact': false,
    'scenes-folded': false,
    'login-lights': [],
    'notify-lights': [],
    'notify-color': 0x3584e4,
    'notify-apps': [],
    'shelly-devices': '[]',
    'room': '',
    'sort-by-name': false,
    'switcher-style': 'bar',
    'switcher-auto': true,
    'switcher-tabs': ['scenes', 'lights', 'cameras'],
    'panel-sensors': [],
    'panel-interval': 5,
    'pinned': [],
    'order': [],
    'hidden': [],
    'names': {},
    'icons': {},
    'extra-tiles': [],
    'groups': {},
    'gree-units': '[]',
    'aircons': '[]',
    'tapo-cameras': '[]',
    'cast-speakers': '[]',
    'tvs': '[]',
    'sonoff-switches': '[]',
    'ewelink-devices': '[]',
    'ewelink-region': '',
    'hue-bridges': '[]',
    'hue-devices': '[]',
    'hass-server': '',
    'hass-devices': '[]',
    'homekit-accessories': '[]',
    'smartlife-user': '',
    'smartlife-devices': '[]',
    'lg-devices': '[]',
    'smartthings-devices': '[]',
    'melcloud-devices': '[]',
    'electrolux-devices': '[]',
    'hidden-rooms': [],
    'alerts': {},
    'sensor-rules': '{}',
    'location': 'panel',
    'panel-box': 'right',
    'panel-index': 0,
    'middle-click': 'none',
    'hover-switch': false,
};

// Logical px; WrapLayout isn't styled, so callers multiply by the scale factor.
export const CHIP_SPACING = 6;

let units = null;

function unitText(unit) {
    units ??= {
        celsius: '°C',
        percentage: '%',
        lux: pgettext('unit', 'lx'),
        ppm: 'ppm',
        seconds: pgettext('unit', 's'),
        minutes: pgettext('unit', 'min'),
        hours: pgettext('unit', 'h'),
        days: pgettext('unit', 'd'),
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

export const numberFormat = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});

export function readSetting(settings, key) {
    if (!settings?.settings_schema?.has_key(key))
        return DEFAULTS[key];

    try {
        return settings.get_value(key).deepUnpack();
    } catch (e) {
        console.debug(`nook: ${key}: ${e.message}`);
        return DEFAULTS[key];
    }
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

export function formatValue(prop, value) {
    if (value === null || value === undefined)
        return '';
    const choice = prop.choices?.find(c => c.value === value);
    if (choice)
        return choiceText(choice.description);
    if (typeof value === 'boolean')
        return booleanText(prop.name, value);
    if (typeof value === 'string')
        return plainString(value) ?? value;
    if (typeof value !== 'number')
        return String(value);

    const number = numberFormat.format(value);
    const unit = unitText(prop.unit) ?? prop.suffix;
    if (!unit)
        return number;
    return unit === '%' ? `${number}%` : `${number} ${unit}`;
}

export function plainString(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16))).trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text))
        return text.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
    return text.length <= 24 && /^\p{L}[\p{L}\p{M} '/._-]*$/u.test(text) ? text : null;
}

// ONVIF cameras have no urn, and their model ('IPC-model') names no kind.
export const deviceType = device => device.urn?.split(':')[3] ?? (device.primary?.kind === 'camera' ? 'camera' : null);

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

export function volumeIcon(level, muted) {
    if (muted || level === 0)
        return 'audio-volume-muted-symbolic';
    if (level < 0.34)
        return 'audio-volume-low-symbolic';
    return level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
}

export function sonoffTrouble(e) {
    if (e instanceof SonoffError)
        return e.code === 401 ? _('The switch is not in DIY mode.') : _('The switch did not take the command.');
    if (e instanceof GLib.Error)
        return _('The switch is not answering. Is it on and on this network?');
    return e.message;
}

// SpecError codes in words; the rest as the device or service put it.
export function specTrouble(e) {
    switch (e.code) {
    case 'busy':
        return _('The device is busy. Try again in a moment.');
    case 'unreachable':
        return _('The accessory cannot be reached.');
    case 'refused':
        return _('The device refused it.');
    case 'broken':
        return _('The device sent an answer Nook cannot read.');
    case 'unsupported':
        return _('The device cannot do that.');
    case 'tls':
        return _('The certificate of this Home Assistant is not trusted. Use its http:// address on this network, or give it a trusted certificate.');
    case 'unpaired':
        return _('The device no longer knows Nook. Pair it again.');
    case 'certificate':
        return _('The bridge answered with another certificate. Pair it again if it was replaced.');
    case 'unauthorized':
        return _('Home Assistant refused the access token.');
    case 'expired':
        return e.label ? _('The %s login has expired.').replace('%s', e.label) : _('The Smart Life login has expired.');
    case 'timeout':
        return _('The device did not answer in time.');
    case 'closed':
        return _('The connection closed. Try again.');
    case 'gone':
        return _('This scene is no longer in Mi Home.');
    default:
        return e.message;
    }
}

export function tvTrouble(e) {
    if (e.code === 'unpaired')
        return _('Pair it in Settings, under TVs, to control it from here.');
    if (e.code === 'denied')
        return _('The TV did not let Nook in.');
    if (e.code === 'asleep')
        return _('The TV did not wake up. Turn on network standby (Powered On by Apps) in its network settings.');
    if (e instanceof GLib.Error || ['timeout', 'closed'].includes(e.code))
        return _('The TV is not answering. Is it on the same network?');
    return e.message;
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

export function clearWords() {
    units = null;
    choiceWords = null;
}
