// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gsk from 'gi://Gsk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _} from 'gettext';

import * as Glyphs from './lib/glyphs.js';
import * as Scenes from './lib/scenes.js';
import {atRest, heroColor, heroOf, tileText} from './hero.js';
import * as Motion from './motion.js';
import {deviceType, heardOf, isBluetooth, isOn, numberFormat, ownSwitch, stateText} from './text.js';

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
        // As the extension paints them: a tinted well while off, the well filled while on,
        // a page's card shaded from the colour; a tile's status dot in it.
        provider.load_from_string(`.nook-glyph.${name}:not(.offline) { background-color: alpha(${hex(color)}, 0.2); }
            .nook-glyph.${name}.on { background-color: ${hex(color)}; }
            button.nook-glyph.${name}.on:hover { background-color: shade(${hex(color)}, 1.08); }
            .nook-hero.${name} { background-image: linear-gradient(to bottom, ${shade(0.5)}, ${shade(0.24)}); }
            .nook-status-dot.${name} { background-color: ${hex(color)}; }`);
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

// Pictures stay still by the window's own switch, or by the system's Reduce Animation.
let still = false;
export function holdStill(value) {
    still = value;
}

export const animating = () => !still && Gtk.Settings.get_default().gtk_enable_animations;

// Tiles show the device, or its glyph in a well.
let withPictures = true;
export function showPictures(value) {
    withPictures = value;
}

// A tile with only the well over its text needs less height than a picture.
const GLYPH_RATIO = 1.3;

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
        const moving = this.get_mapped() && Scenes.moves(this._name, this._state) && animating();
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

// What a tile's switch turns on and off: as the device page's power button.
export const powered = device => device.online !== false && typeof device.source?.setSwitch === 'function' &&
    (device.primary?.kind === 'switch' ? ownSwitch(device) : ['climate', 'tv'].includes(device.primary?.kind));

// By file in pictures/: the corners of its display, as fractions of the picture, top-left first.
// The television's is drawn lit, and darkened while it is off.
const DISPLAYS = {
    'air-conditioner': [0.6799, 0.4041, 0.7977, 0.4284, 0.7964, 0.6003, 0.679, 0.5739],
    'temperature-humidity-sensor': [0.0628, 0.135, 0.8021, 0.1569, 0.7902, 0.9099, 0.077, 0.834],
    'television': [0.006, 0.037, 0.997, 0.004, 0.988, 0.766, 0.018, 0.912],
};
// A tile's picture is whole, as large as fits INSET from its corner, left of WIDE and above GROUND,
// which it stands on: in pixels, and in fractions of the tile's width and height.
const INSET = 20;
const WIDE = 0.71;
const GROUND = 0.6;
// What the box allows is cut down for pictures that fill more of it, so that a plug weighs
// about what a bulb does: by (MASS / their share of a square as tall)^0.3, to no less than FLOOR.
const MASS = 0.35;
const FLOOR = 0.55;
// By file in pictures/: where its light comes from, as fractions of the picture; how far it
// reaches across and down, in picture heights; and the share of that at full strength.
const GLOWS = {
    'light': [0.5, 0.3, 0.75, 0.75, 0.35],
    'gateway': [0.48, 0.5, 0.85, 0.85, 0.55],
    'air-conditioner': [0.5, 0.75, 1.8, 1.1, 0.1],
};
const GLYPH_PICTURES = {
    bulb: 'light', aircon: 'air-conditioner', plug: 'plug', tv: 'television', speaker: 'speaker', camera: 'camera',
    hub: 'gateway', thermometer: 'temperature-humidity-sensor', motion: 'motion-sensor', door: 'magnet-sensor',
    drop: 'submersion-sensor', vacuum: 'vacuum', fan: 'fan', wifi: 'repeater', pot: 'air-fryer', scale: 'scale',
    smoke: 'smoke-sensor', button: 'wireless-switch', kettle: 'kettle', scooter: 'scooter', rocker: 'relay',
};

// Models that look unlike the rest of their kind: the round Mi sensor has no display.
const MODEL_PICTURES = [[/^lumi\.sensor_ht\./, 'round-sensor']];

// The picture shows what the device is, the glyph what it switches: a gateway's night light
// is not the gateway.
function pictureName(device, [glyph]) {
    const [type] = Glyphs.kindOf(deviceType(device), null, device.model ?? '');
    if (glyph === lookOf(device)[0] && GLYPH_PICTURES[type]) {
        const own = MODEL_PICTURES.find(([pattern]) => pattern.test(device.model ?? ''));
        return own?.[1] ?? GLYPH_PICTURES[type];
    }
    return GLYPH_PICTURES[glyph] ?? null;
}

// What the picture's display shows: [big, small, colour], or null while it is dark.
function screenOf(device) {
    if (device.online === false && !heardOf(device))
        return null;
    if (device.primary?.kind === 'climate') {
        const target = device.state?.SetTem;
        return device.state?.Pow === 1 && typeof target === 'number' ? [numberFormat.format(target), null, AC_DIGITS] : null;
    }
    const {temperature, humidity} = heroOf(device).state;
    if (typeof temperature !== 'number')
        return null;
    return [`${numberFormat.format(temperature)}°`, typeof humidity === 'number' ? `${Math.round(humidity)}%` : null, LCD_INK];
}

// A sensor's display before its first reading: blank, it would pass for a plug or a switch.
const NO_READING = ['--.-°', '--%', new Gdk.RGBA({red: 0.13, green: 0.14, blue: 0.15, alpha: 0.3})];

const LCD_INK = new Gdk.RGBA({red: 0.13, green: 0.14, blue: 0.15, alpha: 0.88});
const AC_DIGITS = new Gdk.RGBA({red: 0.22, green: 0.6, blue: 1, alpha: 1});

// The projective map from the unit square onto a quad, as [a, b, c, d, e, f, g, h]:
// x = (a u + b v + c) / (g u + h v + 1), y likewise with d e f.
function squareTo([x0, y0, x1, y1, x2, y2, x3, y3]) {
    const [dx1, dx2, dx3] = [x1 - x2, x3 - x2, x0 - x1 + x2 - x3];
    const [dy1, dy2, dy3] = [y1 - y2, y3 - y2, y0 - y1 + y2 - y3];
    const det = dx1 * dy2 - dx2 * dy1;
    const g = (dx3 * dy2 - dx2 * dy3) / det;
    const h = (dx1 * dy3 - dx3 * dy1) / det;
    return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

function textLayout(widget, text, size) {
    const layout = widget.create_pango_layout(text);
    const font = Pango.FontDescription.from_string('Adwaita Sans');
    font.set_weight(Pango.Weight.MEDIUM);
    font.set_absolute_size(size * Pango.SCALE);
    layout.set_font_description(font);
    return layout;
}

const pictures = new Map();

// [pixbuf, texture, height, the share of it that is not transparent]
function picture(name) {
    let held = pictures.get(name);
    if (!held) {
        const uri = GLib.Uri.resolve_relative(import.meta.url, `pictures/${name}.png`, GLib.UriFlags.NONE);
        try {
            const full = GdkPixbuf.Pixbuf.new_from_file(Gio.File.new_for_uri(uri).get_path());
            held = [full, null, 0, coverage(full)];
        } catch (e) {
            console.warn(`nook: ${uri}: ${e.message}`);
            held = [null, null, 0, 1];
        }
        pictures.set(name, held);
    }
    return held;
}

// Read off a thumbnail: near enough, and quick.
function coverage(full) {
    if (!full.has_alpha)
        return 1;
    const thumb = full.scale_simple(Math.max(1, Math.round(48 * full.width / full.height)), 48, GdkPixbuf.InterpType.BILINEAR);
    const bytes = thumb.read_pixel_bytes().toArray();
    let sum = 0;
    for (let y = 0; y < thumb.height; y++) {
        for (let x = 0; x < thumb.width; x++)
            sum += bytes[y * thumb.rowstride + x * thumb.n_channels + 3];
    }
    return sum / 255 / (thumb.width * thumb.height);
}

// [width, height, coverage]
function pictureSize(name) {
    const [full, , , covered] = picture(name);
    return full ? [full.width, full.height, covered] : [0, 0, 1];
}

// Scaled here rather than by the renderer, whose mipmaps blur it.
function pictureAt(name, height) {
    const held = picture(name);
    const [full, texture, made] = held;
    if (!full || made === height)
        return texture;
    const scaled = full.scale_simple(Math.max(1, Math.round(full.width * height / full.height)), height,
        GdkPixbuf.InterpType.BILINEAR);
    held[1] = Gdk.MemoryTexture.new(scaled.width, scaled.height, Gdk.MemoryFormat.R8G8B8A8,
        scaled.read_pixel_bytes(), scaled.rowstride);
    held[2] = height;
    return held[1];
}

// ms a change of its light or display fades over.
const FADE = 400;
// µs between frames of what moves around it, the same frames in every tile: one redraw of
// the window draws them all.
const MOTION_FRAME = 1e6 / 20;

// A glow as a gradient, which the GPU draws: stops as [offset, red, green, blue, alpha].
function glowAt(snapshot, [cx, cy], [rx, ry], stops) {
    snapshot.append_radial_gradient(new Graphene.Rect().init(cx - rx, cy - ry, 2 * rx, 2 * ry),
        new Graphene.Point({x: cx, y: cy}), rx, ry, 0, 1,
        stops.map(([offset, red, green, blue, alpha]) => new Gsk.ColorStop({offset, color: new Gdk.RGBA({red, green, blue, alpha})})));
}

// Drawn past its own edges: the tile's rounded corners cut it. Its light and display fade
// between states; what the device does moves around it, never the picture itself, which
// would blur.
const DevicePicture = GObject.registerClass(
class DevicePicture extends Gtk.Widget {
    _init() {
        super._init({can_target: false, css_classes: ['nook-tile-picture']});
        this._name = null;
        this._screen = null;
        this._glow = null;
        this._dark = false;
        this._motion = null;
        // While a change fades in: what showed before it, and how far along it is, 0 to 1.
        this._was = null;
        this._fade = 1;
        this._fadeStart = 0;
        this._tick = 0;
        this._last = 0;
        this._content = null;
        this._adjustment = null;
        this._scrolled = [];
        // Below 1 in small tiles, whose text takes more of them: the picture shrinks toward the corner.
        this.shrink = 1;
        this.connect('map', () => {
            this._watch(true);
            this._run();
        });
        this.connect('unmap', () => {
            this._watch(false);
            this._run();
        });
    }

    // Scrolled out of sight it stops moving, and moves again once back.
    _watch(on) {
        this._scrolled.forEach(id => this._adjustment.disconnect(id));
        this._scrolled = [];
        const scroller = on ? this.get_ancestor(Gtk.ScrolledWindow) : null;
        const child = scroller?.get_child() ?? null;
        // Measured within what scrolls, which a scroll doesn't move: it is told before the
        // scrolled layout is.
        this._content = child instanceof Gtk.Viewport ? child.get_child() : child;
        this._adjustment = scroller?.vadjustment ?? null;
        if (this._adjustment)
            this._scrolled = ['value-changed', 'changed'].map(signal => this._adjustment.connect(signal, () => this._run()));
    }

    // Give or take half its height: what moves around it reaches past it.
    _inView() {
        if (!this._content || !this._adjustment)
            return true;
        const [known, bounds] = this.compute_bounds(this._content);
        if (!known)
            return true;
        const [top, tall] = [bounds.get_y(), bounds.get_height()];
        const {value, page_size: page} = this._adjustment;
        return top + 1.5 * tall > value && top - tall / 2 < value + page;
    }

    // Laid out in sight or out of it with nothing scrolled.
    vfunc_size_allocate(width, height, baseline) {
        super.vfunc_size_allocate(width, height, baseline);
        this._run();
    }

    // false: there is no picture of it. screen: what its display shows, as screenOf(); glow:
    // the light it gives off, as glowOf(); dark: its display is off; motion: what moves
    // around it, as motionOf().
    set(name, {screen = null, glow = null, dark = false, motion = null} = {}) {
        if (name !== this._name || JSON.stringify([screen, glow, dark]) !== JSON.stringify([this._screen, this._glow, this._dark])) {
            // Another picture shows at once; the same one changing fades, while it shows.
            const fading = name === this._name && this.get_mapped() && animating() && this._inView();
            this._was = fading ? {glow: this._glowNow(), dark: this._darkNow(), screen: this._screenNow()} : null;
            this._fade = fading ? 0 : 1;
            this._fadeStart = 0;
            this._name = name;
            this._screen = screen;
            this._glow = glow;
            this._dark = dark;
            this.queue_draw();
        }
        if (JSON.stringify(motion) !== JSON.stringify(this._motion)) {
            this._motion = motion;
            this.queue_draw();
        }
        this._run();
        return name !== null;
    }

    // The light as shown now: [red, green, blue, alpha], or null.
    _glowNow() {
        if (!this._was)
            return this._glow;
        const [from, to] = [this._was.glow, this._glow];
        if (!from && !to)
            return null;
        const start = from ?? [...to.slice(0, 3), 0];
        const end = to ?? [...from.slice(0, 3), 0];
        return start.map((v, i) => v + (end[i] - v) * this._fade);
    }

    // How dark its display is, 0 to 1.
    _darkNow() {
        const to = this._dark ? 1 : 0;
        return this._was ? this._was.dark + (to - this._was.dark) * this._fade : to;
    }

    // [[screen, alpha]]: what the display shows. It fades only as it lights up or goes out.
    _screens() {
        const was = this._was?.screen ?? null;
        if (!this._was || Boolean(was) === Boolean(this._screen))
            return this._screen ? [[this._screen, 1]] : [];
        return was ? [[was, 1 - this._fade]] : [[this._screen, this._fade]];
    }

    _screenNow() {
        const [[screen, alpha] = [null, 0]] = this._screens();
        return alpha >= 0.5 ? screen : null;
    }

    // Ticks while it fades or moves, and only while in sight.
    _run() {
        if (!this.get_mapped() && this._was) {
            this._was = null;
            this._fade = 1;
        }
        const wanted = this.get_mapped() && (this._fade < 1 || (Boolean(this._motion) && animating() && this._inView()));
        if (wanted && !this._tick) {
            this._tick = this.add_tick_callback((_widget, clock) => this._frame(clock.get_frame_time()));
        } else if (!wanted && this._tick) {
            this.remove_tick_callback(this._tick);
            this._tick = 0;
        }
    }

    _frame(now) {
        if (this._fade < 1) {
            this._fadeStart ||= now;
            const share = Math.min(1, (now - this._fadeStart) / (FADE * 1000));
            // Eased out: quick at first, then settling.
            this._fade = 1 - (1 - share) ** 3;
            if (share >= 1)
                this._was = null;
            this.queue_draw();
        } else if (Math.floor(now / MOTION_FRAME) !== Math.floor(this._last / MOTION_FRAME)) {
            this._last = now;
            this.queue_draw();
        }
        // Out of sight also by a layout that scrolled nothing, which no signal reports.
        if (this._fade < 1 || (this._motion && animating() && this._inView()))
            return GLib.SOURCE_CONTINUE;
        this._tick = 0;
        return GLib.SOURCE_REMOVE;
    }

    vfunc_snapshot(snapshot) {
        if (!this._name)
            return;
        const [wide, tall, covered] = pictureSize(this._name);
        const across = (WIDE * this.get_width() - INSET) * this.shrink;
        const down = (GROUND * this.get_height() - INSET) * this.shrink;
        const weighed = down * Math.min(1, Math.max(FLOOR, (MASS * tall / (wide * covered)) ** 0.3));
        const scale = this.get_native()?.get_surface()?.get_scale() ?? this.get_scale_factor();
        // In device pixels, so that it is drawn as it was scaled.
        const height = Math.round(Math.min(weighed, across * tall / wide) * scale / 8) * 8;
        const texture = height > 0 ? pictureAt(this._name, height) : null;
        if (!texture)
            return;
        const snap = v => Math.round(v * scale) / scale;
        const rect = new Graphene.Rect().init(snap(INSET), snap(INSET + down - texture.get_height() / scale),
            texture.get_width() / scale, texture.get_height() / scale);
        const glow = this._glowNow();
        if (glow && GLOWS[this._name])
            shine(snapshot, rect, GLOWS[this._name], glow);
        if (this._motion)
            this._move(snapshot, rect);
        snapshot.append_scaled_texture(texture, Gsk.ScalingFilter.LINEAR, rect);
        const display = DISPLAYS[this._name];
        if (!display)
            return;
        const dark = this._darkNow();
        if (dark > 0)
            this._darken(snapshot, rect, display, dark);
        for (const [screen, alpha] of this._screens())
            writeOn(this, snapshot, rect, display, screen, alpha);
    }

    // Behind the picture: air and steam come out from under it. Still where animations are off.
    _move(snapshot, rect) {
        const box = [rect.get_x(), rect.get_y(), rect.get_width(), rect.get_height()];
        const time = this._tick ? GLib.get_monotonic_time() / 1e6 : 0;
        const pulse = Motion.pulse(this._motion, box, time);
        if (pulse) {
            const [cx, cy, radius, stops] = pulse;
            glowAt(snapshot, [cx, cy], [radius, radius], stops);
            return;
        }
        const [x, y, width, height] = Motion.area(this._motion.kind, box);
        const cr = snapshot.append_cairo(new Graphene.Rect().init(x, y, width, height));
        Motion.draw(cr, box, time, {...this._motion, dark: Adw.StyleManager.get_default().dark});
        cr.$dispose();
    }

    // Dark glass, a little lighter toward the top.
    _darken(snapshot, rect, display, amount) {
        const quad = display.map((v, i) => i % 2 ? rect.get_y() + v * rect.get_height() : rect.get_x() + v * rect.get_width());
        const cr = snapshot.append_cairo(rect);
        const glass = new Cairo.LinearGradient(quad[0], quad[1], quad[4], quad[5]);
        glass.addColorStopRGBA(0, 0.16, 0.16, 0.18, amount);
        glass.addColorStopRGBA(1, 0.05, 0.05, 0.06, amount);
        cr.setSource(glass);
        cr.moveTo(quad[0], quad[1]);
        for (let i = 2; i < 8; i += 2)
            cr.lineTo(quad[i], quad[i + 1]);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
});

// glows as in GLOWS, color as glowOf() gives it.
function shine(snapshot, rect, [x, y, across, down, core], [red, green, blue, alpha]) {
    const [cx, cy] = [rect.get_x() + x * rect.get_width(), rect.get_y() + y * rect.get_height()];
    const [rx, ry] = [across * rect.get_height(), down * rect.get_height()];
    glowAt(snapshot, [cx, cy], [rx, ry], [[0, 1], [core, 1], [core + (1 - core) * 0.3, 0.55], [core + (1 - core) * 0.6, 0.2], [1, 0]]
        .map(([at, share]) => [at, red, green, blue, alpha * share]));
}

// Laid out on a 100 tall display as wide as the quad's sides say, then put on the quad.
function writeOn(widget, snapshot, rect, display, [big, small, color], alpha) {
    const quad = display.map((v, i) => i % 2 ? rect.get_y() + v * rect.get_height() : rect.get_x() + v * rect.get_width());
    const wide = 100 * Math.hypot(quad[2] - quad[0], quad[3] - quad[1]) / Math.hypot(quad[6] - quad[0], quad[7] - quad[1]);
    const [a, b, c, d, e, f, g, h] = squareTo(quad);
    snapshot.save();
    snapshot.transform(Gsk.Transform.new().matrix(new Graphene.Matrix().init_from_float(
        [a, d, 0, g, b, e, 0, h, 0, 0, 1, 0, c, f, 0, 1])));
    snapshot.scale(1 / wide, 1 / 100);
    const ink = new Gdk.RGBA({red: color.red, green: color.green, blue: color.blue, alpha: color.alpha * alpha});
    const put = (text, size, y) => {
        const layout = textLayout(widget, text, size);
        const [, logical] = layout.get_pixel_extents();
        snapshot.save();
        snapshot.translate(new Graphene.Point({x: (wide - logical.width) / 2, y: y - logical.height / 2}));
        snapshot.append_layout(layout, ink);
        snapshot.restore();
    };
    if (small) {
        put(big, 34, 38);
        put(small, 20, 76);
    } else {
        put(big, 74, 50);
    }
    snapshot.restore();
}

// ms each picture of a Showcase takes to rise in, apart, and the lamp to light up after them.
const SHOW_RISE = 600;
const SHOW_APART = 110;
const SHOW_LIGHT = 700;

// A few devices on one floor, for a window that has none yet. items, back to front:
// {name, x, floor, height, foot, glow, screen}: x and floor where it stands and height how
// tall, in units of unit pixels; foot the share of its width it stands on; glow as glowOf()
// gives it; screen [big, small] on its display. Its pictures rise in once, the first time it
// shows; "started" as they do, or as it shows where nothing rises.
export const Showcase = GObject.registerClass({
    Signals: {'started': {}},
}, class Showcase extends Gtk.Widget {
    _init(items, unit) {
        super._init({can_target: false, halign: Gtk.Align.CENTER, css_classes: ['nook-showcase']});
        this._unit = unit;
        this._items = items;
        this._played = false;
        this._drawn = false;
        this._elapsed = Infinity;
        this._start = 0;
        this._tick = 0;
        this.connect('map', () => this._play());
        this.connect('unmap', () => this._end());
    }

    _end() {
        if (this._tick)
            this.remove_tick_callback(this._tick);
        this._tick = 0;
        this._elapsed = Infinity;
        if (this._played && !this._start) {
            this._start = 1;
            this.emit('started');
        }
    }

    set items(items) {
        this._items = items;
        this.queue_resize();
    }

    // [left, top, right, bottom] in units, with room for the light above and the shadows below.
    _bounds() {
        let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const {name, x, floor, height, glow} of this._items) {
            const [wide, tall] = pictureSize(name);
            left = Math.min(left, x);
            right = Math.max(right, x + height * wide / Math.max(1, tall));
            top = Math.min(top, floor - height * (glow ? 1.4 : 1));
            bottom = Math.max(bottom, floor + 0.06);
        }
        return [left - 0.1, top, right + 0.1, bottom];
    }

    vfunc_measure(orientation) {
        const [left, top, right, bottom] = this._bounds();
        const size = Math.ceil((orientation === Gtk.Orientation.HORIZONTAL ? right - left : bottom - top) * this._unit);
        return [size, size, -1, -1];
    }

    _play() {
        if (this._played)
            return;
        this._played = true;
        if (!animating()) {
            this._end();
            return;
        }
        this._elapsed = 0;
        const length = SHOW_APART * this._items.length + SHOW_RISE + SHOW_LIGHT;
        this._tick = this.add_tick_callback((_widget, clock) => {
            // From the frame after the first is drawn, which can take long: see vfunc_snapshot().
            if (!this._drawn)
                return GLib.SOURCE_CONTINUE;
            if (!this._start) {
                this._start = clock.get_frame_time();
                this.emit('started');
            }
            this._elapsed = (clock.get_frame_time() - this._start) / 1000;
            this.queue_draw();
            if (this._elapsed < length)
                return GLib.SOURCE_CONTINUE;
            this._tick = 0;
            this._elapsed = Infinity;
            return GLib.SOURCE_REMOVE;
        });
    }

    // 0 to 1, eased out: how far along, elapsed ms in, what starts delay ms in and takes length.
    _along(elapsed, delay, length) {
        const share = Math.min(1, Math.max(0, (elapsed - delay) / length));
        return 1 - (1 - share) ** 3;
    }

    vfunc_snapshot(snapshot) {
        // Before it starts, a frame of it all but transparent: the pictures are scaled and what
        // the renderer makes for a kind of drawing the first time is made, before anything moves.
        const warming = Boolean(this._tick) && !this._start;
        this._drawn = true;
        if (warming)
            snapshot.push_opacity(0.004);
        this._draw(snapshot, warming ? Infinity : this._elapsed);
        if (warming)
            snapshot.pop();
    }

    _draw(snapshot, elapsed) {
        const [left, top] = this._bounds();
        const unit = this._unit;
        const scale = this.get_native()?.get_surface()?.get_scale() ?? this.get_scale_factor();
        const snap = v => Math.round(v * scale) / scale;
        const placed = this._items.map((item, i) => {
            const texture = pictureAt(item.name, Math.round(item.height * unit * scale));
            const [width, height] = texture ? [texture.get_width() / scale, texture.get_height() / scale] : [0, 0];
            const floor = snap((item.floor - top) * unit);
            const rect = new Graphene.Rect().init(snap((item.x - left) * unit), floor - height, width, height);
            return {item, texture, rect, shown: this._along(elapsed, SHOW_APART * i, SHOW_RISE)};
        });
        const lit = this._along(elapsed, SHOW_APART * this._items.length + SHOW_RISE / 2, SHOW_LIGHT);
        // Light is in the air, behind them all.
        for (const {item, rect} of placed) {
            if (item.glow && GLOWS[item.name] && lit > 0)
                shine(snapshot, rect, GLOWS[item.name], [...item.glow.slice(0, 3), item.glow[3] * lit]);
        }
        const shade = Adw.StyleManager.get_default().dark ? 0.6 : 0.24;
        for (const {item, texture, rect, shown} of placed) {
            if (!texture || shown <= 0)
                continue;
            const [cx, floor] = [rect.get_x() + rect.get_width() / 2, rect.get_y() + rect.get_height()];
            const foot = rect.get_width() * (item.foot ?? 0.9);
            snapshot.push_opacity(shown);
            glowAt(snapshot, [cx, floor], [foot * 0.75, Math.max(4, foot * 0.12)],
                [[0, 0, 0, 0, shade], [0.5, 0, 0, 0, shade * 0.35], [1, 0, 0, 0, 0]]);
            snapshot.save();
            snapshot.translate(new Graphene.Point({x: 0, y: (1 - shown) * 18}));
            snapshot.append_scaled_texture(texture, Gsk.ScalingFilter.LINEAR, rect);
            if (item.screen && DISPLAYS[item.name])
                writeOn(this, snapshot, rect, DISPLAYS[item.name], [...item.screen, LCD_INK], 1);
            snapshot.restore();
            snapshot.pop();
        }
    }
});

// The light a device gives off while it is on: [red, green, blue, alpha], or null.
function glowOf(device) {
    const {scene, state} = heroOf(device);
    if (scene === 'light' && state.on)
        return [...state.color, 0.25 + 0.55 * Math.min(1, Math.max(0, state.brightness / 100))];
    if (scene === 'gateway' && state.light)
        return [...state.color ?? [0.97, 0.62, 0.26], 0.7];
    if (scene === 'aircon' && state.on)
        return [...state.color, 0.3];
    return null;
}

// What moves around its picture while it works, as motion.js draws it, or null.
function motionOf(picture, hero, on) {
    if (hero.alarm)
        return {kind: 'alarm'};
    switch (picture) {
    case 'air-conditioner':
        return on ? {kind: 'air', color: hero.state.air ?? hero.state.color} : null;
    case 'kettle':
        // Heating, or keeping warm.
        return [1, 3].includes(hero.state.status) ? {kind: 'steam', strength: hero.state.status === 1 ? 1 : 0.6} : null;
    case 'speaker':
        return hero.state.playing ? {kind: 'sound', color: hero.color} : null;
    case 'fan':
        return on ? {kind: 'breeze', pace: hero.state.level ?? 1} : null;
    }
    return null;
}

// A device in the Home grid: its picture, or its glyph when it has none; the switch turns it
// on and off, the rest opens its page.
export const Tile = GObject.registerClass({
    Signals: {'open': {}, 'toggle': {}, 'menu': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]}},
}, class Tile extends Adw.Bin {
    _init(device, name, look) {
        super._init({layout_manager: new AspectLayout(withPictures ? 1 : GLYPH_RATIO, 220), css_classes: ['nook-tile']});
        onContextMenu(this, (x, y) => this.emit('menu', x, y));
        this.device = device;
        this._look = look;
        this._syncing = false;

        this._picture = new DevicePicture();
        this._well = new GlyphWell({size: 32, large: true});
        Object.assign(this._well, {halign: Gtk.Align.START, valign: Gtk.Align.START, margin_start: 18, margin_top: 18});
        this._name = new Gtk.Label({
            label: name,
            xalign: 0,
            wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR,
            lines: 2,
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 12,
            css_classes: ['nook-tile-name'],
        });
        this._state = new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 12, css_classes: ['nook-tile-state']});
        this._dot = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['nook-status-dot']});
        this._tint = null;
        const status = new Gtk.Box({spacing: 6});
        status.append(this._dot);
        status.append(this._state);
        this._text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.END, spacing: 2, margin_start: 20, margin_bottom: 18});
        this._text.append(this._name);
        this._text.append(status);
        const inside = new Gtk.Overlay({child: this._picture});
        inside.add_overlay(this._well);
        inside.add_overlay(this._text);
        this._button = new Gtk.Button({child: inside, tooltip_text: name, overflow: Gtk.Overflow.HIDDEN, css_classes: ['card', 'nook-tile-body']});
        this._button.connect('clicked', () => this.emit('open'));

        // Over the button, not in it, so they get their own clicks.
        this._switch = new Gtk.Switch({halign: Gtk.Align.END, valign: Gtk.Align.END, margin_end: 18, margin_bottom: 20});
        this._switch.update_property([Gtk.AccessibleProperty.LABEL], [name]);
        this._switch.connect('notify::active', () => {
            if (!this._syncing)
                this.emit('toggle');
        });
        this._more = new Gtk.Button({
            icon_name: 'view-more-symbolic',
            halign: Gtk.Align.END,
            valign: Gtk.Align.START,
            margin_end: 14,
            margin_top: 14,
            tooltip_text: _('More'),
            css_classes: ['circular', 'flat', 'nook-tile-more'],
        });
        this._more.connect('clicked', () => {
            const [, bounds] = this._more.compute_bounds(this);
            this.emit('menu', bounds.get_x(), bounds.get_y() + bounds.get_height());
        });
        const overlay = new Gtk.Overlay({child: this._button});
        overlay.add_overlay(this._switch);
        overlay.add_overlay(this._more);
        this.child = overlay;
        this.sync();
    }

    // The width the grid fits its rows with; tiles grow from it to fill a row.
    setWidth(width) {
        this.width_request = Math.round(width * 0.8);
        this.layout_manager.natural = width;
        this._small = width < 200;
        this._picture.shrink = this._small ? 0.9 : 1;
        if (this._small)
            this.add_css_class('small');
        else
            this.remove_css_class('small');
        this.sync();
    }

    setName(name) {
        this._name.label = name;
        this._button.tooltip_text = name;
        this._switch.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    }

    setLook(look) {
        this._look = look;
        this.sync();
    }

    sync() {
        // A Bluetooth device's tile says whether it was heard, as the extension's.
        const offline = this.device.online === false && !isBluetooth(this.device);
        const on = isOn(this.device) && !offline;
        const {kind} = this.device.primary;
        // Only what has a power of its own: a sensor is never off, nor is a gateway whose light is.
        const off = !on && !offline && (kind === 'switch' ? ownSwitch(this.device) : ['climate', 'tv'].includes(kind));
        for (const [name, set] of [['offline', offline], ['on', on], ['off', off]]) {
            if (set)
                this.add_css_class(name);
            else
                this.remove_css_class(name);
        }
        const switched = powered(this.device);
        this._switch.visible = switched;
        if (this._switch.active !== on) {
            this._syncing = true;
            this._switch.active = on;
            this._syncing = false;
        }
        this._text.margin_end = switched ? this._small ? 72 : 84 : 20;
        this._state.label = tileText(this.device);
        const hero = heroOf(this.device);
        this._showStatus(hero, offline || off || atRest(hero) ||
            (isBluetooth(this.device) && this.device.online !== true && !heardOf(this.device)));
        // A picture of the user's own takes the well, as do all with pictures off.
        const picture = this._look[2] || !withPictures ? null : pictureName(this.device, this._look);
        const screen = picture && DISPLAYS[picture] ? screenOf(this.device) : null;
        const pictured = this._picture.set(picture, {
            screen: screen ?? (picture === 'temperature-humidity-sensor' ? NO_READING : null),
            glow: on ? glowOf(this.device) : null,
            dark: kind === 'tv' && !on,
            motion: picture && !offline ? motionOf(picture, hero, on) : null,
        });
        this._picture.visible = pictured;
        this._well.visible = !pictured;
        if (!pictured)
            this._well.set(this._look, on, offline);
    }

    // Said in full, after a dot in the device's colour, while it does something; dimmed at rest.
    _showStatus(hero, idle) {
        const alarm = !idle && hero.alarm;
        for (const [name, set] of [['dim-label', idle], ['busy', !idle && !alarm], ['alarm', alarm]]) {
            if (set)
                this._state.add_css_class(name);
            else
                this._state.remove_css_class(name);
        }
        const tint = idle ? null : tintClass(heroColor(this.device, hero));
        if (tint !== this._tint) {
            if (this._tint)
                this._dot.remove_css_class(this._tint);
            if (tint)
                this._dot.add_css_class(tint);
            this._tint = tint;
        }
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

    set natural(width) {
        this._natural = width;
        this.layout_changed();
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

    setWidth(width) {
        this.width_request = Math.round(width * 0.8);
        this.child.layout_manager.natural = width;
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

// A camera at the foot of the sidebar: its last still, then its name and where it is.
export const CameraPin = GObject.registerClass({
    Signals: {'open': {}},
}, class CameraPin extends Gtk.Button {
    _init() {
        super._init({visible: false, css_classes: ['flat', 'nook-camera-pin']});
        this.device = null;
        this._picture = new Gtk.Picture({content_fit: Gtk.ContentFit.COVER, can_shrink: true});
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(aspectBox(this._picture, 16 / 9, 200, {overflow: Gtk.Overflow.HIDDEN, css_classes: ['nook-camera-pin-still']}));
        this._name = new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ['heading']});
        box.append(this._name);
        this._where = new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ['caption', 'dim-label']});
        box.append(this._where);
        this.child = box;
        this.connect('clicked', () => this.emit('open'));
    }

    // Hidden with no device.
    set(device, name, still) {
        this.device = device;
        this.visible = Boolean(device);
        if (!device)
            return;
        this._picture.paintable = still;
        this._name.label = name;
        this.tooltip_text = name;
        // The room, or the model for a camera in none; not what its name says already.
        const where = [device.room, device.model?.replace(/^tapo /, 'Tapo ')]
            .find(text => text && text.toLocaleLowerCase() !== name.toLocaleLowerCase()) ?? '';
        this._where.label = where;
        this._where.visible = where !== '';
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
