// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EVENT_KEYS, sensorKind} from './events.js';
import {WrapLayout} from './layouts.js';
import {CHIP_SPACING, deviceType, formatValue, modeText, numberFormat, tvShowing} from './text.js';
import {Glyph} from './widgets.js';

export function playingNow(device) {
    return ['PLAYING', 'BUFFERING'].includes(device.state?.media?.state) || onlyStops(device);
}

// An app with no media session and no playing group takes no pause, only a receiver STOP.
export function onlyStops(device) {
    return Boolean(device.state?.app) && !device.state.media;
}

// BLE devices reach the cloud via a nearby phone or gateway; its "offline" means little.
export const isBluetooth = device => String(device.did).startsWith('blt.');

function shortWhen(seconds) {
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const now = GLib.DateTime.new_now_local();
    if (then.format('%Y-%m-%d') === now.format('%Y-%m-%d'))
        return then.format('%H:%M');
    return then.format('%e %b').trim();
}

// Non-enumerable, so it stays out of the cached device list (stale by the next start).
export function setLive(device, state) {
    Object.defineProperty(device, 'live', {value: state, writable: true, configurable: true, enumerable: false});
}

// Last BLE advertisement per did. Module-level so it outlives device list reloads and the
// indicator, which the lock screen destroys; a kettle advertises only every ~30 s.
// Cleared in disable().
export const beacons = new Map();

// Seconds. Older readings stay off tiles, where they'd look current; cards date them.
export const BEACON_FRESH = 10 * 60;
export function beaconOf(device) {
    return beacons.get(device.did) ?? null;
}

export function kettleStatus(status) {
    return [_('Idle'), _('Heating'), _('Cooling down'), _('Keeping warm')][status] ?? null;
}

function beaconText(beacon) {
    const parts = [];
    if (beacon.temperature !== undefined)
        parts.push(`${numberFormat.format(beacon.temperature)} °C`);
    if (beacon.humidity !== undefined)
        parts.push(`${numberFormat.format(beacon.humidity)} %`);
    if (beacon.status > 0 && kettleStatus(beacon.status))
        parts.push(kettleStatus(beacon.status));
    return parts.join(' · ') || null;
}

function statChip({title, glyph, text}) {
    const chip = new St.BoxLayout({style_class: 'nook-stat-chip'});
    chip._glyph = new Glyph(glyph);
    chip.add_child(chip._glyph);
    chip._title = new St.Label({style_class: 'nook-stat-title', text: title, y_align: Clutter.ActorAlign.CENTER});
    chip.add_child(chip._title);
    chip._value = new St.Label({style_class: 'nook-stat-value', text, y_align: Clutter.ActorAlign.CENTER});
    chip.add_child(chip._value);
    return chip;
}

export function statFlow() {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    return new St.Widget({style_class: 'nook-stats', layout_manager: new WrapLayout(CHIP_SPACING * scale), x_expand: true});
}

export function fillStats(box, stats) {
    // Same chips, new numbers: retext in place, rebuilding makes the card jump.
    const chips = box.get_children();
    if (chips.length === stats.length && chips.every((chip, i) => chip._title?.text === stats[i].title)) {
        chips.forEach((chip, i) => {
            chip._glyph.setName(stats[i].glyph);
            chip._value.text = stats[i].text;
        });
        return;
    }
    box.destroy_all_children();
    for (const stat of stats)
        box.add_child(statChip(stat));
}

export function spanText(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (days > 0)
        return _('%s d %s h').replace('%s', days).replace('%s', hours);
    if (hours > 0)
        return _('%s h %s min').replace('%s', hours).replace('%s', minutes);
    return _('%s min').replace('%s', minutes);
}

export function liveText(device) {
    const data = device.live;
    if (!data)
        return null;
    const kind = sensorKind(device.model);
    if ((kind === 'smoke' || kind === 'gas') && data.alarm !== undefined) {
        const alarm = String(data.alarm);
        if (alarm === '0')
            return kind === 'smoke' ? _('No smoke') : _('No gas');
        if (alarm === '1' || alarm === '2')
            return kind === 'smoke' ? _('Smoke!') : _('Gas!');
        return _('Fault');
    }
    if (data.status === 'leak')
        return _('Leak!');
    if (data.status === 'no_leak')
        return _('No leak');
    return null;
}

export function eventText(device) {
    const last = device.lastEvent;
    if (sensorKind(device.model) === 'leak') {
        const live = liveText(device);
        if (live)
            return live;
        if (last === undefined)
            return null;
        // null: the history answered empty (undefined: not loaded yet).
        return last?.key === 'leak' ? `${_('Leak!')} · ${shortWhen(last.time)}` : _('No leak');
    }
    if (!last)
        return null;
    const label = (EVENT_KEYS()[deviceType(device)] ?? []).find(([key]) => key === last.key)?.[1];
    return label ? `${label} · ${shortWhen(last.time)}` : null;
}

// Xiaomi Zigbee coin cell mV to %, zigbee2mqtt's scale: 2850 mV empty, 3000 mV full.
export function batteryShare(millivolts) {
    return Math.max(0, Math.min(100, Math.round((millivolts - 2850) / 1.5)));
}

export function stateText(device) {
    const {primary, values, online} = device;
    const beacon = beaconOf(device);
    if (beacon && Date.now() / 1000 - beacon.time < BEACON_FRESH) {
        const heard = beaconText(beacon);
        if (heard)
            return heard;
    }
    if (online === null || online === undefined)
        return '…';
    if (!online && isBluetooth(device))
        return _('Bluetooth');
    if (!online)
        return _('Offline');

    if (primary.kind === 'camera')
        return _('Online');

    if (primary.kind === 'climate') {
        const {Pow: power, Mod: mode, SetTem: target} = device.state;
        return power === 1 ? `${modeText(mode)} · ${numberFormat.format(target)}°` : _('Off');
    }

    if (primary.kind === 'media') {
        const media = device.state?.media;
        if (playingNow(device))
            return media?.title ?? device.state.app ?? _('Playing');
        if (media?.state === 'PAUSED')
            return _('Paused');
        return device.state?.app ?? _('Idle');
    }

    if (primary.kind === 'tv') {
        if (!device.state?.paired)
            return _('Not paired');
        if (!device.state.on)
            return _('Off');
        return device.state.muted ? _('Muted') : tvShowing(device) ?? _('On');
    }

    if (primary.kind === 'switch') {
        if (!values)
            return '…';
        const on = values[0] === true;
        if (primary.props[0].service === 'light' && deviceType(device) !== 'light')
            return on ? _('Light on') : _('Light off');
        return on ? _('On') : _('Off');
    }

    if (device.unreadable)
        return liveText(device) ?? _('Online');
    if (primary.kind === 'none') {
        const text = eventText(device) ?? liveText(device);
        if (text)
            return text;
        return sensorKind(device.model) === 'leak' ? '…' : _('Online');
    }

    if (primary.kind === 'reading' && !values)
        return '…';
    const parts = primary.props.map((p, i) => formatValue(p, values?.[i])).filter(Boolean);
    if (parts.length === 0)
        return liveText(device) ?? _('Online');
    const time = primary.props.length === 1 && primary.props[0].format === 'bool' ? device.times?.[0] : null;
    if (time)
        parts.push(shortWhen(time));
    return parts.join(' · ');
}
