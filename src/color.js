// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

import {PRESETS, WHITE, hsvToRgb, nearestRgb, rgbToHsv} from './lib/spec-home.js';
import {NUMBER_FORMATS} from './humanize.js';
import {choiceText} from './text.js';
import {glyphArea} from './widgets.js';

const TAU = 2 * Math.PI;
const SLICES = 120;
const SIZE = 208;
// As shares of the wheel's size: the disk, the hole under the power button (saturation
// runs from its edge out) and the marker.
const RADIUS = 0.44;
const HOLE = 0.4;
const MARKER = 0.055;

// Swatches as a screen shows them well; the lamp still gets the pure preset.
const SHADES = new Map([
    [0xff0000, 0xff453a],
    [0xff8000, 0xff9f0a],
    [0xffd200, 0xffd60a],
    [0x00ff00, 0x30d158],
    [0x00ffff, 0x40c8e0],
    [0x0000ff, 0x0a84ff],
    [0x8000ff, 0xa35cff],
    [0xff40a0, 0xff4fa0],
]);
// White's swatch, top to bottom.
const WARM = [0xfff7e8, 0xffd39a];

export const rgbOf = value => [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(v => v / 255);

// Mi Home lights give an RGB number; the other sources use colorProp's presets.
export const isColor = prop => prop.name === 'color' && NUMBER_FORMATS.includes(prop.format) &&
    (prop.range?.[1] === 0xffffff || Boolean(prop.choices?.some(c => c.value === WHITE)));

// The light a wheel drives, with that service's own switch, brightness and colour
// temperature where it has them.
export function paintOf(services) {
    for (const service of services) {
        const color = service.properties.find(p => isColor(p) && p.access.includes('write'));
        if (!color)
            continue;
        const find = (name, fits) => service.properties.find(p => p.name === name && p.access.includes('write') && fits(p)) ?? null;
        const ranged = p => NUMBER_FORMATS.includes(p.format) && p.range?.[1] > p.range?.[0];
        return {
            service,
            color,
            on: find('on', p => p.format === 'bool'),
            brightness: find('brightness', ranged),
            temperature: find('color-temperature', ranged),
        };
    }
    return null;
}

export function colorName(value) {
    const nearest = nearestRgb(value);
    return choiceText(PRESETS.find(([, preset]) => preset === nearest)[0]);
}

function matches(value, preset) {
    if (typeof value !== 'number')
        return false;
    const [h, s] = rgbToHsv(value);
    if (preset === WHITE)
        return s < 0.12;
    const [hue] = rgbToHsv(preset);
    return s >= 0.7 && Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue)) <= 12;
}

function swatchDot(preset) {
    const area = new Gtk.DrawingArea({content_width: 22, content_height: 22, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
    area.set_draw_func((_area, cr, width, height) => {
        try {
            const [x, y, radius] = [width / 2, height / 2, Math.min(width, height) / 2];
            cr.arc(x, y, radius, 0, TAU);
            if (preset === WHITE) {
                const warm = new Cairo.LinearGradient(0, y - radius, 0, y + radius);
                warm.addColorStopRGB(0, ...rgbOf(WARM[0]));
                warm.addColorStopRGB(1, ...rgbOf(WARM[1]));
                cr.setSource(warm);
            } else {
                cr.setSourceRGB(...rgbOf(SHADES.get(preset)));
            }
            cr.fill();
            // Sets the white one off a light page.
            const ink = area.get_color();
            cr.setSourceRGBA(ink.red, ink.green, ink.blue, 0.15);
            cr.setLineWidth(1);
            cr.arc(x, y, radius - 0.5, 0, TAU);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    });
    return area;
}

// White first; pick(value) gets the preset's own value. The mark follows value only: a
// click marks nothing until the row is made again.
export function swatchRow(value, pick) {
    const row = new Gtk.Box({homogeneous: true, hexpand: true, css_classes: ['nook-swatches']});
    for (const [description, preset] of PRESETS) {
        const name = choiceText(description);
        const checked = matches(value, preset);
        const swatch = new Gtk.Button({
            child: swatchDot(preset),
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            tooltip_text: name,
            css_classes: ['nook-swatch', ...checked ? ['checked'] : []],
        });
        swatch.update_property([Gtk.AccessibleProperty.LABEL], [name]);
        swatch.update_state([Gtk.AccessibleState.PRESSED], [checked ? Gtk.AccessibleTristate.TRUE : Gtk.AccessibleTristate.FALSE]);
        swatch.connect('clicked', () => pick(preset));
        row.append(swatch);
    }
    return row;
}

// Hue round the ring, red at the top; saturation from the hole out. Brightness stays
// with its slider. pick(rgb) runs on release.
const Disk = GObject.registerClass(
class Disk extends Gtk.DrawingArea {
    _init(pick) {
        // A drawing area is generic, and a generic role takes no label.
        super._init({content_width: SIZE, content_height: SIZE, accessible_role: Gtk.AccessibleRole.IMG});
        this.update_property([Gtk.AccessibleProperty.LABEL], [_('Colour')]);
        this._pick = pick;
        this._value = null;
        this._on = false;
        this._shown = {value: null, on: false};
        this._start = null;
        this.set_draw_func((_area, cr, width, height) => {
            try {
                this._draw(cr, width, height);
            } finally {
                cr.$dispose();
            }
        });
        const drag = new Gtk.GestureDrag();
        // Claimed at once, or the page's scrolling takes a touch drag.
        drag.connect('drag-begin', (gesture, x, y) => gesture.set_state(this._begin(x, y)
            ? Gtk.EventSequenceState.CLAIMED : Gtk.EventSequenceState.DENIED));
        drag.connect('drag-update', (_gesture, dx, dy) => this._drag(dx, dy));
        drag.connect('drag-end', (_gesture, dx, dy) => this._end(dx, dy));
        // Taken by another gesture, or made insensitive: nothing is picked.
        drag.connect('cancel', () => this._cancel());
        this.add_controller(drag);
    }

    show(value, on) {
        this._shown = {value: typeof value === 'number' ? value : null, on};
        if (!this._start)
            this._redraw();
    }

    _redraw() {
        ({value: this._value, on: this._on} = this._shown);
        this.queue_draw();
    }

    _draw(cr, width, height) {
        const size = Math.min(width, height);
        if (size <= 0)
            return;
        const [x, y] = [width / 2, height / 2];
        const radius = size * RADIUS;
        const hole = radius * HOLE;

        cr.setSourceRGBA(0, 0, 0, 0.28);
        cr.arc(x, y + size * 0.012, radius, 0, TAU);
        cr.fill();
        cr.save();
        cr.arc(x, y, radius, 0, TAU);
        cr.clip();
        // Unsmoothed, overlapping slices leave no seams; the clip keeps the rim smooth.
        cr.setAntialias(Cairo.Antialias.NONE);
        for (let i = 0; i < SLICES; i++) {
            cr.moveTo(x, y);
            cr.arc(x, y, radius + 1, (i / SLICES - 0.25) * TAU, ((i + 1.5) / SLICES - 0.25) * TAU);
            cr.closePath();
            cr.setSourceRGB(...rgbOf(hsvToRgb((i + 0.5) * 360 / SLICES, 1)));
            cr.fill();
        }
        const white = new Cairo.RadialGradient(x, y, hole, x, y, radius);
        white.addColorStopRGBA(0, 1, 1, 1, 1);
        white.addColorStopRGBA(1, 1, 1, 1, 0);
        cr.setSource(white);
        cr.paint();
        if (!this._on) {
            cr.setSourceRGBA(0.13, 0.13, 0.15, 0.62);
            cr.paint();
        }
        cr.restore();

        // White shows as its swatch, not as a dot in the hole's rim.
        if (this._value === null || this._value === WHITE)
            return;
        const [h, s] = rgbToHsv(this._value);
        const reach = hole + s * (radius - hole);
        const angle = (h / 360 - 0.25) * TAU;
        const [mx, my] = [x + reach * Math.cos(angle), y + reach * Math.sin(angle)];
        const marker = size * MARKER;
        cr.setSourceRGBA(0, 0, 0, 0.35);
        cr.arc(mx, my + size * 0.008, marker, 0, TAU);
        cr.fill();
        cr.setSourceRGB(1, 1, 1);
        cr.arc(mx, my, marker, 0, TAU);
        cr.fill();
        cr.setSourceRGB(...rgbOf(this._value));
        cr.arc(mx, my, marker * 0.72, 0, TAU);
        cr.fill();
    }

    // Hue and saturation under (x, y), or null inside the hole or off the disk.
    _at(x, y, loose) {
        const [width, height] = [this.get_width(), this.get_height()];
        const size = Math.min(width, height);
        const radius = size * RADIUS;
        const hole = radius * HOLE;
        const dx = x - width / 2;
        const dy = y - height / 2;
        const reach = Math.hypot(dx, dy);
        if (!loose && (reach < hole || reach > radius + size * MARKER))
            return null;
        const h = (Math.atan2(dx, -dy) * 360 / TAU + 360) % 360;
        return hsvToRgb(h, Math.min(1, Math.max(0, (reach - hole) / (radius - hole))));
    }

    _begin(x, y) {
        const value = this._at(x, y, false);
        if (value === null)
            return false;
        this._start = [x, y];
        this._move(value);
        return true;
    }

    // dx, dy: from the press.
    _drag(dx, dy) {
        if (this._start)
            this._move(this._at(this._start[0] + dx, this._start[1] + dy, true));
    }

    _end(dx, dy) {
        if (!this._start)
            return;
        this._drag(dx, dy);
        this._start = null;
        this._pick(this._value);
    }

    _cancel() {
        if (!this._start)
            return;
        this._start = null;
        this._redraw();
    }

    _move(value) {
        this._value = value;
        this.queue_draw();
    }
});

// toggle, if given, runs from the button in the middle.
export const ColorWheel = GObject.registerClass(
class ColorWheel extends Gtk.Overlay {
    _init(pick, toggle) {
        super._init({halign: Gtk.Align.CENTER, css_classes: ['nook-wheel']});
        this._disk = new Disk(pick);
        this.child = this._disk;
        this._power = new Gtk.Button({
            child: glyphArea('bulb', 24),
            visible: Boolean(toggle),
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            css_classes: ['circular', 'nook-wheel-power'],
        });
        if (toggle)
            this._power.connect('clicked', () => toggle());
        this.add_overlay(this._power);
    }

    show(value, on, active) {
        this._disk.sensitive = active;
        this._power.sensitive = active;
        this._disk.show(value, on);
        if (on)
            this._power.add_css_class('on');
        else
            this._power.remove_css_class('on');
        const label = on ? _('Turn Off') : _('Turn On');
        this._power.tooltip_text = label;
        this._power.update_property([Gtk.AccessibleProperty.LABEL], [label]);
    }
});
