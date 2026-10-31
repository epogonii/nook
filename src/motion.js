// SPDX-License-Identifier: GPL-2.0-or-later

// What moves around a Home tile's picture while its device works: air under a running air
// conditioner, steam over a hot kettle, sound beside a playing speaker, air off a fan, a pulse
// behind an alarm. Drawn behind the picture; box is where the picture is, [x, y, width, height].

import Cairo from 'cairo';

const TAU = 2 * Math.PI;
const cycle = (time, period, index = 0, count = 1) => ((time / period + index / count) % 1 + 1) % 1;

// Measured off the pictures, as fractions of them: the air conditioner's lower edge, left end
// then right, just inside it; the kettle's lid; the speaker's middle; the fan's head, its
// radius in picture heights.
const UNIT_EDGE = [0.12, 0.725, 0.84, 0.934];
const LID = [0.34, 0.04];
const SPEAKER = [0.5, 0.49];
const FAN_HEAD = [0.5, 0.18, 0.18];

const COOL = [0.36, 0.62, 0.95];
const ALARM = [0.88, 0.11, 0.14];
// Steam and air: grey on a light tile, where white would not show.
const inkOf = dark => (dark ? [1, 1, 1, 0.5] : [0.5, 0.56, 0.64, 0.5]);

function air(cr, [x, y, width, height], time, {color = COOL}) {
    const [x0, y0, x1, y1] = UNIT_EDGE;
    const reach = height * 0.85;
    for (let i = 0; i < 5; i++) {
        const along = (i + 0.5) / 5;
        const startX = x + (x0 + (x1 - x0) * along) * width;
        const startY = y + (y0 + (y1 - y0) * along) * height;
        const lean = (along - 0.5) * reach * 0.6;
        const path = () => {
            cr.moveTo(startX, startY);
            cr.curveTo(startX, startY + reach * 0.45, startX + lean * 0.6, startY + reach * 0.75, startX + lean, startY + reach);
        };
        const fade = share => {
            const gradient = new Cairo.LinearGradient(0, startY, 0, startY + reach);
            gradient.addColorStopRGBA(0, ...color, share);
            gradient.addColorStopRGBA(1, ...color, 0);
            return gradient;
        };
        cr.setSource(fade(0.16));
        cr.setLineWidth(6);
        path();
        cr.stroke();
        cr.setSource(fade(0.85));
        cr.setLineWidth(1.8);
        cr.setDash([5, 6], -((time * 20 + i * 4) % 11));
        path();
        cr.stroke();
        cr.setDash([], 0);
    }
}

function steam(cr, [x, y, width, height], time, {strength = 1, dark}) {
    const [red, green, blue, alpha] = inkOf(dark);
    const centerX = x + LID[0] * width;
    const top = y + LID[1] * height;
    // As high as the tile leaves above the lid.
    const rise = Math.max(12, Math.min(height * 0.4, top - 4));
    const count = strength >= 1 ? 4 : 3;
    const spread = width * 0.1;
    cr.setLineWidth(2.2);
    for (let i = 0; i < count; i++) {
        const share = cycle(time, 2.4, i, count);
        const baseX = centerX + (i - (count - 1) / 2) * spread;
        const bottom = top - share * rise * 0.6;
        cr.setSourceRGBA(red, green, blue, alpha * strength * Math.sin(share * Math.PI));
        cr.moveTo(baseX + Math.sin(time * 2 + i) * 2, bottom);
        for (let k = 1; k <= 6; k++)
            cr.lineTo(baseX + Math.sin(time * 2 + i + k * 0.9) * 3, bottom - k * rise * 0.07);
        cr.stroke();
    }
}

function sound(cr, [x, y, width, height], time, {color}) {
    const centerX = x + SPEAKER[0] * width;
    const centerY = y + SPEAKER[1] * height;
    cr.setLineWidth(2);
    for (let i = 0; i < 3; i++) {
        const share = cycle(time, 1.8, i, 3);
        cr.setSourceRGBA(...color, 0.6 * (1 - share) * Math.min(1, share * 4));
        cr.arc(centerX, centerY, width * (0.56 + share * 0.55), -0.5, 0.5);
        cr.stroke();
    }
}

function breeze(cr, [x, y, width, height], time, {pace = 1, dark}) {
    const [red, green, blue, alpha] = inkOf(dark);
    const radius = FAN_HEAD[2] * height;
    const from = x + FAN_HEAD[0] * width + radius * 0.9;
    const middle = y + FAN_HEAD[1] * height;
    const reach = radius * 2.2;
    const gradient = new Cairo.LinearGradient(from, 0, from + reach, 0);
    gradient.addColorStopRGBA(0, red, green, blue, alpha * 1.4);
    gradient.addColorStopRGBA(1, red, green, blue, 0);
    cr.setSource(gradient);
    cr.setLineWidth(1.8);
    cr.setDash([5, 5], -((time * (14 + 8 * pace)) % 10));
    for (let i = -1; i <= 1; i++) {
        const lineY = middle + i * radius * 0.55;
        cr.moveTo(from, lineY);
        cr.curveTo(from + reach * 0.33, lineY - radius * 0.15, from + reach * 0.66, lineY + radius * 0.15, from + reach, lineY);
        cr.stroke();
    }
    cr.setDash([], 0);
}

const MOTIONS = {air, steam, sound, breeze};

// Where it draws, as [x, y, width, height]: what the tile has to repaint.
export function area(kind, [x, y, width, height]) {
    switch (kind) {
    case 'air':
        return [x, y + UNIT_EDGE[1] * height, width * 1.2, (UNIT_EDGE[3] - UNIT_EDGE[1]) * height + height * 0.9];
    case 'steam':
        return [x + LID[0] * width - width * 0.3, 0, width * 0.6, y + LID[1] * height + 4];
    case 'sound':
        return [x + width * 0.5, y + SPEAKER[1] * height - width * 0.6, width * 1.2, width * 1.2];
    case 'breeze': {
        const radius = FAN_HEAD[2] * height;
        return [x + FAN_HEAD[0] * width, y + FAN_HEAD[1] * height - radius, radius * 3.4, radius * 2];
    }
    }
    return [x, y, width, height];
}

// The pulse behind an alarm, a glow for the GPU to draw rather than lines: [x, y, radius,
// stops as [offset, red, green, blue, alpha]], or null.
export function pulse(motion, [x, y, width, height], time) {
    if (motion.kind !== 'alarm')
        return null;
    const beat = 0.5 + 0.5 * Math.sin(time * TAU / 1.2);
    return [x + width / 2, y + height / 2, Math.max(width, height) * 0.85,
        [[0, ...ALARM, 0.2 + 0.35 * beat], [0.5, ...ALARM, 0.1 + 0.2 * beat], [1, ...ALARM, 0]]];
}

// motion: {kind, ...} as widgets.js gives it; time in seconds.
export function draw(cr, box, time, motion) {
    cr.setLineCap(Cairo.LineCap.ROUND);
    MOTIONS[motion.kind]?.(cr, box, time, motion);
}
