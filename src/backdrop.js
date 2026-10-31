// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

// Home's background: one of these, in backgrounds/, or a picture of the user's own, kept in
// OWN_DIR. The background setting has its name, the path of the user's, or '' for none. The
// light ones first.
const BUILT_IN = () => [
    ['morning', _('Morning')],
    ['blinds', _('Blinds')],
    ['linen', _('Linen')],
    ['mist', _('Mist')],
    ['sage', _('Sage')],
    ['ripple', _('Ripple')],
    ['dunes', _('Dunes')],
    ['dusk', _('Dusk')],
    ['night', _('Night')],
    ['rain', _('Rain')],
    ['lamp', _('Lamp')],
    ['velvet', _('Velvet')],
];

// Copies get fresh names: a texture loaded from a path is cached by it.
const OWN_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'nook', 'backgrounds']);
// px a picture of the user's is kept at, on its long side: about a large screen's width.
const OWN_SIZE = 2560;

const builtIn = (name, suffix = '') =>
    GLib.filename_from_uri(GLib.Uri.resolve_relative(import.meta.url, `backgrounds/${name}${suffix}.jpg`, GLib.UriFlags.NONE))[0];

// Null for none, or a name that is no picture of the app's.
function fileOf(value) {
    if (value.startsWith('/'))
        return value;
    return BUILT_IN().some(([name]) => name === value) ? builtIn(value) : null;
}

// The latest picture of the user's, kept to choose again after another.
function ownPicture() {
    try {
        const names = [];
        const dir = Gio.File.new_for_path(OWN_DIR).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = dir.next_file(null); info; info = dir.next_file(null))
            names.push(info.get_name());
        dir.close(null);
        const latest = names.filter(name => name.endsWith('.jpg')).sort().at(-1);
        return latest ? GLib.build_filenamev([OWN_DIR, latest]) : null;
    } catch {
        return null;
    }
}

// Turned upright, made no larger than OWN_SIZE and saved as JPEG; the copies before it go.
function keepPicture(file) {
    const path = file.get_path();
    // At scale makes a smaller one larger too.
    const [, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    const pixbuf = (Math.max(width, height) > OWN_SIZE
        ? GdkPixbuf.Pixbuf.new_from_file_at_scale(path, OWN_SIZE, OWN_SIZE, true)
        : GdkPixbuf.Pixbuf.new_from_file(path)).apply_embedded_orientation();
    GLib.mkdir_with_parents(OWN_DIR, 0o700);
    // Named by time, so that the latest sorts last.
    const kept = GLib.build_filenamev([OWN_DIR, `${GLib.DateTime.new_now_utc().format('%Y%m%d%H%M%S')}-${GLib.uuid_string_random().slice(0, 8)}.jpg`]);
    pixbuf.savev(kept, 'jpeg', ['quality'], ['90']);
    try {
        const dir = Gio.File.new_for_path(OWN_DIR).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = dir.next_file(null); info; info = dir.next_file(null)) {
            const other = GLib.build_filenamev([OWN_DIR, info.get_name()]);
            if (other !== kept)
                GLib.unlink(other);
        }
        dir.close(null);
    } catch (e) {
        console.debug(`nook: old backgrounds: ${e.message}`);
    }
    return kept;
}

// How much of the window's own colour goes over the picture, [light, dark]: enough that the
// text on it reads where the picture is darkest in the light style and lightest in the dark.
function scrimOf(path) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 24, 24, false);
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.rowstride;
    const step = pixbuf.n_channels;
    const lumas = [];
    for (let y = 0; y < pixbuf.height; y++) {
        for (let x = 0; x < pixbuf.width; x++) {
            const i = y * stride + x * step;
            lumas.push(0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]);
        }
    }
    lumas.sort((a, b) => a - b);
    const darkest = lumas[Math.floor(lumas.length * 0.1)];
    const lightest = lumas[Math.floor(lumas.length * 0.9)];
    const clamp = (value, low) => Math.min(0.85, Math.max(low, value));
    // The window's own colours are about 250 light and 34 dark; text wants above 165 and
    // below 90 under it.
    // A picture lighter or darker than the window's own needs no more than the least.
    return [clamp(Math.max(0, 165 - darkest) / Math.max(1, 250 - darkest), 0.35),
        clamp(Math.max(0, lightest - 90) / Math.max(1, lightest - 34), 0.45)];
}

let provider = null;
let shown = null;

// On widget, as the background setting says, under the window's colour in the style in use: a
// provider of the app's own takes @media as in the light style. A picture that can't be read is
// none.
export function showBackdrop(widget, value) {
    const manager = Adw.StyleManager.get_default();
    if (!provider) {
        provider = new Gtk.CssProvider();
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        manager.connect('notify::dark', () => {
            if (shown)
                showBackdrop(...shown);
        });
    }
    shown = [widget, value];
    let path = null;
    let css = '';
    try {
        path = fileOf(value);
        if (path) {
            const [light, dark] = scrimOf(path);
            const veil = `alpha(var(--window-bg-color), ${(manager.dark ? dark : light).toFixed(2)})`;
            css = `.nook-backdrop { background-image: linear-gradient(${veil}, ${veil}), url("${GLib.filename_to_uri(path, null)}");
                background-size: cover; background-position: center; }`;
        }
    } catch (e) {
        console.debug(`nook: background ${path}: ${e.message}`);
    }
    provider.load_from_string(css);
    if (css)
        widget.add_css_class('nook-backdrop');
    else
        widget.remove_css_class('nook-backdrop');
}

// With the page it was on: a change of style then has nothing to redo.
export function forgetBackdrop() {
    shown = null;
}

function chooseOwn(parent, onDone) {
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

// None, the pictures that come with the app, the user's own, and a button to choose another.
export function backdropDialog(parent, settings) {
    const grid = new Gtk.FlowBox({
        selection_mode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        min_children_per_line: 2,
        max_children_per_line: 4,
        column_spacing: 12,
        row_spacing: 12,
        css_classes: ['nook-backdrops'],
    });
    const swatches = [];
    const mark = () => {
        const value = settings.get_string('background');
        for (const [swatch, own] of swatches) {
            if (own === value)
                swatch.add_css_class('chosen');
            else
                swatch.remove_css_class('chosen');
        }
    };
    const add = (value, label, picture, onClick = () => settings.set_string('background', value)) => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        // Sized by the box: a picture would take its own size.
        const frame = new Gtk.Overlay({
            child: new Gtk.Box({width_request: 152, height_request: 95}),
            css_classes: ['nook-backdrop-frame'],
            overflow: Gtk.Overflow.HIDDEN,
        });
        if (picture)
            frame.add_overlay(new Gtk.Picture({file: Gio.File.new_for_path(picture), content_fit: Gtk.ContentFit.COVER}));
        box.append(frame);
        box.append(new Gtk.Label({label, css_classes: ['caption']}));
        const swatch = new Gtk.Button({child: box, css_classes: ['flat', 'nook-backdrop-swatch'], tooltip_text: label});
        swatch.connect('clicked', onClick);
        grid.append(swatch);
        swatches.push([swatch, value]);
        return frame;
    };
    add('', _('None'), null).add_css_class('none');
    for (const [name, label] of BUILT_IN())
        add(name, label, builtIn(name, '-thumb'));
    const own = settings.get_string('background').startsWith('/') ? settings.get_string('background') : ownPicture();
    if (own)
        add(own, _('Your Picture'), own);
    const choose = add(null, _('Choose…'), null, () => chooseOwn(grid, path => {
        settings.set_string('background', path);
        dialog.close();
    }));
    choose.add_css_class('choose');
    choose.add_overlay(new Gtk.Image({icon_name: 'list-add-symbolic', pixel_size: 24, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER}));
    mark();
    const handler = settings.connect('changed::background', mark);

    const view = new Adw.ToolbarView({
        content: new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
            child: grid,
        }),
    });
    view.add_top_bar(new Adw.HeaderBar());
    // Four to a row.
    const dialog = new Adw.Dialog({title: _('Background'), content_width: 760, child: view});
    dialog.connect('closed', () => settings.disconnect(handler));
    dialog.present(parent);
}
