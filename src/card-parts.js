// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _} from 'gettext';

import {formatValue} from './text.js';
import {glyphArea} from './widgets.js';

// ms the stepper buttons rest before the value goes out.
const STEP_SETTLE = 700;
// ms a slider rests before its value goes out.
const SLIDER_SETTLE = 700;
// ms a slider just moved keeps its value over what a read brings: the device may not
// report the write yet.
const SLIDER_TOUCHED = 4000;

export function volumeIcon(level, muted) {
    if (muted || level === 0)
        return 'audio-volume-muted-symbolic';
    if (level < 0.34)
        return 'audio-volume-low-symbolic';
    return level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
}

export function roundButton(iconName, label, onClick) {
    const button = new Gtk.Button({
        icon_name: iconName,
        tooltip_text: label,
        valign: Gtk.Align.CENTER,
        css_classes: ['circular', 'nook-round'],
    });
    button.connect('clicked', onClick);
    return button;
}

// − value + over min..max; stepOf(v, direction) is how far a press goes. A pending
// value still goes out when the box leaves the page.
function stepper(current, [min, max], format, stepOf, write) {
    let wanted = current;
    let written = current;
    let timer = 0;
    const flush = () => {
        if (timer)
            GLib.source_remove(timer);
        timer = 0;
        if (wanted !== written) {
            written = wanted;
            write(wanted);
        }
    };
    const shown = new Gtk.Label({label: format(current), width_chars: 7, css_classes: ['numeric', 'nook-stepper-value']});
    const minus = roundButton('list-remove-symbolic', _('Less'), () => nudge(-1));
    const plus = roundButton('list-add-symbolic', _('More'), () => nudge(1));
    const sync = () => {
        minus.sensitive = wanted > min;
        plus.sensitive = wanted < max;
    };
    const nudge = direction => {
        wanted = Math.min(max, Math.max(min, wanted + direction * stepOf(wanted, direction)));
        shown.label = format(wanted);
        sync();
        if (timer)
            GLib.source_remove(timer);
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP_SETTLE, () => {
            timer = 0;
            flush();
            return GLib.SOURCE_REMOVE;
        });
    };
    sync();
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER, css_classes: ['nook-stepper']});
    box.append(minus);
    box.append(shown);
    box.append(plus);
    box.connect('unrealize', flush);
    return box;
}

// For a boxed group: title, then − value +.
export function stepperRow(title, current, range, format, stepOf, write) {
    const row = new Adw.ActionRow({title});
    row.add_suffix(stepper(current, range, format, stepOf, write));
    return row;
}

// The same in a hero's stage.
export function stepperLine(title, current, range, format, stepOf, write) {
    const line = new Gtk.Box({spacing: 6, css_classes: ['nook-stepper-line']});
    line.append(new Gtk.Label({label: title, xalign: 0, hexpand: true, wrap: true, css_classes: ['nook-slider-title']}));
    line.append(stepper(current, range, format, stepOf, write));
    return line;
}

// A boxed group's placeholder while its rows load.
export function loadingRow() {
    const row = new Adw.PreferencesRow({activatable: false});
    row.child = new Adw.Spinner({height_request: 32, margin_top: 12, margin_bottom: 12});
    return row;
}

export function noteRow(text) {
    const row = new Adw.PreferencesRow({activatable: false});
    row.child = new Gtk.Label({
        label: text,
        wrap: true,
        xalign: 0,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
        css_classes: ['dim-label'],
    });
    return row;
}

// Title and value over a slider of prop.range; steps: − and + beside it, lead: a button
// before it. update(value) shows a read unless the slider moved just now; scale follows
// a drag before it goes out.
export function sliderRow(title, prop, value, write, steps = false, lead = null) {
    const [min, max, step] = prop.range;
    const unit = step || 1;
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2, css_classes: ['nook-slider-row']});
    const top = new Gtk.Box({spacing: 6});
    top.append(new Gtk.Label({label: title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, css_classes: ['nook-slider-title']}));
    const shown = new Gtk.Label({css_classes: ['nook-slider-value', 'numeric']});
    top.append(shown);
    box.append(top);
    const adjustment = new Gtk.Adjustment({lower: min, upper: max, step_increment: unit, page_increment: Math.max(unit, (max - min) / 10)});
    const scale = new Gtk.Scale({adjustment, hexpand: true, valign: Gtk.Align.CENTER, draw_value: false, css_classes: ['nook-slider']});
    const snap = () => Math.min(max, Math.max(min, min + Math.round((adjustment.value - min) / unit) * unit));
    let timer = 0;
    let touched = 0;
    let quiet = false;
    const flush = () => {
        if (!timer)
            return;
        GLib.source_remove(timer);
        timer = 0;
        write(snap());
    };
    scale.connect('value-changed', () => {
        shown.label = formatValue(prop, snap()) || '–';
        if (quiet)
            return;
        touched = Date.now();
        if (timer)
            GLib.source_remove(timer);
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_SETTLE, () => {
            timer = 0;
            write(snap());
            return GLib.SOURCE_REMOVE;
        });
    });
    scale.connect('unrealize', flush);
    const update = next => {
        if (typeof next !== 'number' || timer || Date.now() - touched < SLIDER_TOUCHED)
            return;
        quiet = true;
        adjustment.value = next;
        quiet = false;
        shown.label = formatValue(prop, snap()) || '–';
    };
    quiet = true;
    adjustment.value = typeof value === 'number' ? value : min;
    quiet = false;
    shown.label = typeof value === 'number' ? formatValue(prop, snap()) || '–' : '–';
    if (!steps) {
        const line = new Gtk.Box({spacing: 10});
        if (lead)
            line.append(lead);
        line.append(scale);
        box.append(line);
        return {widget: box, update, scale};
    }
    const nudge = Math.max(unit, Math.round((max - min) / 20 / unit) * unit);
    const line = new Gtk.Box({spacing: 10});
    line.append(roundButton('list-remove-symbolic', _('Less'), () => {
        adjustment.value = Math.max(min, snap() - nudge);
    }));
    line.append(scale);
    line.append(roundButton('list-add-symbolic', _('More'), () => {
        adjustment.value = Math.min(max, snap() + nudge);
    }));
    box.append(line);
    return {widget: box, update, scale};
}

function wordLabel(text, classes) {
    return new Gtk.Label({label: text, ellipsize: Pango.EllipsizeMode.END, xalign: 0, css_classes: classes});
}

// A tile: its glyph in a bubble, a mark (the drawer's arrow or an LED), title and value.
// wide: alone in its line, laid out as a strip.
class GridTile {
    constructor(tile, opens, wide) {
        this.opens = opens;
        this._glyph = null;
        this._bubble = new Adw.Bin({css_classes: ['nook-ac-bubble'], halign: Gtk.Align.START});
        this.pin = new Gtk.Image({icon_name: 'view-pin-symbolic', pixel_size: 12, visible: false, valign: Gtk.Align.START, css_classes: ['nook-ac-mark']});
        const mark = opens
            ? new Gtk.Image({icon_name: 'pan-down-symbolic', pixel_size: 12, valign: Gtk.Align.START, css_classes: ['nook-ac-mark']})
            : new Gtk.Box({valign: Gtk.Align.START, css_classes: ['nook-ac-led']});
        this._title = wordLabel(tile.title, ['nook-ac-tile-title']);
        this._value = wordLabel('', ['nook-ac-tile-value']);
        let box;
        if (wide) {
            box = new Gtk.Box({spacing: 10});
            this._bubble.valign = Gtk.Align.CENTER;
            box.append(this._bubble);
            const words = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER});
            this._title.add_css_class('wide');
            words.append(this._title);
            words.append(this._value);
            box.append(words);
            this.pin.valign = mark.valign = Gtk.Align.CENTER;
            box.append(this.pin);
            box.append(mark);
        } else {
            const head = new Gtk.Box({spacing: 4});
            head.append(this._bubble);
            head.append(new Gtk.Box({hexpand: true}));
            head.append(this.pin);
            head.append(mark);
            box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 3});
            box.append(head);
            box.append(this._title);
            box.append(this._value);
        }
        this.button = new Gtk.Button({child: box, hexpand: true, tooltip_text: tile.title, css_classes: ['nook-ac-tile']});
        this.set(tile);
    }

    set(tile) {
        this.tile = tile;
        if (tile.glyph !== this._glyph) {
            this._glyph = tile.glyph;
            this._bubble.child = glyphArea(tile.glyph ?? 'dot', 16);
        }
        this._value.label = tile.text ?? '';
        const on = !this.opens && tile.on === true;
        if (on)
            this.button.add_css_class('on');
        else
            this.button.remove_css_class('on');
        this.pin.visible = tile.pinned === true;
    }

    setOpen(open) {
        if (open)
            this.button.add_css_class('open');
        else
            this.button.remove_css_class('open');
    }
}

// Tiles in lines of three or four: {title, glyph, text, on, value, pick(value),
// choices: [[value, label, glyph]], icon(value) → Gio.Icon, range: {prop, value, write},
// fill(box), pinned, togglePin()}. choices, range and fill open a drawer under the
// tile's line, the others switch; a secondary click on a tile with togglePin pins it.
export const TileGrid = GObject.registerClass(
class TileGrid extends Gtk.Box {
    _init(params = {}) {
        super._init({orientation: Gtk.Orientation.VERTICAL, spacing: 8, ...params});
        this.add_css_class('nook-tile-grid');
        this._shape = null;
        this._made = [];
        this._drawer = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, visible: false, css_classes: ['nook-drawer']});
        this._open = null;
        this._slider = null;
    }

    show(tiles) {
        const shape = JSON.stringify(tiles.map(t => [t.title, Boolean(t.choices), Boolean(t.range), Boolean(t.fill),
            t.choices?.map(([value, label]) => [value, label]), t.range?.prop.range]));
        if (shape !== this._shape) {
            this._shape = shape;
            this._build(tiles);
            return;
        }
        tiles.forEach((tile, i) => this._made[i].set(tile));
        const open = this._made.find(made => made.tile.title === this._open);
        if (!open)
            return;
        if (open.tile.range)
            this._slider?.update(open.tile.range.value);
        else
            this._unfold(open, false);
    }

    _build(tiles) {
        for (let child = this.get_first_child(); child; child = this.get_first_child())
            this.remove(child);
        this._made = [];
        this._slider = null;
        this.visible = tiles.length > 0;
        if (tiles.length === 0)
            return;
        let perRow = tiles.length % 4 !== 0 && tiles.length % 3 === 0 ? 3 : 4;
        perRow = Math.min(perRow, tiles.length);
        let line = null;
        tiles.forEach((tile, i) => {
            if (i % perRow === 0) {
                line = new Gtk.Box({spacing: 8, homogeneous: true});
                this.append(line);
            }
            const made = new GridTile(tile, Boolean(tile.choices || tile.range || tile.fill), perRow === 1);
            made.line = line;
            made.button.connect('clicked', () => this._clicked(made));
            const secondary = new Gtk.GestureClick({button: 3});
            secondary.connect('pressed', gesture => {
                if (!made.tile.togglePin)
                    return;
                gesture.set_state(Gtk.EventSequenceState.CLAIMED);
                made.tile.togglePin();
                made.pin.visible = !made.pin.visible;
            });
            made.button.add_controller(secondary);
            line.append(made.button);
            this._made.push(made);
        });
        for (let i = tiles.length % perRow; i > 0 && i < perRow; i++)
            line.append(new Gtk.Box());
        this.append(this._drawer);
        const open = this._made.find(made => made.opens && made.tile.title === this._open && !made.tile.choices);
        if (open)
            this._unfold(open, false);
        else
            this._fold();
    }

    _clicked(made) {
        if (!made.opens) {
            made.tile.pick(!made.tile.on);
            return;
        }
        const again = this._open === made.tile.title && this._drawer.visible;
        this._fold();
        if (!again)
            this._unfold(made, true);
    }

    _fold() {
        for (const made of this._made)
            made.setOpen(false);
        this._open = null;
        this._slider = null;
        this._drawer.visible = false;
    }

    _unfold(made, fresh) {
        const tile = made.tile;
        for (const other of this._made)
            other.setOpen(other === made);
        this._open = tile.title;
        for (let child = this._drawer.get_first_child(); child; child = this._drawer.get_first_child())
            this._drawer.remove(child);
        this._slider = null;
        if (tile.fill) {
            tile.fill(this._drawer);
        } else if (tile.range) {
            const {prop, value, write} = tile.range;
            this._slider = sliderRow(tile.title, prop, value, write, true);
            this._drawer.append(this._slider.widget);
        } else {
            this._fillChoices(tile);
        }
        this.reorder_child_after(this._drawer, made.line);
        this._drawer.visible = true;
        if (fresh)
            this._drawer.child_focus?.(Gtk.DirectionType.TAB_FORWARD);
    }

    _fillChoices(tile) {
        const count = tile.choices.length;
        const longest = Math.max(...tile.choices.map(([, label]) => label.length));
        const lines = Math.ceil(count / (longest > 10 ? 3 : longest > 6 ? 4 : 5));
        let line = null;
        let room = 0;
        let index = 0;
        tile.choices.forEach(([value, label, glyph]) => {
            if (room === 0) {
                room = Math.floor(count / lines) + (index < count % lines ? 1 : 0);
                index++;
                line = new Gtk.Box({homogeneous: true, spacing: 2, css_classes: ['nook-segments']});
                this._drawer.append(line);
            }
            room--;
            const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, css_classes: ['nook-segment-box']});
            const picture = tile.icon?.(value);
            if (picture)
                content.append(new Gtk.Image({gicon: picture, pixel_size: 32}));
            else if (glyph)
                content.append(glyphArea(glyph, 16));
            content.append(new Gtk.Label({label, wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 12}));
            const segment = new Gtk.Button({child: content, hexpand: true, tooltip_text: `${tile.title}: ${label}`, css_classes: ['nook-segment']});
            if (value === tile.value)
                segment.add_css_class('on');
            segment.connect('clicked', () => {
                this._fold();
                tile.pick(value);
            });
            line.append(segment);
        });
    }
});

// Readings as chips: [{title, glyph, text}].
export function statChips(stats) {
    const box = new Adw.WrapBox({child_spacing: 6, line_spacing: 6, css_classes: ['nook-stats']});
    for (const stat of stats) {
        const chip = new Gtk.Box({spacing: 5, css_classes: ['nook-stat-chip']});
        if (stat.glyph)
            chip.append(glyphArea(stat.glyph, 14));
        chip.append(new Gtk.Label({label: stat.title, css_classes: ['nook-stat-title']}));
        chip.append(new Gtk.Label({label: stat.text, css_classes: ['nook-stat-value', 'numeric']}));
        box.append(chip);
    }
    return box;
}

// Round buttons with a word under each, four to a line at most: [{icon, label, run}].
export function actionsRow(actions) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    if (actions.length === 0)
        return box;
    const perRow = Math.ceil(actions.length / Math.ceil(actions.length / 4));
    let line = null;
    actions.forEach(({icon, label, run}, i) => {
        if (i % perRow === 0) {
            line = new Gtk.Box({spacing: 6, homogeneous: true, css_classes: ['nook-actions']});
            box.append(line);
        }
        const item = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        const button = roundButton(icon, label, run);
        button.halign = Gtk.Align.CENTER;
        button.add_css_class('nook-action');
        item.append(button);
        item.append(new Gtk.Label({label, wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 10, css_classes: ['nook-action-word']}));
        line.append(item);
    });
    for (let i = actions.length % perRow; i > 0 && i < perRow; i++)
        line.append(new Gtk.Box());
    return box;
}
