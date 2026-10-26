// SPDX-License-Identifier: GPL-2.0-or-later

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Scenes from '../lib/scenes.js';
import {MODES} from '../lib/aircon-home.js';
import {choiceText, modeText} from './text.js';

// The colour scale; a unit's own range is in its caps.
const CLIMATE_MIN = 16;
const CLIMATE_MAX = 30;

export const COOL = [0.21, 0.52, 0.89];
export const WARM = [0.96, 0.55, 0.23];
const TEAL = [0.22, 0.66, 0.62];
const ICE = [0.14, 0.42, 0.98];
const MILD = [0.3, 0.6, 0.84];
const AMBER = [0.97, 0.64, 0.24];
const EMBER = [0.93, 0.34, 0.2];
const VIOLET = [0.56, 0.44, 0.88];
const SAND = [0.78, 0.66, 0.42];

export const CLIMATE_TOGGLES = () => [
    ['SvSt', _('Eco'), 'leaf'],
    ['SwhSlp', _('Sleep'), 'moon'],
    ['Tur', _('Turbo'), 'bolt'],
    ['Quiet', _('Quiet'), 'quiet'],
    ['Lig', _('Display'), 'bulb'],
    ['Health', _('Ionizer'), 'purifier'],
    ['Blo', _('X-Fan'), 'fan'],
    ['StHt', _('8° heat'), 'heater'],
    ['Air', _('Fresh air'), 'wind'],
];

// Quiet stays 1: greeclimate sends 2, which firmware 3.75 ignores.
export const climateToggle = (state, key) => ({[key]: state[key] ? 0 : 1});

export const MODE_GLYPHS = {auto: 'auto', cool: 'snowflake', dry: 'drop', fan: 'fan', heat: 'sun'};

export const CLIMATE_MODES = caps => caps.modes.map(i => [i, modeText(i), MODE_GLYPHS[MODES[i]]]);

let fanWords = null;

// [label, value text] of a fan speed; numbered ones count among the unit's own steps.
export function fanText(fan, caps) {
    fanWords ??= {
        auto: _('Auto'),
        quiet: _('Quiet'),
        low: _('Low'),
        medium: _('Medium'),
        high: _('High'),
        max: _('Max'),
        turbo: _('Turbo'),
    };
    if (fan.word)
        return [fanWords[fan.word] ?? fan.word, fanWords[fan.word] ?? fan.word];
    if (fan.label)
        return [choiceText(fan.label), choiceText(fan.label)];
    const steps = caps.fans.filter(f => !f.word && !f.label);
    const n = String(steps.indexOf(fan) + 1);
    return [n, `${n} / ${steps.length}`];
}

const fanGlyph = fan => (fan?.level >= 1 && fan.level <= 5 ? `speed${fan.level}` : 'auto');

export const CLIMATE_FANS = caps => caps.fans.map(fan => [fan.value, fanText(fan, caps)[0], fanGlyph(fan)]);

const swingChoice = (value, swing, prefix) => {
    if (value === 1)
        return [1, _('Swing'), swing];
    if (value >= 2 && value <= 6)
        return [value, String(value - 1), `${prefix}${value - 1}`];
    return [0, _('Off'), `${prefix}0`];
};

export const CLIMATE_AIRFLOWS = caps => caps.airflows.map(v => swingChoice(v, 'flow-swing', 'flow'));

export const CLIMATE_SIDES = caps => caps.sides.map(v => swingChoice(v, 'side-swing', 'side'));

// Swing or off is a switch, not a choice.
export const swingsOnly = choices => choices.length === 2 && choices.every(([v]) => v === 0 || v === 1);

// The card's view of an air conditioner: native units carry state and caps, a spec one
// gets them from its services (_readClimate).
export const climateView = device => (device.primary.kind === 'climate'
    ? device.state && {state: device.state, caps: device.caps}
    : device.climate ?? null);

export function climateLook(mode, temperature) {
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

export function climateMode(description) {
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

export function climateStatus(mode) {
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

// SwUpDn 7-11 are partial swings; shown as Swing.
export const airflowChoice = value => (value >= 7 ? 1 : value);

export function climateSpeed(state, caps) {
    if (state.Tur)
        return 1.8;
    if (state.Quiet)
        return 0.55;
    const level = caps.fans.find(f => f.value === state.WdSpd)?.level ?? 0;
    return level > 0 ? 0.6 + level * 0.18 : 1;
}

export function clearFanWords() {
    fanWords = null;
}
