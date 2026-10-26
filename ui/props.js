// SPDX-License-Identifier: GPL-2.0-or-later

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {humanize} from './humanize.js';
import {plainString} from './text.js';

// Destructive actions are left off cards: too easy to hit by a stray click in a menu.
export const RISKY_ACTION = /^(reset|del|delete)-/;

export const PLUMBING = ['user-management', 'offline-data', 'sync-info', 'cancel-share', 'customized-service-for-ble',
    'device-information', 'ota'];

export const MAIN_RANGES = ['brightness', 'target-temperature', 'target-humidity', 'fan-percent', 'target-position', 'volume'];

export const PROP_GLYPHS = {
    'on': 'power',
    'mode': 'auto',
    'fan-level': 'fan',
    'speed-level': 'fan',
    'fan-percent': 'fan',
    'speed': 'fan',
    'horizontal-swing': 'swing',
    'vertical-swing': 'swing',
    'swing': 'swing',
    'horizontal-angle': 'swing',
    'brightness': 'sun',
    'color-temperature': 'bulb',
    'color': 'bulb',
    'temperature': 'thermometer',
    'target-temperature': 'thermometer',
    'indoor-temperature': 'thermometer',
    'relative-humidity': 'drop',
    'target-humidity': 'drop',
    'water-level': 'drop',
    'physical-controls-locked': 'lock',
    'child-lock': 'lock',
    'alarm': 'bell',
    'fault': 'bell',
    'volume': 'speaker',
    'mute': 'quiet',
    'battery-level': 'bolt',
    'charging-state': 'bolt',
    'electric-power': 'bolt',
    'electric-current': 'bolt',
    'voltage': 'bolt',
    'power-consumption': 'bolt',
    'off-delay-time': 'clock',
    'left-time': 'clock',
    'countdown-time': 'clock',
    'target-time': 'clock',
    'reservation-left-time': 'clock',
    'filter-life-level': 'leaf',
    'filter-left-time': 'leaf',
    'pm2.5-density': 'leaf',
    'pm10-density': 'leaf',
    'soil-moisture': 'drop',
    'tds-out': 'filter',
    'current-position': 'curtain',
    'target-position': 'curtain',
    'spin-speed': 'washer',
    'co2-density': 'leaf',
    'tvoc-density': 'leaf',
    'air-quality': 'leaf',
    'anion': 'leaf',
    'eco': 'leaf',
    'illumination': 'sun',
    'guard-mode': 'shield',
    'sleep-mode': 'moon',
    'no-disturb': 'moon',
    'heater': 'sun',
    'preheat': 'sun',
    'auto-keep-warm': 'pot',
};
export const SERVICE_GLYPHS = {
    'indicator-light': 'bulb',
    'light': 'bulb',
    'alarm': 'bell',
    'physical-controls-locked': 'lock',
    'battery': 'bolt',
    'filter': 'leaf',
    'environment': 'thermometer',
    'screen': 'sun',
    'audio': 'speaker',
    'motor-controller': 'swing',
    'annoy': 'moon',
    'timer': 'clock',
};

export const IN_HERO = {
    repeater: ['network', 'signal'],
    thermo: ['temperature', 'humidity', 'relative-humidity'],
    kettle: ['temperature', 'status'],
    smoke: ['alarm', 'smoke-concentration'],
    plug: ['electric-power'],
    vacuum: ['status', 'battery-level', 'fault'],
    fryer: ['status'],
    scooter: ['ble-battery-level'],
    washer: ['status', 'left-time'],
    dishwasher: ['status', 'left-time'],
    coffee: ['status', 'left-time'],
    cooker: ['status', 'left-time'],
    purifier: ['pm2.5-density', 'filter-life-level'],
    humidifier: ['relative-humidity'],
    dehumidifier: ['relative-humidity'],
    heater: ['temperature'],
    thermostat: ['temperature'],
    curtain: ['current-position'],
    plant: ['soil-moisture', 'temperature', 'illumination'],
    water: ['tds-out'],
};

export function specTitle(service, prop, type) {
    if (prop.name === 'on' && service.name !== type)
        return humanize(service.name);
    return humanize(prop.name);
}

export function choiceGlyph(description, fallback) {
    const text = description ?? '';
    if (/auto|smart/i.test(text))
        return 'auto';
    if (/sleep|night|silent/i.test(text))
        return 'moon';
    if (/natur|eco|energy|sav/i.test(text))
        return 'leaf';
    if (/strong|turbo|boost|max|high/i.test(text))
        return 'bolt';
    if (/quiet|low|mute/i.test(text))
        return 'quiet';
    if (/cool|cold/i.test(text))
        return 'snowflake';
    if (/heat|warm|hot/i.test(text))
        return 'sun';
    if (/dry/i.test(text))
        return 'drop';
    if (/fan|wind/i.test(text))
        return 'wind';
    return fallback;
}

export function actionIcon(name) {
    if (/pause/.test(name))
        return 'media-playback-pause-symbolic';
    if (/stop|cancel|end/.test(name))
        return 'media-playback-stop-symbolic';
    if (/toggle/.test(name))
        return 'system-shutdown-symbolic';
    if (/charge|home|dock|back/.test(name))
        return 'go-home-symbolic';
    if (/find|locate|identify/.test(name))
        return 'find-location-symbolic';
    if (/^open/.test(name))
        return 'go-up-symbolic';
    if (/^close/.test(name))
        return 'go-down-symbolic';
    if (/^lock/.test(name))
        return 'changes-prevent-symbolic';
    if (/^next/.test(name))
        return 'media-skip-forward-symbolic';
    return 'media-playback-start-symbolic';
}

// Hidden: firmware-internal strings (recipe codes, sync lists, map keys), status numbers
// the spec gives no meaning, and unanswered values, which would show as off or zero.
export function worthShowing(prop, value, answered) {
    if (!prop.access.includes('read') && !prop.access.includes('write'))
        return false;
    if (prop.access.includes('read') && !answered)
        return false;
    if (prop.format === 'string')
        return plainString(value) !== null;
    if (prop.name === 'status' && !(prop.choices?.length > 0))
        return false;
    if (prop.name === 'fault' && !value)
        return false;
    return !prop.choices?.length || prop.access.includes('write') || prop.choices.some(c => c.value === value);
}

// Zigbee sensor history: [history key, spec property, label, unit, raw divisor, colour].
const HISTORY_KEYS = () => [
    ['temperature', 'temperature', _('Temperature'), '°C', 100, [0.95, 0.47, 0.35]],
    ['humidity', 'relative-humidity', _('Humidity'), '%', 100, [0.3, 0.62, 0.95]],
    ['pressure', 'atmospheric-pressure', _('Pressure'), 'hPa', 100, [0.6, 0.48, 0.88]],
];
export const HISTORY_SPAN = 24 * 3600;

export function historyKeys(device) {
    if (!device.did.startsWith('lumi.'))
        return [];
    return HISTORY_KEYS().filter(([, prop]) => device.primary.props.some(p => p.name === prop));
}
