// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from 'gettext';

import {removable, removeDevice, unitOf} from './remove.js';
import {isOn} from './text.js';
import {dropPicture, iconDialog, renameDialog, setNamed, switchable} from './widgets.js';

export function toggled(settings, key, did, on) {
    const list = settings.get_strv(key).filter(d => d !== did);
    settings.set_strv(key, on ? [...list, did] : list);
}

// Kept in the app and, while it runs, in the extension too.
export function setLook(settings, menu, key, did, value) {
    setNamed(settings, key, did, value);
    if (menu.present)
        setNamed(menu, key, did, value);
}

function toast(parent, title) {
    parent.get_root()?.add_toast?.(new Adw.Toast({title, timeout: 6}));
}

function confirmRemove(device, home, parent, onRemoved) {
    const unit = unitOf(device.did);
    const together = home.devices.filter(d => unitOf(d.did) === unit);
    const dialog = new Adw.AlertDialog({
        heading: _('Remove “%s”?').format(home.nameOf(device)),
        body: together.length > 1
            ? _('Its whole unit goes: %s. To add it again, search for it on its account page.')
                .format(together.map(d => home.nameOf(d)).join(', '))
            : _('To add it again, search for it on its account page.'),
        default_response: 'cancel',
        close_response: 'cancel',
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('remove', _('Remove'));
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_dialog, response) => {
        if (response !== 'remove')
            return;
        onRemoved?.();
        removeDevice(home.appSettings, device).then(freed => {
            if (!freed)
                toast(parent, _('Removed. The accessory could not be reached to forget Nook; reset it before pairing it again.'));
        }).catch(e => toast(parent, e.message));
    });
    dialog.present(parent);
}

// [model, actions] of a device's context menu, the items named device.*.
// open: shows its page, when the menu is not on it already; parent: of the dialogs;
// onRemoved: before it goes.
export function deviceMenu(device, home, {open = null, parent = home, onRemoved = null} = {}) {
    const settings = home.appSettings;
    const menu = home.menuSettings;
    const did = device.did;
    const actions = new Gio.SimpleActionGroup();
    const action = (name, run) => {
        const made = new Gio.SimpleAction({name});
        made.connect('activate', () => run());
        actions.add_action(made);
    };
    const check = (name, on, set) => {
        const made = Gio.SimpleAction.new_stateful(name, null, GLib.Variant.new_boolean(on));
        made.connect('change-state', (_action, value) => {
            made.set_state(value);
            set(value.get_boolean());
        });
        actions.add_action(made);
    };
    const model = new Gio.Menu();

    const first = new Gio.Menu();
    if (open) {
        first.append(_('Open'), 'device.open');
        action('open', open);
    }
    if (switchable(device)) {
        first.append(isOn(device) ? _('Turn Off') : _('Turn On'), 'device.toggle');
        action('toggle', () => home.toggle(device).catch(logError));
    }
    model.append_section(null, first);

    const look = new Gio.Menu();
    look.append(_('Rename…'), 'device.rename');
    action('rename', () => {
        const own = settings.get_value('names').deepUnpack()[did];
        renameDialog(device.name, own, parent, name => setLook(settings, menu, 'names', did, name));
    });
    look.append(_('Change Icon…'), 'device.icon');
    action('icon', () => {
        const old = settings.get_value('icons').deepUnpack()[did] ?? '';
        iconDialog(old, parent, icon => {
            setLook(settings, menu, 'icons', did, icon);
            if (old !== icon)
                dropPicture(old);
        });
    });
    model.append_section(null, look);

    // The extension's lists: only while it runs to read them.
    if (menu.present) {
        const bar = new Gio.Menu();
        bar.append(_('Show in the Menu'), 'device.in-menu');
        check('in-menu', !menu.get_strv('hidden').includes(did), on => toggled(menu, 'hidden', did, !on));
        bar.append(_('Pin in the Menu'), 'device.pinned');
        check('pinned', menu.get_strv('pinned').includes(did), on => toggled(menu, 'pinned', did, on));
        bar.append(_('Show in the Top Bar'), 'device.panel');
        check('panel', menu.get_strv('panel-sensors').includes(did), on => toggled(menu, 'panel-sensors', did, on));
        model.append_section(_('Top Bar Menu'), bar);
    }

    const last = new Gio.Menu();
    const hidden = settings.get_strv('home-hidden').includes(did);
    last.append(hidden ? _('Show on Home') : _('Hide from Home'), 'device.hide');
    action('hide', () => toggled(settings, 'home-hidden', did, !hidden));
    if (removable(device)) {
        last.append(_('Remove…'), 'device.remove');
        action('remove', () => confirmRemove(device, home, parent, onRemoved));
    }
    model.append_section(null, last);
    return [model, actions];
}
