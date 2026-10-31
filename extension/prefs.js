// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {AppLink} from './prefs/app.js';

const LOGO_FILE = 'icons/nook-logo.svg';

const LOGO_FILE_DARK = 'icons/nook-logo-dark.svg';

// Accounts, devices and the menu's own settings are all set in the Nook app's window;
// with the app there, this only opens it.
export default class NookPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const app = new AppLink();
        window.connect('close-request', () => {
            app.destroy();
            return false;
        });

        window.search_enabled = false;
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        const logo = new Gtk.Image({pixel_size: 96});
        const style = Adw.StyleManager.get_default();
        const show = () => (logo.file = `${this.path}/${style.dark ? LOGO_FILE_DARK : LOGO_FILE}`);
        const handler = style.connect('notify::dark', show);
        logo.connect('destroy', () => style.disconnect(handler));
        show();
        group.add(logo);
        const title = new Gtk.Label({label: _('Nook'), margin_top: 12, css_classes: ['title-1']});
        group.add(title);
        const text = new Gtk.Label({
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_top: 6,
            css_classes: ['dim-label'],
        });
        group.add(text);
        const button = new Gtk.Button({halign: Gtk.Align.CENTER, margin_top: 24, css_classes: ['pill', 'suggested-action']});
        group.add(button);
        page.add(group);
        window.add(page);

        if (app.installed) {
            text.label = _('Accounts, devices and the look of the menu are set in the Nook app.');
            button.label = _('Open Nook');
            const open = () => app.open('top-bar', window);
            button.connect('clicked', () => open().catch(logError));
            // Left open, with its button, when the app fails to start.
            open().then(() => window.close()).catch(logError);
        } else {
            text.label = _('Nook reaches your devices through the Nook app. Install it, and its window is where accounts, devices and the menu are set up.');
            button.label = _('Install Nook');
            button.connect('clicked', () => app.install(window));
        }
    }
}
