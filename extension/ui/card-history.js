// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Chart} from './chart.js';
import {XiaomiError} from './errors.js';
import {alertsOn, sensorRules, whenText} from './events.js';
import {HISTORY_SPAN, historyKeys} from './props.js';
import {VERTICAL, numberFormat, readSetting} from './text.js';

const ALERT_SCOPE = () => ({
    leak: _('A leak, and when it is dry again'),
    smoke: _('An alarm, and when it is over'),
    gas: _('An alarm, and when it is over'),
    door: _('Every opening and closing'),
    motion: _('Every motion it sees'),
    vibration: _('Every knock, tilt and fall'),
    button: _('Every press'),
});

export class HistoryCard {
    _readHistory(home, device, eventKeys) {
        const keys = historyKeys(device).map(([key]) => key);
        return Promise.all([
            keys.length > 0 ? home.readHistory(device, keys, HISTORY_SPAN) : [],
            home.readEventLog(device, eventKeys.map(([key]) => key)),
        ]);
    }

    async _fillHistory(home, device, eventKeys, {charts, log, token}) {
        const keys = historyKeys(device);
        let series, entries;
        try {
            [series, entries] = await this._readHistory(home, device, eventKeys);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            if (this._card !== device || this._cardToken !== token)
                return;
            for (const section of [charts, log].filter(Boolean)) {
                section.destroy_all_children();
                section.add_child(new St.Label({style_class: 'nook-card-value', text: e.message}));
            }
            return;
        }
        if (this._card !== device || this._cardToken !== token)
            return;

        if (charts) {
            charts.destroy_all_children();
            keys.forEach(([, , name, unit, divisor, color], i) => {
                const points = series[i].map(p => ({time: p.time, value: p.value / divisor}));
                const head = new St.BoxLayout({style_class: 'nook-card-row'});
                head.add_child(new St.Label({style_class: 'nook-card-label', text: name, x_expand: true}));
                const values = points.map(p => p.value);
                const range = values.length > 0
                    ? `${numberFormat.format(Math.min(...values))} – ${numberFormat.format(Math.max(...values))} ${unit}`
                    : _('Nothing kept');
                const value = new St.Label({style_class: 'nook-card-value', text: range});
                head.add_child(value);
                charts.add_child(head);
                if (points.length > 0) {
                    charts.add_child(new Chart(points, color, point => {
                        value.text = point
                            ? `${numberFormat.format(point.value)} ${unit} · ${whenText(point.time)}`
                            : range;
                    }));
                }
            });
        }

        if (log) {
            if (device.lastEvent === undefined && device.primary.props.length === 0) {
                home.noteEvent(device, entries[0] ?? null);
                this._syncHero(device);
            }
            log.destroy_all_children();
            const labels = new Map(eventKeys);
            for (const {key, time} of entries) {
                const row = new St.BoxLayout({style_class: 'nook-card-row'});
                row.add_child(new St.Label({style_class: 'nook-card-label', text: labels.get(key) ?? key, x_expand: true}));
                row.add_child(new St.Label({style_class: 'nook-card-value', text: whenText(time)}));
                log.add_child(row);
            }
            if (entries.length === 0)
                log.add_child(new St.Label({style_class: 'nook-card-value', text: _('Nothing in the last 30 days.')}));
        }
    }

    _addAlertsRow(device, kind) {
        this._body.add_child(new St.Label({style_class: 'nook-room', text: _('Notifications')}));
        const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
        const switchRow = (text, on, flip) => {
            const row = new St.BoxLayout({style_class: 'nook-card-row'});
            const label = new St.Label({
                style_class: 'nook-card-label',
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.line_wrap = true;
            const toggle = new PopupMenu.Switch(on);
            toggle.reactive = false;
            const button = new St.Button({child: toggle, can_focus: true, accessible_name: text});
            button.connect('clicked', () => {
                toggle.state = !toggle.state;
                flip(toggle.state);
            });
            row.add_child(label);
            row.add_child(button);
            section.add_child(row);
        };
        if (ALERT_SCOPE()[kind]) {
            switchRow(ALERT_SCOPE()[kind], alertsOn(this._settings, device.did, kind), on => {
                const alerts = {...readSetting(this._settings, 'alerts'), [device.did]: on};
                this._settings.set_value('alerts', new GLib.Variant('a{sb}', alerts));
            });
        }

        const rule = sensorRules(this._settings)[device.did] ?? {};
        const setRule = (name, value) => {
            const rules = sensorRules(this._settings);
            const changed = {...rules[device.did]};
            if (value === null)
                delete changed[name];
            else
                changed[name] = value;
            if (Object.keys(changed).length > 0)
                rules[device.did] = changed;
            else
                delete rules[device.did];
            this._settings.set_string('sensor-rules', JSON.stringify(rules));
        };
        const limit = (name, title, list, usual, text) => {
            const at = Math.max(0, list.indexOf(rule[name] ?? null));
            this._addStepper(section, title, at, [0, list.length - 1],
                i => (list[i] === null ? _('Off') : text(list[i])),
                (i, direction) => (i === 0 && direction > 0 ? list.indexOf(usual) : 1),
                i => setRule(name, list[i]));
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
        if (!this._alerts.heard) {
            const note = new St.Label({
                style_class: 'nook-card-value',
                text: _('They come from the gateway once its LAN protocol is on, in the gateway’s settings in Mi Home.'),
            });
            note.clutter_text.line_wrap = true;
            section.add_child(note);
        }
        this._body.add_child(section);
    }
}
