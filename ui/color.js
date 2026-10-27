// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PRESETS, WHITE, hsvToRgb, nearestRgb, rgbToHsv} from '../lib/spec-home.js';
import {NUMBER_FORMATS} from './humanize.js';
import {choiceText} from './text.js';
import {Glyph} from './widgets.js';

const TAU = 2 * Math.PI;
const SLICES = 120;
// As shares of the wheel's size: the disk, the hole under the power button (saturation
// runs from its edge out) and the marker.
const RADIUS = 0.44;
const HOLE = 0.4;
const MARKER = 0.055;

// Swatches as a screen shows them well; the lamp still gets the pure preset.
const SHADES = new Map([
    [0xff0000, '#ff453a'],
    [0xff8000, '#ff9f0a'],
    [0xffd200, '#ffd60a'],
    [0x00ff00, '#30d158'],
    [0x00ffff, '#40c8e0'],
    [0x0000ff, '#0a84ff'],
    [0x8000ff, '#a35cff'],
    [0xff40a0, '#ff4fa0'],
]);

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

// White first; pick(value) gets the preset's own value.
export function swatchRow(value, pick) {
    const row = new St.BoxLayout({style_class: 'nook-swatches', x_expand: true});
    row.layout_manager.homogeneous = true;
    for (const [description, preset] of PRESETS) {
        const dot = new St.Widget({
            style_class: 'nook-swatch-dot',
            style: preset === WHITE ? 'background-gradient-direction: vertical; ' +
                'background-gradient-start: #fff7e8; background-gradient-end: #ffd39a;'
                : `background-color: ${SHADES.get(preset)};`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const swatch = new St.Button({
            style_class: 'nook-swatch',
            child: dot,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            accessible_name: choiceText(description),
            checked: matches(value, preset),
        });
        swatch.connect('clicked', () => pick(preset));
        row.add_child(swatch);
    }
    return row;
}

// Hue round the ring, red at the top; saturation from the hole out. Brightness stays
// with its slider. pick(rgb) runs on release.
const Disk = GObject.registerClass(
class Disk extends St.DrawingArea {
    _init(pick) {
        super._init({reactive: true, accessible_name: _('Colour'), x_expand: true, y_expand: true});
        this._pick = pick;
        this._value = null;
        this._on = false;
        this._grab = null;
        this._sequence = null;
        this.connect('destroy', () => this._release());
    }

    show(value, on) {
        if (this._grab)
            return;
        this._value = typeof value === 'number' ? value : null;
        this._on = on;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
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
        } finally {
            cr.$dispose();
        }
    }

    _local(event) {
        const [, x, y] = this.transform_stage_point(...event.get_coords());
        return [x, y];
    }

    // Hue and saturation under (x, y), or null inside the hole or off the disk.
    _at(x, y, loose) {
        const size = Math.min(this.width, this.height);
        const radius = size * RADIUS;
        const hole = radius * HOLE;
        const dx = x - this.width / 2;
        const dy = y - this.height / 2;
        const reach = Math.hypot(dx, dy);
        if (!loose && (reach < hole || reach > radius + size * MARKER))
            return null;
        const h = (Math.atan2(dx, -dy) * 360 / TAU + 360) % 360;
        return hsvToRgb(h, Math.min(1, Math.max(0, (reach - hole) / (radius - hole))));
    }

    _begin(event, sequence) {
        const value = this._at(...this._local(event), false);
        if (value === null)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this);
        this._sequence = sequence;
        this._move(value);
        return Clutter.EVENT_STOP;
    }

    _move(value) {
        this._value = value;
        this.queue_repaint();
    }

    _end() {
        this._release();
        if (this._value !== null)
            this._pick(this._value);
        return Clutter.EVENT_STOP;
    }

    _release() {
        this._grab?.dismiss();
        this._grab = null;
        this._sequence = null;
    }

    vfunc_button_press_event(event) {
        if (this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        return this._begin(event, null);
    }

    vfunc_motion_event(event) {
        if (!this._grab || this._sequence)
            return Clutter.EVENT_PROPAGATE;
        this._move(this._at(...this._local(event), true));
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || this._sequence || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        return this._end();
    }

    vfunc_touch_event(event) {
        const type = event.type();
        const sequence = event.get_event_sequence();
        if (type === Clutter.EventType.TOUCH_BEGIN && !this._grab)
            return this._begin(event, sequence);
        if (!this._sequence || sequence?.get_slot() !== this._sequence.get_slot())
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.TOUCH_UPDATE) {
            this._move(this._at(...this._local(event), true));
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL)
            return this._end();
        return Clutter.EVENT_PROPAGATE;
    }
});

// toggle, if given, runs from the button in the middle.
export const ColorWheel = GObject.registerClass(
class ColorWheel extends St.Widget {
    _init(pick, toggle) {
        super._init({style_class: 'nook-wheel', layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        this._disk = new Disk(pick);
        this.add_child(this._disk);
        this._power = new St.Button({
            style_class: 'nook-wheel-power',
            can_focus: true,
            child: new Glyph('bulb'),
            visible: Boolean(toggle),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (toggle)
            this._power.connect('clicked', toggle);
        this.add_child(this._power);
    }

    show(value, on, active) {
        this._disk.reactive = active;
        this._power.reactive = active;
        this._disk.show(value, on);
        this._power.checked = on;
        this._power.accessible_name = on ? _('Turn Off') : _('Turn On');
    }
});
