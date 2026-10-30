// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MapError, decodeMap, parsePath} from '../lib/vacuum-map.js';
import * as Timers from '../lib/timers.js';
import {XiaomiError} from './errors.js';
import {ALARM, choiceOf, vacuumMode, wordLabel} from './hero.js';
import {humanize} from './humanize.js';
import {fillStats, spanText, statFlow} from './rows.js';
import {VERTICAL, choiceText, numberFormat} from './text.js';
import {Scene, skeletonBlock} from './widgets.js';

// Vacuum map refetch: after MAP_FRESH ms; every MAP_FRESH_WORKING s while cleaning.
const MAP_FRESH = 5 * 60 * 1000;

const MAP_FRESH_WORKING = 20;

const MAP_LIVE = 5;

const MAP_TRAIL = 20000;

export class VacuumCard {
    // Shown items go into covered: properties as 'siid/piid', actions as 'siid/a<aiid>'.
    _addVacuumControls(device, services, values, covered) {
        const home = this._home;
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-vacuum'});
        const keyOf = (service, prop) => `${service.siid}/${prop.piid}`;
        const findProperty = (names, test = () => true) => {
            for (const name of names) {
                for (const service of services) {
                    const prop = service.properties.find(p => p.name === name && test(p));
                    if (prop)
                        return {service, prop, key: keyOf(service, prop)};
                }
            }
            return null;
        };
        const status = findProperty(['status']);
        const mode = vacuumMode(choiceOf(status?.prop, values.get(status?.key)));

        const mapService = services.find(s => s.name === 'map' && s.properties.some(p => p.name === 'object-name'));
        if (mapService) {
            const frame = new St.Widget({
                style_class: 'nook-vacuum-map',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
            });
            const scene = new Scene('map', 'nook-vacuum-map-scene');
            scene.y_expand = true;
            frame.add_child(scene);
            const waiting = skeletonBlock();
            frame.add_child(waiting);
            const note = new St.Label({
                style_class: 'nook-card-value',
                visible: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            frame.add_child(note);
            box.add_child(frame);
            const request = mapService.actions?.find(a => a.name === 'map-req' && a.in.length === 1);
            this._map = {
                device,
                scene,
                waiting,
                note,
                siid: mapService.siid,
                piid: mapService.properties.find(p => p.name === 'object-name').piid,
                request: request ? {aiid: request.aiid, piid: request.in[0]} : null,
                live: mapService.properties.find(p => p.name === 'map-view')?.piid ?? null,
                working: mode === 'cleaning' || mode === 'returning',
                timer: 0,
            };
            this._loadMap(this._map).catch(logError);
        }

        const runTime = findProperty(['cleaning-time', 'time-duration']);
        const runArea = findProperty(['cleaning-area', 'size']);
        const paused = /paus/i.test(choiceOf(status?.prop, values.get(status?.key)) ?? '');
        if ((mode === 'cleaning' || mode === 'returning' || paused) && (runTime || runArea)) {
            covered.add(runTime?.key);
            covered.add(runArea?.key);
            const flow = statFlow();
            flow.visible = false;
            box.add_child(flow);
            this._fillRun(device, flow, runTime, runArea, values).catch(logError);
        }

        const buttons = new St.BoxLayout({style_class: 'nook-vacuum-actions', x_expand: true});
        buttons.layout_manager.homogeneous = true;
        // Older Dreame robots lack pause-sweeping: for them stop-clean pauses and
        // stop-sweeping stops.
        const pauses = services.some(s => s.actions?.some(a => a.name === 'pause-sweeping'));
        for (const name of ['start-sweep', 'start-clean', 'pause-sweeping', 'stop-sweeping', 'stop-clean']) {
            for (const service of services) {
                const action = (service.actions ?? []).find(a => a.name === name && a.in.length === 0);
                if (action)
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
        }
        for (const [names, icon, label, active] of [
            mode === 'cleaning'
                ? [[pauses ? 'pause-sweeping' : 'stop-clean'], 'media-playback-pause-symbolic', _('Pause'), false]
                : [['start-sweep', 'start-clean'], 'media-playback-start-symbolic', _('Clean'), false],
            [['stop-sweeping', 'stop-clean'], 'media-playback-stop-symbolic', _('Stop'), false],
            [['start-charge'], 'go-home-symbolic', _('Dock'), mode === 'charging' || mode === 'returning'],
            [['identify'], 'find-location-symbolic', _('Find'), false],
        ]) {
            let first = null;
            for (const name of names) {
                for (const service of services) {
                    const action = (service.actions ?? []).find(a => a.name === name && a.in.length === 0);
                    if (!action)
                        continue;
                    first ??= {service, action};
                    covered.add(`${service.siid}/a${action.aiid}`);
                }
            }
            if (!first)
                continue;
            const item = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-action'});
            const button = this._addRoundButton(item, icon, label, () => {
                this._cardWrite(device, () => home.runAction(device, first.service.siid, first.action.aiid))
                    .catch(logError);
            });
            button.x_align = Clutter.ActorAlign.CENTER;
            button.checked = active;
            item.add_child(wordLabel(label));
            buttons.add_child(item);
        }
        if (buttons.get_n_children() > 0)
            box.add_child(buttons);

        const suction = findProperty(['suction-level', 'cleaning-mode', 'mode', 'fan-level'],
            p => p.access.includes('write') && (p.choices?.length ?? 0) > 1);
        if (suction) {
            covered.add(suction.key);
            box.add_child(new St.Label({style_class: 'nook-vacuum-title', text: _('Suction')}));
            const segments = new St.BoxLayout({style_class: 'nook-segments', x_expand: true});
            segments.layout_manager.homogeneous = true;
            const current = values.get(suction.key);
            for (const choice of suction.prop.choices) {
                const label = new St.Label({text: choiceText(choice.description), x_align: Clutter.ActorAlign.CENTER});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                const segment = new St.Button({style_class: 'nook-segment', child: label, can_focus: true, x_expand: true});
                segment.checked = choice.value === current;
                segment.connect('clicked', () => {
                    this._cardWrite(device, () => home.setProperty(device, suction.service.siid, suction.prop.piid, choice.value))
                        .catch(logError);
                });
                segments.add_child(segment);
            }
            box.add_child(segments);
        }

        const wear = [];
        for (const service of services) {
            const level = service.properties.find(p => p.name.endsWith('life-level'));
            const value = level ? values.get(keyOf(service, level)) : undefined;
            if (typeof value !== 'number')
                continue;
            const left = service.properties.find(p => p.name.endsWith('left-time'));
            const hours = left ? values.get(keyOf(service, left)) : undefined;
            covered.add(keyOf(service, level));
            if (left)
                covered.add(keyOf(service, left));
            wear.push([humanize(service.description || service.name), value, hours]);
        }
        if (wear.length > 0) {
            box.add_child(new St.Label({style_class: 'nook-vacuum-title', text: _('Brushes and Filter')}));
            for (const [name, value, hours] of wear) {
                const row = new St.BoxLayout({style_class: 'nook-wear'});
                const text = new St.BoxLayout({...VERTICAL, x_expand: true});
                const head = new St.BoxLayout();
                head.add_child(new St.Label({text: name, x_expand: true}));
                const parts = [`${value} %`];
                if (typeof hours === 'number')
                    parts.push(_('%s h left').replace('%s', hours));
                head.add_child(new St.Label({style_class: 'nook-card-value', text: parts.join(' · ')}));
                text.add_child(head);
                const bar = new Scene('progress', 'nook-wear-bar');
                let color = [0.36, 0.82, 0.56];
                if (value < 10)
                    color = ALARM;
                else if (value < 30)
                    color = [0.98, 0.66, 0.22];
                bar.show({share: value / 100, color});
                text.add_child(bar);
                row.add_child(text);
                box.add_child(row);
            }
        }

        const total = name => {
            const found = findProperty([name]);
            if (found)
                covered.add(found.key);
            const value = found ? values.get(found.key) : undefined;
            return typeof value === 'number' ? value : null;
        };
        const stats = [
            [total('total-clean-times'), _('cleanings')],
            [total('total-clean-time'), _('hours'), minutes => numberFormat.format(Math.round(minutes / 6) / 10)],
            [total('total-clean-area'), _('m² cleaned')],
        ].filter(([value]) => value !== null);
        if (stats.length > 0) {
            const row = new St.BoxLayout({style_class: 'nook-vacuum-stats', x_expand: true});
            row.layout_manager.homogeneous = true;
            for (const [value, word, shape = v => numberFormat.format(v)] of stats) {
                const stat = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-stat', x_expand: true});
                const number = new St.Label({style_class: 'nook-vacuum-number', text: shape(value), x_align: Clutter.ActorAlign.CENTER});
                number.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                stat.add_child(number);
                stat.add_child(wordLabel(word));
                row.add_child(stat);
            }
            box.add_child(row);
        }

        const settings = [];
        const quiet = services.find(s => s.name === 'annoy');
        const enable = quiet?.properties.find(p => p.name === 'enable' && p.format === 'bool');
        const quietKey = enable ? keyOf(quiet, enable) : null;
        covered.add(quietKey);
        if (typeof values.get(quietKey) === 'boolean') {
            const row = this._propertyRow(home, device, quiet, enable, values.get(quietKey), _('Do Not Disturb'));
            const hours = ['start-time', 'stop-time'].map(name => {
                const prop = quiet.properties.find(p => p.name === name);
                if (prop)
                    covered.add(keyOf(quiet, prop));
                const value = prop ? values.get(keyOf(quiet, prop)) : undefined;
                return typeof value === 'string' ? value.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1') : '';
            });
            if (hours.every(h => /^\d{1,2}:\d{2}$/.test(h))) {
                row.insert_child_at_index(new St.Label({
                    style_class: 'nook-card-value',
                    text: hours.join(' – '),
                    y_align: Clutter.ActorAlign.CENTER,
                }), 1);
            }
            settings.push(row);
        }
        const audio = services.find(s => s.name === 'audio');
        const volume = audio?.properties.find(p => p.name === 'volume' && p.access.includes('read'));
        const volumeKey = volume ? keyOf(audio, volume) : null;
        covered.add(volumeKey);
        if (typeof values.get(volumeKey) === 'number') {
            const row = this._propertyRow(home, device, audio, volume, values.get(volumeKey), _('Volume'));
            const test = audio.actions?.find(a => a.name === 'play-sound' && a.in.length === 0);
            if (test && row && device.online) {
                const chip = new St.Button({style_class: 'nook-chip', label: _('Play a Sound'), can_focus: true, x_align: Clutter.ActorAlign.START});
                chip.connect('clicked', () => {
                    this._cardWrite(device, () => home.runAction(device, audio.siid, test.aiid)).catch(logError);
                });
                row.add_child(chip);
            }
            if (row)
                settings.push(row);
        }
        if (settings.length > 0) {
            box.add_child(new St.Label({style_class: 'nook-vacuum-title', text: _('Settings')}));
            for (const row of settings)
                box.add_child(row);
        }

        // In the hero already, or internal firmware values meaningless to show.
        for (const name of ['status', 'battery-level', 'charging-state', 'work-mode', 'clean-log-start-time',
            'button-led', 'task-done', 'delete-timer'])
            covered.add(findProperty([name])?.key);
        // Hide the 'remote' service (a joystick, no room for it) and all audio actions:
        // voice packs are set in the app, Find is above, the test sound sits by Volume.
        for (const service of services) {
            const all = service.name === 'remote';
            for (const action of service.actions ?? []) {
                if (all || service === audio)
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
            if (all) {
                for (const prop of service.properties)
                    covered.add(keyOf(service, prop));
            }
        }
        if (box.get_n_children() > 0)
            this._stageAdd(box);
    }

    // Cached map first, refetched when stale. While cleaning, follow map-view history if
    // the robot has it (_followRobot()), else request a whole new map periodically.
    async _loadMap(view) {
        const did = view.device.did;
        const cached = this._maps.get(did);
        if (cached)
            this._showMap(view, cached);
        const fresh = view.working && !view.live ? MAP_FRESH_WORKING * 1000 : MAP_FRESH;
        if (!cached || Date.now() - cached.at > fresh) {
            let file = null, map = null;
            try {
                if (view.working && view.request && !view.live) {
                    await this._home.requestMap(view.device, view.siid, view.request.aiid, view.request.piid);
                    await Timers.sleep(3000);
                }
                file = await this._home.mapFile(view.device, view.siid, view.piid);
                map = file ? decodeMap(file.text) : null;
            } catch (e) {
                if (!(e instanceof XiaomiError) && !(e instanceof MapError) && !(e instanceof GLib.Error))
                    throw e;
                console.debug(`nook: map: ${e.message}`);
            }
            if (this._map !== view)
                return;
            if (map) {
                const same = cached?.since === file.time;
                const entry = {
                    map,
                    at: Date.now(),
                    since: file.time,
                    seen: same ? cached.seen : file.time,
                    trail: same ? cached.trail : [],
                    robot: same ? cached.robot : null,
                };
                this._maps.set(did, entry);
                this._showMap(view, entry);
            } else if (!cached) {
                view.waiting.visible = false;
                view.note.text = _('No map yet: one is drawn as the robot cleans.');
                view.note.visible = true;
            }
        }
        if (view.working && !view.timer) {
            const every = view.live ? MAP_LIVE : MAP_FRESH_WORKING;
            view.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, every, () => {
                if (this._menu.isOpen)
                    (view.live ? this._followRobot(view) : this._loadMap(view)).catch(logError);
                return GLib.SOURCE_CONTINUE;
            });
            if (view.live)
                this._followRobot(view).catch(logError);
        }
    }

    async _followRobot(view) {
        const entry = this._maps.get(view.device.did);
        if (!entry || entry.following)
            return;
        entry.following = true;
        try {
            if (!entry.robot) {
                const last = await this._home.lastTold(view.device, view.siid, view.live);
                let frame = null;
                try {
                    frame = last ? decodeMap(String(last.value)) : null;
                } catch (e) {
                    if (!(e instanceof MapError))
                        throw e;
                }
                if (frame && frame.robot.x !== 32767) {
                    entry.robot = frame.robot;
                    if (this._map?.device === view.device)
                        this._showMap(this._map, entry);
                }
            }
            const frames = await this._home.propHistory(view.device, view.siid, view.live, entry.seen + 1);
            for (const [i, {time, value}] of frames.entries()) {
                // Yield to the main loop every 100 frames so the shell doesn't stall.
                if (i % 100 === 99) {
                    await Timers.sleep(0, GLib.PRIORITY_DEFAULT_IDLE);
                }
                let frame;
                try {
                    frame = decodeMap(String(value));
                } catch (e) {
                    if (!(e instanceof MapError))
                        throw e;
                    continue;
                }
                entry.seen = Math.max(entry.seen, time);
                if (frame.rooms)
                    entry.map = frame;
                if (frame.robot.x !== 32767)
                    entry.robot = frame.robot;
                entry.trail.push(...parsePath(frame.trace, entry.trail.at(-1)));
            }
            if (entry.trail.length > MAP_TRAIL)
                entry.trail.splice(0, entry.trail.length - MAP_TRAIL);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: live map: ${e.message}`);
        } finally {
            entry.following = false;
        }
        if (this._map?.device === view.device)
            this._showMap(this._map, entry);
    }

    _showMap(view, {map, trail = [], robot = null}) {
        view.waiting.visible = false;
        view.note.visible = false;
        view.scene.show({
            map: {...map, robot: robot ?? map.robot, path: trail.length > 1 ? [...map.path, ...trail] : map.path},
            working: view.working,
        });
        view.scene.run(view.working && this._menu.isOpen);
    }

    // Robots that report these only on change: fall back to the cloud's last stored
    // value, if reported since this clean began.
    async _fillRun(device, flow, time, area, values) {
        let gone = false;
        flow.connect('destroy', () => {
            gone = true;
        });
        const since = this._maps.get(device.did)?.since ?? 0;
        const told = async found => {
            if (!found)
                return null;
            if (values.has(found.key))
                return values.get(found.key);
            const last = await this._home.lastTold(device, found.service.siid, found.prop.piid);
            return last && last.time >= since - 120 ? last.value : null;
        };
        let minutes = null, size = null;
        try {
            [minutes, size] = await Promise.all([told(time), told(area)]);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: this clean: ${e.message}`);
        }
        if (gone)
            return;
        const rows = [];
        if (minutes !== null && minutes !== '' && Number.isFinite(Number(minutes)))
            rows.push({key: 'run-time', title: _('Cleaning for'), glyph: 'clock', text: spanText(Number(minutes) * 60)});
        if (size !== null && size !== '' && Number.isFinite(Number(size)))
            rows.push({key: 'run-area', title: _('Cleaned'), glyph: 'vacuum', text: `${numberFormat.format(Number(size))} m²`});
        fillStats(flow, rows);
        flow.visible = rows.length > 0;
    }

    _forgetMap() {
        if (this._map?.timer)
            GLib.source_remove(this._map.timer);
        this._map?.scene.run(false);
        this._map = null;
    }
}
