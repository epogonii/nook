// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {showInFiles} from './camera.js';
import {alertsOn, sensorKind, sensorRules} from './events.js';
import {batteryShare} from './rows.js';
import {numberFormat, readSetting} from './text.js';

const LOW_BATTERY = 15;

function reportText(kind, data) {
    const status = data.status ?? data.wleak_status ?? data.window_status ?? data.motion_status ?? data.channel_0;
    switch (kind) {
    case 'leak':
        if (status === 'leak')
            return [_('Water leak!'), true];
        return status === 'no_leak' ? [_('Dry again.'), false] : null;
    case 'smoke':
    case 'gas': {
        const alarm = data.alarm === undefined ? null : String(data.alarm);
        if (alarm === null)
            return null;
        if (alarm === '1' || alarm === '2')
            return [kind === 'smoke' ? _('Smoke alarm!') : _('Gas alarm!'), true];
        return alarm === '0' ? [_('The alarm is over.'), false] : [_('The detector reports a fault.'), false];
    }
    case 'door':
        if (data.no_close)
            return [_('Still open.'), false];
        return {open: [_('Opened.'), false], close: [_('Closed.'), false]}[status] ?? null;
    case 'motion':
        return status === 'motion' ? [_('Motion.'), false] : null;
    case 'vibration':
        return {
            vibrate: [_('A knock.'), false],
            tilt: [_('Tilted.'), false],
            free_fall: [_('Dropped.'), false],
        }[status] ?? null;
    case 'button':
        return {
            click: [_('Pressed.'), false],
            double_click: [_('Pressed twice.'), false],
            long_click_press: [_('Held down.'), false],
            both_click: [_('Pressed.'), false],
            shake: [_('Shaken.'), false],
        }[status] ?? null;
    }
    return null;
}

// Gateway sensor events as notifications. The only part of Nook kept on the lock screen.
export class Alerts {
    constructor(settings, path, app) {
        this._settings = settings;
        this._app = app;
        this._icon = Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/nook-symbolic.svg`));
        this._listener = null;
        this._stopped = true;
        this._known = new Map();
        this._source = null;
        this._last = new Map();
        this._crossed = new Set();
        this._lowNoticed = new Set();
        this._openTimers = new Map();
        this.onReport = null;
    }

    state(sid) {
        return this._listener?.state(sid) ?? null;
    }

    read(sid) {
        return this._listener?.read(sid) ?? Promise.resolve(null);
    }

    start() {
        this._stopped = false;
        this._start().catch(e => console.debug(`nook: gateway: ${e.message}`));
    }

    async _start() {
        if (!this._listener) {
            const listener = await this._app.open('gateway');
            if (this._stopped || this._listener) {
                this._app.release(listener);
                return;
            }
            listener.onReport = report => this._report(report).catch(logError);
            this._listener = listener;
        }
        await this._listener.start();
    }

    get heard() {
        return this._listener?.heard ?? false;
    }

    async _report({sid, model, data, cmd, name, room}) {
        const did = `lumi.${sid}`;
        this._known.set(did, {name, room});
        // Sub-device heartbeats repeat the state about hourly; only their voltage is news.
        if (cmd === 'heartbeat') {
            for (const [body, alarm] of this._checkRules(did, model, null, {voltage: data.voltage}))
                await this._tell(did, model, body, alarm);
            return;
        }
        this.onReport?.(sid, data);
        const kind = sensorKind(model);
        const notices = this._checkRules(did, model, kind, data);
        const text = kind ? reportText(kind, data) : null;
        if (text && alertsOn(this._settings, did, kind))
            notices.unshift(text);
        for (const [body, alarm] of notices)
            await this._tell(did, model, body, alarm);
    }

    async _tell(did, model, body, alarm) {
        if (!this._listener?.running)
            return;
        const known = this._known.get(did);
        const name = readSetting(this._settings, 'names')[did] || known?.name || model;
        this._notify(did, name, known?.room ? `${body} · ${known.room}` : body, alarm);
    }

    // Each threshold notifies once per crossing and re-arms when the reading is back past
    // its margin.
    _checkRules(did, model, kind, data) {
        const rule = sensorRules(this._settings)[did] ?? {};
        const notices = [];
        if (kind === 'door' && data.status === 'open' && rule.openFor > 0) {
            this._stopTimer(did);
            const minutes = rule.openFor;
            this._openTimers.set(did, GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
                this._openTimers.delete(did);
                this._tell(did, model, _('Open for %s min.').replace('%s', minutes), false).catch(logError);
                return GLib.SOURCE_REMOVE;
            }));
        } else if (kind === 'door' && data.status === 'close') {
            this._stopTimer(did);
        }
        const check = (name, value, limit, above, margin, text) => {
            if (typeof limit !== 'number' || !Number.isFinite(value))
                return;
            const key = `${did}/${name}`;
            if (above ? value > limit : value < limit) {
                if (!this._crossed.has(key))
                    notices.push([text, false]);
                this._crossed.add(key);
            } else if (above ? value <= limit - margin : value >= limit + margin) {
                this._crossed.delete(key);
            }
        };
        const reading = (raw, unit) => `${numberFormat.format(Number(raw) / 100)} ${unit}`;
        if (data.temperature !== undefined) {
            const value = Number(data.temperature) / 100;
            const now = reading(data.temperature, '°C');
            check('warm', value, rule.warm, true, 0.5,
                _('%s now, warmer than %s.').replace('%s', now).replace('%s', `${rule.warm} °C`));
            check('cold', value, rule.cold, false, 0.5,
                _('%s now, colder than %s.').replace('%s', now).replace('%s', `${rule.cold} °C`));
        }
        if (data.humidity !== undefined) {
            const value = Number(data.humidity) / 100;
            const now = reading(data.humidity, '%');
            check('wet', value, rule.wet, true, 3,
                _('Humidity %s now, above %s.').replace('%s', now).replace('%s', `${rule.wet} %`));
            check('dry', value, rule.dry, false, 3,
                _('Humidity %s now, below %s.').replace('%s', now).replace('%s', `${rule.dry} %`));
        }
        if (data.voltage !== undefined && rule.battery !== false) {
            const share = batteryShare(Number(data.voltage));
            if (share < LOW_BATTERY && !this._lowNoticed.has(did)) {
                this._lowNoticed.add(did);
                notices.push([_('The battery is at %s %. Time for a new one.').replace('%s', share), false]);
            } else if (share >= LOW_BATTERY + 10) {
                this._lowNoticed.delete(did);
            }
        }
        return notices;
    }

    _stopTimer(did) {
        const timer = this._openTimers.get(did);
        if (timer)
            GLib.source_remove(timer);
        this._openTimers.delete(did);
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Nook', icon: this._icon});
            this._source.connect('destroy', () => {
                this._source = null;
                this._last.clear();
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    snapshotSaved(camera, file) {
        const notification = new MessageTray.Notification({
            source: this._ensureSource(),
            title: _('Snapshot saved'),
            body: camera,
            gicon: new Gio.FileIcon({file}),
        });
        notification.connect('activated', () => {
            Gio.app_info_launch_default_for_uri(file.get_uri(), global.create_app_launch_context(0, -1));
        });
        notification.addAction(_('Show in Files'), () => showInFiles(file));
        this._source.addNotification(notification);
    }

    _notify(did, title, body, alarm) {
        this._ensureSource();
        const notification = new MessageTray.Notification({
            source: this._source,
            title,
            body,
            urgency: alarm ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL,
        });
        // Alarms stay until seen. Other events replace the sensor's last notification,
        // destroyed only after adding the new one: removing a source's last notification
        // destroys the source.
        const last = this._last.get(did);
        if (alarm) {
            this._last.delete(did);
        } else {
            this._last.set(did, notification);
            notification.connect('destroy', () => {
                if (this._last.get(did) === notification)
                    this._last.delete(did);
            });
        }
        this._source.addNotification(notification);
        last?.destroy();
    }

    stop() {
        this._stopped = true;
        for (const did of [...this._openTimers.keys()])
            this._stopTimer(did);
        if (this._listener) {
            this._listener.stop().catch(e => console.debug(`nook: gateway: ${e.message}`));
            this._app.release(this._listener);
        }
        this._listener = null;
        this._source?.destroy();
        this._source = null;
    }
}
