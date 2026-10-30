// SPDX-License-Identifier: GPL-2.0-or-later

// Same file as ui/bridge.js in the extension: keep both in step.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const BUS_NAME = 'io.github.epogonii.nook-app';
export const OBJECT_PATH = '/io/github/epogonii/nook_app/Homes';
export const INTERFACE = 'io.github.epogonii.NookApp.Homes';
export const ERROR = 'io.github.epogonii.NookApp.Error';

export const INTERFACE_XML = `<node>
  <interface name="${INTERFACE}">
    <method name="Attach">
      <arg type="u" direction="out" name="version"/>
      <arg type="s" direction="out" name="homes"/>
    </method>
    <method name="Xiaomi">
      <arg type="s" direction="out" name="homes"/>
    </method>
    <method name="Detach"/>
    <method name="Wants">
      <arg type="b" direction="out" name="settings"/>
      <arg type="b" direction="out" name="secrets"/>
    </method>
    <method name="ImportSecrets">
      <arg type="a(sss)" direction="in" name="items"/>
      <arg type="b" direction="out" name="taken"/>
    </method>
    <method name="Import">
      <arg type="a{sv}" direction="in" name="settings"/>
      <arg type="b" direction="out" name="taken"/>
    </method>
    <method name="Call">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="method"/>
      <arg type="s" direction="in" name="args"/>
      <arg type="s" direction="in" name="token"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="Cancel">
      <arg type="s" direction="in" name="token"/>
    </method>
    <method name="Open">
      <arg type="s" direction="in" name="kind"/>
      <arg type="s" direction="in" name="args"/>
      <arg type="s" direction="out" name="remote"/>
    </method>
    <method name="Release">
      <arg type="s" direction="in" name="id"/>
    </method>
    <method name="OpenFeed">
      <arg type="s" direction="in" name="camera"/>
      <arg type="h" direction="out" name="frames"/>
      <arg type="s" direction="out" name="feed"/>
    </method>
    <method name="CloseFeed">
      <arg type="s" direction="in" name="feed"/>
    </method>
    <method name="Still">
      <arg type="s" direction="in" name="camera"/>
      <arg type="ay" direction="out" name="jpeg"/>
    </method>
    <method name="SetUi">
      <arg type="a{sv}" direction="in" name="values"/>
    </method>
    <signal name="Changed">
      <arg type="s" name="id"/>
      <arg type="s" name="patch"/>
    </signal>
    <signal name="Event">
      <arg type="s" name="id"/>
      <arg type="s" name="name"/>
      <arg type="s" name="args"/>
    </signal>
    <signal name="FeedEnded">
      <arg type="s" name="feed"/>
      <arg type="i" name="status"/>
    </signal>
    <signal name="Reloaded"/>
    <signal name="UiChanged">
      <arg type="a{sv}" name="values"/>
    </signal>
    <signal name="UiWanted"/>
  </interface>
</node>`;

// lib/ callback fields, forwarded as Event signals.
export const EVENTS = ['onChange', 'onExpired', 'onBack', 'onMoved', 'onDevices', 'onLocked', 'onBeacon', 'onReport'];

// Read synchronously by the extension, from a mirror sent with every change.
// perDevice: method -> its extra arguments; values are kept per did.
const SPEC = {fields: ['label', 'extras'], perDevice: {isRunning: [null]}};
export const MIRROR = {
    xiaomi: {fields: ['homes', 'homeName', 'extras'], getters: ['loggedIn', 'quietUntil']},
    scenes: {fields: ['label'], perDevice: {isRunning: [null]}},
    tv: {perDevice: {listed: ['sources', 'apps'], showing: [null]}},
    tapo: {perDevice: {isRefused: [null]}},
    gateway: {getters: ['heard', 'running', 'states']},
    beacons: {fields: ['off']},
    shelly: SPEC,
    ewelink: SPEC,
    hue: SPEC,
    hass: SPEC,
    homekit: SPEC,
    smartlife: SPEC,
    cloud: SPEC,
};

export const WRITABLE = {
    xiaomi: ['extras'],
    beacons: ['off'],
    shelly: ['extras'],
    ewelink: ['extras'],
    hue: ['extras'],
    hass: ['extras'],
    homekit: ['extras'],
    smartlife: ['extras'],
    cloud: ['extras'],
};

// feed.js exit codes; a failed Still carries them as code.
export const NO_GSTREAMER = 2;
export const REFUSED = 3;
export const NO_PLUGIN = 4;

function base64(bytes) {
    return GLib.base64_encode(bytes instanceof GLib.Bytes ? bytes.toArray() : bytes);
}

function isPlain(value) {
    const proto = Object.getPrototypeOf(value);
    return (proto === Object.prototype || proto === null) &&
        !Object.values(value).some(v => typeof v === 'function');
}

// A GLib.Error keeps its domain so e.matches() works after the trip.
function encodeError(e) {
    if (e instanceof GLib.Error)
        return {name: 'GLib.Error', message: e.message, domain: GLib.quark_to_string(e.domain), code: e.code};
    const out = {};
    for (const [key, value] of Object.entries(e)) {
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
            out[key] = value;
    }
    // The constructor's name, not a name field: subclasses stay distinct.
    return {...out, name: e.constructor?.name ?? 'Error', message: e.message ?? String(e)};
}

// hooks: device(v) -> {home, did}, handle(v) -> {id} of the other side's object,
// remote(v) -> {id, kind, methods} of one kept here, cancellable(v) -> token.
export function encode(value, hooks = {}) {
    if (value === null || value === undefined)
        return null;
    switch (typeof value) {
    case 'string':
    case 'boolean':
        return value;
    case 'number':
        return Number.isFinite(value) ? value : null;
    case 'bigint':
        return Number(value);
    case 'function':
        return null;
    }
    if (Array.isArray(value))
        return value.map(v => encode(v, hooks));
    if (value instanceof Map)
        return {$map: [...value].map(([k, v]) => [encode(k, hooks), encode(v, hooks)])};
    if (value instanceof Set)
        return {$set: [...value].map(v => encode(v, hooks))};
    if (value instanceof Uint8Array)
        return {$bytes: base64(value)};
    if (value instanceof GLib.Bytes)
        return {$gbytes: base64(value)};
    if (value instanceof Gio.BytesIcon)
        return {$icon: base64(value.get_bytes())};
    if (value instanceof Gio.Cancellable)
        return {$cancellable: hooks.cancellable?.(value) ?? ''};
    if (value instanceof Error || value instanceof GLib.Error)
        return {$error: encodeError(value)};
    const device = hooks.device?.(value);
    if (device)
        return {$device: device.did, $home: device.home};
    const handle = hooks.handle?.(value);
    if (handle)
        return {$remote: handle};
    if (!isPlain(value)) {
        const remote = hooks.remote?.(value);
        return remote ? {$remote: remote} : null;
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        if (v !== undefined && typeof v !== 'function')
            out[key] = encode(v, hooks);
    }
    return out;
}

// hooks: device(home, did), remote(info), cancellable(token), error(fields).
export function decode(value, hooks = {}) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(v => decode(v, hooks));
    if ('$map' in value)
        return new Map(value.$map.map(([k, v]) => [decode(k, hooks), decode(v, hooks)]));
    if ('$set' in value)
        return new Set(value.$set.map(v => decode(v, hooks)));
    if ('$bytes' in value)
        return GLib.base64_decode(value.$bytes);
    if ('$gbytes' in value)
        return new GLib.Bytes(GLib.base64_decode(value.$gbytes));
    if ('$icon' in value)
        return Gio.BytesIcon.new(new GLib.Bytes(GLib.base64_decode(value.$icon)));
    if ('$cancellable' in value)
        return hooks.cancellable?.(value.$cancellable) ?? null;
    if ('$error' in value)
        return hooks.error ? hooks.error(value.$error) : reviveError(value.$error);
    if ('$device' in value)
        return hooks.device?.(value.$home, value.$device) ?? null;
    if ('$remote' in value)
        return hooks.remote?.(value.$remote) ?? null;
    const out = {};
    for (const [key, v] of Object.entries(value))
        out[key] = decode(v, hooks);
    return out;
}

// Unknown names come back as a plain Error with the same fields.
export function reviveError(fields, classes = {}) {
    const {name, message, domain, code, ...rest} = fields;
    if (domain)
        return new GLib.Error(GLib.quark_from_string(domain), code, message);
    const Class = classes[name];
    const e = Class ? Object.create(Class.prototype) : new Error(message);
    if (Class) {
        e.message = message;
        e.stack = new Error().stack;
    }
    e.name = name;
    if (code !== undefined)
        e.code = code;
    return Object.assign(e, rest);
}

export function methodsOf(object) {
    const names = new Set(Object.keys(object).filter(key => typeof object[key] === 'function'));
    for (let proto = Object.getPrototypeOf(object); proto && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, name);
            if (name !== 'constructor' && !name.startsWith('_') && typeof descriptor.value === 'function')
                names.add(name);
        }
    }
    return [...names].filter(name => !EVENTS.includes(name));
}
