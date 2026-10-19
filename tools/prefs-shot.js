// SPDX-License-Identifier: GPL-2.0-or-later

// Builds the prefs window outside the Extensions app, opens one page and saves a
// screenshot, for tools/run-nested.sh --shot. Run on the nested shell's display.
//
//   gjs -m tools/prefs-shot.js OUT.png [page title] [extension directory]
//
// Prefs module loading adapted from Now Playing Card's tools/prefs-smoke.js.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

Gio.resources_register(Gio.Resource.load(
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource'));
String.prototype.format = imports.format.format;

const RESOURCE = 'resource:///org/gnome/Shell/Extensions/js';
const [out, pageTitle = 'Devices', dirPath] = System.programArgs;
const searching = pageTitle === 'Find';
const dir = Gio.File.new_for_path(dirPath ??
    `${GLib.get_user_data_dir()}/gnome-shell/extensions/nook@epogonii.github.io`);

function* walk(widget) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        yield child;
        yield* walk(child);
    }
}

function save(window) {
    const snapshot = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, window.get_width(), window.get_height());
    const texture = window.get_native().get_renderer().render_texture(snapshot.to_node(), null);
    texture.save_to_png(out);
}

const loop = GLib.MainLoop.new(null, false);
let failed = true;

Promise.all([
    import(`${RESOURCE}/misc/extensionUtils.js`),
    import(`${RESOURCE}/extensionsService.js`),
    import(`file://${dir.get_path()}/prefs.js`),
]).then(([utils, service, {default: Preferences}]) => {
    const [, bytes] = dir.get_child('metadata.json').load_contents(null);
    const metadata = JSON.parse(new TextDecoder().decode(bytes));
    Adw.init();

    const prefs = new Preferences({...metadata, dir, path: dir.get_path()});
    const extension = service.extensionManager.createExtensionObject(
        utils.serializeExtension({
            metadata,
            uuid: metadata.uuid,
            type: utils.ExtensionType.PER_USER,
            state: utils.ExtensionState.ACTIVE,
            enabled: true,
            path: dir.get_path(),
            error: '',
            hasPrefs: true,
            hasUpdate: false,
            canChange: true,
            sessionModes: ['user'],
        }));
    extension.stateObj = prefs;

    const window = new Adw.PreferencesWindow({default_width: 640, default_height: 820});
    prefs.fillPreferencesWindow(window);
    const name = searching ? 'devices' : pageTitle.toLowerCase();
    const page = [...walk(window)].find(w => w instanceof Adw.PreferencesPage && w.name === name);
    if (page)
        window.set_visible_page(page);
    window.present();

    if (searching) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            [...walk(window)].find(w => w instanceof Gtk.Button && w.has_css_class('suggested-action'))
                ?.emit('clicked');
            return GLib.SOURCE_REMOVE;
        });
    }

    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        const star = [...walk(window)].find(w => w instanceof Gtk.ToggleButton && w.icon_name?.includes('starred'));
        if (star)
            star.active = !star.active;
        return GLib.SOURCE_REMOVE;
    });
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, searching ? 12000 : 3000, () => {
        try {
            save(window);
            failed = false;
        } catch (error) {
            printerr(`prefs-shot: ${error}`);
        } finally {
            loop.quit();
        }
        return GLib.SOURCE_REMOVE;
    });
}).catch(error => {
    printerr(`prefs-shot: ${error}\n${error.stack}`);
    loop.quit();
});

loop.run();
System.exit(failed ? 1 : 0);
