// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {readSetting} from './text.js';

// Cloud event-history keys by device type. A function so the labels are translated
// at call time, not at import.
export const EVENT_KEYS = () => ({
    'submersion-sensor': [['leak', _('Leak')], ['no_leak', _('Dry again')]],
    'remote-control': [['click', _('Pressed')], ['double_click', _('Pressed twice')], ['long_click_press', _('Held')]],
    'motion-sensor': [['motion', _('Motion')]],
    'magnet-sensor': [['open', _('Opened')], ['close', _('Closed')]],
});

export function whenText(seconds) {
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const now = GLib.DateTime.new_now_local();
    const day = d => d.format('%Y-%m-%d');
    if (day(then) === day(now))
        return _('today, %s').replace('%s', then.format('%H:%M'));
    if (day(then) === day(now.add_days(-1)))
        return _('yesterday, %s').replace('%s', then.format('%H:%M'));
    return then.format('%e %b, %H:%M').trim();
}

// Matches both the gateway's model names ("magnet", "sensor_wleak.aq1") and Mi Home's
// ("lumi.sensor_magnet").
export function sensorKind(model) {
    if (/wleak/.test(model))
        return 'leak';
    if (/smoke/.test(model))
        return 'smoke';
    if (/natgas/.test(model))
        return 'gas';
    if (/magnet/.test(model))
        return 'door';
    if (/motion/.test(model))
        return 'motion';
    if (/vibration/.test(model))
        return 'vibration';
    if (/switch|86sw|remote\.b/.test(model))
        return 'button';
    if (/sensor_ht|weather/.test(model))
        return 'climate';
    return null;
}

const ALARM_KINDS = ['leak', 'smoke', 'gas'];

export function alertsOn(settings, did, kind) {
    return readSetting(settings, 'alerts')[did] ?? ALARM_KINDS.includes(kind);
}

export function sensorRules(settings) {
    try {
        const rules = JSON.parse(readSetting(settings, 'sensor-rules'));
        return rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
    } catch {
        return {};
    }
}
