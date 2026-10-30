// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _} from 'gettext';

import * as Glyphs from './lib/glyphs.js';
import * as Scenes from './lib/scenes.js';
import {deviceType, isOn, stateText} from './text.js';

// [glyph, colour, image path or null]: the device's own look, or the one chosen for it.
export function lookOf(device, icons = {}) {
    const [glyph, color] = Glyphs.kindOf(deviceType(device), device.primary?.props?.[0]?.service ?? null, device.model ?? '');
    const own = icons[device.did];
    if (own?.startsWith('/'))
        return [glyph, color, own];
    if (own && Glyphs.CHOICES.includes(own))
        return [own, Glyphs.colorOf(own, color), null];
    return [glyph, color, null];
}

const hex = ([r, g, b]) => `#${[r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

// One class per kind colour, made when first needed: GTK CSS takes no inline style.
const tints = new Set();

export function tintClass(color) {
    const name = `nook-tint-${hex(color).slice(1)}`;
    if (!tints.has(name)) {
        tints.add(name);
        const provider = new Gtk.CssProvider();
        const shade = share => `rgb(${color.map(v => Math.round(v * 255 * share)).join(', ')})`;
        // As the extension paints them: a tinted well while off, the tile tinted while on,
        // a page's card shaded from the colour.
        provider.load_from_string(`.nook-glyph.${name}:not(.offline) { background-color: alpha(${hex(color)}, 0.2); }
            .nook-glyph.${name}.on { background-color: ${hex(color)}; }
            button.nook-glyph.${name}.on:hover { background-color: shade(${hex(color)}, 1.08); }
            .nook-tile.${name}.on { background-color: alpha(${hex(color)}, 0.22); }
            button.nook-tile.${name}.on:hover { background-color: alpha(${hex(color)}, 0.28); }
            .nook-hero.${name} { background-image: linear-gradient(to bottom, ${shade(0.5)}, ${shade(0.24)}); }`);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    return name;
}

// A glyph in a round well: kind colour, white on the colour while on, grey while offline.
export const GlyphWell = GObject.registerClass(
class GlyphWell extends Gtk.Button {
    _init({size = 20, large = false, activatable = false} = {}) {
        super._init({
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            can_target: activatable,
            focusable: activatable,
            css_classes: ['nook-glyph', ...large ? ['large'] : []],
        });
        this._size = size;
        this._look = ['appliance', [0.6, 0.6, 0.6], null];
        this._lit = false;
        this._dim = false;
        this._tint = null;
        this._art = new Gtk.DrawingArea({content_width: size, content_height: size, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        this._art.set_draw_func((_area, cr, width, height) => {
            const [glyph, color] = this._look;
            if (this._lit) {
                cr.setSourceRGB(1, 1, 1);
            } else if (this._dim) {
                const ink = this._art.get_color();
                cr.setSourceRGBA(ink.red, ink.green, ink.blue, 0.45);
            } else {
                cr.setSourceRGB(...color);
            }
            cr.scale(width / 16, height / 16);
            Glyphs.draw(cr, glyph);
            cr.$dispose();
        });
        this._image = null;
        this.child = this._art;
    }

    set(look, lit, dim) {
        this._look = look;
        this._lit = lit && !dim;
        this._dim = dim;
        const tint = tintClass(look[1]);
        if (tint !== this._tint) {
            if (this._tint)
                this.remove_css_class(this._tint);
            this.add_css_class(tint);
            this._tint = tint;
        }
        if (this._lit)
            this.add_css_class('on');
        else
            this.remove_css_class('on');
        const image = look[2];
        if (image) {
            this._image ??= new Gtk.Image({pixel_size: this._size});
            this._image.file = image;
            this.child = this._image;
        } else {
            this.child = this._art;
            this._art.queue_draw();
        }
    }
});

// A device card's picture from lib/scenes.js, moving while shown when its scene does.
export const SceneArea = GObject.registerClass(
class SceneArea extends Gtk.DrawingArea {
    _init(height) {
        super._init({content_height: height, hexpand: true});
        this._name = 'glyph';
        this._state = {};
        this._tick = 0;
        this._last = 0;
        this.set_draw_func((_area, cr, width, tall) => {
            try {
                const font = this.get_pango_context().get_font_description();
                Scenes.draw(cr, this._name, width, tall, GLib.get_monotonic_time() / 1e6, {...this._state, font});
            } finally {
                cr.$dispose();
            }
        });
        this.connect('map', () => this._run());
        this.connect('unmap', () => this._run());
    }

    show(name, state) {
        this._name = name;
        this._state = state;
        this.queue_draw();
        this._run();
    }

    // The device as drawn, [x, y, width, height]: clicks around it don't count.
    body() {
        return Scenes.body(this._name, this.get_width(), this.get_height(), this._state);
    }

    _run() {
        const moving = this.get_mapped() && Scenes.moves(this._name, this._state) &&
            Gtk.Settings.get_default().gtk_enable_animations;
        if (moving && !this._tick) {
            this._tick = this.add_tick_callback((_area, clock) => {
                const now = clock.get_frame_time();
                if (now - this._last >= 1e6 / Scenes.framesPerSecond(this._name) - 4000) {
                    this._last = now;
                    this.queue_draw();
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!moving && this._tick) {
            this.remove_tick_callback(this._tick);
            this._tick = 0;
        }
    }
});

// Secondary click, long press, Shift+F10 or the Menu key; x, y in widget.
export function onContextMenu(widget, show) {
    const click = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
    click.connect('pressed', (gesture, _n, x, y) => {
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        show(x, y);
    });
    widget.add_controller(click);
    const press = new Gtk.GestureLongPress({touch_only: true});
    press.connect('pressed', (gesture, x, y) => {
        gesture.set_state(Gtk.EventSequenceState.CLAIMED);
        show(x, y);
    });
    widget.add_controller(press);
    const keys = new Gtk.ShortcutController();
    keys.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('<Shift>F10|Menu'),
        action: Gtk.CallbackAction.new(() => {
            show(widget.get_width() / 2, widget.get_height() / 2);
            return true;
        }),
    }));
    widget.add_controller(keys);
}

// actions: what the model's items name under prefix, set on widget.
export function popupMenu(widget, model, prefix, actions, x, y) {
    widget.insert_action_group(prefix, actions);
    const popover = new Gtk.PopoverMenu({menu_model: model, has_arrow: false, halign: Gtk.Align.START});
    popover.set_parent(widget);
    popover.pointing_to = new Gdk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1});
    // Items run their action after closed: let go of it only then.
    popover.connect('closed', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        popover.unparent();
        return GLib.SOURCE_REMOVE;
    }));
    popover.popup();
}

// The switches the app can set: plugs, lights and relays that answer.
export const switchable = device => device.primary?.kind === 'switch' &&
    typeof device.source?.setSwitch === 'function' && device.online !== false;

// A device in the Home grid: the well switches it, the rest opens its page.
export const Tile = GObject.registerClass({
    Signals: {'open': {}, 'toggle': {}, 'menu': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]}},
}, class Tile extends Gtk.Overlay {
    _init(device, name, look) {
        super._init();
        onContextMenu(this, (x, y) => this.emit('menu', x, y));
        this.device = device;
        this._look = look;
        this._well = new GlyphWell({activatable: switchable(device)});
        this._well.margin_start = 8;
        this._well.halign = Gtk.Align.START;
        this._well.connect('clicked', () => this.emit('toggle'));

        this._name = new Gtk.Label({
            label: name,
            xalign: 0,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            lines: 2,
            ellipsize: Pango.EllipsizeMode.END,
            // Natural widths stay small, so a long name doesn't cost the grid a column.
            max_width_chars: 12,
            css_classes: ['nook-tile-name'],
        });
        this._state = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 12,
            css_classes: ['caption', 'dim-label', 'nook-tile-state'],
        });
        const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER, hexpand: true, spacing: 1});
        text.append(this._name);
        text.append(this._state);
        const line = new Gtk.Box({spacing: 10});
        // Room for the well, which floats over the button so it gets its own clicks.
        line.append(new Gtk.Box({width_request: 36}));
        line.append(text);
        this._button = new Gtk.Button({child: line, tooltip_text: name, css_classes: ['card', 'nook-tile']});
        this._tint = null;
        this._button.connect('clicked', () => this.emit('open'));
        this.child = this._button;
        this.add_overlay(this._well);
        this.sync();
    }

    setName(name) {
        this._name.label = name;
        this._button.tooltip_text = name;
    }

    setLook(look) {
        this._look = look;
        this.sync();
    }

    sync() {
        const offline = this.device.online === false;
        for (const widget of [this._button, this._well]) {
            if (offline)
                widget.add_css_class('offline');
            else
                widget.remove_css_class('offline');
        }
        this._well.can_target = switchable(this.device);
        this._well.focusable = this._well.can_target;
        this._well.tooltip_text = this._well.can_target ? (isOn(this.device) ? _('Turn Off') : _('Turn On')) : null;
        this._well.set(this._look, isOn(this.device), offline);
        this._state.label = stateText(this.device);
        const tint = tintClass(this._look[1]);
        if (tint !== this._tint) {
            if (this._tint)
                this._button.remove_css_class(this._tint);
            this._button.add_css_class(tint);
            this._tint = tint;
        }
        if (isOn(this.device) && !offline)
            this._button.add_css_class('on');
        else
            this._button.remove_css_class('on');
    }
});

// As tall as its width and ratio say: Gtk.AspectFrame only fits the child into the
// height it gets, so in a grid it ends up a strip.
const AspectLayout = GObject.registerClass(
class AspectLayout extends Gtk.LayoutManager {
    _init(ratio, natural) {
        super._init();
        this._ratio = ratio;
        this._natural = natural;
    }

    vfunc_get_request_mode() {
        return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH;
    }

    vfunc_measure(widget, orientation, forSize) {
        const child = widget.get_first_child();
        const [minWidth] = child?.measure(Gtk.Orientation.HORIZONTAL, -1) ?? [0];
        if (orientation === Gtk.Orientation.HORIZONTAL)
            return [minWidth, Math.max(minWidth, this._natural), -1, -1];
        const [minHeight] = child?.measure(Gtk.Orientation.VERTICAL, -1) ?? [0];
        const tall = width => Math.max(minHeight, Math.round(width / this._ratio));
        if (forSize > 0)
            return [tall(forSize), tall(forSize), -1, -1];
        return [tall(minWidth), tall(Math.max(minWidth, this._natural)), -1, -1];
    }

    vfunc_allocate(widget, width, height, baseline) {
        widget.get_first_child()?.allocate(width, height, baseline, null);
    }
});

// natural: the width it asks for; a page's picture asks for all the page has.
export function aspectBox(child, ratio, natural, params = {}) {
    return new Adw.Bin({child, layout_manager: new AspectLayout(ratio, natural), ...params});
}

// A camera in the Home grid: its last still, the name over it.
export const CameraTile = GObject.registerClass({
    Signals: {'open': {}, 'menu': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]}},
}, class CameraTile extends Gtk.Button {
    _init(device, name) {
        super._init({tooltip_text: name, overflow: Gtk.Overflow.HIDDEN, css_classes: ['card', 'nook-camera']});
        onContextMenu(this, (x, y) => this.emit('menu', x, y));
        this.device = device;
        this._picture = new Gtk.Picture({content_fit: Gtk.ContentFit.COVER, can_shrink: true});
        const waiting = glyphArea('camera', 28);
        waiting.add_css_class('dim-label');
        this._stack = new Gtk.Stack({transition_type: Gtk.StackTransitionType.CROSSFADE});
        this._stack.add_named(waiting, 'waiting');
        this._stack.add_named(this._picture, 'still');
        const caption = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.END, css_classes: ['nook-camera-caption']});
        this._name = new Gtk.Label({label: name, xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ['nook-tile-name']});
        caption.append(this._name);
        this._state = new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ['caption', 'nook-tile-state']});
        caption.append(this._state);
        const overlay = new Gtk.Overlay({child: this._stack});
        overlay.add_overlay(caption);
        this.child = aspectBox(overlay, 16 / 9, 280);
        this.connect('clicked', () => this.emit('open'));
        this.sync();
    }

    setName(name) {
        this._name.label = name;
        this.tooltip_text = name;
    }

    setStill(texture) {
        this._picture.paintable = texture;
        this._stack.visible_child_name = texture ? 'still' : 'waiting';
    }

    sync() {
        if (this.device.online === false)
            this.add_css_class('offline');
        else
            this.remove_css_class('offline');
        this._state.label = stateText(this.device);
        // The picture says it is online.
        this._state.visible = this.device.online !== true;
    }
});

export function setNamed(settings, key, did, value) {
    const next = {...settings.get_value(key).deepUnpack()};
    if (value)
        next[did] = value;
    else
        delete next[did];
    settings.set_value(key, new GLib.Variant('a{ss}', next));
}

export function renameDialog(name, own, parent, onDone) {
    const entry = new Gtk.Entry({text: own ?? '', placeholder_text: name, activates_default: true});
    const dialog = new Adw.AlertDialog({
        heading: _('Rename'),
        body: _('A name for Nook only; the device and its app keep their own. Leave it empty to use that one.'),
        extra_child: entry,
        default_response: 'save',
        close_response: 'cancel',
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('save', _('Save'));
    dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
    dialog.connect('response', (_dialog, response) => {
        if (response === 'save')
            onDone(entry.text.trim());
    });
    dialog.present(parent);
}

// Copies get fresh names: the shell's texture cache keys on the path.
const ICON_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'nook', 'icons']);

function keepPicture(source) {
    GLib.mkdir_with_parents(ICON_DIR, 0o700);
    // St recolours an SVG only when its name ends in -symbolic.svg.
    const suffix = /(-symbolic)?\.[^./]+$/.exec(source.get_basename())?.[0] ?? '';
    const target = Gio.File.new_for_path(GLib.build_filenamev([ICON_DIR, `${GLib.uuid_string_random()}${suffix}`]));
    source.copy(target, Gio.FileCopyFlags.NONE, null, null);
    return target.get_path();
}

// A copy this app made is removed once nothing points at it.
export function dropPicture(path) {
    if (path?.startsWith(`${ICON_DIR}/`))
        GLib.unlink(path);
}

function choosePicture(parent, onDone) {
    const filter = new Gtk.FileFilter({name: _('Images')});
    filter.add_pixbuf_formats();
    const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
    filters.append(filter);
    const dialog = new Gtk.FileDialog({title: _('Choose an Image'), filters, default_filter: filter});
    dialog.open(parent.get_root(), null, (_dialog, result) => {
        let file;
        try {
            file = dialog.open_finish(result);
        } catch {
            return;
        }
        try {
            onDone(keepPicture(file));
        } catch (e) {
            const alert = new Adw.AlertDialog({heading: _('Could Not Use the Image'), body: e.message});
            alert.add_response('close', _('Close'));
            alert.present(parent);
        }
    });
}

export function glyphArea(name, size) {
    const area = new Gtk.DrawingArea({content_width: size, content_height: size, valign: Gtk.Align.CENTER, halign: Gtk.Align.CENTER});
    area.set_draw_func((_area, cr, width, height) => {
        const ink = area.get_color();
        cr.setSourceRGBA(ink.red, ink.green, ink.blue, ink.alpha);
        cr.scale(width / 16, height / 16);
        Glyphs.draw(cr, name);
        cr.$dispose();
    });
    return area;
}

// onDone(icon): a glyph name, an image path, or '' for the device's own.
export function iconDialog(current, parent, onDone) {
    const grid = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 6,
        max_children_per_line: 8,
        column_spacing: 4,
        row_spacing: 4,
    });
    const dialog = new Adw.AlertDialog({
        heading: _('Icon'),
        body: _('Pick one for the tile, or use an image of your own.'),
        extra_child: grid,
        close_response: 'cancel',
    });
    for (const name of Glyphs.CHOICES) {
        const button = new Gtk.ToggleButton({
            child: glyphArea(name, 20),
            active: name === current,
            css_classes: ['flat'],
        });
        button.connect('clicked', () => {
            onDone(name);
            dialog.close();
        });
        grid.append(button);
    }
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('default', _('Default'));
    dialog.add_response('file', _('Image…'));
    dialog.set_response_enabled('default', Boolean(current));
    dialog.connect('response', (_dialog, response) => {
        if (response === 'default')
            onDone('');
        else if (response === 'file')
            choosePicture(parent, onDone);
    });
    dialog.present(parent);
}

// For the header of each page the sidebar leads to; the window's win.show-sidebar holds the state.
export function sidebarButton() {
    return new Gtk.ToggleButton({icon_name: 'sidebar-show-symbolic', action_name: 'win.show-sidebar', tooltip_text: _('Show Sidebar')});
}

export function navigationRow(title, subtitle = null) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    return row;
}

// A page with a header bar for the window's navigation view.
export function subpage(title, content, tag = null) {
    const view = new Adw.ToolbarView({content});
    view.add_top_bar(new Adw.HeaderBar());
    return new Adw.NavigationPage({title, tag, child: view});
}
