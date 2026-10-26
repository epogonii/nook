// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import * as Glyphs from '../lib/glyphs.js';
import * as Scenes from '../lib/scenes.js';
import {COOL, WARM} from './climate.js';
import {VERTICAL} from './text.js';

// Wheel scrolls the card instead of moving the slider and sending the new value.
export const CardSlider = GObject.registerClass(
class CardSlider extends Slider.Slider {
    vfunc_scroll_event() {
        return Clutter.EVENT_PROPAGATE;
    }
});

export const TemperatureSlider = GObject.registerClass(
class TemperatureSlider extends CardSlider {
    _init([min, max, step], preview, set) {
        super._init(0);
        this._min = min;
        this._max = max;
        this._step = step;
        this.x_expand = true;
        this._dragging = false;
        this.connect('notify::value', () => {
            if (this._dragging)
                preview(this.temperature);
        });
        this.connect('drag-begin', () => {
            this._dragging = true;
        });
        this.connect('drag-end', () => {
            this._dragging = false;
            set(this.temperature);
        });
    }

    get temperature() {
        const raw = this._min + this.value * (this._max - this._min);
        const snapped = Math.round(Math.round(raw / this._step) * this._step * 10) / 10;
        return Math.min(this._max, Math.max(this._min, snapped));
    }

    showTemperature(temperature) {
        if (!this._dragging)
            this.value = (temperature - this._min) / (this._max - this._min);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const bar = node.get_length('-barlevel-height') || 6;
        const radius = node.get_length('-slider-handle-radius') || 10;
        const handleX = radius + (width - 2 * radius) * this.value / (this.maximum_value || 1);
        const y = height * 0.42;
        const gradient = new Cairo.LinearGradient(radius, 0, width - radius, 0);
        gradient.addColorStopRGB(0, ...COOL);
        gradient.addColorStopRGB(1, ...WARM);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(bar);
        cr.setSource(gradient);
        cr.moveTo(radius, y);
        cr.lineTo(width - radius, y);
        cr.pushGroup();
        cr.stroke();
        cr.popGroupToSource();
        cr.paintWithAlpha(0.3);
        cr.setSource(gradient);
        cr.moveTo(radius, y);
        cr.lineTo(handleX, y);
        cr.stroke();

        cr.setLineWidth(scale);
        cr.setSourceRGBA(1, 1, 1, 0.35);
        for (let degree = Math.ceil(this._min); degree <= this._max; degree++) {
            const x = radius + (width - 2 * radius) * (degree - this._min) / (this._max - this._min);
            const long = degree % 5 === 0;
            cr.moveTo(x, y + bar / 2 + 3 * scale);
            cr.lineTo(x, y + bar / 2 + (long ? 7 : 5) * scale);
        }
        cr.stroke();

        cr.setSourceRGBA(0, 0, 0, 0.25);
        cr.arc(handleX, y + scale, radius, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGB(1, 1, 1);
        cr.arc(handleX, y, radius, 0, 2 * Math.PI);
        cr.fill();
        const t = this.value / (this.maximum_value || 1);
        cr.setSourceRGB(...COOL.map((cool, i) => cool + (WARM[i] - cool) * t));
        cr.arc(handleX, y, radius * 0.38, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});

export const VolumeSlider = GObject.registerClass(
class VolumeSlider extends CardSlider {
    _init(preview, set) {
        super._init(0);
        this.x_expand = true;
        this._dragging = false;
        this.connect('notify::value', () => {
            if (this._dragging)
                preview(this.value);
        });
        this.connect('drag-begin', () => {
            this._dragging = true;
        });
        this.connect('drag-end', () => {
            this._dragging = false;
            set(this.value);
        });
    }

    showLevel(level) {
        if (!this._dragging)
            this.value = level;
    }
});

export const Scene = GObject.registerClass(
class Scene extends St.DrawingArea {
    _init(name, styleClass, expand = true) {
        super._init({style_class: styleClass, x_expand: expand});
        this._name = name;
        this._state = {};
        this._timeline = null;
        this.connect('destroy', () => this.run(false));
    }

    show(state) {
        this._state = state;
        this.queue_repaint();
    }

    setScene(name, state) {
        this._name = name;
        this.show(state);
    }

    run(on) {
        if (on && !this._timeline) {
            this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
            let last = 0;
            this._timeline.connect('new-frame', () => {
                const now = GLib.get_monotonic_time();
                if (now - last < 1e6 / Scenes.framesPerSecond(this._name) - 4000)
                    return;
                last = now;
                this.queue_repaint();
            });
            this._timeline.start();
        } else if (!on && this._timeline) {
            this._timeline.stop();
            this._timeline = null;
            this.queue_repaint();
        }
    }

    // The device drawn, in this actor's coordinates. Not get_surface_size(): it only
    // works while repainting.
    body() {
        return Scenes.body(this._name, this.width, this.height, this._state);
    }

    // Dispose the context even if drawing throws, or every later frame leaks one.
    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0)
                return;
            const font = this.get_theme_node().get_font();
            Scenes.draw(cr, this._name, width, height, GLib.get_monotonic_time() / 1e6, {...this._state, font});
        } finally {
            cr.$dispose();
        }
    }
});

// Pressed on the device its scene draws, not anywhere on the stage around it.
export const SceneButton = GObject.registerClass(
class SceneButton extends St.Button {
    vfunc_pick(context) {
        const scene = this.child;
        const body = this.reactive ? scene.body() : null;
        if (!body)
            return;
        const [x, y, width, height] = body;
        const left = scene.x + x;
        const top = scene.y + y;
        this.pick_box(context, new Clutter.ActorBox({x1: left, y1: top, x2: left + width, y2: top + height}));
    }
});

export const Glyph = GObject.registerClass(
class Glyph extends St.DrawingArea {
    _init(name) {
        super._init({
            style_class: 'nook-glyph',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = name;
        this._color = null;
        this.connect('style-changed', () => this.queue_repaint());
    }

    setName(name) {
        if (name !== this._name) {
            this._name = name;
            this.queue_repaint();
        }
    }

    // [r, g, b] in 0-1, or null for the theme foreground.
    setColor(color) {
        this._color = color;
        this.queue_repaint();
    }

    _ink(cr) {
        const ink = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(ink.red / 255, ink.green / 255, ink.blue / 255, ink.alpha / 255);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (this._color)
            cr.setSourceRGB(...this._color);
        else
            this._ink(cr);
        cr.scale(width / 16, height / 16);
        try {
            Glyphs.draw(cr, this._name);
        } finally {
            cr.$dispose();
        }
    }
});

// Clutter drops transitions on unmapped actors, so the pulse starts on map.
// It stops on unmap: an endless ease holds off unredirection.
const Skeleton = GObject.registerClass(
class Skeleton extends St.Widget {
    _init(params = {}) {
        super._init({style_class: 'nook-skeleton', ...params});
        this.connect('notify::mapped', () => breathe(this));
    }
});

export function breathe(actor, on = true) {
    actor.remove_all_transitions();
    actor.opacity = 255;
    if (!on || !actor.mapped || !St.Settings.get().enable_animations)
        return;
    actor.ease({
        opacity: 80,
        duration: 750,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        repeatCount: -1,
        autoReverse: true,
    });
}

export function skeletonBar(width = '') {
    return new Skeleton({
        style_class: width ? `nook-skeleton nook-skeleton-${width}` : 'nook-skeleton',
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export function skeletonLines(widths = ['wide', 'mid', '']) {
    const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-skeleton-lines'});
    for (const width of widths)
        box.add_child(skeletonBar(width));
    return box;
}

// Shows each pick at once; when no write is in flight any more, settles on the last one
// the device took.
export function optimistic(actor, initial, show) {
    let acked = initial, ackedAsk = 0, asks = 0, pending = 0, gone = false;
    actor.connect('destroy', () => {
        gone = true;
    });
    return (value, write) => {
        const ask = ++asks;
        pending++;
        show(value);
        write(value).then(() => {
            if (ask > ackedAsk) {
                acked = value;
                ackedAsk = ask;
            }
        }, () => {}).finally(() => {
            if (--pending === 0 && !gone)
                show(acked);
        });
    };
}

export function skeletonBlock(styleClass = '') {
    return new Skeleton({style_class: `nook-skeleton-block ${styleClass}`.trim(), x_expand: true, y_expand: true});
}

// A blank label under the bar keeps the line as tall as the text.
export function skeletonLine(textClass, width = '') {
    const line = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
    line.add_child(new St.Label({style_class: textClass, text: ' ', x_expand: true}));
    const bar = skeletonBar(width);
    bar.x_expand = true;
    line.add_child(bar);
    return line;
}
