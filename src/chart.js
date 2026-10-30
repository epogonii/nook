// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import PangoCairo from 'gi://PangoCairo';

import {HISTORY_SPAN} from './props.js';
import {numberFormat} from './text.js';

// Up to three gridline values, in steps of 1, 2, 2.5 or 5 times a power of ten. No 0.25:
// numberFormat shows one decimal at most.
function chartLevels(low, high) {
    if (!Number.isFinite(high - low))
        return [];
    for (let unit = 0.1; ; unit *= 10) {
        for (const factor of unit < 1 ? [1, 2, 5] : [1, 2, 2.5, 5]) {
            const step = unit * factor;
            const first = Math.ceil(low / step);
            const last = Math.floor(high / step);
            if (last - first < 3)
                return Array.from({length: last - first + 1}, (_, i) => (first + i) * step);
        }
    }
}

// Ticks every 6 clock hours in (start, end]; midnight shows the date. A 24 h span
// touches a third date only across a DST change.
function chartTimes(start, end) {
    const times = [];
    const first = GLib.DateTime.new_from_unix_local(start);
    for (let days = 0; days < 3; days++) {
        const date = first.add_days(days);
        for (let hour = 0; hour < 24; hour += 6) {
            const tick = GLib.DateTime.new_local(date.get_year(), date.get_month(), date.get_day_of_month(), hour, 0, 0);
            const time = tick.to_unix();
            if (time > start && time <= end)
                times.push({time, text: hour === 0 ? tick.format('%e %b').trim() : tick.format('%H:%M')});
        }
    }
    return times;
}

// ink: [r, g, b, a] for text and grid. Returns time => x for hit tests, or null when nothing was drawn.
export function drawChart(cr, width, height, {points, color, ink, font = null, hovered = null}) {
    if (points.length === 0 || width <= 0 || height <= 0)
        return null;
    const end = Date.now() / 1000;
    const start = end - HISTORY_SPAN;
    const values = points.map(p => p.value);
    let low = Math.min(...values);
    let high = Math.max(...values);
    if (high - low < 1) {
        const middle = (high + low) / 2;
        low = middle - 0.5;
        high = middle + 0.5;
    }

    const word = text => {
        const layout = PangoCairo.create_layout(cr);
        if (font)
            layout.set_font_description(font);
        layout.set_text(text, -1);
        const [w, h] = layout.get_pixel_size();
        return {layout, width: w, height: h};
    };
    const levels = chartLevels(low, high).map(value => ({value, ...word(numberFormat.format(value))}));
    const times = chartTimes(start, end).map(({time, text}) => ({time, ...word(text)}));
    const gap = 4;
    const textHeight = Math.max(0, ...levels.map(l => l.height), ...times.map(t => t.height));
    const right = width - Math.max(0, ...levels.map(l => l.width + 2 * gap));
    const top = textHeight / 2;
    const bottom = height - textHeight - gap;
    const pad = (bottom - top) * 0.08;
    const x = time => Math.max(0, (time - start) / HISTORY_SPAN) * right;
    const y = value => top + pad + (1 - (value - low) / (high - low)) * (bottom - top - 2 * pad);
    const marked = levels.filter(level => y(level.value) + level.height / 2 <= bottom);

    const [ir, ig, ib, ia = 1] = ink;
    cr.setSourceRGBA(ir, ig, ib, ia * 0.2);
    cr.setLineWidth(1);
    for (const level of marked) {
        const at = Math.round(y(level.value)) + 0.5;
        cr.moveTo(0, at);
        cr.lineTo(right, at);
    }
    for (const tick of times) {
        const at = Math.round(x(tick.time)) + 0.5;
        cr.moveTo(at, top);
        cr.lineTo(at, bottom);
    }
    cr.stroke();

    cr.moveTo(x(points[0].time), y(points[0].value));
    for (const point of points.slice(1))
        cr.lineTo(x(point.time), y(point.value));
    cr.lineTo(right, y(points.at(-1).value));
    const [r, g, b] = color;
    cr.setSourceRGB(r, g, b);
    cr.setLineWidth(Math.max(1.5, (bottom - top) / 32));
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.strokePreserve();
    cr.lineTo(right, bottom);
    cr.lineTo(x(points[0].time), bottom);
    cr.closePath();
    const fill = new Cairo.LinearGradient(0, 0, 0, bottom);
    fill.addColorStopRGBA(0, r, g, b, 0.3);
    fill.addColorStopRGBA(1, r, g, b, 0);
    cr.setSource(fill);
    cr.fill();

    cr.setSourceRGBA(ir, ig, ib, ia);
    for (const level of marked) {
        cr.moveTo(width - level.width, y(level.value) - level.height / 2);
        PangoCairo.show_layout(cr, level.layout);
    }
    for (const tick of times) {
        const middle = Math.min(Math.max(x(tick.time), tick.width / 2), width - tick.width / 2);
        cr.moveTo(middle - tick.width / 2, bottom + gap);
        PangoCairo.show_layout(cr, tick.layout);
    }

    if (hovered) {
        const hx = Math.round(x(hovered.time)) + 0.5;
        const hy = y(hovered.value);
        cr.setSourceRGBA(ir, ig, ib, ia * 0.6);
        cr.setLineWidth(1);
        cr.moveTo(hx, top);
        cr.lineTo(hx, bottom);
        cr.stroke();
        cr.setSourceRGB(r, g, b);
        cr.arc(hx, hy, Math.max(3, (bottom - top) / 18), 0, 2 * Math.PI);
        cr.fill();
    }
    return x;
}

export const Chart = GObject.registerClass(
class Chart extends Gtk.DrawingArea {
    _init(points, color, onHover) {
        super._init({css_classes: ['nook-chart'], content_height: 90, hexpand: true});
        this._points = points;
        this._color = color;
        this._onHover = onHover;
        this._hovered = null;
        this._x = null;
        this.set_draw_func((_area, cr, width, height) => {
            try {
                const ink = this.get_color();
                this._x = drawChart(cr, width, height, {
                    points: this._points,
                    color: this._color,
                    ink: [ink.red, ink.green, ink.blue, ink.alpha],
                    font: this.get_pango_context().get_font_description(),
                    hovered: this._hovered,
                });
            } finally {
                cr.$dispose();
            }
        });

        const motion = new Gtk.EventControllerMotion();
        motion.connect('motion', (_controller, at) => {
            if (!this._x)
                return;
            let nearest = this._points[0];
            for (const point of this._points) {
                if (Math.abs(this._x(point.time) - at) < Math.abs(this._x(nearest.time) - at))
                    nearest = point;
            }
            this._hover(nearest);
        });
        motion.connect('leave', () => this._hover(null));
        this.add_controller(motion);
        // The page may be rebuilt under the pointer: the leave then comes after its label is gone.
        this.connect('unrealize', () => (this._onHover = null));
    }

    _hover(point) {
        if (point === this._hovered)
            return;
        this._hovered = point;
        this._onHover?.(point);
        this.queue_draw();
    }
});
