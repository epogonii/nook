// SPDX-License-Identifier: GPL-2.0-or-later

// What the climate card shows of an air conditioner, whatever the maker. The names are
// Gree's, the first one Nook drove:
//   Pow 0/1, Mod an index into MODES, SetTem °C, roomTemperature °C or null;
//   WdSpd one of caps.fans' values;
//   SwUpDn and SwingLfRig 1 swing, 2-6 fixed from top or left, 0 off or left to the unit;
//   SvSt eco, SwhSlp sleep, Tur turbo, Quiet, Lig display, Health ionizer, Blo X-fan,
//   StHt 8° heat, Air fresh air: 0/1, absent where the unit has no such thing.
// caps: {range: [min, max, step], modes: [MODES index...], fans: [{value, word, level}...],
//   airflows: [SwUpDn value...], sides: [SwingLfRig value...]}. A fan's word is one of
//   FAN_WORDS, or null for a numbered level; level is 0 for auto, else 1-5 slow to fast.

export const MODES = ['auto', 'cool', 'dry', 'fan', 'heat'];

export const FAN_WORDS = ['auto', 'quiet', 'low', 'medium', 'high', 'max', 'turbo'];

export class ClimateError extends Error {
    constructor(message, code = '') {
        super(message);
        this.name = 'ClimateError';
        this.code = code;
    }
}

export const numbered = levels => levels.map(level => ({value: level, word: null, level}));

export const GREE_CAPS = {
    range: [16, 30, 1],
    modes: [0, 1, 2, 3, 4],
    fans: [{value: 0, word: 'auto', level: 0}, ...numbered([1, 2, 3, 4, 5])],
    airflows: [1, 2, 3, 4, 5, 6, 0],
    sides: [1, 2, 3, 4, 5, 6, 0],
};

// Nearest step within the range: the card and every maker agree on what a value means.
export function snapTemperature(caps, temperature) {
    const [min, max, step] = caps.range;
    const snapped = Math.round(temperature / step) * step;
    return Math.min(max, Math.max(min, Math.round(snapped * 10) / 10));
}

function modeOf(description) {
    const text = String(description ?? '').toLowerCase();
    if (/heat.*cool|cool.*heat|auto|smart/.test(text))
        return 'auto';
    if (/cool|cold/.test(text))
        return 'cool';
    if (/heat|warm|hot/.test(text))
        return 'heat';
    if (/dry|dehumid|wet/.test(text))
        return 'dry';
    if (/fan|wind|vent|blow/.test(text))
        return 'fan';
    return null;
}

const FAN_NAMES = [
    [/^auto(matic)?$/, 'auto', 0],
    [/^(silent|quiet|mute|sleep|slow)$/, 'quiet', 1],
    [/^low$/, 'low', 2],
    [/^(mid|medium|middle)$/, 'medium', 3],
    [/^high$/, 'high', 4],
    [/^(max|full)$/, 'max', 5],
    [/^(turbo|strong|powerful|power)$/, 'turbo', 5],
];

// Spec fan levels: known words, "Level 3" or "3" as numbered steps, anything else by its
// own name.
function fansOf(choices) {
    const counted = choices.filter(c => /^\D*\d+\s*$/.test(String(c.description ?? '')));
    return choices.map(({value, description}) => {
        const text = String(description ?? '').trim().toLowerCase();
        const named = FAN_NAMES.find(([pattern]) => pattern.test(text));
        if (named)
            return {value, word: named[1], level: named[2]};
        const n = counted.findIndex(c => c.value === value);
        if (n >= 0)
            return {value, word: null, level: Math.max(1, Math.round((n + 1) * 5 / counted.length))};
        return {value, word: null, level: 3, label: description};
    });
}

const SPEC_TOGGLES = [['SvSt', 'eco'], ['SwhSlp', 'sleep-mode'], ['Tur', 'turbo'], ['Quiet', 'quiet'], ['Blo', 'dryer'],
    ['Health', 'anion']];
const DISPLAYS = ['indicator-light', 'screen'];

/**
 * The card's state of an air conditioner described by MIoT-like services (Mi Home and
 * the sources spec-home.js builds), or null without a switch, modes or a Celsius target.
 * Values not read are null. keys lists the properties the card shows itself;
 * writes(changes) gives the [siid, piid, value] to set for the card's changes. power
 * stands in for an unread switch.
 */
export function specClimate(services, values, power = null) {
    const find = (name, test = () => true) => {
        for (const service of services) {
            const prop = service.properties.find(p => p.name === name && test(p, service));
            if (prop)
                return {siid: service.siid, prop, key: `${service.siid}/${prop.piid}`};
        }
        return null;
    };
    const writable = p => p.access.includes('write');
    const mode = find('mode', p => writable(p) && p.choices?.length > 0);
    const target = find('target-temperature', writable);
    const on = mode ? find('on', (p, s) => s.siid === mode.siid && writable(p)) : null;
    if (!mode || !target || !on)
        return null;
    // The card is in Celsius only; a Fahrenheit unit keeps the plain card.
    if (target.prop.unit === 'fahrenheit' || /F/.test(target.prop.suffix ?? ''))
        return null;
    const value = found => (found && values.has(found.key) ? values.get(found.key) : undefined);
    const flag = found => (typeof value(found) === 'boolean' ? Number(value(found)) : null);

    const byMode = new Map();
    for (const choice of mode.prop.choices) {
        const normal = modeOf(choice.description);
        if (normal && !byMode.has(normal))
            byMode.set(normal, choice.value);
    }
    const [min = 16, max = 30, step = 1] = target.prop.range ?? [];
    const caps = {
        range: [min, max, step > 0 ? step : 1],
        modes: MODES.map((m, i) => (byMode.has(m) ? i : -1)).filter(i => i >= 0),
        fans: [],
        airflows: [1, 0],
        sides: [1, 0],
    };
    if (caps.modes.length === 0)
        return null;

    const current = modeOf(mode.prop.choices.find(c => c.value === value(mode))?.description);
    const set = value(target);
    const switched = typeof value(on) === 'boolean' ? value(on) : power;
    const state = {
        Pow: switched ? 1 : 0,
        Mod: current ? MODES.indexOf(current) : null,
        SetTem: typeof set === 'number' ? set : null,
        roomTemperature: null,
    };
    const keys = new Set([on.key, mode.key, target.key]);
    const room = find('temperature', p => !writable(p)) ?? find('indoor-temperature');
    if (room) {
        keys.add(room.key);
        if (typeof value(room) === 'number')
            state.roomTemperature = value(room);
    }

    const fields = {Pow: [on, v => Boolean(v)], SetTem: [target, v => v],
        Mod: [mode, v => byMode.get(MODES[v]) ?? byMode.values().next().value]};
    const take = (key, found, write, read) => {
        keys.add(found.key);
        state[key] = read(found);
        fields[key] = [found, write];
    };
    const fan = find('fan-level', p => writable(p) && p.choices?.length > 1);
    if (fan) {
        caps.fans = fansOf(fan.prop.choices);
        take('WdSpd', fan, v => v, found => value(found) ?? null);
    }
    for (const [key, name] of [['SwUpDn', 'vertical-swing'], ['SwingLfRig', 'horizontal-swing']]) {
        const swing = find(name, p => writable(p) && p.format === 'bool');
        if (swing)
            take(key, swing, v => v === 1, flag);
    }
    for (const [key, name] of SPEC_TOGGLES) {
        const toggle = find(name, p => writable(p) && p.format === 'bool');
        if (toggle)
            take(key, toggle, v => Boolean(v), flag);
    }
    for (const [key, names] of [['Lig', DISPLAYS], ['Air', ['air-fresh']]]) {
        const own = find('on', (p, s) => names.includes(s.name) && writable(p));
        if (own)
            take(key, own, v => Boolean(v), flag);
    }

    return {
        state,
        caps,
        keys,
        writes: changes => Object.entries(changes).filter(([key]) => fields[key])
            .map(([key, v]) => [fields[key][0].siid, fields[key][0].prop.piid, fields[key][1](v)]),
    };
}
