// SPDX-License-Identifier: GPL-2.0-or-later

// Same values as the app's lib/spec-home.js.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Quick picks beside the colour wheel. White is the white (colour temperature) mode
// where a light has one.
export const WHITE = 0xffffff;
export const PRESETS = [
    ['White', WHITE],
    ['Red', 0xff0000],
    ['Orange', 0xff8000],
    ['Yellow', 0xffd200],
    ['Green', 0x00ff00],
    ['Cyan', 0x00ffff],
    ['Blue', 0x0000ff],
    ['Purple', 0x8000ff],
    ['Pink', 0xff40a0],
];

const channels = rgb => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map(v => v / 255);
const pack = ([r, g, b]) => (Math.round(clamp(r, 0, 1) * 255) << 16) | (Math.round(clamp(g, 0, 1) * 255) << 8) |
    Math.round(clamp(b, 0, 1) * 255);

// h in degrees, s and v 0-1.
export function rgbToHsv(rgb) {
    const [r, g, b] = channels(rgb);
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    let h = 0;
    if (span > 0 && max === r)
        h = 60 * (((g - b) / span) % 6);
    else if (span > 0 && max === g)
        h = 60 * ((b - r) / span + 2);
    else if (span > 0)
        h = 60 * ((r - g) / span + 4);
    return [(h + 360) % 360, max > 0 ? span / max : 0, max];
}

export function hsvToRgb(h, s, v = 1) {
    const channel = n => {
        const k = (n + h / 60) % 6;
        return v - v * s * clamp(Math.min(k, 4 - k), 0, 1);
    };
    return pack([channel(5), channel(3), channel(1)]);
}

function nearestColor(h, s) {
    if (!(s >= 0.25))
        return WHITE;
    let best = WHITE;
    let gap = Infinity;
    for (const [, value] of PRESETS.slice(1)) {
        const [hue] = rgbToHsv(value);
        const distance = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
        if (distance < gap) {
            gap = distance;
            best = value;
        }
    }
    return best;
}

export const nearestRgb = rgb => {
    const [h, s] = rgbToHsv(rgb);
    return nearestColor(h, s);
};
