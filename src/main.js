// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {bindtextdomain, gettext as _, textdomain} from 'gettext';

import {APP_ID} from './constants.js';

// share/locale, one level up from this directory.
const here = Gio.File.new_for_uri(import.meta.url).get_parent();
bindtextdomain(APP_ID, here.get_parent().get_child('locale').get_path());
textdomain(APP_ID);

// The pages' strings came from the extension's prefs, where GNOME Shell set this up.
String.prototype.format = imports.format.format;

GLib.set_prgname(APP_ID);
GLib.set_application_name(_('Nook'));

// After bindtextdomain: modules look strings up when imported.
const {Application} = await import('./application.js');
const code = await new Application().runAsync([System.programInvocationName, ...ARGV]);
System.exit(code);
