// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _} from 'gettext';

import {roundButton, statChips} from './card-parts.js';
import {choiceOf, vacuumMode} from './hero.js';
import {humanize} from './humanize.js';
import * as Timers from './lib/timers.js';
import {MapError, decodeMap, parsePath} from './lib/vacuum-map.js';
import {XiaomiError} from './lib/xiaomi.js';
import {choiceText, formatValue, numberFormat, spanText} from './text.js';
import {SceneArea} from './widgets.js';

// Map refetch: after MAP_FRESH ms; every MAP_FRESH_WORKING s while cleaning.
const MAP_FRESH = 5 * 60 * 1000;
const MAP_FRESH_WORKING = 20;
// s between reads of the live map-view frames while cleaning.
const MAP_LIVE = 5;
const MAP_TRAIL = 20000;
const MAP_HEIGHT = 280;
// ms a control just used keeps its value over what a read brings: the robot may not
// report the write yet.
const TOUCHED = 4000;
// ms the volume slider rests before its value goes out.
const SETTLE = 700;

// By did, so a page opened again shows the last map at once.
const maps = new Map();

const VERTICAL = Gtk.Orientation.VERTICAL;

function setClass(widget, name, on) {
    if (on)
        widget.add_css_class(name);
    else
        widget.remove_css_class(name);
}

// Shown items go into covered: properties as 'siid/piid', actions as 'siid/a<aiid>'.
export class VacuumCard {
    constructor(ctx) {
        this._ctx = ctx;
        this._device = ctx.device;
        this._services = null;
        this._added = [];
        this._gone = false;
        this.covered = new Set();

        this.stage = new Gtk.Box({orientation: VERTICAL, spacing: 14, margin_top: 16, visible: false});
        this._run = new Adw.Bin({halign: Gtk.Align.CENTER, visible: false});
        this._runShown = null;
        this._runToken = 0;
        this.stage.append(this._run);
        this._actions = new Gtk.Box({spacing: 6, homogeneous: true, css_classes: ['nook-actions']});
        this.stage.append(this._actions);
        this._suction = new Gtk.Box({orientation: VERTICAL, spacing: 6});
        this.stage.append(this._suction);

        this._mapGroup = new Adw.PreferencesGroup({title: _('Map'), visible: false});
        this._wearGroup = new Adw.PreferencesGroup({title: _('Brushes and Filter'), visible: false});
        this._totalsGroup = new Adw.PreferencesGroup({visible: false});
        this._settingsGroup = new Adw.PreferencesGroup({title: _('Settings'), visible: false});
        this.groups = [this._mapGroup, this._wearGroup, this._totalsGroup, this._settingsGroup];

        this._view = null;
        this._mapTimer = 0;
        this._mapLoading = false;
        this._mapTried = 0;
        this._volumeTimer = 0;
        this._flushVolume = null;
    }

    sync(spec) {
        const device = this._device;
        const services = spec?.services ?? [];
        this.covered.clear();
        if (services.length === 0 || device.unreadable) {
            this._runToken++;
            this._setWorking(false);
            this.stage.visible = false;
            for (const group of this.groups)
                group.visible = false;
            return;
        }
        if (services !== this._services)
            this._build(services);
        const values = spec.values ?? new Map();
        const online = device.online !== false;
        const p = this._parts;
        const status = choiceOf(p.status?.prop, values.get(p.status?.key));
        const mode = vacuumMode(status);
        const paused = /paus/i.test(status ?? '');
        this.stage.visible = this._slots.length > 0 || Boolean(p.suction || p.runTime || p.runArea);

        this._mapGroup.visible = Boolean(this._view);
        if (this._view) {
            this._setWorking(mode === 'cleaning' || mode === 'returning');
            this._loadMap().catch(logError);
        }

        if ((mode === 'cleaning' || mode === 'returning' || paused) && (p.runTime || p.runArea)) {
            this._cover(p.runTime?.key, p.runArea?.key);
            this._fillRun(values).catch(logError);
        } else {
            this._runToken++;
            this._run.visible = false;
        }

        this._cover(...p.actionKeys);
        for (const slot of this._slots) {
            const cleaning = mode === 'cleaning' && 'pause' in slot;
            slot.use = cleaning ? slot.pause : slot.action;
            slot.item.visible = Boolean(slot.use);
            if ('pause' in slot) {
                const label = cleaning ? _('Pause') : _('Clean');
                slot.button.icon_name = cleaning ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
                slot.button.tooltip_text = label;
                slot.word.label = label;
            }
            if (slot.dock)
                setClass(slot.button, 'on', mode === 'charging' || mode === 'returning');
        }
        this._actions.visible = this._slots.length > 0;
        this._actions.sensitive = online;

        if (p.suction) {
            this._cover(p.suction.key);
            this._suctionValue = values.get(p.suction.key);
            if (Date.now() - this._suctionTouched > TOUCHED)
                this._markSuction(this._suctionValue);
            this._suction.sensitive = online;
        }

        let worn = false;
        for (const part of this._wear) {
            const level = values.get(part.level);
            const hours = part.left ? values.get(part.left) : undefined;
            this._cover(part.level, part.left);
            part.row.visible = typeof level === 'number';
            if (!part.row.visible)
                continue;
            worn = true;
            part.bar.value = Math.min(1, Math.max(0, level / 100));
            part.shown.label = `${level} %`;
            part.row.subtitle = typeof hours === 'number' ? _('%s h left').replace('%s', hours) : '';
        }
        this._wearGroup.visible = worn;

        let counted = false;
        for (const total of this._totals) {
            this._cover(total.key);
            const value = values.get(total.key);
            total.box.visible = typeof value === 'number';
            if (total.box.visible) {
                total.number.label = total.shape(value);
                counted = true;
            }
        }
        this._totalsGroup.visible = counted;

        this._syncSettings(values, online);

        this._cover(...p.hidden);
    }

    // When the page leaves: no more map reads; a volume let go just now still goes out.
    forget() {
        this._gone = true;
        this._runToken++;
        this._stopMap();
        this._flushVolume?.();
    }

    _cover(...keys) {
        for (const key of keys) {
            if (key)
                this.covered.add(key);
        }
    }

    _find(names, test = () => true) {
        for (const name of names) {
            for (const service of this._services) {
                const prop = service.properties.find(p => p.name === name && test(p));
                if (prop)
                    return {service, prop, key: `${service.siid}/${prop.piid}`};
            }
        }
        return null;
    }

    _findAction(names) {
        for (const name of names) {
            for (const service of this._services) {
                const action = (service.actions ?? []).find(a => a.name === name && a.in.length === 0);
                if (action)
                    return {service, action, key: `${service.siid}/a${action.aiid}`};
            }
        }
        return null;
    }

    _build(services) {
        this._services = services;
        this._stopMap();
        this._view = null;
        for (const [group, child] of this._added)
            group.remove(child);
        this._added = [];
        for (const box of [this._actions, this._suction]) {
            for (let child = box.get_first_child(); child; child = box.get_first_child())
                box.remove(child);
        }
        const keyOf = (service, prop) => `${service.siid}/${prop.piid}`;
        const p = {
            status: this._find(['status']),
            runTime: this._find(['cleaning-time', 'time-duration']),
            runArea: this._find(['cleaning-area', 'size']),
            suction: this._find(['suction-level', 'cleaning-mode', 'mode', 'fan-level'],
                prop => prop.access.includes('write') && (prop.choices?.length ?? 0) > 1),
            actionKeys: [],
            hidden: [],
        };
        this._parts = p;

        // Older Dreame robots lack pause-sweeping: for them stop-clean pauses and
        // stop-sweeping stops.
        const pauses = services.some(s => s.actions?.some(a => a.name === 'pause-sweeping'));
        for (const name of ['start-sweep', 'start-clean', 'pause-sweeping', 'stop-sweeping', 'stop-clean']) {
            for (const service of services) {
                const action = (service.actions ?? []).find(a => a.name === name && a.in.length === 0);
                if (action)
                    p.actionKeys.push(`${service.siid}/a${action.aiid}`);
            }
        }
        this._slots = [
            {action: this._findAction(['start-sweep', 'start-clean']), pause: this._findAction([pauses ? 'pause-sweeping' : 'stop-clean']),
                icon: 'media-playback-start-symbolic', label: _('Clean')},
            {action: this._findAction(['stop-sweeping', 'stop-clean']), icon: 'media-playback-stop-symbolic', label: _('Stop')},
            {action: this._findAction(['start-charge']), icon: 'go-home-symbolic', label: _('Dock'), dock: true},
            {action: this._findAction(['identify']), icon: 'find-location-symbolic', label: _('Find')},
        ].filter(slot => slot.action || slot.pause);
        for (const slot of this._slots) {
            p.actionKeys.push(slot.action?.key, slot.pause?.key);
            slot.button = roundButton(slot.icon, slot.label, () => {
                const {service, action} = slot.use ?? {};
                if (action)
                    this._write(() => this._device.source.runAction(this._device, service.siid, action.aiid)).catch(logError);
            });
            slot.button.halign = Gtk.Align.CENTER;
            slot.button.add_css_class('nook-action');
            slot.word = new Gtk.Label({
                label: slot.label,
                wrap: true,
                justify: Gtk.Justification.CENTER,
                max_width_chars: 10,
                css_classes: ['nook-action-word'],
            });
            slot.item = new Gtk.Box({orientation: VERTICAL, spacing: 4});
            slot.item.append(slot.button);
            slot.item.append(slot.word);
            this._actions.append(slot.item);
        }

        this._segments = [];
        this._suctionTouched = 0;
        this._suctionValue = undefined;
        this._suction.visible = Boolean(p.suction);
        if (p.suction) {
            this._suction.append(new Gtk.Label({label: _('Suction'), xalign: 0, css_classes: ['nook-vacuum-title']}));
            const line = new Gtk.Box({homogeneous: true, spacing: 2, css_classes: ['nook-segments']});
            for (const choice of p.suction.prop.choices) {
                const label = choiceText(choice.description);
                const content = new Gtk.Box({css_classes: ['nook-segment-box']});
                content.append(new Gtk.Label({label, hexpand: true, ellipsize: Pango.EllipsizeMode.END}));
                const segment = new Gtk.Button({
                    child: content,
                    hexpand: true,
                    tooltip_text: `${_('Suction')}: ${label}`,
                    css_classes: ['nook-segment'],
                });
                segment.connect('clicked', () => this._pickSuction(choice.value).catch(logError));
                this._segments.push({value: choice.value, segment});
                line.append(segment);
            }
            this._suction.append(line);
        }

        const mapService = services.find(s => s.name === 'map' && s.properties.some(prop => prop.name === 'object-name'));
        if (mapService && typeof this._device.source?.mapFile === 'function')
            this._buildMap(mapService);

        this._wear = [];
        for (const service of services) {
            const level = service.properties.find(prop => prop.name.endsWith('life-level'));
            if (!level)
                continue;
            const left = service.properties.find(prop => prop.name.endsWith('left-time'));
            const row = new Adw.ActionRow({title: humanize(service.description || service.name), use_markup: false, visible: false});
            const bar = new Gtk.LevelBar({valign: Gtk.Align.CENTER, width_request: 120});
            // Red under 10 %, amber under 30 %, as in the extension. Own offset names:
            // libadwaita paints 'low' in the accent colour.
            bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_LOW);
            bar.remove_offset_value(Gtk.LEVEL_BAR_OFFSET_HIGH);
            bar.add_offset_value('nook-worn', 0.1);
            bar.add_offset_value('nook-wearing', 0.3);
            const shown = new Gtk.Label({width_chars: 5, xalign: 1, css_classes: ['dim-label', 'numeric']});
            row.add_suffix(bar);
            row.add_suffix(shown);
            this._add(this._wearGroup, row);
            this._wear.push({level: keyOf(service, level), left: left ? keyOf(service, left) : null, row, bar, shown});
        }

        this._totals = [];
        const card = new Gtk.Box({homogeneous: true, css_classes: ['card']});
        for (const [name, word, shape = v => numberFormat.format(v)] of [
            ['total-clean-times', _('cleanings')],
            ['total-clean-time', _('hours'), minutes => numberFormat.format(Math.round(minutes / 6) / 10)],
            ['total-clean-area', _('m² cleaned')],
        ]) {
            const found = this._find([name]);
            if (!found)
                continue;
            const box = new Gtk.Box({orientation: VERTICAL, spacing: 2, margin_top: 12, margin_bottom: 12, visible: false});
            const number = new Gtk.Label({css_classes: ['nook-vacuum-number', 'numeric']});
            box.append(number);
            box.append(new Gtk.Label({label: word, wrap: true, justify: Gtk.Justification.CENTER, css_classes: ['caption', 'dim-label']}));
            card.append(box);
            this._totals.push({key: found.key, box, number, shape});
        }
        if (this._totals.length > 0)
            this._add(this._totalsGroup, card);

        this._buildSettings(services);

        // In the hero already, or internal firmware values meaningless to show.
        for (const name of ['status', 'battery-level', 'charging-state', 'work-mode', 'clean-log-start-time',
            'button-led', 'task-done', 'delete-timer'])
            p.hidden.push(this._find([name])?.key);
        // Hide the 'remote' service (a joystick, no room for it) and all audio actions:
        // voice packs are set in the app, Find is above, the test sound sits by Volume.
        for (const service of services) {
            const all = service.name === 'remote';
            for (const action of service.actions ?? []) {
                if (all || service.name === 'audio')
                    p.hidden.push(`${service.siid}/a${action.aiid}`);
            }
            if (all)
                p.hidden.push(...service.properties.map(prop => keyOf(service, prop)));
        }
    }

    _buildSettings(services) {
        const s = {};
        this._settings = s;
        const quiet = services.find(service => service.name === 'annoy');
        const enable = quiet?.properties.find(prop => prop.name === 'enable' && prop.format === 'bool');
        if (enable) {
            const row = new Adw.SwitchRow({title: _('Do Not Disturb'), sensitive: enable.access.includes('write'), visible: false});
            s.quiet = {service: quiet, prop: enable, key: `${quiet.siid}/${enable.piid}`, row, touched: 0, quiet: false};
            s.hours = ['start-time', 'stop-time'].map(name => quiet.properties.find(prop => prop.name === name))
                .map(prop => (prop ? `${quiet.siid}/${prop.piid}` : null));
            row.connect('notify::active', () => {
                if (!s.quiet.quiet)
                    this._pickQuiet(row.active).catch(logError);
            });
            this._add(this._settingsGroup, row);
        }

        const audio = services.find(service => service.name === 'audio');
        const volume = audio?.properties.find(prop => prop.name === 'volume' && prop.access.includes('read'));
        if (!volume)
            return;
        const v = {service: audio, prop: volume, key: `${audio.siid}/${volume.piid}`, touched: 0, quiet: false};
        s.volume = v;
        v.row = new Adw.ActionRow({title: _('Volume'), visible: false});
        v.shown = new Gtk.Label({width_chars: 5, xalign: 1, css_classes: ['dim-label', 'numeric']});
        const [min, max, step] = volume.range ?? [];
        if (volume.access.includes('write') && max > min) {
            const unit = step || 1;
            v.adjustment = new Gtk.Adjustment({lower: min, upper: max, step_increment: unit, page_increment: Math.max(unit, (max - min) / 10)});
            const scale = new Gtk.Scale({adjustment: v.adjustment, hexpand: true, valign: Gtk.Align.CENTER, width_request: 200, draw_value: false});
            const snap = () => Math.min(max, Math.max(min, min + Math.round((v.adjustment.value - min) / unit) * unit));
            const send = () => {
                this._volumeTimer = 0;
                v.touched = Date.now();
                this._writeProperty(v, snap()).catch(logError);
            };
            this._flushVolume = () => {
                if (!this._volumeTimer)
                    return;
                GLib.source_remove(this._volumeTimer);
                send();
            };
            scale.connect('value-changed', () => {
                v.shown.label = formatValue(volume, snap()) || '–';
                if (v.quiet)
                    return;
                v.touched = Date.now();
                if (this._volumeTimer)
                    GLib.source_remove(this._volumeTimer);
                this._volumeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE, () => {
                    send();
                    return GLib.SOURCE_REMOVE;
                });
            });
            v.row.add_suffix(scale);
        }
        v.row.add_suffix(v.shown);
        this._add(this._settingsGroup, v.row);
        const test = audio.actions?.find(a => a.name === 'play-sound' && a.in.length === 0);
        if (test) {
            v.test = new Adw.ButtonRow({title: _('Play a Sound'), start_icon_name: 'audio-volume-high-symbolic', visible: false});
            v.test.connect('activated', () => {
                this._write(() => this._device.source.runAction(this._device, audio.siid, test.aiid)).catch(logError);
            });
            this._add(this._settingsGroup, v.test);
        }
    }

    _syncSettings(values, online) {
        const {quiet, hours, volume} = this._settings;
        let any = false;
        if (quiet) {
            this._cover(quiet.key, ...hours);
            const value = values.get(quiet.key);
            quiet.row.visible = typeof value === 'boolean';
            if (quiet.row.visible) {
                any = true;
                if (Date.now() - quiet.touched > TOUCHED && quiet.row.active !== value) {
                    quiet.quiet = true;
                    quiet.row.active = value;
                    quiet.quiet = false;
                }
                const times = hours.map(key => {
                    const text = values.get(key);
                    return typeof text === 'string' ? text.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1') : '';
                });
                quiet.row.subtitle = times.every(t => /^\d{1,2}:\d{2}$/.test(t)) ? times.join(' – ') : '';
            }
        }
        if (volume) {
            this._cover(volume.key);
            const value = values.get(volume.key);
            volume.row.visible = typeof value === 'number';
            if (volume.row.visible) {
                any = true;
                if (!volume.adjustment) {
                    volume.shown.label = formatValue(volume.prop, value) || '–';
                } else if (!this._volumeTimer && Date.now() - volume.touched > TOUCHED) {
                    volume.quiet = true;
                    volume.adjustment.value = value;
                    volume.quiet = false;
                    volume.shown.label = formatValue(volume.prop, value) || '–';
                }
            }
            if (volume.test)
                volume.test.visible = volume.row.visible && online;
        }
        this._settingsGroup.visible = any;
        this._settingsGroup.sensitive = online;
    }

    _buildMap(service) {
        const objectName = service.properties.find(prop => prop.name === 'object-name');
        const request = service.actions?.find(a => a.name === 'map-req' && a.in.length === 1);
        this._view = {
            siid: service.siid,
            piid: objectName.piid,
            request: request ? {aiid: request.aiid, piid: request.in[0]} : null,
            live: service.properties.find(prop => prop.name === 'map-view')?.piid ?? null,
            working: false,
        };
        this._mapTried = 0;
        this._scene = new SceneArea(MAP_HEIGHT);
        this._mapStack = new Gtk.Stack({css_classes: ['nook-vacuum-map'], overflow: Gtk.Overflow.HIDDEN});
        const waiting = new Adw.Spinner({width_request: 32, height_request: 32, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER});
        this._mapStack.add_named(waiting, 'waiting');
        this._mapStack.add_named(this._scene, 'map');
        this._mapStack.add_named(new Gtk.Label({
            label: _('No map yet: one is drawn as the robot cleans.'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_start: 24,
            margin_end: 24,
            css_classes: ['nook-vacuum-map-note'],
        }), 'none');
        this._add(this._mapGroup, this._mapStack);
        const cached = maps.get(this._device.did);
        if (cached)
            this._showMap(cached);
    }

    _stopMap() {
        if (this._mapTimer)
            GLib.source_remove(this._mapTimer);
        this._mapTimer = 0;
    }

    // While cleaning, follow the map-view history if the robot has it (_followRobot()),
    // else request a whole new map periodically.
    _setWorking(working) {
        const view = this._view;
        if (!view || view.working === working)
            return;
        view.working = working;
        this._stopMap();
        const entry = maps.get(this._device.did);
        if (entry && this._mapStack.visible_child_name === 'map')
            this._showMap(entry);
        if (!working || this._gone)
            return;
        this._mapTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, view.live ? MAP_LIVE : MAP_FRESH_WORKING, () => {
            if (this._scene.get_mapped())
                (view.live ? this._followRobot() : this._loadMap()).catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
        if (view.live)
            this._followRobot().catch(logError);
    }

    async _loadMap() {
        const view = this._view;
        const device = this._device;
        const cached = maps.get(device.did);
        const fresh = view.working && !view.live ? MAP_FRESH_WORKING * 1000 : MAP_FRESH;
        if (this._mapLoading || Date.now() - (cached?.at ?? this._mapTried) <= fresh)
            return;
        this._mapLoading = true;
        this._mapTried = Date.now();
        let file = null, map = null;
        try {
            if (view.working && view.request && !view.live) {
                await device.source.requestMap(device, view.siid, view.request.aiid, view.request.piid);
                await Timers.sleep(3000);
            }
            file = await device.source.mapFile(device, view.siid, view.piid);
            map = file ? decodeMap(file.text) : null;
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof MapError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook-app: map: ${e.message}`);
        } finally {
            this._mapLoading = false;
        }
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
            maps.set(device.did, entry);
            if (this._gone)
                return;
            this._showMap(entry);
            if (view.working && view.live)
                this._followRobot().catch(logError);
        } else if (!cached && !this._gone) {
            this._mapStack.visible_child_name = 'none';
        }
    }

    async _followRobot() {
        const view = this._view;
        const device = this._device;
        const entry = maps.get(device.did);
        if (!entry || entry.following)
            return;
        entry.following = true;
        try {
            if (!entry.robot) {
                const last = await device.source.lastTold(device, view.siid, view.live);
                let frame = null;
                try {
                    frame = last ? decodeMap(String(last.value)) : null;
                } catch (e) {
                    if (!(e instanceof MapError))
                        throw e;
                }
                if (frame && frame.robot.x !== 32767) {
                    entry.robot = frame.robot;
                    if (!this._gone)
                        this._showMap(entry);
                }
            }
            const frames = await device.source.propHistory(device, view.siid, view.live, entry.seen + 1);
            for (const [i, {time, value}] of frames.entries()) {
                if (i % 100 === 99)
                    await Timers.sleep(0, GLib.PRIORITY_DEFAULT_IDLE);
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
            console.debug(`nook-app: live map: ${e.message}`);
        } finally {
            entry.following = false;
        }
        if (!this._gone)
            this._showMap(entry);
    }

    _showMap({map, trail = [], robot = null}) {
        this._mapStack.visible_child_name = 'map';
        this._scene.show('map', {
            map: {...map, robot: robot ?? map.robot, path: trail.length > 1 ? [...map.path, ...trail] : map.path},
            working: this._view.working,
        });
    }

    // Robots that report these only on change: fall back to the cloud's last stored
    // value, if reported since this clean began.
    async _fillRun(values) {
        const token = ++this._runToken;
        const device = this._device;
        const since = maps.get(device.did)?.since ?? 0;
        const told = async found => {
            if (!found)
                return null;
            if (values.has(found.key))
                return values.get(found.key);
            if (typeof device.source.lastTold !== 'function')
                return null;
            const last = await device.source.lastTold(device, found.service.siid, found.prop.piid);
            return last && last.time >= since - 120 ? last.value : null;
        };
        let minutes = null, size = null;
        try {
            [minutes, size] = await Promise.all([told(this._parts.runTime), told(this._parts.runArea)]);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook-app: this clean: ${e.message}`);
        }
        if (this._gone || token !== this._runToken)
            return;
        const stats = [];
        if (minutes !== null && minutes !== '' && Number.isFinite(Number(minutes)))
            stats.push({title: _('Cleaning for'), glyph: 'clock', text: spanText(Number(minutes) * 60)});
        if (size !== null && size !== '' && Number.isFinite(Number(size)))
            stats.push({title: _('Cleaned'), glyph: 'vacuum', text: `${numberFormat.format(Number(size))} m²`});
        const shape = JSON.stringify(stats);
        if (shape !== this._runShown) {
            this._runShown = shape;
            this._run.child = stats.length > 0 ? statChips(stats) : null;
        }
        this._run.visible = stats.length > 0;
    }

    async _pickSuction(value) {
        this._suctionTouched = Date.now();
        this._markSuction(value);
        if (!await this._writeProperty(this._parts.suction, value) && !this._gone) {
            this._suctionTouched = 0;
            this._markSuction(this._suctionValue);
        }
    }

    async _pickQuiet(on) {
        const quiet = this._settings.quiet;
        quiet.touched = Date.now();
        if (!await this._writeProperty(quiet, on) && !this._gone) {
            quiet.touched = 0;
            quiet.quiet = true;
            quiet.row.active = !on;
            quiet.quiet = false;
        }
    }

    _markSuction(value) {
        for (const {value: own, segment} of this._segments)
            setClass(segment, 'on', own === value);
    }

    _writeProperty({service, prop}, value) {
        return this._write(() => this._device.source.setProperty(this._device, service.siid, prop.piid, value));
    }

    async _write(task) {
        try {
            await task();
        } catch (e) {
            if (!this._gone)
                this._ctx.toast(e.message);
            return false;
        }
        if (!this._gone)
            this._ctx.written();
        return true;
    }

    _add(group, child) {
        group.add(child);
        this._added.push([group, child]);
    }
}
