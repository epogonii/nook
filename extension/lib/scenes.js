// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import * as Glyphs from './glyphs.js';

const TAU = 2 * Math.PI;

function roundRect(cr, left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    cr.newSubPath();
    cr.arc(right - radius, top + radius, radius, -TAU / 4, 0);
    cr.arc(right - radius, bottom - radius, radius, 0, TAU / 4);
    cr.arc(left + radius, bottom - radius, radius, TAU / 4, TAU / 2);
    cr.arc(left + radius, top + radius, radius, TAU / 2, 3 * TAU / 4);
    cr.closePath();
}

export const mix = (from, to, share) => from.map((v, i) => v + (to[i] - v) * share);

function shadow(cr, left, top, width, height, radius, depth) {
    for (let i = depth; i > 0; i--) {
        cr.setSourceRGBA(0, 0, 0, 0.07);
        roundRect(cr, left - i * 0.6, top + i * 0.9, width + i * 1.2, height + i * 0.6, radius + i * 0.6);
        cr.fill();
    }
}

function write(cr, string, {x, y, size, bold = false, font = null}) {
    const layout = PangoCairo.create_layout(cr);
    const description = font ? font.copy() : Pango.FontDescription.from_string('Sans');
    description.set_absolute_size(size * Pango.SCALE);
    description.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    layout.set_font_description(description);
    layout.set_text(string, -1);
    const [, logical] = layout.get_extents();
    cr.moveTo(x - logical.width / Pango.SCALE / 2, y - logical.height / Pango.SCALE / 2);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
}

function ellipse(cr, centerX, centerY, radiusX, radiusY) {
    cr.save();
    cr.translate(centerX, centerY);
    cr.scale(radiusX, radiusY);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, TAU);
    cr.restore();
}

function plastic(cr, top, bottom, shade = 0) {
    const gradient = new Cairo.LinearGradient(0, top, 0, bottom);
    gradient.addColorStopRGB(0, 0.99 - shade, 0.99 - shade, 1 - shade);
    gradient.addColorStopRGB(1, 0.8 - shade, 0.82 - shade, 0.86 - shade);
    cr.setSource(gradient);
}

function floorShadow(cr, centerX, y, radius) {
    cr.save();
    cr.translate(centerX, y);
    cr.scale(1, 0.24);
    const gradient = new Cairo.RadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStopRGBA(0, 0, 0, 0, 0.4);
    gradient.addColorStopRGBA(1, 0, 0, 0, 0);
    cr.setSource(gradient);
    cr.arc(0, 0, radius, 0, TAU);
    cr.fill();
    cr.restore();
}

// HSV, for blending by hue: an RGB blend of two colours greys out midway.
function toHsv([r, g, b]) {
    const max = Math.max(r, g, b);
    const span = max - Math.min(r, g, b);
    let hue = 0;
    if (span > 0 && max === r)
        hue = 60 * ((g - b) / span);
    else if (span > 0 && max === g)
        hue = 60 * ((b - r) / span + 2);
    else if (span > 0)
        hue = 60 * ((r - g) / span + 4);
    return [(hue + 360) % 360, max > 0 ? span / max : 0, max];
}

function fromHsv([hue, saturation, value]) {
    const channel = n => {
        const k = (n + hue / 60) % 6;
        return value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [channel(5), channel(3), channel(1)];
}

function mixHue(from, to, share) {
    const [h0, s0, v0] = toHsv(from);
    const [h1, s1, v1] = toHsv(to);
    let turn = h1 - h0;
    if (turn > 180)
        turn -= 360;
    else if (turn < -180)
        turn += 360;
    return fromHsv([(h0 + turn * share + 360) % 360, s0 + (s1 - s0) * share, v0 + (v1 - v0) * share]);
}

function ramp(stops, temperature, blend = mixHue) {
    if (temperature <= stops[0][0])
        return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        const [upTo, color] = stops[i];
        if (temperature <= upTo) {
            const [from, before] = stops[i - 1];
            return blend(before, color, (temperature - from) / (upTo - from));
        }
    }
    return stops.at(-1)[1];
}

// Green to amber within 1 degree: a hue blend between them passes through olive.
const AIR = [
    [12, [0.3, 0.6, 0.98]],
    [22, [0.36, 0.82, 0.56]],
    [24.6, [0.36, 0.82, 0.56]],
    [25.6, [0.98, 0.66, 0.22]],
    [31, [0.97, 0.38, 0.22]],
];

function warmth(temperature) {
    return ramp(AIR, temperature);
}

// Blended in RGB (mix), not by hue, so blue to amber skips green.
const WATER = [
    [36, [0.36, 0.64, 0.98]],
    [46, [1, 0.76, 0.32]],
    [62, [1, 0.76, 0.32]],
    [95, [0.98, 0.45, 0.2]],
];

function waterColor(temperature) {
    return ramp(WATER, temperature, mix);
}

const cycle = (time, period, index = 0, count = 1) => ((time / period + index / count) % 1 + 1) % 1;

function drop(cr, centerX, top, size) {
    cr.newSubPath();
    cr.moveTo(centerX, top);
    cr.curveTo(centerX, top, centerX + size * 0.5, top + size * 0.5, centerX + size * 0.5, top + size * 0.7);
    cr.arc(centerX, top + size * 0.7, size * 0.5, 0, Math.PI);
    cr.curveTo(centerX - size * 0.5, top + size * 0.5, centerX, top, centerX, top);
    cr.closePath();
}

// Louver tilt, 0 (up) to 1 (down), from Gree SwUpDn: 1 swings fully, 7-11 swing
// around the upper to the lower part, 2-6 are fixed positions top to bottom, 0 leaves
// it to the unit.
function louver(swing, time) {
    if (swing === 1)
        return 0.5 + 0.5 * Math.sin(time * TAU / 6);
    if (swing >= 7 && swing <= 11)
        return 0.15 + 0.7 * (swing - 7) / 4 + 0.15 * Math.sin(time * TAU / 4);
    if (swing >= 2 && swing <= 6)
        return (swing - 2) / 4;
    return 0.55;
}

// Vane turn, -1 (left) to 1 (right), from Gree SwingLfRig: 1 swings, 2-6 are fixed
// positions left to right, 0 leaves it to the unit. A slower beat than the louver.
function vane(side, time) {
    if (side === 1)
        return Math.sin(time * TAU / 8);
    if (side >= 2 && side <= 6)
        return (side - 4) / 2;
    return 0;
}

const UNIT_WIDTH = 168;
const UNIT_HEIGHT = 50;

function airconUnit(cr, width, height, time, state) {
    const {on, color, air = color, target, swing = 0, side = 0, speed = 1, light = true, font} = state;
    const left = (width - UNIT_WIDTH) / 2;
    const top = 6;
    const bottom = top + UNIT_HEIGHT;
    const tilt = on ? louver(swing, time) : 0;
    const turn = on ? vane(side, time) : 0;

    if (on)
        airflow(cr, width, height, bottom + 4, time, air, tilt, turn, speed);

    shadow(cr, left, top, UNIT_WIDTH, UNIT_HEIGHT, 12, 6);
    const body = new Cairo.LinearGradient(0, top, 0, bottom);
    body.addColorStopRGB(0, 0.99, 0.99, 1);
    body.addColorStopRGB(0.62, 0.94, 0.95, 0.97);
    body.addColorStopRGB(1, 0.83, 0.85, 0.89);
    cr.setSource(body);
    roundRect(cr, left, top, UNIT_WIDTH, UNIT_HEIGHT, 12);
    cr.fill();

    cr.setLineWidth(0.8);
    cr.setSourceRGBA(0.55, 0.58, 0.64, 0.45);
    cr.moveTo(left + 8, top + UNIT_HEIGHT * 0.66);
    cr.lineTo(left + UNIT_WIDTH - 8, top + UNIT_HEIGHT * 0.66);
    cr.stroke();
    cr.setSourceRGBA(1, 1, 1, 0.9);
    cr.moveTo(left + 12, top + 1.2);
    cr.lineTo(left + UNIT_WIDTH - 12, top + 1.2);
    cr.stroke();

    const slotTop = top + UNIT_HEIGHT * 0.74;
    const slotLeft = left + 14;
    const slotWidth = UNIT_WIDTH - 28;
    if (on) {
        const slot = new Cairo.LinearGradient(0, slotTop, 0, bottom - 3);
        slot.addColorStopRGB(0, 0.16, 0.18, 0.22);
        slot.addColorStopRGB(1, 0.32, 0.35, 0.41);
        cr.setSource(slot);
        roundRect(cr, slotLeft, slotTop, slotWidth, bottom - 3 - slotTop, 3);
        cr.fill();
        cr.setSourceRGBA(0.78, 0.8, 0.85, 0.75);
        cr.setLineWidth(1.2);
        for (let i = 1; i < 12; i++) {
            const x = slotLeft + slotWidth * i / 12;
            cr.moveTo(x - turn * 2.5, slotTop + 1.5);
            cr.lineTo(x + turn * 2.5, bottom - 4);
        }
        cr.stroke();
        const drop = 2.5 + tilt * 5;
        const blade = new Cairo.LinearGradient(0, bottom - 4, 0, bottom + drop);
        blade.addColorStopRGB(0, 0.97, 0.97, 0.99);
        blade.addColorStopRGB(1, 0.8, 0.82, 0.87);
        cr.setSource(blade);
        cr.moveTo(slotLeft - 2, bottom - 4);
        cr.lineTo(slotLeft + slotWidth + 2, bottom - 4);
        cr.curveTo(slotLeft + slotWidth + 2, bottom - 4 + drop, slotLeft + slotWidth - 4, bottom + drop,
            slotLeft + slotWidth - 10, bottom + drop);
        cr.lineTo(slotLeft + 8, bottom + drop);
        cr.curveTo(slotLeft - 2, bottom + drop, slotLeft - 2, bottom - 4 + drop, slotLeft - 2, bottom - 4);
        cr.closePath();
        cr.fill();
    } else {
        cr.setSourceRGBA(0.55, 0.58, 0.64, 0.5);
        cr.setLineWidth(0.8);
        roundRect(cr, slotLeft, slotTop, slotWidth, bottom - 3 - slotTop, 3);
        cr.stroke();
    }

    if (on && light) {
        const digitsX = left + UNIT_WIDTH - 46;
        const digitsY = top + 18;
        const glow = new Cairo.RadialGradient(digitsX, digitsY, 1, digitsX, digitsY, 26);
        glow.addColorStopRGBA(0, ...color, 0.28);
        glow.addColorStopRGBA(1, ...color, 0);
        cr.setSource(glow);
        cr.arc(digitsX, digitsY, 26, 0, TAU);
        cr.fill();
        cr.setSourceRGB(...mix(color, [0, 0, 0], 0.12));
        write(cr, `${target}°`, {x: digitsX, y: digitsY, size: 17, bold: true, font});
        cr.setSourceRGB(0.2, 0.78, 0.45);
        cr.arc(digitsX + 24, digitsY, 1.8, 0, TAU);
        cr.fill();
    }
}

function aircon(cr, width, height, time, state) {
    const fit = Math.min(1, (width - 8) / UNIT_WIDTH);
    cr.save();
    cr.scale(fit, fit);
    airconUnit(cr, width / fit, height / fit, time, state);
    cr.restore();
}

function airconBody(_state, width) {
    const fit = Math.min(1, (width - 8) / UNIT_WIDTH);
    // The louver hangs up to 7.5 below the casing.
    return [-UNIT_WIDTH * fit / 2, 6 * fit, UNIT_WIDTH * fit, (UNIT_HEIGHT + 8) * fit];
}

function airflow(cr, width, height, from, time, color, tilt, turn, speed) {
    const middle = width / 2;
    const reach = height - from;
    const lean = 0.35 + tilt * 0.65;
    const shift = turn * reach * 0.9;
    const fade = new Cairo.LinearGradient(0, from, 0, height);
    fade.addColorStopRGBA(0, ...color, 0.95);
    fade.addColorStopRGBA(1, ...color, 0);
    const lines = () => {
        for (let i = -3; i <= 3; i++) {
            const startX = middle + i * 18;
            const spread = i * (12 + 22 * (1 - lean));
            cr.moveTo(startX, from);
            cr.curveTo(startX + spread * 0.15 + shift * 0.15, from + reach * 0.45 * lean,
                startX + spread * 0.7 + shift * 0.6, from + reach * 0.75,
                startX + spread + shift, height - 2);
        }
    };
    cr.setSource(fade);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.pushGroup();
    cr.setLineWidth(7);
    lines();
    cr.stroke();
    cr.popGroupToSource();
    cr.paintWithAlpha(0.12);
    cr.setSource(fade);
    cr.setLineWidth(2);
    const dash = 7;
    cr.setDash([dash, dash * 0.9], -(time * speed * 26) % (dash * 1.9));
    lines();
    cr.stroke();
    cr.setDash([], 0);
}

function thermo(cr, width, height, time, state) {
    const {temperature = null, humidity = null} = state;
    const centerX = width / 2 - (humidity === null ? 0 : 20);
    const tube = 14;
    const top = 10;
    const bulbY = 70;
    const bulb = 13;
    const glass = inset => {
        const half = tube / 2 - inset;
        const radius = bulb - inset;
        const angle = Math.asin(half / radius);
        cr.newPath();
        cr.arc(centerX, top + tube / 2, half, Math.PI, 0);
        cr.arc(centerX, bulbY, radius, -TAU / 4 + angle, 3 * TAU / 4 - angle);
        cr.closePath();
    };
    floorShadow(cr, centerX, bulbY + bulb + 4, 18);
    glass(0);
    plastic(cr, top, bulbY + bulb);
    cr.fill();

    const color = temperature === null ? [0.62, 0.64, 0.7] : warmth(temperature);
    const share = temperature === null ? 0.15 : Math.min(1, Math.max(0.04, (temperature + 10) / 50));
    const level = bulbY - 6 - share * (bulbY - 6 - top - 4);
    cr.save();
    glass(3.5);
    cr.clip();
    const column = new Cairo.LinearGradient(centerX - 4, 0, centerX + 4, 0);
    column.addColorStopRGB(0, ...mix(color, [1, 1, 1], 0.25));
    column.addColorStopRGB(1, ...color);
    cr.setSource(column);
    cr.rectangle(centerX - bulb, level, bulb * 2, bulbY + bulb - level);
    cr.fill();
    cr.restore();

    cr.setSourceRGBA(0.35, 0.38, 0.45, 0.6);
    cr.setLineWidth(1);
    for (let i = 0; i < 6; i++) {
        const y = top + 8 + i * 8.5;
        cr.moveTo(centerX + tube / 2 + 2, y);
        cr.lineTo(centerX + tube / 2 + (i % 2 ? 4.5 : 6.5), y);
    }
    cr.stroke();
    cr.setSourceRGBA(1, 1, 1, 0.7);
    cr.setLineWidth(1.5);
    cr.moveTo(centerX - tube / 2 + 2.5, top + 6);
    cr.lineTo(centerX - tube / 2 + 2.5, bulbY - 14);
    cr.stroke();

    if (humidity === null)
        return;
    const dropX = width / 2 + 24;
    const dropTop = 30;
    const size = 40;
    floorShadow(cr, dropX, dropTop + size * 1.22 + 4, 16);
    drop(cr, dropX, dropTop, size);
    cr.setSourceRGBA(1, 1, 1, 0.16);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, 0.85);
    cr.setLineWidth(2);
    cr.stroke();
    cr.save();
    drop(cr, dropX, dropTop, size);
    cr.clip();
    const bottom = dropTop + size * 1.2;
    const surface = bottom - Math.min(1, Math.max(0, humidity / 100)) * size * 1.2;
    const water = new Cairo.LinearGradient(0, surface, 0, bottom);
    water.addColorStopRGB(0, 0.45, 0.75, 1);
    water.addColorStopRGB(1, 0.18, 0.46, 0.92);
    cr.setSource(water);
    cr.moveTo(dropX - size, surface);
    for (let x = -size; x <= size; x += 2)
        cr.lineTo(dropX + x, surface + Math.sin(x * 0.35) * 1.2);
    cr.lineTo(dropX + size, bottom + 2);
    cr.lineTo(dropX - size, bottom + 2);
    cr.closePath();
    cr.fill();
    cr.restore();
}

function walker(cr, x, y, time, color) {
    const step = Math.sin(time * 5);
    cr.setSourceRGBA(...color, 0.95);
    cr.setLineWidth(3.6);
    cr.arc(x, y - 15, 4.5, 0, TAU);
    cr.fill();
    cr.moveTo(x, y - 9);
    cr.lineTo(x + 1, y + 5);
    for (const side of [1, -1]) {
        cr.moveTo(x + 1, y + 5);
        cr.lineTo(x + 1 + side * 6 * step, y + 20);
        cr.moveTo(x, y - 6);
        cr.lineTo(x - side * 5 * step, y + 3);
    }
    cr.stroke();
}

function motion(cr, width, height, time, state) {
    const {active = false} = state;
    const centerX = width / 2 - 26;
    const centerY = 44;
    const lensX = centerX + 9;
    const accent = [0.36, 0.86, 0.55];

    const reach = Math.max(40, width - lensX);
    const zone = new Cairo.RadialGradient(lensX, centerY, 4, lensX, centerY, reach);
    zone.addColorStopRGBA(0, ...accent, active ? 0.45 : 0.16);
    zone.addColorStopRGBA(1, ...accent, 0);
    cr.setSource(zone);
    cr.moveTo(lensX, centerY);
    cr.arc(lensX, centerY, reach, -0.5, 0.62);
    cr.closePath();
    cr.fill();
    if (active)
        walker(cr, lensX + reach * (0.58 + 0.06 * Math.sin(time * 0.8)), centerY + 4, time, mix(accent, [1, 1, 1], 0.55));

    floorShadow(cr, centerX, 84, 20);
    plastic(cr, 60, 84, 0.06);
    cr.moveTo(centerX - 6, 58);
    cr.lineTo(centerX + 6, 58);
    cr.lineTo(centerX + 10, 82);
    cr.lineTo(centerX - 10, 82);
    cr.closePath();
    cr.fill();
    ellipse(cr, centerX, 82, 10, 2.5);
    cr.fill();
    const ball = new Cairo.RadialGradient(centerX - 6, centerY - 8, 2, centerX, centerY, 20);
    ball.addColorStopRGB(0, 1, 1, 1);
    ball.addColorStopRGB(1, 0.8, 0.82, 0.87);
    cr.setSource(ball);
    cr.arc(centerX, centerY, 19, 0, TAU);
    cr.fill();

    const lens = new Cairo.RadialGradient(lensX - 2, centerY - 4, 1, lensX, centerY, 12);
    lens.addColorStopRGB(0, 1, 1, 1);
    lens.addColorStopRGB(1, 0.86, 0.88, 0.92);
    cr.setSource(lens);
    ellipse(cr, lensX, centerY, 9, 11);
    cr.fill();
    cr.save();
    ellipse(cr, lensX, centerY, 9, 11);
    cr.clip();
    cr.setLineWidth(0.6);
    cr.setSourceRGBA(0.56, 0.6, 0.67, 0.45);
    for (let x = lensX - 9; x <= lensX + 9; x += 3) {
        cr.moveTo(x, centerY - 11);
        cr.lineTo(x, centerY + 11);
    }
    for (let y = centerY - 11; y <= centerY + 11; y += 3) {
        cr.moveTo(lensX - 9, y);
        cr.lineTo(lensX + 9, y);
    }
    cr.stroke();
    cr.restore();
    cr.setLineWidth(1);
    cr.setSourceRGBA(0.6, 0.63, 0.7, 0.7);
    ellipse(cr, lensX, centerY, 9, 11);
    cr.stroke();

    if (active)
        cr.setSourceRGBA(0.3, 0.62, 1, 0.55 + 0.45 * Math.sin(time * 7));
    else
        cr.setSourceRGB(0.72, 0.74, 0.79);
    cr.arc(centerX + 2, centerY + 15, 1.6, 0, TAU);
    cr.fill();
}

function door(cr, width, height, time, state) {
    const {open = false} = state;
    const left = width / 2 - 24;
    const top = 8;
    const doorWidth = 44;
    const doorHeight = 80;
    cr.setSourceRGBA(1, 1, 1, 0.12);
    cr.rectangle(left - 22, top + doorHeight, doorWidth + 48, 2);
    cr.fill();
    cr.setSourceRGB(0.86, 0.87, 0.9);
    cr.rectangle(left - 4, top - 4, doorWidth + 8, doorHeight + 4);
    cr.fill();
    const beyond = new Cairo.LinearGradient(0, top, 0, top + doorHeight);
    beyond.addColorStopRGB(0, 0.1, 0.11, 0.14);
    beyond.addColorStopRGB(1, 0.2, 0.21, 0.25);
    cr.setSource(beyond);
    cr.rectangle(left, top, doorWidth, doorHeight);
    cr.fill();

    const leaf = new Cairo.LinearGradient(left, 0, left + doorWidth, 0);
    leaf.addColorStopRGB(0, 0.97, 0.96, 0.95);
    leaf.addColorStopRGB(1, 0.84, 0.83, 0.82);
    cr.setSource(leaf);
    let knobX, sensorX, sensorY;
    if (open) {
        const reach = doorWidth * 0.55;
        cr.moveTo(left, top);
        cr.lineTo(left - reach, top - 6);
        cr.lineTo(left - reach, top + doorHeight + 6);
        cr.lineTo(left, top + doorHeight);
        cr.closePath();
        cr.fill();
        knobX = left - reach + 5;
        sensorX = left - reach + 3;
        sensorY = top - 2;
        const light = new Cairo.LinearGradient(left, 0, left + doorWidth, 0);
        light.addColorStopRGBA(0, 1, 0.93, 0.75, 0.35);
        light.addColorStopRGBA(1, 1, 0.93, 0.75, 0);
        cr.setSource(light);
        cr.moveTo(left, top + doorHeight);
        cr.lineTo(left + doorWidth, top + doorHeight);
        cr.lineTo(left + doorWidth + 20, top + doorHeight + 8);
        cr.lineTo(left - 6, top + doorHeight + 8);
        cr.closePath();
        cr.fill();
    } else {
        cr.rectangle(left, top, doorWidth, doorHeight);
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 0.08);
        cr.setLineWidth(1);
        roundRect(cr, left + 6, top + 8, doorWidth - 12, 28, 2);
        cr.stroke();
        roundRect(cr, left + 6, top + 44, doorWidth - 12, 28, 2);
        cr.stroke();
        knobX = left + doorWidth - 7;
        sensorX = left + doorWidth - 12;
        sensorY = top + 2;
    }
    cr.setSourceRGB(0.75, 0.62, 0.35);
    cr.arc(knobX, top + 46, 2.4, 0, TAU);
    cr.fill();
    plastic(cr, top - 6, top + 8, 0.04);
    roundRect(cr, sensorX, sensorY, 9, 5, 1.5);
    cr.fill();
    roundRect(cr, left + doorWidth + 1, top - 3, 7, 12, 1.5);
    cr.fill();
    cr.setSourceRGB(...(open ? [0.97, 0.66, 0.25] : [0.36, 0.86, 0.55]));
    cr.arc(left + doorWidth + 4.5, top + 1, 1.2, 0, TAU);
    cr.fill();
}

function leak(cr, width, height, time, state) {
    const {wet = false} = state;
    const centerX = width / 2;
    const floor = 78;
    if (wet) {
        cr.setSourceRGBA(0.3, 0.6, 1, 0.45);
        ellipse(cr, centerX, floor + 2, 46, 8);
        cr.fill();
        cr.setLineWidth(1.5);
        for (let i = 0; i < 3; i++) {
            const share = cycle(time, 2.2, i, 3);
            cr.setSourceRGBA(0.6, 0.82, 1, 0.8 * (1 - share));
            ellipse(cr, centerX, floor + 2, 14 + share * 36, 2.5 + share * 6);
            cr.stroke();
        }
        for (let i = 0; i < 2; i++) {
            const share = cycle(time, 1.4, i, 2);
            const x = centerX + (i ? 16 : -18);
            cr.setSourceRGBA(0.5, 0.75, 1, Math.min(1, (1 - share) * 2));
            drop(cr, x, 4 + share * (floor - 28), 9);
            cr.fill();
        }
    } else {
        floorShadow(cr, centerX, floor + 2, 30);
    }
    plastic(cr, floor - 12, floor, 0.08);
    cr.rectangle(centerX - 24, floor - 8, 48, 8);
    cr.fill();
    ellipse(cr, centerX, floor, 24, 5);
    cr.fill();
    plastic(cr, floor - 14, floor - 2);
    ellipse(cr, centerX, floor - 8, 24, 5);
    cr.fill();
    cr.setSourceRGBA(0.3, 0.33, 0.4, 0.5);
    cr.arc(centerX, floor - 8, 1.6, 0, TAU);
    cr.fill();
    if (wet)
        return;
    const bob = 0;
    drop(cr, centerX, 14 + bob, 30);
    const water = new Cairo.LinearGradient(0, 14 + bob, 0, 50 + bob);
    water.addColorStopRGB(0, 0.55, 0.8, 1);
    water.addColorStopRGB(1, 0.25, 0.52, 0.95);
    cr.setSource(water);
    cr.fill();
    cr.setSourceRGB(1, 1, 1);
    cr.setLineWidth(2.5);
    cr.moveTo(centerX - 6, 36 + bob);
    cr.lineTo(centerX - 1.5, 40.5 + bob);
    cr.lineTo(centerX + 6.5, 31.5 + bob);
    cr.stroke();
}

function smoke(cr, width, height, time, state) {
    const {alarm = false} = state;
    const centerX = width / 2;
    cr.translate(0, 18);
    cr.setSourceRGBA(1, 1, 1, 0.12);
    cr.rectangle(centerX - 52, 6, 104, 2);
    cr.fill();
    if (alarm) {
        for (let i = 0; i < 3; i++) {
            const share = cycle(time, 1.2, i, 3);
            cr.setSourceRGBA(0.95, 0.3, 0.3, 0.7 * (1 - share));
            cr.setLineWidth(2);
            cr.newSubPath();
            cr.arc(centerX, 26, 22 + share * 30, 0.25, Math.PI - 0.25);
            cr.stroke();
        }
        for (let i = 0; i < 4; i++) {
            const share = cycle(time, 3, i, 4);
            const x = centerX - 30 + i * 20 + Math.sin(time + i) * 4;
            cr.setSourceRGBA(0.75, 0.76, 0.8, 0.45 * Math.sin(share * Math.PI));
            cr.arc(x, 92 - share * 50, 6 + share * 8, 0, TAU);
            cr.fill();
        }
    }
    cr.setSourceRGBA(0, 0, 0, 0.25);
    ellipse(cr, centerX, 24, 33, 13);
    cr.fill();
    plastic(cr, 8, 34);
    cr.moveTo(centerX - 32, 8);
    cr.lineTo(centerX + 32, 8);
    cr.curveTo(centerX + 32, 26, centerX + 18, 33, centerX, 33);
    cr.curveTo(centerX - 18, 33, centerX - 32, 26, centerX - 32, 8);
    cr.closePath();
    cr.fill();
    cr.setSourceRGBA(0.35, 0.38, 0.45, 0.45);
    cr.setLineWidth(1);
    for (let i = -3; i <= 3; i++) {
        cr.moveTo(centerX + i * 8, 12);
        cr.lineTo(centerX + i * 8.6, 18);
    }
    cr.stroke();
    let light = [0.36, 0.86, 0.55, 0.7];
    if (alarm)
        light = [1, 0.3, 0.3, cycle(time, 0.6) < 0.5 ? 1 : 0.3];
    cr.setSourceRGBA(...light);
    cr.arc(centerX, 26, 2.4, 0, TAU);
    cr.fill();
}

function fan(cr, width, height, time, state) {
    const {on = false, level = 1} = state;
    const centerX = width / 2;
    const centerY = 38;
    const radius = 32;
    floorShadow(cr, centerX, 90, 24);
    plastic(cr, centerY, 90, 0.06);
    cr.rectangle(centerX - 2.5, centerY + radius - 2, 5, 90 - centerY - radius);
    cr.fill();
    ellipse(cr, centerX, 89, 19, 4.5);
    cr.fill();

    cr.setSourceRGBA(1, 1, 1, 0.08);
    cr.arc(centerX, centerY, radius, 0, TAU);
    cr.fill();
    const turn = on ? time * (1.2 + level * 0.7) * TAU : 0.4;
    if (on) {
        cr.setSourceRGBA(0.85, 0.92, 1, 0.12);
        cr.arc(centerX, centerY, radius - 4, 0, TAU);
        cr.fill();
    }
    for (let blade = 0; blade < 5; blade++) {
        cr.save();
        cr.translate(centerX, centerY);
        cr.rotate(turn + blade * TAU / 5);
        cr.moveTo(0, -4);
        cr.curveTo(6, -10, 12, -24, 4, -27);
        cr.curveTo(-3, -29, -7, -14, 0, -4);
        cr.closePath();
        cr.setSourceRGBA(0.92, 0.95, 1, on ? 0.6 : 0.85);
        cr.fill();
        cr.restore();
    }
    cr.setSourceRGBA(0.95, 0.96, 0.98, 0.95);
    cr.setLineWidth(2.5);
    cr.arc(centerX, centerY, radius, 0, TAU);
    cr.stroke();
    cr.setSourceRGBA(0.95, 0.96, 0.98, 0.35);
    cr.setLineWidth(0.8);
    for (const share of [0.38, 0.7]) {
        cr.newSubPath();
        cr.arc(centerX, centerY, radius * share, 0, TAU);
    }
    for (let spoke = 0; spoke < 24; spoke++) {
        const angle = spoke * TAU / 24;
        cr.moveTo(centerX + 7 * Math.cos(angle), centerY + 7 * Math.sin(angle));
        cr.lineTo(centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle));
    }
    cr.stroke();
    const hub = new Cairo.RadialGradient(centerX - 2, centerY - 2, 1, centerX, centerY, 7);
    hub.addColorStopRGB(0, 1, 1, 1);
    hub.addColorStopRGB(1, 0.78, 0.8, 0.85);
    cr.setSource(hub);
    cr.arc(centerX, centerY, 6.5, 0, TAU);
    cr.fill();
}

// Steam wisps as [x from the kettle's middle, phase]; the last two only near a boil.
const WISPS = [[-8, 0], [0, 1 / 3], [8, 2 / 3], [-4, 1 / 6], [4, 1 / 2]];

function kettle(cr, width, height, time, state) {
    const {temperature = null, status = 0} = state;
    const centerX = width / 2 - 4;
    const hot = temperature !== null && temperature >= 60;
    const heating = status === 1;
    const warm = status === 3;
    // 0 as heating starts, 1 at a rolling boil.
    const boil = heating ? Math.min(1, Math.max(0, ((temperature ?? 70) - 40) / 55)) : 0;
    const outline = () => {
        cr.newPath();
        cr.moveTo(centerX - 22, 80);
        cr.lineTo(centerX - 19, 30);
        cr.curveTo(centerX - 19, 24, centerX - 15, 21, centerX - 9, 21);
        cr.lineTo(centerX + 9, 21);
        cr.curveTo(centerX + 15, 21, centerX + 19, 24, centerX + 19, 30);
        cr.lineTo(centerX + 22, 80);
        cr.closePath();
    };

    if (hot || heating || warm) {
        const sway = 2.5 + boil;
        cr.setLineWidth(2.5 + boil);
        for (let i = 0; i < 3 + Math.round(boil * 2); i++) {
            const [offset, phase] = WISPS[i];
            const share = cycle(time, 2.4, phase);
            const baseX = centerX + offset;
            const y0 = 16 - share * 14;
            cr.setSourceRGBA(1, 1, 1, (0.55 + boil * 0.25) * Math.sin(share * Math.PI));
            cr.moveTo(baseX + Math.sin(time * 2 + i) * sway * 0.8, y0 + 10);
            for (let k = 1; k <= 5; k++)
                cr.lineTo(baseX + Math.sin(time * 2 + i + k * 0.9) * sway, y0 + 10 - k * 3);
            cr.stroke();
        }
        if (boil > 0.6) {
            for (let i = 0; i < 3; i++) {
                const share = cycle(time, 1.5, i, 3);
                const x = centerX - 31 - share * 12;
                const y = 25 - share * 16;
                const radius = 2 + share * 5;
                const puff = new Cairo.RadialGradient(x, y, 0, x, y, radius);
                puff.addColorStopRGBA(0, 1, 1, 1, (boil - 0.6) * 1.5 * Math.sin(share * Math.PI));
                puff.addColorStopRGBA(1, 1, 1, 1, 0);
                cr.setSource(puff);
                cr.arc(x, y, radius, 0, TAU);
                cr.fill();
            }
        }
    }

    const pulse = 0.65 + 0.35 * Math.sin(time * (heating ? 4 : 1.5));
    floorShadow(cr, centerX, 88, 30);
    if (warm) {
        cr.save();
        cr.translate(centerX, 86);
        cr.scale(1, 0.3);
        const halo = new Cairo.RadialGradient(0, 0, 0, 0, 0, 42);
        halo.addColorStopRGBA(0, 1, 0.8, 0.35, 0.4 * pulse);
        halo.addColorStopRGBA(1, 1, 0.8, 0.35, 0);
        cr.setSource(halo);
        cr.arc(0, 0, 42, 0, TAU);
        cr.fill();
        cr.restore();
    }
    cr.setSourceRGB(0.2, 0.21, 0.25);
    roundRect(cr, centerX - 28, 79, 56, 9, 4);
    cr.fill();
    if (heating || warm) {
        const glow = heating ? [1, 0.55, 0.2] : [1, 0.8, 0.35];
        cr.setSourceRGBA(...glow, pulse);
        roundRect(cr, centerX - 20, 83, 40, 2.5, 1.25);
        cr.fill();
    }

    cr.setLineWidth(6);
    cr.setSourceRGB(0.88, 0.89, 0.92);
    cr.moveTo(centerX + 18, 30);
    cr.curveTo(centerX + 38, 30, centerX + 38, 66, centerX + 21, 68);
    cr.stroke();
    outline();
    plastic(cr, 20, 80);
    cr.fill();

    cr.save();
    roundRect(cr, centerX - 12, 34, 12, 40, 5);
    cr.clip();
    cr.setSourceRGBA(0.7, 0.74, 0.8, 0.45);
    cr.paint();
    const color = temperature === null ? [0.5, 0.7, 0.95] : waterColor(temperature);
    const surface = 44 - boil * 2;
    const wave = heating ? 0.8 + boil * 1.4 : warm ? 0.5 : 0;
    const pace = heating ? 7 : 2.5;
    const waterline = () => {
        for (let x = -14; x <= 2; x++)
            cr.lineTo(centerX + x, surface + (Math.sin(x * 0.8 - time * pace) + boil * Math.sin(x * 1.9 + time * 11) / 2) * wave);
    };
    const water = new Cairo.LinearGradient(0, surface - wave, 0, 76);
    water.addColorStopRGB(0, ...mix(color, [1, 1, 1], 0.3));
    water.addColorStopRGB(1, ...color);
    cr.setSource(water);
    cr.moveTo(centerX - 14, 80);
    waterline();
    cr.lineTo(centerX + 2, 80);
    cr.closePath();
    cr.fill();
    if (heating) {
        cr.setSourceRGBA(1, 1, 1, 0.7);
        for (let i = 0; i < 5 + Math.round(boil * 7); i++) {
            const share = cycle(time, 1.3 - i * 0.05, i * 0.755);
            const x = centerX - 9 + (i * 3.7) % 9 + Math.sin(time * 5 + i * 2) * boil;
            cr.arc(x, 74 - share * (74 - surface - wave), 0.9 + share * 0.9 + boil * 0.3, 0, TAU);
            cr.fill();
        }
        if (boil > 0.4) {
            cr.setSourceRGBA(1, 1, 1, boil * 0.6);
            cr.setLineWidth(1.2);
            waterline();
            cr.stroke();
        }
    } else if (warm) {
        cr.setSourceRGBA(1, 1, 1, 0.55);
        for (let i = 0; i < 3; i++) {
            const share = cycle(time, 3 + i * 0.5, i * 0.755);
            const x = centerX - 8 + (i * 3.7) % 9 + Math.sin(time * 1.5 + i * 2) * 0.6;
            cr.arc(x, 74 - share * (74 - surface - wave), 0.6 + share * 0.5, 0, TAU);
            cr.fill();
        }
    }
    cr.restore();

    cr.setSourceRGB(0.86, 0.87, 0.9);
    cr.moveTo(centerX - 18, 30);
    cr.lineTo(centerX - 29, 25);
    cr.lineTo(centerX - 30, 28);
    cr.lineTo(centerX - 18.5, 37);
    cr.closePath();
    cr.fill();
    cr.setSourceRGBA(0, 0, 0, 0.1);
    cr.setLineWidth(1);
    cr.moveTo(centerX - 16, 27);
    cr.lineTo(centerX + 16, 27);
    cr.stroke();
    const rattle = boil > 0.85 ? Math.max(0, Math.sin(time * 23) * Math.sin(time * 7)) * 1.2 : 0;
    plastic(cr, 15 - rattle, 21 - rattle, 0.06);
    roundRect(cr, centerX - 5, 16 - rattle, 10, 5, 2);
    cr.fill();
}

function rim(cr, centerX, lidY, radiusX, radiusY, depth) {
    cr.newPath();
    cr.save();
    cr.translate(centerX, lidY + depth);
    cr.scale(radiusX, radiusY);
    cr.arcNegative(0, 0, 1, Math.PI, 0);
    cr.restore();
    cr.save();
    cr.translate(centerX, lidY);
    cr.scale(radiusX, radiusY);
    cr.arc(0, 0, 1, 0, Math.PI);
    cr.restore();
    cr.closePath();
}

function roundSide(cr, centerX, radiusX, light, dark) {
    const gradient = new Cairo.LinearGradient(centerX - radiusX, 0, centerX + radiusX, 0);
    gradient.addColorStopRGB(0, ...dark);
    gradient.addColorStopRGB(0.4, ...light);
    gradient.addColorStopRGB(1, ...dark);
    cr.setSource(gradient);
}

const VACUUM_LIGHTS = {
    cleaning: [0.4, 0.75, 1],
    charging: [0.36, 0.86, 0.55],
    returning: [0.97, 0.75, 0.3],
    error: [1, 0.35, 0.35],
};

function vacuum(cr, width, height, time, state) {
    const {mode = 'idle'} = state;
    const cleaning = mode === 'cleaning';
    const centerX = width / 2 + (cleaning ? 5 * Math.sin(time * 0.9) : 0);
    const lidY = 50;
    const radiusX = 42;
    const radiusY = 18;
    const depth = 10;
    const floorY = lidY + depth + radiusY;

    if (mode === 'charging' || mode === 'returning') {
        plastic(cr, 10, 60, 0.16);
        roundRect(cr, width / 2 - 24, 10, 48, 50, 9);
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 0.12);
        roundRect(cr, width / 2 - 17, 22, 34, 30, 5);
        cr.fill();
        if (mode === 'charging') {
            cr.setSourceRGBA(...VACUUM_LIGHTS.charging, 0.55 + 0.45 * Math.sin(time * 2.5));
            roundRect(cr, width / 2 - 8, 15, 16, 3, 1.5);
            cr.fill();
        }
    }
    floorShadow(cr, centerX, floorY - 2, radiusX + 10);

    if (cleaning) {
        for (let i = 0; i < 6; i++) {
            const share = cycle(time, 1.8, i, 6);
            const side = i % 2 ? 1 : -1;
            const fromX = centerX + side * (12 + (i * 11) % 30);
            const fromY = floorY + 6 + (i * 7) % 9;
            cr.setSourceRGBA(0.72, 0.66, 0.58, 0.8 * Math.sin(share * Math.PI));
            cr.arc(fromX + (centerX + side * 26 - fromX) * share, fromY + (floorY - fromY) * share, 1.3, 0, TAU);
            cr.fill();
        }
    }

    const turn = cleaning ? time * 9 : 0.9;
    cr.setLineWidth(1.6);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGB(0.5, 0.53, 0.6);
    for (const side of [-1, 1]) {
        const brushX = centerX + side * 25;
        const brushY = floorY - 4;
        for (let i = 0; i < 3; i++) {
            const angle = side * turn + i * TAU / 3;
            cr.moveTo(brushX, brushY);
            cr.lineTo(brushX + 12 * Math.cos(angle), brushY + 12 * 0.42 * Math.sin(angle));
        }
        cr.stroke();
    }
    cr.setLineCap(Cairo.LineCap.BUTT);

    rim(cr, centerX, lidY, radiusX, radiusY, depth);
    roundSide(cr, centerX, radiusX, [0.86, 0.87, 0.9], [0.56, 0.58, 0.64]);
    cr.fill();
    cr.setSourceRGBA(0, 0, 0, 0.16);
    cr.setLineWidth(1);
    cr.save();
    cr.translate(centerX, lidY + depth * 0.45);
    cr.scale(radiusX, radiusY);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0.12 * Math.PI, 0.88 * Math.PI);
    cr.restore();
    cr.stroke();
    const lid = new Cairo.RadialGradient(centerX - 12, lidY - 8, 3, centerX, lidY, radiusX);
    lid.addColorStopRGB(0, 1, 1, 1);
    lid.addColorStopRGB(1, 0.84, 0.85, 0.89);
    cr.setSource(lid);
    ellipse(cr, centerX, lidY, radiusX, radiusY);
    cr.fill();

    const turretY = lidY - 7;
    const turretWidth = 11;
    const turretTilt = 5;
    rim(cr, centerX, turretY - 7, turretWidth, turretTilt, 7);
    roundSide(cr, centerX, turretWidth, [0.34, 0.36, 0.42], [0.16, 0.17, 0.2]);
    cr.fill();
    if (cleaning) {
        const angle = time * 5;
        if (Math.sin(angle) > 0) {
            cr.setSourceRGBA(1, 0.35, 0.3, Math.sin(angle));
            cr.arc(centerX + turretWidth * 0.92 * Math.cos(angle), turretY - 3 + turretTilt * 0.9 * Math.sin(angle), 1.2, 0, TAU);
            cr.fill();
        }
    }
    plastic(cr, turretY - 12, turretY - 2);
    ellipse(cr, centerX, turretY - 7, turretWidth, turretTilt);
    cr.fill();

    const light = VACUUM_LIGHTS[mode];
    const blink = mode === 'returning' || mode === 'error';
    const level = !light ? 0 : blink ? (Math.sin(time * 6) > -0.3 ? 1 : 0.15) : 0.65 + 0.35 * Math.sin(time * 2.5);
    if (light) {
        const glow = new Cairo.RadialGradient(centerX, lidY + 8, 1, centerX, lidY + 8, 14);
        glow.addColorStopRGBA(0, ...light, 0.45 * level);
        glow.addColorStopRGBA(1, ...light, 0);
        cr.setSource(glow);
        ellipse(cr, centerX, lidY + 8, 14, 6);
        cr.fill();
    }
    cr.setSourceRGB(...(light ? mix([0.62, 0.65, 0.72], light, level) : [0.62, 0.65, 0.72]));
    ellipse(cr, centerX, lidY + 8, 6.5, 2.2);
    cr.fill();
}

function scale(cr, width, height, time, state) {
    const {weight = null, font} = state;
    const centerX = width / 2;
    floorShadow(cr, centerX, 82, 44);
    cr.save();
    cr.translate(centerX, 58);
    cr.scale(1, 0.62);
    roundRect(cr, -40, -38, 80, 76, 14);
    cr.restore();
    const glass = new Cairo.LinearGradient(0, 34, 0, 82);
    glass.addColorStopRGB(0, 0.98, 0.98, 1);
    glass.addColorStopRGB(1, 0.8, 0.82, 0.87);
    cr.setSource(glass);
    cr.fill();
    cr.setSourceRGB(...(weight === null ? [0.62, 0.65, 0.72] : [0.2, 0.5, 0.9]));
    write(cr, weight ?? '– –', {x: centerX, y: 48, size: 10, bold: true, font});
}

function gateway(cr, width, height, time, state) {
    const {light = false, color = [1, 0.84, 0.55]} = state;
    const centerX = width / 2;
    const centerY = 46;
    if (light) {
        const glow = new Cairo.RadialGradient(centerX, centerY, 20, centerX, centerY, 52);
        glow.addColorStopRGBA(0, ...color, 0.55);
        glow.addColorStopRGBA(1, ...color, 0);
        cr.setSource(glow);
        cr.arc(centerX, centerY, 52, 0, TAU);
        cr.fill();
    }
    cr.setSourceRGBA(0, 0, 0, 0.3);
    cr.arc(centerX + 1, centerY + 3, 31, 0, TAU);
    cr.fill();
    const body = new Cairo.RadialGradient(centerX - 8, centerY - 10, 3, centerX, centerY, 31);
    body.addColorStopRGB(0, 1, 1, 1);
    body.addColorStopRGB(1, 0.82, 0.84, 0.88);
    cr.setSource(body);
    cr.arc(centerX, centerY, 30, 0, TAU);
    cr.fill();
    cr.setLineWidth(4);
    cr.setSourceRGB(...(light ? mix(color, [1, 1, 1], 0.35) : [0.74, 0.76, 0.81]));
    cr.arc(centerX, centerY, 23, 0, TAU);
    cr.stroke();
    plastic(cr, centerY - 6, centerY + 6, 0.05);
    cr.arc(centerX, centerY, 5.5, 0, TAU);
    cr.fill();
}

function repeater(cr, width, height, time, state) {
    const {online = true} = state;
    const centerX = width / 2;
    cr.setLineWidth(3.5);
    for (let i = 0; i < 3; i++) {
        const alpha = online ? 0.25 + 0.75 * Math.max(0, Math.sin(time * 2.2 - i * 0.9)) : 0.15;
        cr.setSourceRGBA(0.55, 0.8, 1, alpha);
        cr.newSubPath();
        cr.arc(centerX, 44, 10 + i * 9, -Math.PI * 0.78, -Math.PI * 0.22);
        cr.stroke();
    }
    floorShadow(cr, centerX, 92, 16);
    cr.setSourceRGB(0.62, 0.64, 0.7);
    cr.rectangle(centerX - 6, 82, 12, 8);
    cr.fill();
    plastic(cr, 46, 84);
    roundRect(cr, centerX - 13, 46, 26, 38, 7);
    cr.fill();
    cr.setSourceRGBA(...(online ? [0.4, 0.72, 1, 1] : [0.6, 0.62, 0.68, 1]));
    cr.arc(centerX, 56, 2, 0, TAU);
    cr.fill();
}

function button(cr, width, height, time, state) {
    const {pressed = false} = state;
    const centerX = width / 2;
    const centerY = 48;
    floorShadow(cr, centerX, 76, 34);
    plastic(cr, 26, 76, 0.08);
    cr.rectangle(centerX - 30, centerY, 60, 18);
    cr.fill();
    ellipse(cr, centerX, centerY + 18, 30, 9);
    cr.fill();
    plastic(cr, centerY - 10, centerY + 10);
    ellipse(cr, centerX, centerY, 30, 9);
    cr.fill();
    const top = new Cairo.LinearGradient(0, centerY - 7, 0, centerY + 7);
    top.addColorStopRGB(0, 0.86, 0.87, 0.9);
    top.addColorStopRGB(1, 0.97, 0.97, 0.99);
    cr.setSource(top);
    ellipse(cr, centerX, centerY + (pressed ? 1 : 0), 20, 5.5);
    cr.fill();
}

function fryer(cr, width, height, time, state) {
    const {cooking = false, temperature = null, font} = state;
    const centerX = width / 2;
    if (cooking) {
        cr.setLineWidth(2.2);
        for (let i = 0; i < 3; i++) {
            const share = cycle(time, 2, i, 3);
            const baseX = centerX - 12 + i * 12;
            cr.setSourceRGBA(1, 0.62, 0.3, 0.6 * Math.sin(share * Math.PI));
            const y0 = 14 - share * 12;
            cr.moveTo(baseX, y0 + 8);
            for (let k = 1; k <= 4; k++)
                cr.lineTo(baseX + Math.sin(time * 3 + i + k) * 2.5, y0 + 8 - k * 3);
            cr.stroke();
        }
    }
    floorShadow(cr, centerX, 88, 36);
    plastic(cr, 18, 88);
    roundRect(cr, centerX - 32, 18, 64, 70, 16);
    cr.fill();
    cr.setSourceRGBA(0.3, 0.33, 0.4, 0.3);
    cr.setLineWidth(1);
    cr.moveTo(centerX - 30, 54);
    cr.lineTo(centerX + 30, 54);
    cr.stroke();
    if (cooking) {
        const glow = new Cairo.RadialGradient(centerX, 34, 1, centerX, 34, 20);
        glow.addColorStopRGBA(0, 1, 0.55, 0.2, 0.3);
        glow.addColorStopRGBA(1, 1, 0.55, 0.2, 0);
        cr.setSource(glow);
        cr.arc(centerX, 34, 20, 0, TAU);
        cr.fill();
    }
    cr.setSourceRGB(...(cooking ? [0.95, 0.45, 0.15] : [0.62, 0.65, 0.72]));
    write(cr, temperature === null ? '– –' : `${temperature}°`, {x: centerX, y: 34.5, size: 10, bold: true, font});
    plastic(cr, 62, 72, 0.12);
    roundRect(cr, centerX - 15, 62, 30, 9, 4.5);
    cr.fill();
}

function glyph(cr, width, height, time, state) {
    const centerX = width / 2;
    const centerY = height / 2;
    const disc = new Cairo.RadialGradient(centerX - 10, centerY - 12, 4, centerX, centerY, 38);
    disc.addColorStopRGBA(0, 1, 1, 1, 0.24);
    disc.addColorStopRGBA(1, 1, 1, 1, 0.08);
    cr.setSource(disc);
    cr.arc(centerX, centerY, 38, 0, TAU);
    cr.fill();
    cr.save();
    cr.translate(centerX - 24, centerY - 24);
    cr.scale(3, 3);
    cr.setSourceRGB(1, 1, 1);
    Glyphs.draw(cr, state.glyph ?? 'appliance');
    cr.restore();
}

function scooter(cr, width, height, time, state) {
    const centerX = width / 2;
    floorShadow(cr, centerX, 88, 48);
    cr.setSourceRGB(0.3, 0.32, 0.38);
    cr.setLineWidth(4);
    cr.moveTo(centerX + 24, 76);
    cr.lineTo(centerX + 14, 16);
    cr.stroke();
    cr.setLineWidth(3.5);
    cr.moveTo(centerX + 6, 16);
    cr.lineTo(centerX + 22, 16);
    cr.stroke();
    plastic(cr, 68, 78, 0.1);
    roundRect(cr, centerX - 34, 70, 56, 7, 3);
    cr.fill();
    for (const x of [centerX - 32, centerX + 26]) {
        cr.setSourceRGB(0.14, 0.15, 0.18);
        cr.arc(x, 78, 10, 0, TAU);
        cr.fill();
        cr.setSourceRGB(0.7, 0.72, 0.78);
        cr.arc(x, 78, 4, 0, TAU);
        cr.fill();
    }
}

const KELVIN = [
    [1700, [1, 0.6, 0.28]],
    [2700, [1, 0.78, 0.48]],
    [4000, [1, 0.91, 0.8]],
    [6500, [0.9, 0.94, 1]],
];

export function kelvinColor(kelvin) {
    return ramp(KELVIN, kelvin, mix);
}

function bulb(cr, width, height, time, state) {
    const {on = false, color = [1, 0.84, 0.55], brightness = 100} = state;
    const share = Math.max(0.15, Math.min(1, brightness / 100));
    const centerX = width / 2;
    const centerY = 54;
    const radius = 19;
    const neck = centerY - radius - 5;

    if (on) {
        const reach = radius + 12 + 22 * share;
        const glow = new Cairo.RadialGradient(centerX, centerY, radius * 0.5, centerX, centerY, reach);
        glow.addColorStopRGBA(0, ...color, 0.3 + 0.45 * share);
        glow.addColorStopRGBA(1, ...color, 0);
        cr.setSource(glow);
        cr.arc(centerX, centerY, reach, 0, TAU);
        cr.fill();
        cr.setLineWidth(2.5);
        for (let i = -3; i <= 3; i++) {
            const angle = Math.PI / 2 + i * 0.62;
            const pulse = 0.5 + 0.5 * Math.sin(time * 1.6 + i * 0.9);
            const from = radius + 6;
            const to = radius + 10 + 5 * pulse * share;
            cr.setSourceRGBA(...color, (0.3 + 0.5 * pulse) * share);
            cr.moveTo(centerX + from * Math.cos(angle), centerY + from * Math.sin(angle));
            cr.lineTo(centerX + to * Math.cos(angle), centerY + to * Math.sin(angle));
            cr.stroke();
        }
    }

    cr.setSourceRGB(0.3, 0.32, 0.36);
    cr.setLineWidth(2);
    cr.moveTo(centerX, 0);
    cr.lineTo(centerX, neck - 12);
    cr.stroke();
    const metal = new Cairo.LinearGradient(centerX - 7, 0, centerX + 7, 0);
    metal.addColorStopRGB(0, 0.62, 0.64, 0.68);
    metal.addColorStopRGB(0.4, 0.92, 0.93, 0.95);
    metal.addColorStopRGB(1, 0.55, 0.57, 0.62);
    cr.setSource(metal);
    roundRect(cr, centerX - 7, neck - 13, 14, 14, 3);
    cr.fill();
    cr.setSourceRGBA(0.4, 0.42, 0.47, 0.6);
    cr.setLineWidth(0.9);
    for (const y of [neck - 9, neck - 5]) {
        cr.moveTo(centerX - 7, y);
        cr.lineTo(centerX + 7, y + 1.5);
        cr.stroke();
    }

    const glass = () => {
        const side = radius * Math.cos(Math.PI / 6);
        const shoulder = centerY - radius / 2;
        cr.moveTo(centerX + 6, neck);
        cr.curveTo(centerX + 6, neck + 5, centerX + side - 3, shoulder - 5, centerX + side, shoulder);
        cr.arc(centerX, centerY, radius, -Math.PI / 6, Math.PI + Math.PI / 6);
        cr.curveTo(centerX - side + 3, shoulder - 5, centerX - 6, neck + 5, centerX - 6, neck);
        cr.closePath();
    };
    if (on) {
        const inside = new Cairo.RadialGradient(centerX, centerY - 2, 2, centerX, centerY, radius + 2);
        inside.addColorStopRGB(0, 1, 1, 0.98);
        inside.addColorStopRGB(1, ...mix(color, [1, 1, 1], 0.25));
        cr.setSource(inside);
    } else {
        cr.setSourceRGBA(0.86, 0.88, 0.92, 0.3);
    }
    glass();
    cr.fill();
    cr.setLineWidth(1.2);
    cr.setSourceRGBA(...(on ? mix(color, [1, 1, 1], 0.5) : [0.72, 0.75, 0.81]), 0.9);
    glass();
    cr.stroke();

    cr.setLineWidth(1);
    cr.setSourceRGBA(...(on ? [1, 0.97, 0.85] : [0.42, 0.44, 0.5]), 0.95);
    cr.moveTo(centerX - 3, neck + 1);
    cr.lineTo(centerX - 6, centerY);
    cr.moveTo(centerX + 3, neck + 1);
    cr.lineTo(centerX + 6, centerY);
    cr.stroke();
    cr.setLineWidth(1.4);
    cr.moveTo(centerX - 6, centerY);
    for (let i = 1; i <= 6; i++)
        cr.lineTo(centerX - 6 + i * 2, centerY + (i % 2 ? -2 : 0));
    cr.stroke();

    cr.setSourceRGBA(1, 1, 1, on ? 0.6 : 0.45);
    cr.setLineWidth(2);
    cr.arc(centerX, centerY, radius - 5, Math.PI * 1.05, Math.PI * 1.32);
    cr.stroke();
}

function socket(cr, width, height, time, state) {
    const {on = false, kind = 'outlet'} = state;
    const size = 62;
    const centerX = width / 2;
    const top = 10;
    const centerY = top + size / 2;
    const left = centerX - size / 2;
    const green = [0.36, 0.86, 0.55];

    shadow(cr, left, top, size, size, 12, 5);
    plastic(cr, top, top + size);
    roundRect(cr, left, top, size, size, 12);
    cr.fill();

    if (kind === 'switch') {
        const rocker = new Cairo.LinearGradient(0, centerY - 20, 0, centerY + 20);
        rocker.addColorStopRGB(on ? 0 : 1, 0.84, 0.86, 0.9);
        rocker.addColorStopRGB(on ? 1 : 0, 1, 1, 1);
        cr.setSource(rocker);
        roundRect(cr, centerX - 14, centerY - 20, 28, 40, 6);
        cr.fill();
        cr.setSourceRGBA(0.55, 0.58, 0.64, 0.5);
        cr.setLineWidth(0.8);
        roundRect(cr, centerX - 14, centerY - 20, 28, 40, 6);
        cr.stroke();
        cr.moveTo(centerX - 12, centerY);
        cr.lineTo(centerX + 12, centerY);
        cr.stroke();
        cr.setSourceRGB(...(on ? green : [0.7, 0.72, 0.77]));
        roundRect(cr, centerX - 4, centerY + 12, 8, 2.4, 1.2);
        cr.fill();
        return;
    }

    const hollow = new Cairo.RadialGradient(centerX, centerY - 4, 4, centerX, centerY, 22);
    hollow.addColorStopRGB(0, 0.74, 0.76, 0.81);
    hollow.addColorStopRGB(1, 0.86, 0.88, 0.92);
    cr.setSource(hollow);
    cr.arc(centerX, centerY, 21, 0, TAU);
    cr.fill();

    const cord = () => {
        cr.moveTo(centerX, centerY + 8);
        cr.curveTo(centerX, centerY + 30, centerX + 22, height - 18, centerX + 26, height + 4);
    };
    cr.setSourceRGB(0.28, 0.3, 0.34);
    cr.setLineWidth(5);
    cord();
    cr.stroke();
    if (on) {
        cr.setSourceRGBA(...green, 0.9);
        cr.setLineWidth(1.6);
        cr.setDash([3, 7], -time * 14);
        cord();
        cr.stroke();
        cr.setDash([], 0);
    }

    cr.setSourceRGBA(0, 0, 0, 0.25);
    cr.arc(centerX + 1, centerY + 2, 16, 0, TAU);
    cr.fill();
    const face = new Cairo.RadialGradient(centerX - 5, centerY - 6, 2, centerX, centerY, 16);
    face.addColorStopRGB(0, 0.99, 0.99, 1);
    face.addColorStopRGB(1, 0.8, 0.82, 0.87);
    cr.setSource(face);
    cr.arc(centerX, centerY, 15, 0, TAU);
    cr.fill();
    cr.setSourceRGBA(0.6, 0.63, 0.69, 0.5);
    cr.setLineWidth(1);
    for (const x of [-5, 0, 5]) {
        cr.moveTo(centerX + x, centerY - 9);
        cr.lineTo(centerX + x, centerY - 3);
        cr.stroke();
    }
    if (on) {
        const glow = new Cairo.RadialGradient(centerX, centerY + 6, 0.5, centerX, centerY + 6, 7);
        glow.addColorStopRGBA(0, ...green, 0.7);
        glow.addColorStopRGBA(1, ...green, 0);
        cr.setSource(glow);
        cr.arc(centerX, centerY + 6, 7, 0, TAU);
        cr.fill();
    }
    cr.setSourceRGB(...(on ? green : [0.66, 0.68, 0.73]));
    cr.arc(centerX, centerY + 6, 2, 0, TAU);
    cr.fill();
}

function fabric(cr, left, top, width, height, [r, g, b]) {
    const gradient = new Cairo.LinearGradient(0, top, 0, top + height);
    gradient.addColorStopRGB(0, Math.min(1, r + 0.05), Math.min(1, g + 0.05), Math.min(1, b + 0.05));
    gradient.addColorStopRGB(1, r - 0.17, g - 0.17, b - 0.17);
    cr.save();
    cr.clipPreserve();
    cr.setSource(gradient);
    cr.fill();
    cr.setSourceRGBA(0, 0, 0, 0.08);
    for (let y = top + 1.5, row = 0; y < top + height; y += 3, row++) {
        for (let x = left + (row % 2) * 1.5; x < left + width; x += 3) {
            cr.newSubPath();
            cr.arc(x, y, 0.5, 0, TAU);
        }
    }
    cr.fill();
    cr.restore();
}

const CHALK = [0.93, 0.93, 0.91];

function lights(cr, centerX, y, gap, time, on) {
    if (!on)
        return;
    for (let i = 0; i < 4; i++) {
        cr.setSourceRGBA(1, 1, 1, 0.35 + 0.65 * Math.abs(Math.sin(time * 2.6 + i * 0.7)));
        cr.newSubPath();
        cr.arc(centerX + (i - 1.5) * gap, y, 1.4, 0, TAU);
        cr.fill();
    }
}

function puck(cr, time, state) {
    floorShadow(cr, 0, 1, 40);
    cr.newPath();
    cr.moveTo(-34, -21);
    cr.lineTo(-34, -11);
    cr.save();
    cr.translate(0, -11);
    cr.scale(34, 11);
    cr.arcNegative(0, 0, 1, Math.PI, 0);
    cr.restore();
    cr.lineTo(34, -21);
    cr.closePath();
    fabric(cr, -34, -21, 68, 21, CHALK.map(v => v - 0.12));
    ellipse(cr, 0, -21, 34, 11);
    fabric(cr, -34, -32, 68, 22, CHALK);
    lights(cr, 0, -21, 6, time, state.playing);
}

function tower(cr, time, state) {
    floorShadow(cr, 0, 1, 30);
    roundRect(cr, -21, -64, 42, 64, 19);
    fabric(cr, -21, -64, 42, 64, CHALK);
    const sheen = new Cairo.LinearGradient(-21, 0, 21, 0);
    sheen.addColorStopRGBA(0, 1, 1, 1, 0.2);
    sheen.addColorStopRGBA(0.5, 1, 1, 1, 0);
    sheen.addColorStopRGBA(1, 0, 0, 0, 0.12);
    roundRect(cr, -21, -64, 42, 64, 19);
    cr.setSource(sheen);
    cr.fill();
    lights(cr, 0, -50, 5, time, state.playing);
}

function display(cr, time, state) {
    const {playing = false, color = [0.6, 0.5, 1]} = state;
    floorShadow(cr, 0, 1, 38);
    roundRect(cr, -30, -20, 60, 20, 9);
    fabric(cr, -30, -20, 60, 20, CHALK);
    shadow(cr, -36, -66, 72, 48, 6, 3);
    roundRect(cr, -36, -66, 72, 48, 6);
    cr.setSourceRGB(0.97, 0.97, 0.98);
    cr.fill();
    const glow = new Cairo.LinearGradient(0, -63, 0, -21);
    glow.addColorStopRGB(0, ...mix(color, [1, 1, 1], 0.45));
    glow.addColorStopRGB(1, ...mix(color, [0, 0, 0], 0.2));
    roundRect(cr, -33, -63, 66, 42, 4);
    cr.setSource(glow);
    cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.9);
    for (let i = 0; i < 7; i++) {
        const level = playing ? 0.25 + 0.75 * Math.abs(Math.sin(time * (2 + i * 0.37) + i)) : 0.12;
        const tall = 4 + level * 22;
        roundRect(cr, -23.5 + i * 7, -27 - tall, 4, tall, 2);
        cr.fill();
    }
}

function place(cr, x, y, size, draw, time, state) {
    cr.save();
    cr.translate(x, y);
    cr.scale(size, size);
    draw(cr, time, state);
    cr.restore();
}

function soundWaves(cr, centerX, middleY, half, time, volume) {
    cr.setLineWidth(2.2);
    for (let i = 0; i < 3; i++) {
        const share = cycle(time, 1.8, i, 3);
        const radius = half + 6 + share * 14;
        cr.setSourceRGBA(1, 1, 1, (1 - share) * (0.25 + 0.5 * volume));
        cr.newPath();
        for (const side of [0, Math.PI]) {
            cr.newSubPath();
            cr.arc(centerX, middleY, radius, side - 0.45, side + 0.45);
        }
        cr.stroke();
    }
}

function speaker(cr, width, height, time, state) {
    const {kind = 'tower', playing = false, volume = 0.5, muted = false} = state;
    const centerX = width / 2;
    const base = 84;
    const [half, middle] = {puck: [34, base - 16], display: [36, base - 42], group: [40, base - 26]}[kind] ?? [21, base - 32];
    if (playing && !muted)
        soundWaves(cr, centerX, middle, half, time, volume ?? 0.5);
    if (kind === 'group') {
        place(cr, centerX + 17, base, 0.8, tower, time, state);
        place(cr, centerX - 15, base + 2, 0.8, puck, time, state);
    } else {
        place(cr, centerX, base, 1, {puck, display}[kind] ?? tower, time, state);
    }
}

const ROOM_COLORS = [
    [0.42, 0.64, 1],
    [0.98, 0.68, 0.38],
    [0.45, 0.82, 0.58],
    [0.76, 0.58, 0.96],
    [0.96, 0.58, 0.66],
    [0.42, 0.8, 0.86],
    [0.92, 0.82, 0.42],
];

// Map y runs up, screen y down.
function floorPlan(cr, width, height, time, state) {
    const {map, working = false} = state;
    if (!map)
        return;
    const size = Math.min((width - 8) / map.width, (height - 8) / map.height);
    const left = (width - map.width * size) / 2;
    const top = (height - map.height * size) / 2;
    const at = (x, y) => [
        left + (x - map.left) / map.grid * size,
        top + (map.height - (y - map.top) / map.grid) * size,
    ];
    // Saved map: kind is a room id, 0x80 marks walls. New map: 1 floor, 2 wall.
    const colors = new Map();
    const colorOf = kind => {
        if (!map.rooms)
            return {1: [0.42, 0.64, 1, 0.5], 2: [0.8, 0.88, 1, 0.95]}[kind] ?? null;
        if (kind & 0x80)
            return [0.8, 0.88, 1, 0.95];
        if (!colors.has(kind))
            colors.set(kind, [...ROOM_COLORS[colors.size % ROOM_COLORS.length], 0.6]);
        return colors.get(kind);
    };
    const kinds = [...new Set(map.runs.map(run => run[3]))].sort((a, b) => (a & 0x80) - (b & 0x80) || a - b);
    for (const kind of kinds) {
        const color = colorOf(kind);
        if (!color)
            continue;
        cr.setSourceRGBA(...color);
        for (const [row, from, to, which] of map.runs) {
            if (which === kind)
                cr.rectangle(left + from * size, top + (map.height - 1 - row) * size, (to - from) * size, size);
        }
        cr.fill();
    }

    if (map.path.length > 1) {
        cr.setSourceRGBA(1, 1, 1, 0.75);
        cr.setLineWidth(Math.max(1.3, size * 0.5));
        cr.newPath();
        for (const point of map.path) {
            const [x, y] = at(point.x, point.y);
            if (point.jump)
                cr.moveTo(x, y);
            else
                cr.lineTo(x, y);
        }
        cr.stroke();
    }

    // 32767: position unknown.
    if (map.charger.x !== 32767) {
        const [chargerX, chargerY] = at(map.charger.x, map.charger.y);
        cr.setSourceRGBA(0, 0, 0, 0.3);
        roundRect(cr, chargerX - 6, chargerY - 4, 12, 10, 3);
        cr.fill();
        cr.setSourceRGB(0.36, 0.82, 0.56);
        roundRect(cr, chargerX - 6, chargerY - 5, 12, 10, 3);
        cr.fill();
        cr.setSourceRGB(1, 1, 1);
        cr.arc(chargerX, chargerY, 1.6, 0, TAU);
        cr.fill();
    }

    const [robotX, robotY] = at(map.robot.x, map.robot.y);
    if (working) {
        const share = cycle(time, 1.6);
        cr.setSourceRGBA(0.42, 0.64, 1, 0.6 * (1 - share));
        cr.arc(robotX, robotY, 7 + share * 10, 0, TAU);
        cr.fill();
    }
    cr.setSourceRGBA(0, 0, 0, 0.3);
    cr.arc(robotX, robotY + 1, 7, 0, TAU);
    cr.fill();
    cr.setSourceRGB(1, 1, 1);
    cr.arc(robotX, robotY, 7, 0, TAU);
    cr.fill();
    cr.setSourceRGB(0.3, 0.55, 0.98);
    cr.arc(robotX, robotY, 3.2, 0, TAU);
    cr.fill();
}

function progress(cr, width, height, time, state) {
    const {share = 0, color = [1, 1, 1]} = state;
    roundRect(cr, 0, 2, width, 4, 2);
    cr.setSourceRGBA(1, 1, 1, 0.18);
    cr.fill();
    if (share > 0) {
        roundRect(cr, 0, 2, Math.max(4, width * Math.min(1, share)), 4, 2);
        cr.setSourceRGBA(...color, 0.95);
        cr.fill();
    }
}

function television(cr, width, height, time, state) {
    const {on = false, volume = null, muted = false, label = '', font = null} = state;
    const centerX = width / 2;
    const screenWidth = 104;
    const screenHeight = 60;
    const left = centerX - screenWidth / 2;
    const top = 8;
    const hue = (time * 14) % 360;
    const glow = fromHsv([hue, 0.5, 1]);

    if (on) {
        cr.save();
        cr.translate(centerX, top + screenHeight / 2);
        cr.scale(1, 0.55);
        const light = new Cairo.RadialGradient(0, 0, 30, 0, 0, 68);
        light.addColorStopRGBA(0, ...glow, 0.32);
        light.addColorStopRGBA(1, ...glow, 0);
        cr.setSource(light);
        cr.arc(0, 0, 68, 0, TAU);
        cr.fill();
        cr.restore();
    }
    floorShadow(cr, centerX, 88, 36);
    cr.setSourceRGB(0.14, 0.15, 0.18);
    roundRect(cr, centerX - 3.5, top + screenHeight - 2, 7, 16, 2);
    cr.fill();
    roundRect(cr, centerX - 24, top + screenHeight + 12, 48, 5, 2.5);
    cr.fill();

    shadow(cr, left, top, screenWidth, screenHeight, 5, 4);
    cr.setSourceRGB(0.09, 0.09, 0.11);
    roundRect(cr, left, top, screenWidth, screenHeight, 5);
    cr.fill();

    const inset = 3;
    const glassLeft = left + inset;
    const glassTop = top + inset;
    const glassWidth = screenWidth - 2 * inset;
    const glassHeight = screenHeight - 2 * inset;
    cr.save();
    roundRect(cr, glassLeft, glassTop, glassWidth, glassHeight, 2.5);
    cr.clip();
    const glass = new Cairo.LinearGradient(glassLeft, glassTop, glassLeft + glassWidth, glassTop + glassHeight);
    if (on) {
        glass.addColorStopRGB(0, ...fromHsv([hue, 0.55, 0.95]));
        glass.addColorStopRGB(0.55, ...fromHsv([(hue + 50) % 360, 0.6, 0.75]));
        glass.addColorStopRGB(1, ...fromHsv([(hue + 110) % 360, 0.65, 0.55]));
    } else {
        glass.addColorStopRGB(0, 0.07, 0.08, 0.1);
        glass.addColorStopRGB(1, 0.16, 0.17, 0.2);
    }
    cr.setSource(glass);
    cr.paint();
    if (on) {
        const x = glassLeft + glassWidth * (0.5 + 0.35 * Math.sin(time * 0.6));
        const y = glassTop + glassHeight * (0.5 + 0.3 * Math.cos(time * 0.45));
        const blob = new Cairo.RadialGradient(x, y, 0, x, y, 34);
        blob.addColorStopRGBA(0, 1, 1, 1, 0.28);
        blob.addColorStopRGBA(1, 1, 1, 1, 0);
        cr.setSource(blob);
        cr.paint();
    }
    cr.setSourceRGBA(1, 1, 1, on ? 0.07 : 0.05);
    cr.moveTo(glassLeft + glassWidth * 0.55, glassTop);
    cr.lineTo(glassLeft + glassWidth * 0.8, glassTop);
    cr.lineTo(glassLeft + glassWidth * 0.45, glassTop + glassHeight);
    cr.lineTo(glassLeft + glassWidth * 0.2, glassTop + glassHeight);
    cr.closePath();
    cr.fill();
    if (on && label) {
        cr.setSourceRGBA(1, 1, 1, 0.92);
        write(cr, label, {x: centerX, y: glassTop + glassHeight / 2 - 4, size: 10, bold: true, font});
    }
    if (on && typeof volume === 'number') {
        const barWidth = 56;
        const barLeft = centerX - barWidth / 2;
        const barTop = glassTop + glassHeight - 9;
        cr.setSourceRGBA(0, 0, 0, 0.3);
        roundRect(cr, barLeft, barTop, barWidth, 3.5, 1.75);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, muted ? 0.35 : 0.9);
        const share = Math.max(0, Math.min(1, volume));
        if (share > 0) {
            roundRect(cr, barLeft, barTop, Math.max(3.5, barWidth * share), 3.5, 1.75);
            cr.fill();
        }
    }
    cr.restore();
}

function rising(cr, centerX, bottom, time, {spread = 12, count = 3, length = 18, alpha = 0.55}) {
    cr.setLineWidth(2);
    for (let i = 0; i < count; i++) {
        const share = cycle(time, 2.2, i, count);
        const x = count > 1 ? centerX - spread + i * 2 * spread / (count - 1) : centerX;
        const y = bottom - share * length * 0.6;
        cr.setSourceRGBA(1, 1, 1, alpha * Math.sin(share * Math.PI));
        cr.moveTo(x, y);
        for (let k = 1; k <= 4; k++)
            cr.lineTo(x + Math.sin(time * 2.5 + i * 1.7 + k) * 2.2, y - k * length / 4);
        cr.stroke();
    }
}

function darkFace(cr, left, top, width, height, radius) {
    const face = new Cairo.LinearGradient(0, top, 0, top + height);
    face.addColorStopRGB(0, 0.32, 0.34, 0.4);
    face.addColorStopRGB(1, 0.18, 0.2, 0.24);
    cr.setSource(face);
    roundRect(cr, left, top, width, height, radius);
    cr.fill();
}

const IDLE_LIGHT = [0.66, 0.68, 0.73];
const BLUE_LIGHT = [0.36, 0.75, 0.98];

function washer(cr, width, height, time, state) {
    const {working = false} = state;
    const centerX = width / 2;
    const size = 68;
    const left = centerX - size / 2;
    const top = 6;
    floorShadow(cr, centerX, 88, 40);
    shadow(cr, left, top, size, 80, 8, 4);
    plastic(cr, top, top + 80);
    roundRect(cr, left, top, size, 80, 8);
    cr.fill();
    cr.setSourceRGBA(0.55, 0.58, 0.64, 0.35);
    cr.setLineWidth(0.8);
    cr.moveTo(left + 4, top + 16);
    cr.lineTo(left + size - 4, top + 16);
    cr.stroke();
    cr.setSourceRGB(0.78, 0.8, 0.85);
    cr.arc(left + size - 13, top + 8, 4, 0, TAU);
    cr.fill();
    cr.setSourceRGB(...(working ? BLUE_LIGHT : IDLE_LIGHT));
    roundRect(cr, left + 8, top + 5.5, 18, 5, 2);
    cr.fill();

    const doorY = top + 48;
    cr.setSourceRGB(0.72, 0.75, 0.8);
    cr.arc(centerX, doorY, 24, 0, TAU);
    cr.fill();
    const glass = new Cairo.RadialGradient(centerX - 6, doorY - 8, 2, centerX, doorY, 20);
    glass.addColorStopRGB(0, 0.42, 0.55, 0.7);
    glass.addColorStopRGB(1, 0.16, 0.22, 0.3);
    cr.setSource(glass);
    cr.arc(centerX, doorY, 19, 0, TAU);
    cr.fill();
    cr.save();
    cr.arc(centerX, doorY, 19, 0, TAU);
    cr.clip();
    if (working) {
        cr.setSourceRGBA(0.4, 0.7, 1, 0.45);
        cr.rectangle(centerX - 20, doorY + 4 + Math.sin(time * 3) * 1.5, 40, 30);
        cr.fill();
    }
    const turn = working ? time * 2.4 : 0.6;
    [[0.95, 0.55, 0.45], [0.98, 0.85, 0.4], [0.55, 0.75, 0.98]].forEach((color, i) => {
        const angle = turn + i * TAU / 3;
        cr.setSourceRGBA(...color, 0.85);
        ellipse(cr, centerX + Math.cos(angle) * 9, doorY + Math.sin(angle) * 9 + (working ? 0 : 6), 7, 4.5);
        cr.fill();
    });
    cr.restore();
    cr.setSourceRGBA(1, 1, 1, 0.25);
    cr.setLineWidth(2);
    cr.arc(centerX, doorY, 15, -2.6, -1.8);
    cr.stroke();
}

function dishwasher(cr, width, height, time, state) {
    const {working = false} = state;
    const centerX = width / 2;
    const left = centerX - 34;
    const top = 16;
    const bottom = 86;
    if (working)
        rising(cr, centerX, top - 1, time, {spread: 16, length: 14, alpha: 0.4});
    floorShadow(cr, centerX, 89, 40);
    shadow(cr, left, top, 68, bottom - top, 6, 4);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, 68, bottom - top, 6);
    cr.fill();
    cr.setSourceRGBA(0.55, 0.58, 0.64, 0.4);
    cr.setLineWidth(0.8);
    cr.moveTo(left + 3, top + 12);
    cr.lineTo(left + 65, top + 12);
    cr.stroke();
    cr.setSourceRGB(...(working ? BLUE_LIGHT : IDLE_LIGHT));
    for (const x of [-20, -13, -6]) {
        cr.arc(centerX + x, top + 6, 1.6, 0, TAU);
        cr.fill();
    }
    cr.setSourceRGB(0.62, 0.65, 0.71);
    roundRect(cr, centerX - 16, top + 18, 32, 3.5, 1.75);
    cr.fill();
    if (working) {
        const glow = new Cairo.RadialGradient(centerX, bottom + 4, 1, centerX, bottom + 4, 18);
        glow.addColorStopRGBA(0, ...BLUE_LIGHT, 0.7);
        glow.addColorStopRGBA(1, ...BLUE_LIGHT, 0);
        cr.setSource(glow);
        ellipse(cr, centerX, bottom + 4, 18, 3);
        cr.fill();
    }
}

function purifier(cr, width, height, time, state) {
    const {on = false, level = 1, color = [0.36, 0.86, 0.55]} = state;
    const centerX = width / 2;
    const towerWidth = 42;
    const left = centerX - towerWidth / 2;
    const top = 14;
    const bottom = 88;
    if (on) {
        cr.setLineWidth(1.8);
        for (let i = 0; i < 3; i++) {
            const share = cycle(time, 2.4 / (0.6 + level * 0.4), i, 3);
            cr.setSourceRGBA(0.8, 0.95, 1, 0.55 * Math.sin(share * Math.PI));
            const y = top - 2 - share * 10;
            cr.moveTo(centerX - 14, y);
            cr.curveTo(centerX - 6, y - 4, centerX + 6, y + 4, centerX + 14, y);
            cr.stroke();
        }
    }
    floorShadow(cr, centerX, bottom, 28);
    shadow(cr, left, top, towerWidth, bottom - top, 10, 4);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, towerWidth, bottom - top, 10);
    cr.fill();
    cr.setSourceRGB(0.7, 0.73, 0.78);
    ellipse(cr, centerX, top + 3, towerWidth / 2 - 4, 2.2);
    cr.fill();
    cr.setSourceRGB(...(on ? color : IDLE_LIGHT));
    cr.setLineWidth(2);
    cr.newSubPath();
    cr.arc(centerX, top + 16, 5, 0, TAU);
    cr.stroke();
    cr.setSourceRGBA(0.45, 0.48, 0.55, 0.45);
    for (let row = 0; row < 7; row++) {
        for (let column = 0; column < 6; column++) {
            cr.arc(left + 8 + column * 5.2, top + 34 + row * 6.5, 1.1, 0, TAU);
            cr.fill();
        }
    }
    if (on) {
        for (let i = 0; i < 6; i++) {
            const share = cycle(time, 1.8, i, 6);
            const side = i % 2 ? 1 : -1;
            cr.setSourceRGBA(0.85, 0.85, 0.8, 0.6 * (1 - share));
            cr.arc(centerX + side * (towerWidth / 2 + 16 - share * 14), top + 40 + (i * 7) % 36, 1.3, 0, TAU);
            cr.fill();
        }
    }
}

function humidifier(cr, width, height, time, state) {
    const {on = false, water = null} = state;
    const centerX = width / 2;
    const bodyWidth = 54;
    const left = centerX - bodyWidth / 2;
    const top = 40;
    const bottom = 88;
    if (on) {
        for (let i = 0; i < 5; i++) {
            const share = cycle(time, 3, i, 5);
            cr.setSourceRGBA(0.92, 0.96, 1, 0.35 * (1 - share));
            cr.arc(centerX + Math.sin(time + i * 1.3) * 3 * share, top - 8 - share * 26, 4 + share * 9, 0, TAU);
            cr.fill();
        }
    }
    floorShadow(cr, centerX, bottom, 32);
    const tankTop = top + 2;
    const tankBottom = bottom - 14;
    const tank = () => roundRect(cr, left + 4, tankTop, bodyWidth - 8, tankBottom - tankTop, 10);
    cr.setSourceRGBA(0.85, 0.92, 1, 0.35);
    tank();
    cr.fill();
    if (water !== null) {
        const surface = tankBottom - (tankBottom - tankTop - 4) * Math.max(0, Math.min(1, water));
        cr.save();
        tank();
        cr.clip();
        cr.setSourceRGBA(0.35, 0.65, 1, 0.65);
        cr.rectangle(left, surface, bodyWidth, tankBottom - surface);
        cr.fill();
        cr.restore();
    }
    cr.setSourceRGBA(1, 1, 1, 0.5);
    cr.setLineWidth(1);
    tank();
    cr.stroke();
    plastic(cr, bottom - 16, bottom);
    roundRect(cr, left, bottom - 16, bodyWidth, 16, 7);
    cr.fill();
    plastic(cr, top - 6, top + 4, 0.05);
    roundRect(cr, centerX - 9, top - 6, 18, 9, 4);
    cr.fill();
    cr.setSourceRGB(...(on ? BLUE_LIGHT : IDLE_LIGHT));
    cr.arc(centerX, bottom - 8, 2, 0, TAU);
    cr.fill();
}

function dehumidifier(cr, width, height, time, state) {
    const {on = false} = state;
    const centerX = width / 2;
    const bodyWidth = 52;
    const left = centerX - bodyWidth / 2;
    const top = 8;
    const bottom = 88;
    floorShadow(cr, centerX, bottom, 32);
    shadow(cr, left, top, bodyWidth, bottom - top, 9, 4);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, bodyWidth, bottom - top, 9);
    cr.fill();
    cr.setSourceRGBA(0.45, 0.48, 0.55, 0.5);
    cr.setLineWidth(1.2);
    for (let i = 0; i < 5; i++) {
        cr.moveTo(left + 9, top + 7 + i * 3.2);
        cr.lineTo(left + bodyWidth - 9, top + 7 + i * 3.2);
    }
    cr.stroke();
    const tankX = left + 7;
    const tankY = bottom - 34;
    const tankWidth = bodyWidth - 14;
    const tankHeight = 26;
    cr.setSourceRGBA(0.3, 0.35, 0.45, 0.2);
    roundRect(cr, tankX, tankY, tankWidth, tankHeight, 5);
    cr.fill();
    cr.setSourceRGBA(0.35, 0.65, 1, 0.55);
    roundRect(cr, tankX + 2, tankY + tankHeight * 0.55, tankWidth - 4, tankHeight * 0.45 - 2, 3);
    cr.fill();
    if (on) {
        const share = cycle(time, 1.2);
        cr.setSourceRGBA(0.45, 0.72, 1, 0.9 - share * 0.4);
        drop(cr, centerX, tankY + 2 + share * tankHeight * 0.4, 5);
        cr.fill();
    }
    cr.setSourceRGB(...(on ? BLUE_LIGHT : IDLE_LIGHT));
    cr.arc(centerX, top + 30, 3, 0, TAU);
    cr.fill();
}

function heater(cr, width, height, time, state) {
    const {on = false} = state;
    const centerX = width / 2;
    const fins = 7;
    const finWidth = 9;
    const gap = 2;
    const total = fins * finWidth + (fins - 1) * gap;
    const left = centerX - total / 2;
    const top = 18;
    const bottom = 82;
    if (on) {
        cr.setLineWidth(2);
        for (let i = 0; i < 4; i++) {
            const share = cycle(time, 2.4, i, 4);
            const x = left + 8 + i * (total - 16) / 3;
            const y = top - 2 - share * 10;
            cr.setSourceRGBA(1, 0.6, 0.35, 0.5 * Math.sin(share * Math.PI));
            cr.moveTo(x, y + 8);
            cr.curveTo(x - 3, y + 5, x + 3, y + 2, x, y - 1);
            cr.stroke();
        }
    }
    floorShadow(cr, centerX, 90, total / 2 + 6);
    const warm = on ? [1, 0.82, 0.72] : [0.95, 0.96, 0.98];
    for (let i = 0; i < fins; i++) {
        const x = left + i * (finWidth + gap);
        const fin = new Cairo.LinearGradient(x, 0, x + finWidth, 0);
        fin.addColorStopRGB(0, ...warm.map(v => v * 0.82));
        fin.addColorStopRGB(0.5, ...warm);
        fin.addColorStopRGB(1, ...warm.map(v => v * 0.8));
        cr.setSource(fin);
        roundRect(cr, x, top, finWidth, bottom - top, 4.5);
        cr.fill();
    }
    cr.setSourceRGB(0.4, 0.42, 0.47);
    for (const x of [left + 6, left + total - 6]) {
        roundRect(cr, x - 4, bottom, 8, 6, 2);
        cr.fill();
    }
    cr.setSourceRGB(...(on ? [1, 0.45, 0.25] : IDLE_LIGHT));
    cr.arc(left + total - finWidth / 2, top + 8, 1.8, 0, TAU);
    cr.fill();
}

function curtain(cr, width, height, time, state) {
    const {position = null} = state;
    const centerX = width / 2;
    const windowWidth = 92;
    const left = centerX - windowWidth / 2;
    const top = 10;
    const bottom = 86;
    const sky = new Cairo.LinearGradient(0, top, 0, bottom);
    sky.addColorStopRGB(0, 0.55, 0.78, 0.98);
    sky.addColorStopRGB(1, 0.85, 0.93, 1);
    cr.setSource(sky);
    roundRect(cr, left + 6, top + 4, windowWidth - 12, bottom - top - 8, 3);
    cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.8);
    cr.setLineWidth(2.5);
    roundRect(cr, left + 6, top + 4, windowWidth - 12, bottom - top - 8, 3);
    cr.stroke();
    cr.moveTo(centerX, top + 4);
    cr.lineTo(centerX, bottom - 4);
    cr.stroke();
    cr.setSourceRGB(0.55, 0.5, 0.48);
    cr.setLineWidth(3);
    cr.moveTo(left, top);
    cr.lineTo(left + windowWidth, top);
    cr.stroke();
    const open = position === null ? 0.5 : Math.max(0, Math.min(1, position));
    const panel = windowWidth / 2 * (1 - open * 0.8);
    for (const side of [-1, 1]) {
        const outer = side < 0 ? left : left + windowWidth;
        for (let i = 0; i < 4; i++) {
            const from = outer - side * panel * i / 4;
            const to = outer - side * panel * (i + 1) / 4;
            const fold = new Cairo.LinearGradient(Math.min(from, to), 0, Math.max(from, to), 0);
            fold.addColorStopRGB(0, 0.62, 0.5, 0.82);
            fold.addColorStopRGB(0.5, 0.78, 0.66, 0.95);
            fold.addColorStopRGB(1, 0.6, 0.48, 0.8);
            cr.setSource(fold);
            cr.rectangle(Math.min(from, to), top + 1, Math.abs(to - from) + 0.5, bottom - top - 1);
            cr.fill();
        }
    }
}

function lock(cr, width, height, time, state) {
    const {locked = null} = state;
    const centerX = width / 2;
    const plateWidth = 34;
    const left = centerX - plateWidth / 2;
    const top = 8;
    let color = IDLE_LIGHT;
    if (locked !== null)
        color = locked ? [0.36, 0.86, 0.55] : [0.98, 0.65, 0.3];
    cr.setSourceRGB(0.75, 0.77, 0.82);
    roundRect(cr, centerX + plateWidth / 2 - 4, top + 66, locked ? 22 : 8, 7, 2);
    cr.fill();
    shadow(cr, left, top, plateWidth, 80, 10, 4);
    darkFace(cr, left, top, plateWidth, 80, 10);
    cr.setSourceRGBA(1, 1, 1, 0.55);
    for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
            cr.arc(left + 10 + column * 7, top + 12 + row * 7, 1.4, 0, TAU);
            cr.fill();
        }
    }
    cr.setSourceRGB(...color);
    cr.setLineWidth(2);
    cr.newSubPath();
    cr.arc(centerX, top + 42, 5, 0, TAU);
    cr.stroke();
    plastic(cr, top + 52, top + 60, 0.15);
    roundRect(cr, centerX - 6, top + 52, 30, 7, 3.5);
    cr.fill();
}

function fridge(cr, width, height, time, state) {
    const {fridge: inside = null, freezer = null, font} = state;
    const centerX = width / 2;
    const bodyWidth = 50;
    const left = centerX - bodyWidth / 2;
    const top = 4;
    const bottom = 90;
    const split = top + 52;
    floorShadow(cr, centerX, bottom, 30);
    shadow(cr, left, top, bodyWidth, bottom - top, 7, 4);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, bodyWidth, bottom - top, 7);
    cr.fill();
    cr.setSourceRGBA(0.45, 0.48, 0.55, 0.5);
    cr.setLineWidth(1);
    cr.moveTo(left + 1, split);
    cr.lineTo(left + bodyWidth - 1, split);
    cr.stroke();
    cr.setSourceRGB(0.7, 0.72, 0.78);
    roundRect(cr, left + 6, top + 10, 3, 22, 1.5);
    cr.fill();
    roundRect(cr, left + 6, split + 6, 3, 16, 1.5);
    cr.fill();
    cr.setSourceRGB(0.3, 0.55, 0.9);
    write(cr, inside ?? '– –', {x: centerX + 6, y: top + 24, size: 9, bold: true, font});
    write(cr, freezer ?? '– –', {x: centerX + 6, y: split + 16, size: 9, bold: true, font});
}

function coffee(cr, width, height, time, state) {
    const {working = false} = state;
    const centerX = width / 2;
    const bodyWidth = 56;
    const left = centerX - bodyWidth / 2;
    const top = 8;
    const bottom = 88;
    floorShadow(cr, centerX, bottom, 34);
    shadow(cr, left, top, bodyWidth, bottom - top, 8, 4);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, bodyWidth, 26, 8);
    cr.fill();
    roundRect(cr, left, top, 14, bottom - top, 7);
    cr.fill();
    roundRect(cr, left, bottom - 10, bodyWidth, 10, 4);
    cr.fill();
    cr.setSourceRGB(0.4, 0.42, 0.48);
    roundRect(cr, centerX - 2, top + 26, 10, 6, 2);
    cr.fill();
    const cupTop = bottom - 30;
    plastic(cr, cupTop, bottom - 10, 0.02);
    cr.moveTo(centerX - 8, cupTop);
    cr.lineTo(centerX + 18, cupTop);
    cr.lineTo(centerX + 15, bottom - 10);
    cr.lineTo(centerX - 5, bottom - 10);
    cr.closePath();
    cr.fill();
    cr.setSourceRGB(0.85, 0.86, 0.9);
    cr.setLineWidth(2.5);
    cr.newSubPath();
    cr.arc(centerX + 19, cupTop + 8, 5, -TAU / 4, TAU / 4);
    cr.stroke();
    cr.setSourceRGB(0.42, 0.26, 0.16);
    ellipse(cr, centerX + 5, cupTop + 1.5, 12, 2);
    cr.fill();
    if (working) {
        cr.setSourceRGBA(0.42, 0.26, 0.16, 0.9);
        cr.setLineWidth(2);
        cr.setDash([3, 2], -time * 20);
        cr.moveTo(centerX + 3, top + 32);
        cr.lineTo(centerX + 3, cupTop);
        cr.stroke();
        cr.setDash([], 0);
    }
    cr.setSourceRGB(...(working ? [0.98, 0.65, 0.3] : IDLE_LIGHT));
    cr.arc(left + 7, top + 40, 2, 0, TAU);
    cr.fill();
}

function thermostat(cr, width, height, time, state) {
    const {target = null, temperature = null, on = true, font} = state;
    const centerX = width / 2;
    const centerY = 48;
    const radius = 38;
    cr.setSourceRGBA(0, 0, 0, 0.18);
    cr.arc(centerX + 1, centerY + 3, radius, 0, TAU);
    cr.fill();
    const face = new Cairo.RadialGradient(centerX - 10, centerY - 14, 4, centerX, centerY, radius);
    face.addColorStopRGB(0, 0.99, 0.99, 1);
    face.addColorStopRGB(1, 0.82, 0.84, 0.88);
    cr.setSource(face);
    cr.arc(centerX, centerY, radius, 0, TAU);
    cr.fill();
    const start = 0.75 * Math.PI;
    const sweep = 1.5 * Math.PI;
    cr.setSourceRGBA(0.45, 0.48, 0.55, 0.5);
    cr.setLineWidth(1.4);
    for (let i = 0; i <= 20; i++) {
        const angle = start + sweep * i / 20;
        cr.moveTo(centerX + Math.cos(angle) * (radius - 8), centerY + Math.sin(angle) * (radius - 8));
        cr.lineTo(centerX + Math.cos(angle) * (radius - 4), centerY + Math.sin(angle) * (radius - 4));
    }
    cr.stroke();
    if (typeof target === 'number') {
        const share = Math.max(0, Math.min(1, (target - 10) / 20));
        cr.setSourceRGB(...(on ? [0.98, 0.5, 0.25] : IDLE_LIGHT));
        cr.setLineWidth(3);
        cr.newSubPath();
        cr.arc(centerX, centerY, radius - 6, start, start + sweep * share);
        cr.stroke();
    }
    const shown = typeof temperature === 'number' ? temperature : target;
    cr.setSourceRGB(0.25, 0.28, 0.34);
    write(cr, typeof shown === 'number' ? `${Math.round(shown)}°` : '– –', {x: centerX, y: centerY, size: 16, bold: true, font});
}

function doorbell(cr, width, height, time, state) {
    const {ringing = false} = state;
    const centerX = width / 2;
    const plateWidth = 30;
    const left = centerX - plateWidth / 2;
    const top = 8;
    const amber = [0.98, 0.75, 0.3];
    if (ringing) {
        cr.setLineWidth(2);
        for (let i = 0; i < 3; i++) {
            const share = cycle(time, 1.6, i, 3);
            cr.setSourceRGBA(...amber, 0.6 * (1 - share));
            cr.newSubPath();
            cr.arc(centerX, top + 58, 10 + share * 26, 0, TAU);
            cr.stroke();
        }
    }
    shadow(cr, left, top, plateWidth, 78, 12, 4);
    darkFace(cr, left, top, plateWidth, 78, 12);
    cr.setSourceRGB(0.08, 0.1, 0.14);
    cr.arc(centerX, top + 18, 7, 0, TAU);
    cr.fill();
    cr.setSourceRGBA(0.4, 0.55, 0.9, 0.7);
    cr.arc(centerX - 2, top + 16, 2, 0, TAU);
    cr.fill();
    cr.setSourceRGB(...(ringing ? amber : [0.85, 0.87, 0.9]));
    cr.arc(centerX, top + 58, 8, 0, TAU);
    cr.fill();
}

function plant(cr, width, height, time, state) {
    const {moisture = null} = state;
    const centerX = width / 2;
    floorShadow(cr, centerX, 90, 26);
    cr.save();
    cr.translate(centerX, 56);
    for (const [angle, length] of [[-1.05, 26], [-0.45, 36], [0.15, 32], [0.75, 27], [1.25, 20]]) {
        cr.save();
        cr.rotate(angle);
        const leaf = new Cairo.LinearGradient(0, 0, 0, -length);
        leaf.addColorStopRGB(0, 0.22, 0.52, 0.3);
        leaf.addColorStopRGB(1, 0.42, 0.78, 0.45);
        cr.setSource(leaf);
        cr.moveTo(0, 0);
        cr.curveTo(length * 0.35, -length * 0.3, length * 0.25, -length * 0.8, 0, -length);
        cr.curveTo(-length * 0.25, -length * 0.8, -length * 0.35, -length * 0.3, 0, 0);
        cr.fill();
        cr.restore();
    }
    cr.restore();
    cr.setSourceRGB(0.94, 0.95, 0.97);
    roundRect(cr, centerX + 9, 38, 4, 20, 2);
    cr.fill();
    roundRect(cr, centerX + 7, 34, 8, 8, 2.5);
    cr.fill();
    const pot = new Cairo.LinearGradient(centerX - 24, 0, centerX + 24, 0);
    pot.addColorStopRGB(0, 0.72, 0.4, 0.28);
    pot.addColorStopRGB(0.5, 0.88, 0.55, 0.38);
    pot.addColorStopRGB(1, 0.7, 0.38, 0.26);
    cr.setSource(pot);
    cr.moveTo(centerX - 24, 56);
    cr.lineTo(centerX + 24, 56);
    cr.lineTo(centerX + 18, 88);
    cr.lineTo(centerX - 18, 88);
    cr.closePath();
    cr.fill();
    const wet = moisture === null ? 0.4 : Math.max(0, Math.min(1, moisture / 60));
    cr.setSourceRGB(...mix([0.62, 0.48, 0.34], [0.28, 0.19, 0.13], wet));
    ellipse(cr, centerX, 57, 22, 3.5);
    cr.fill();
}

function cooker(cr, width, height, time, state) {
    const {cooking = false} = state;
    const centerX = width / 2;
    const bodyWidth = 72;
    const left = centerX - bodyWidth / 2;
    const top = 34;
    const bottom = 86;
    if (cooking)
        rising(cr, centerX + 14, top - 12, time, {count: 2, spread: 4, length: 18, alpha: 0.5});
    floorShadow(cr, centerX, 90, 38);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, bodyWidth, bottom - top, 18);
    cr.fill();
    plastic(cr, top - 12, top + 8, 0.06);
    ellipse(cr, centerX, top + 2, bodyWidth / 2 - 2, 13);
    cr.fill();
    cr.setSourceRGB(0.55, 0.58, 0.64);
    cr.arc(centerX + 14, top - 6, 2.5, 0, TAU);
    cr.fill();
    cr.setSourceRGB(0.2, 0.22, 0.26);
    roundRect(cr, centerX - 14, top + 22, 28, 12, 4);
    cr.fill();
    cr.setSourceRGB(...(cooking ? [0.98, 0.6, 0.25] : [0.45, 0.48, 0.54]));
    roundRect(cr, centerX - 9, top + 26.5, 18, 3, 1.5);
    cr.fill();
}

function waterPurifier(cr, width, height, time, state) {
    const {tds = null, font} = state;
    const centerX = width / 2;
    const bodyWidth = 40;
    const left = centerX - bodyWidth / 2 - 10;
    const top = 8;
    const bottom = 88;
    floorShadow(cr, centerX, bottom, 34);
    shadow(cr, left, top, bodyWidth, bottom - top, 8, 4);
    plastic(cr, top, bottom);
    roundRect(cr, left, top, bodyWidth, bottom - top, 8);
    cr.fill();
    cr.setSourceRGB(0.7, 0.72, 0.78);
    roundRect(cr, left + bodyWidth - 4, top + 16, 20, 5, 2.5);
    cr.fill();
    roundRect(cr, left + bodyWidth + 12, top + 16, 5, 10, 2);
    cr.fill();
    const glassX = left + bodyWidth + 14.5;
    const glassTop = bottom - 30;
    cr.setSourceRGBA(0.75, 0.88, 1, 0.35);
    cr.moveTo(glassX - 9, glassTop);
    cr.lineTo(glassX + 9, glassTop);
    cr.lineTo(glassX + 7, bottom);
    cr.lineTo(glassX - 7, bottom);
    cr.closePath();
    cr.fill();
    cr.setSourceRGBA(0.35, 0.65, 1, 0.6);
    cr.moveTo(glassX - 8.4, glassTop + 8);
    cr.lineTo(glassX + 8.4, glassTop + 8);
    cr.lineTo(glassX + 7, bottom);
    cr.lineTo(glassX - 7, bottom);
    cr.closePath();
    cr.fill();
    cr.setSourceRGB(0.3, 0.55, 0.9);
    write(cr, tds === null ? '– –' : String(tds), {x: left + bodyWidth / 2, y: top + 30, size: 10, bold: true, font});
    write(cr, 'TDS', {x: left + bodyWidth / 2, y: top + 42, size: 6, font});
}

// body: where the device is, as [x from the middle, y, width, height], or a function of
// the state and stage width giving that. Glows, steam, airflow and the like are not in it.
const SCENES = {
    aircon: {height: 108, draw: aircon, body: airconBody, moves: state => state.on},
    thermo: {height: 96, draw: thermo, body: ({humidity = null}) => (humidity === null ? [-13, 10, 27, 73] : [-33, 10, 78, 73])},
    motion: {height: 96, draw: motion, body: [-45, 25, 38, 60], moves: state => state.active},
    door: {height: 96, draw: door, body: ({open = false}) => (open ? [-49, 2, 77, 92] : [-28, 4, 56, 84])},
    leak: {height: 96, draw: leak, body: ({wet = false}) => (wet ? [-46, 65, 92, 23] : [-24, 14, 48, 69]), moves: state => state.wet},
    smoke: {height: 96, draw: smoke, body: [-33, 24, 66, 31], moves: state => state.alarm},
    fan: {height: 96, draw: fan, body: [-34, 4, 68, 90], moves: state => state.on},
    kettle: {height: 96, draw: kettle, body: [-34, 16, 67, 72], moves: state => state.status === 1 || state.status === 3 || state.temperature >= 60},
    vacuum: {
        height: 96,
        draw: vacuum,
        // The dock shows behind it while charging or returning.
        body: ({mode}) => (mode === 'charging' || mode === 'returning' ? [-42, 10, 84, 70] : [-42, 31, 84, 49]),
        moves: state => ['cleaning', 'charging', 'returning', 'error'].includes(state.mode),
    },
    scale: {height: 96, draw: scale, body: [-40, 34, 80, 48]},
    gateway: {height: 96, draw: gateway, body: [-30, 16, 62, 64]},
    repeater: {height: 96, draw: repeater, body: [-24, 14, 48, 76], moves: state => state.online},
    button: {height: 96, draw: button, body: [-30, 39, 60, 36]},
    fryer: {height: 96, draw: fryer, body: [-32, 18, 64, 70], moves: state => state.cooking},
    scooter: {height: 96, draw: scooter, body: [-42, 14, 78, 74]},
    speaker: {
        height: 96,
        draw: speaker,
        body: ({kind}) => ({puck: [-34, 52, 68, 32], display: [-36, 18, 72, 66], group: [-43, 32, 77, 54]})[kind] ?? [-21, 20, 42, 64],
        moves: state => state.playing,
    },
    tv: {height: 96, draw: television, body: [-52, 8, 104, 77], moves: state => state.on},
    light: {height: 96, draw: bulb, body: [-19, 17, 38, 56], moves: state => state.on},
    plug: {height: 96, draw: socket, body: [-31, 10, 62, 62], moves: state => state.on && state.kind !== 'switch'},
    progress: {height: 8, draw: progress},
    // Full redraws are costly and only the robot's ring moves.
    map: {height: 230, draw: floorPlan, moves: state => state.working, fps: 8},
    washer: {height: 96, draw: washer, body: [-34, 6, 68, 80], moves: state => state.working},
    dishwasher: {height: 96, draw: dishwasher, body: [-34, 16, 68, 70], moves: state => state.working},
    purifier: {height: 96, draw: purifier, body: [-21, 14, 42, 75], moves: state => state.on},
    humidifier: {height: 96, draw: humidifier, body: [-27, 34, 54, 54], moves: state => state.on},
    dehumidifier: {height: 96, draw: dehumidifier, body: [-26, 8, 52, 80], moves: state => state.on},
    heater: {height: 96, draw: heater, body: [-38, 18, 76, 70], moves: state => state.on},
    curtain: {height: 96, draw: curtain, body: [-48, 8, 96, 78]},
    lock: {height: 96, draw: lock, body: ({locked}) => [-17, 8, locked ? 52 : 41, 80]},
    fridge: {height: 96, draw: fridge, body: [-25, 4, 50, 86]},
    coffee: {height: 96, draw: coffee, body: [-28, 8, 56, 80], moves: state => state.working},
    thermostat: {height: 96, draw: thermostat, body: [-38, 10, 77, 79]},
    doorbell: {height: 96, draw: doorbell, body: [-15, 8, 30, 78], moves: state => state.ringing},
    plant: {height: 96, draw: plant, body: [-31, 15, 59, 73]},
    cooker: {height: 96, draw: cooker, body: [-36, 23, 72, 63], moves: state => state.cooking},
    water: {height: 96, draw: waterPurifier, body: [-30, 8, 64, 80]},
    glyph: {height: 96, draw: glyph, body: [-38, 10, 76, 76]},
};

export function tint(name, state) {
    const known = typeof state.temperature === 'number' && Number.isFinite(state.temperature);
    if (!known)
        return null;
    if (name === 'thermo')
        return warmth(state.temperature);
    if (name === 'kettle')
        return waterColor(state.temperature);
    if (name === 'fryer' && state.cooking)
        return mix([0.98, 0.62, 0.24], [0.9, 0.28, 0.2], Math.min(1, Math.max(0, (state.temperature - 40) / 190)));
    return null;
}

export function moves(name, state) {
    return Boolean(SCENES[name]?.moves?.(state));
}

export function framesPerSecond(name) {
    return SCENES[name]?.fps ?? 60;
}

// The device itself as [x, y, width, height] in surface pixels.
export function body(name, surfaceWidth, surfaceHeight, state) {
    const scene = SCENES[name];
    if (!scene?.body || surfaceHeight <= 0)
        return null;
    const scale = surfaceHeight / scene.height;
    const width = surfaceWidth / scale;
    const [left, ...rest] = typeof scene.body === 'function' ? scene.body(state, width) : scene.body;
    return [width / 2 + left, ...rest].map(v => v * scale);
}

export function draw(cr, name, surfaceWidth, surfaceHeight, time, state) {
    const scene = SCENES[name];
    if (!scene || surfaceHeight <= 0)
        return;
    const scale = surfaceHeight / scene.height;
    cr.scale(scale, scale);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    scene.draw(cr, surfaceWidth / scale, scene.height, time, state);
}
