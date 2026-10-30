// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

// The extension's own settings, as it last sent them: it keeps them in its schema, which
// the sandbox can't read, so the Top Bar page edits them through the extension.
export const MenuSettings = GObject.registerClass({
    Properties: {
        'present': GObject.ParamSpec.boolean('present', null, null, GObject.ParamFlags.READABLE, false),
    },
    Signals: {
        'changed': {
            flags: GObject.SignalFlags.RUN_LAST | GObject.SignalFlags.DETAILED,
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class MenuSettings extends GObject.Object {
    _init() {
        super._init();
        this._values = new Map();
        // (values) → sends them to the extension.
        this.send = null;
    }

    get present() {
        return this._values.size > 0;
    }

    // values: {key: GLib.Variant}, all the extension has, from SetUi.
    update(values) {
        const was = this.present;
        const changed = [];
        for (const [key, value] of Object.entries(values)) {
            if (!this._values.get(key)?.equal(value)) {
                this._values.set(key, value);
                changed.push(key);
            }
        }
        if (was !== this.present)
            this.notify('present');
        for (const key of changed)
            this.emit(`changed::${key}`, key);
    }

    clear() {
        if (!this.present)
            return;
        this._values.clear();
        this.notify('present');
    }

    get_value(key) {
        return this._values.get(key) ?? null;
    }

    set_value(key, value) {
        if (this._values.get(key)?.equal(value))
            return true;
        this._values.set(key, value);
        this.emit(`changed::${key}`, key);
        this.send?.({[key]: value});
        return true;
    }

    get_string(key) {
        return this.get_value(key)?.get_string()[0] ?? '';
    }

    get_boolean(key) {
        return this.get_value(key)?.get_boolean() ?? false;
    }

    get_uint(key) {
        return this.get_value(key)?.get_uint32() ?? 0;
    }

    get_int(key) {
        return this.get_value(key)?.get_int32() ?? 0;
    }

    get_strv(key) {
        return this.get_value(key)?.get_strv() ?? [];
    }

    set_string(key, value) {
        return this.set_value(key, new GLib.Variant('s', value));
    }

    set_boolean(key, value) {
        return this.set_value(key, new GLib.Variant('b', value));
    }

    set_uint(key, value) {
        return this.set_value(key, new GLib.Variant('u', value));
    }

    set_int(key, value) {
        return this.set_value(key, new GLib.Variant('i', value));
    }

    set_strv(key, value) {
        return this.set_value(key, new GLib.Variant('as', value));
    }

    // As Gio.Settings.bind() with the default flags, for boolean, int and uint keys.
    bind(key, object, property, _flags = Gio.SettingsBindFlags.DEFAULT) {
        const type = () => this.get_value(key)?.get_type_string();
        const read = () => {
            switch (type()) {
            case 'b':
                return this.get_boolean(key);
            case 'u':
                return this.get_uint(key);
            case 'i':
                return this.get_int(key);
            default:
                return null;
            }
        };
        const pull = () => {
            const value = read();
            if (value !== null && object[property] !== value)
                object[property] = value;
        };
        pull();
        const handler = this.connect(`changed::${key}`, pull);
        const notify = object.connect(`notify::${property}`, () => {
            const value = object[property];
            switch (type()) {
            case 'b':
                this.set_boolean(key, value);
                break;
            case 'u':
                this.set_uint(key, Math.max(0, Math.round(value)));
                break;
            case 'i':
                this.set_int(key, Math.round(value));
                break;
            }
        });
        object.connect('destroy', () => {
            this.disconnect(handler);
            object.disconnect(notify);
        });
    }
});
