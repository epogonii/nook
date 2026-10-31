#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Renders the lib/glyphs.js logo to icons/nook-symbolic.svg (notifications, quick
// settings) and icons/nook-top-bar-symbolic.svg (the show-in-top-bar buttons). Rerun
// after changing the glyph. icons/nook-logo.svg (About page) is drawn by hand.

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import System from 'system';

import * as Glyphs from '../lib/glyphs.js';

const dir = GLib.path_get_dirname(GLib.path_get_dirname(System.programPath));

for (const name of ['nook-symbolic.svg', 'nook-top-bar-symbolic.svg']) {
    const path = GLib.build_filenamev([dir, 'icons', name]);
    const surface = new Cairo.SVGSurface(path, 16, 16);
    const context = new Cairo.Context(surface);
    context.setSourceRGBA(0.18, 0.2, 0.21, 1);
    Glyphs.draw(context, 'nook');
    surface.finish();
    print(path);
}
