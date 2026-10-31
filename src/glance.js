// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _} from 'gettext';

import * as Glyphs from './lib/glyphs.js';
import {GlyphWell} from './widgets.js';

const GREY = [0.62, 0.62, 0.68];

// The home at a glance, as HomePage's glanceOf() tells it: in the sidebar, or above the tiles.
// An item is {key, glyph, title, value, level, fold}; level: 'warning', 'error' or 'dim'. A
// click asks for the fold it is about.

function show(parts, item, lit) {
    parts.well.set([item.glyph, Glyphs.colorOf(item.glyph, GREY), null], lit, item.level === 'dim');
    parts.title.label = item.title;
    parts.value.label = item.value;
    for (const level of ['warning', 'error']) {
        if (item.level === level)
            parts.value.add_css_class(level);
        else
            parts.value.remove_css_class(level);
    }
}

// Rows are made anew only when the items are others; else they are refilled in place, and a
// focused one keeps the focus.
const sameKeys = (items, shown) => items.length === shown.length && items.every((item, i) => item.key === shown[i].key);

// Chips in a row that scrolls sideways, above the tiles.
export const GlanceStrip = GObject.registerClass({
    Signals: {'activate': {param_types: [GObject.TYPE_STRING]}},
}, class GlanceStrip extends Gtk.ScrolledWindow {
    _init() {
        super._init({
            hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            css_classes: ['nook-glance-strip'],
        });
        // Room for the chips' shadows: the strip clips what is outside it.
        this._box = new Gtk.Box({spacing: 10, margin_top: 4, margin_bottom: 6, margin_start: 2, margin_end: 2});
        // At their natural width, past the edge if need be: else the chips are squeezed.
        this.child = new Gtk.Viewport({child: this._box, hscroll_policy: Gtk.ScrollablePolicy.NATURAL});
        this._items = [];
        this._parts = [];
    }

    set(items) {
        if (!sameKeys(items, this._items)) {
            for (let child = this._box.get_first_child(); child; child = this._box.get_first_child())
                this._box.remove(child);
            this._parts = items.map(item => {
                const well = new GlyphWell({size: 16});
                const title = new Gtk.Label({xalign: 0, css_classes: ['caption', 'dim-label']});
                const value = new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 22, css_classes: ['nook-glance-value']});
                const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER});
                text.append(title);
                text.append(value);
                const box = new Gtk.Box({spacing: 10});
                box.append(well);
                box.append(text);
                const chip = new Gtk.Button({child: box, css_classes: ['card', 'nook-glance-chip']});
                chip.connect('clicked', () => this.emit('activate', item.fold));
                this._box.append(chip);
                return {chip, well, title, value};
            });
        }
        this._items = items;
        items.forEach((item, i) => {
            show(this._parts[i], item, item.level !== 'dim');
            this._parts[i].chip.tooltip_text = `${item.title}: ${item.value}`;
        });
    }
});

// Rows under the places in the sidebar, the air inside first and large: the item keyed 'air'
// has temperature and humidity, as text.
export const GlanceList = GObject.registerClass({
    Signals: {'activate': {param_types: [GObject.TYPE_STRING]}},
}, class GlanceList extends Gtk.ListBox {
    _init() {
        super._init({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['navigation-sidebar', 'nook-glance']});
        this.set_header_func((row, before) => {
            row.set_header(before ? null : new Gtk.Label({
                label: _('Now'),
                xalign: 0,
                css_classes: ['heading', 'dim-label'],
                margin_start: 12,
                margin_top: 12,
                margin_bottom: 6,
            }));
        });
        this.connect('row-activated', (_list, row) => this.emit('activate', row.fold));
        this._items = [];
        this._parts = [];
    }

    set(items) {
        if (!sameKeys(items, this._items)) {
            for (let row = this.get_first_child(); row; row = this.get_first_child())
                this.remove(row);
            this._parts = items.map(item => (item.key === 'air' ? this._air() : this._row()));
        }
        this._items = items;
        items.forEach((item, i) => {
            const parts = this._parts[i];
            parts.row.fold = item.fold;
            if (parts.big) {
                parts.big.label = item.temperature;
                parts.small.label = item.humidity ?? '';
                parts.small.visible = item.humidity !== null;
                parts.caption.label = item.title;
            } else {
                show(parts, item, false);
            }
        });
    }

    _row() {
        const well = new GlyphWell({size: 14});
        const title = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END});
        const value = new Gtk.Label({xalign: 1, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 12, css_classes: ['dim-label']});
        const box = new Gtk.Box({spacing: 10});
        box.append(well);
        box.append(title);
        box.append(value);
        const row = new Gtk.ListBoxRow({child: box});
        this.append(row);
        return {row, well, title, value};
    }

    _air() {
        const big = new Gtk.Label({css_classes: ['nook-glance-temperature']});
        const small = new Gtk.Label({xalign: 0, css_classes: ['heading']});
        const caption = new Gtk.Label({xalign: 0, css_classes: ['caption', 'dim-label']});
        const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER});
        text.append(small);
        text.append(caption);
        const box = new Gtk.Box({spacing: 12});
        box.append(big);
        box.append(text);
        const row = new Gtk.ListBoxRow({child: box});
        this.append(row);
        return {row, big, small, caption};
    }
});
