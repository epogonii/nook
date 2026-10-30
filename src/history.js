// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _} from 'gettext';

import {loadingRow, noteRow, stepperRow} from './card-parts.js';
import {Chart} from './chart.js';
import {HISTORY_SPAN, historyKeys} from './props.js';
import {deviceType, numberFormat, whenText} from './text.js';

// s between reads of the history while the page shows; the cloud keeps it a while too.
const HISTORY_EVERY = 300;

// Cloud event-history keys by device type.
const EVENT_KEYS = () => ({
    'submersion-sensor': [['leak', _('Leak')], ['no_leak', _('Dry again')]],
    'remote-control': [['click', _('Pressed')], ['double_click', _('Pressed twice')], ['long_click_press', _('Held')]],
    'motion-sensor': [['motion', _('Motion')]],
    'magnet-sensor': [['open', _('Opened')], ['close', _('Closed')]],
});

const ALERT_SCOPE = () => ({
    leak: _('A leak, and when it is dry again'),
    smoke: _('An alarm, and when it is over'),
    gas: _('An alarm, and when it is over'),
    door: _('Every opening and closing'),
    motion: _('Every motion it sees'),
    vibration: _('Every knock, tilt and fall'),
    button: _('Every press'),
});

const ALARM_KINDS = ['leak', 'smoke', 'gas'];

// Both the gateway's model names ("magnet", "sensor_wleak.aq1") and Mi Home's ("lumi.sensor_magnet").
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

// Mi Home devices have a bare did; the cloud keeps their history.
export const eventKeysOf = device => (device.did.includes(':') ? [] : EVENT_KEYS()[deviceType(device)] ?? []);

// "Last 24 Hours" charts and the "History" event log of Mi Home sensors.
export class HistorySection {
    constructor(device) {
        this._device = device;
        this._keys = typeof device.source?.readHistory === 'function' ? historyKeys(device) : [];
        this._events = typeof device.source?.readEventLog === 'function' ? eventKeysOf(device) : [];
        this._readAt = 0;
        this._reading = false;
        this._gone = false;
        this.charts = new Adw.PreferencesGroup({title: _('Last 24 Hours'), visible: this._keys.length > 0});
        this._chartBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, css_classes: ['card', 'nook-charts']});
        this._chartBox.append(new Adw.Spinner({height_request: 32}));
        this.charts.add(this._chartBox);
        this.log = new Adw.PreferencesGroup({title: _('History'), visible: this._events.length > 0});
        this._logRows = [loadingRow()];
        this.log.add(this._logRows[0]);
    }

    get wanted() {
        return this._keys.length > 0 || this._events.length > 0;
    }

    forget() {
        this._gone = true;
    }

    // Now if it has not read for a while.
    async refresh() {
        if (!this.wanted || this._reading || Date.now() - this._readAt < HISTORY_EVERY * 1000)
            return;
        this._reading = true;
        this._readAt = Date.now();
        const device = this._device;
        const home = device.source;
        let series, entries;
        try {
            [series, entries] = await Promise.all([
                this._keys.length > 0 ? home.readHistory(device, this._keys.map(([key]) => key), HISTORY_SPAN) : [],
                this._events.length > 0 ? home.readEventLog(device, this._events.map(([key]) => key)) : [],
            ]);
        } catch (e) {
            if (!this._gone)
                this._failed(e.message);
            return;
        } finally {
            this._reading = false;
        }
        if (this._gone)
            return;
        this._fillCharts(series);
        this._fillLog(entries);
    }

    _failed(text) {
        this._clearCharts();
        this._chartBox.append(new Gtk.Label({label: text, wrap: true, xalign: 0, css_classes: ['dim-label']}));
        this._setLog([noteRow(text)]);
    }

    _clearCharts() {
        for (let child = this._chartBox.get_first_child(); child; child = this._chartBox.get_first_child())
            this._chartBox.remove(child);
    }

    _fillCharts(series) {
        if (this._keys.length === 0)
            return;
        this._clearCharts();
        this._keys.forEach(([, , name, unit, divisor, color], i) => {
            const points = series[i].map(p => ({time: p.time, value: p.value / divisor}));
            const values = points.map(p => p.value);
            const range = values.length > 0
                ? `${numberFormat.format(Math.min(...values))} – ${numberFormat.format(Math.max(...values))} ${unit}`
                : _('Nothing kept');
            const head = new Gtk.Box({spacing: 6});
            head.append(new Gtk.Label({label: name, xalign: 0, hexpand: true, css_classes: ['nook-chart-name']}));
            const value = new Gtk.Label({label: range, css_classes: ['dim-label', 'numeric']});
            head.append(value);
            const block = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
            block.append(head);
            if (points.length > 0) {
                block.append(new Chart(points, color, point => {
                    value.label = point ? `${numberFormat.format(point.value)} ${unit} · ${whenText(point.time)}` : range;
                }));
            }
            this._chartBox.append(block);
        });
    }

    _setLog(rows) {
        for (const row of this._logRows)
            this.log.remove(row);
        this._logRows = rows;
        for (const row of rows)
            this.log.add(row);
    }

    _fillLog(entries) {
        if (this._events.length === 0)
            return;
        const device = this._device;
        if (device.lastEvent === undefined && device.primary.props.length === 0)
            device.source.noteEvent?.(device, entries[0] ?? null);
        const labels = new Map(this._events);
        const rows = entries.map(({key, time}) => {
            const row = new Adw.ActionRow({title: labels.get(key) ?? key});
            row.add_suffix(new Gtk.Label({label: whenText(time), css_classes: ['dim-label', 'numeric']}));
            return row;
        });
        this._setLog(rows.length > 0 ? rows : [noteRow(_('Nothing in the last 30 days.'))]);
    }
}

function sensorRules(menu) {
    try {
        const rules = JSON.parse(menu.get_string('sensor-rules'));
        return rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
    } catch {
        return {};
    }
}

// What the extension tells about an Aqara sensor: it listens to the gateway and keeps
// the rules, so the group shows only while it runs. heard(): whether the gateway spoke
// yet, null when unknown.
export function alertsGroup(device, menu, heard) {
    const kind = device.did.startsWith('lumi.') ? sensorKind(device.model ?? '') : null;
    if (!kind || !menu.present)
        return null;
    const group = new Adw.PreferencesGroup({title: _('Notifications')});
    const switchRow = (title, on, flip) => {
        const row = new Adw.SwitchRow({title, active: on});
        row.connect('notify::active', () => flip(row.active));
        group.add(row);
    };
    if (ALERT_SCOPE()[kind]) {
        const alerts = () => menu.get_value('alerts')?.deepUnpack() ?? {};
        switchRow(ALERT_SCOPE()[kind], alerts()[device.did] ?? ALARM_KINDS.includes(kind), on => {
            menu.set_value('alerts', new GLib.Variant('a{sb}', {...alerts(), [device.did]: on}));
        });
    }

    const rule = sensorRules(menu)[device.did] ?? {};
    const setRule = (name, value) => {
        const rules = sensorRules(menu);
        const changed = {...rules[device.did]};
        if (value === null)
            delete changed[name];
        else
            changed[name] = value;
        if (Object.keys(changed).length > 0)
            rules[device.did] = changed;
        else
            delete rules[device.did];
        menu.set_string('sensor-rules', JSON.stringify(rules));
    };
    const limit = (name, title, list, usual, text) => {
        const at = Math.max(0, list.indexOf(rule[name] ?? null));
        group.add(stepperRow(title, at, [0, list.length - 1],
            i => (list[i] === null ? _('Off') : text(list[i])),
            (i, direction) => (i === 0 && direction > 0 ? list.indexOf(usual) : 1),
            i => setRule(name, list[i])));
    };
    const span = (from, to, step = 1) => Array.from({length: (to - from) / step + 1}, (_v, i) => from + i * step);
    if (kind === 'door') {
        limit('openFor', _('Left open longer than'), [null, 1, 2, 5, 10, 15, 30, 60], 10,
            m => _('%s min').replace('%s', m));
    }
    if (kind === 'climate') {
        limit('warm', _('Warmer than'), [null, ...span(20, 35)], 28, t => `${t} °C`);
        limit('cold', _('Colder than'), [null, ...span(5, 25)], 16, t => `${t} °C`);
        limit('wet', _('More humid than'), [null, ...span(40, 90, 5)], 70, h => `${h} %`);
        limit('dry', _('Drier than'), [null, ...span(10, 50, 5)], 30, h => `${h} %`);
    }
    switchRow(_('A battery running low'), rule.battery !== false, on => setRule('battery', on ? null : false));
    if (heard() === false)
        group.description = _('They come from the gateway once its LAN protocol is on, in the gateway’s settings in Mi Home.');
    return group;
}
