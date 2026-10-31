// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Scenes from '../lib/scenes.js';
import {WHITE} from '../lib/color.js';
import {ColorWheel, paintOf, rgbOf, swatchRow} from './color.js';
import {sensorKind, whenText} from './events.js';
import {ALARM, freeze, heroOf, wordLabel} from './hero.js';
import {NUMBER_FORMATS, humanize} from './humanize.js';
import {WrapLayout} from './layouts.js';
import {IN_HERO, MAIN_RANGES, PLUMBING, PROP_GLYPHS, RISKY_ACTION, SERVICE_GLYPHS, actionIcon, choiceGlyph, historyKeys, specTitle, worthShowing} from './props.js';
import {batteryShare, beaconOf, fillStats, isBluetooth, kettleStatus, spanText, statFlow, stateText} from './rows.js';
import {CHIP_SPACING, SHELL_MAJOR, VERTICAL, choiceText, deviceType, formatValue, numberFormat, readSetting} from './text.js';
import {CardSlider, Scene, SceneButton, breathe, skeletonBlock, skeletonLines} from './widgets.js';

function beaconRows(beacon) {
    const rows = [];
    if (!beacon)
        return rows;
    const kettle = beacon.status !== undefined;
    if (beacon.temperature !== undefined) {
        rows.push({key: 'temperature', title: kettle ? _('Water') : _('Temperature'), glyph: 'thermometer',
            text: `${numberFormat.format(beacon.temperature)} °C`});
    }
    if (kettle && kettleStatus(beacon.status))
        rows.push({key: 'status', title: _('Status'), glyph: 'kettle', text: kettleStatus(beacon.status)});
    if (beacon.humidity !== undefined)
        rows.push({key: 'humidity', title: _('Humidity'), glyph: 'drop', text: `${numberFormat.format(beacon.humidity)} %`});
    if (beacon.battery !== undefined)
        rows.push({key: 'battery', title: _('Battery'), glyph: 'bolt', text: `${beacon.battery} %`});
    if (beacon.rssi !== undefined)
        rows.push({key: 'signal', title: _('Signal'), glyph: 'wifi', text: `${beacon.rssi} ${pgettext('unit', 'dBm')}`});
    if (beacon.time)
        rows.push({key: 'heard', title: _('Heard'), glyph: 'clock', text: whenText(beacon.time)});
    return rows;
}

// miIO.info of spec-less devices (range extenders). Never show the token it also carries.
function infoRows(info) {
    const rows = [];
    if (info?.ap?.ssid)
        rows.push({key: 'network', title: _('Network'), glyph: 'wifi', text: info.ap.ssid});
    if (info?.ap?.rssi !== undefined)
        rows.push({key: 'signal', title: _('Signal'), glyph: 'wifi', text: `${info.ap.rssi} ${pgettext('unit', 'dBm')}`});
    if (info?.sta?.count !== undefined)
        rows.push({key: 'devices', title: _('Devices connected'), glyph: 'hub', text: String(info.sta.count)});
    if (info?.netif?.localIp)
        rows.push({key: 'address', title: _('Address'), glyph: 'home', text: info.netif.localIp});
    if (info?.fw_ver)
        rows.push({key: 'firmware', title: _('Firmware'), glyph: 'appliance', text: info.fw_ver});
    if (info?.life > 0)
        rows.push({key: 'uptime', title: _('Up for'), glyph: 'clock', text: spanText(info.life)});
    return rows;
}

function macText(mac) {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '');
    return hex.length === 12 ? hex.toUpperCase().match(/../g).join(':') : String(mac).toUpperCase();
}

function aboutRows(device, nameOf) {
    const about = device.about ?? {};
    const rows = [];
    if (about.parent)
        rows.push({key: 'gateway', title: _('Gateway'), glyph: 'hub', text: nameOf(about.parent)});
    if (about.ssid)
        rows.push({key: 'network', title: _('Network'), glyph: 'wifi', text: about.ssid});
    if (about.rssi)
        rows.push({key: 'signal', title: _('Signal'), glyph: 'wifi', text: `${about.rssi} ${pgettext('unit', 'dBm')}`});
    if (about.ip)
        rows.push({key: 'address', title: _('Address'), glyph: 'home', text: about.ip});
    if (about.mac) {
        const title = isBluetooth(device) ? _('Bluetooth address') : _('MAC address');
        rows.push({key: 'mac', title, glyph: isBluetooth(device) ? 'dot' : 'wifi', text: macText(about.mac)});
    }
    if (about.firmware)
        rows.push({key: 'firmware', title: _('Firmware'), glyph: 'appliance', text: about.firmware});
    if (about.mcu)
        rows.push({key: 'mcu', title: _('MCU firmware'), glyph: 'appliance', text: about.mcu});
    if (about.hardware)
        rows.push({key: 'hardware', title: _('Hardware'), glyph: 'appliance', text: about.hardware});
    if (about.uptime > 0)
        rows.push({key: 'uptime', title: _('Up for'), glyph: 'clock', text: spanText(about.uptime)});
    const model = 'model' in about ? about.model : device.model;
    if (model)
        rows.push({key: 'model', title: _('Model'), glyph: 'appliance', text: model});
    if (device.online === false && about.lastOnline)
        rows.push({key: 'last-online', title: _('Last online'), glyph: 'clock', text: whenText(about.lastOnline)});
    return rows;
}

const HERO_STATES = ['contact-state', 'motion-state', 'occupancy-status', 'submersion-state', 'smoke-status', 'gas-status'];

const SAID_LIVE = {
    status: ['contact-state', 'submersion-state', 'motion-state'],
    temperature: ['temperature'],
    humidity: ['relative-humidity'],
    pressure: ['atmospheric-pressure'],
    lux: ['illumination'],
    voltage: ['battery-level', 'voltage'],
};

function liveRows(data) {
    const rows = [];
    const scaled = (value, divisor) => numberFormat.format(Number(value) / divisor);
    if (data.alarm !== undefined) {
        const alarm = String(data.alarm);
        rows.push({key: 'alarm', title: _('Alarm'), glyph: 'bell',
            text: alarm === '0' ? _('None') : (alarm === '1' || alarm === '2') ? _('Alarm!') : _('Fault')});
    }
    if (data.density !== undefined)
        rows.push({key: 'density', title: _('Density'), glyph: 'smoke', text: String(data.density)});
    if (data.temperature !== undefined)
        rows.push({key: 'temperature', title: _('Temperature'), glyph: 'thermometer', text: `${scaled(data.temperature, 100)} °C`});
    if (data.humidity !== undefined)
        rows.push({key: 'humidity', title: _('Humidity'), glyph: 'drop', text: `${scaled(data.humidity, 100)} %`});
    if (data.pressure !== undefined)
        rows.push({key: 'pressure', title: _('Pressure'), glyph: 'wind', text: `${scaled(data.pressure, 100)} hPa`});
    if (data.lux !== undefined)
        rows.push({key: 'light', title: _('Light'), glyph: 'sun', text: `${data.lux} ${pgettext('unit', 'lx')}`});
    if (data.voltage !== undefined) {
        rows.push({key: 'battery', title: _('Battery'), glyph: 'bolt',
            text: `${batteryShare(data.voltage)} % · ${scaled(data.voltage, 1000)} ${pgettext('unit', 'V')}`});
    }
    return rows;
}

// A gateway's or socket's built-in light gets its own tile; it isn't the device's switch.
function ownSwitch(device) {
    const [prop] = device.primary.props;
    return device.primary.kind === 'switch' && !(prop.service === 'light' && deviceType(device) !== 'light');
}

// The colour wheel's light has a switch of its own when it isn't the device's (a socket's ring).
function lightSwitch(device, {service, on}) {
    const [primary] = device.primary.kind === 'switch' ? device.primary.props : [];
    return on && !(primary?.siid === service.siid && primary?.piid === on.piid) ? on : null;
}

const SLIDER_SETTLE = 700;

export class SpecCard {
    _fillCard(device, services, values, eventKeys = []) {
        const home = device.source;
        this._clear();
        this._addHero(device, services, values);
        const h = this._hero;
        // Keys already shown by the kind's own controls or the hero power button.
        const covered = new Set();
        if (h.power || (h.wheel && !lightSwitch(device, h.paint) && device.primary.kind === 'switch')) {
            const [prop] = device.primary.props;
            covered.add(`${prop.siid}/${prop.piid}`);
        }
        if (h.wheel)
            this._addColorControls(device, h, values, covered);
        // Vacuum, fryer and gateway controls call Mi Home itself (maps, histories).
        const mi = home === this._home;
        if (mi && deviceType(device) === 'vacuum' && !device.unreadable)
            this._addVacuumControls(device, services, values, covered);
        else if (deviceType(device) === 'fan' && !device.unreadable)
            this._addFanControls(device, services, values, covered);
        else if (mi && deviceType(device) === 'air-fryer' && !device.unreadable)
            this._addFryerControls(device, services, values, covered);
        else if (mi && deviceType(device) === 'gateway' && !device.unreadable)
            this._addGatewayControls(device, services, values, covered);

        let live = [];
        if (device.live) {
            live = liveRows(device.live);
            for (const [field, names] of Object.entries(SAID_LIVE)) {
                if (device.live[field] === undefined)
                    continue;
                for (const service of services) {
                    for (const prop of service.properties.filter(p => names.includes(p.name)))
                        covered.add(`${service.siid}/${prop.piid}`);
                }
            }
        }
        else if (device.info)
            live = infoRows(device.info);
        live = live.filter(row => !h.said.includes(row.key));
        for (const service of services) {
            for (const prop of service.properties.filter(p => HERO_STATES.includes(p.name)))
                covered.add(`${service.siid}/${prop.piid}`);
        }
        if (isBluetooth(device)) {
            this._heardSection = statFlow();
            this._stageAdd(this._heardSection, true);
            this._syncHeard(device);
        }
        this._addSpecTiles(device, device.unreadable ? [] : services, values, covered, live);

        if (device.online === false)
            freeze(h.controls);
        this._layHero(!h.controlled);
        this._syncControls();
        if (!h.controls.visible && device.online === false && !isBluetooth(device) && !device.unreadable &&
            services.length > 0) {
            const label = new St.Label({style_class: 'nook-message', text: _('Its settings show once it is back online.')});
            label.clutter_text.line_wrap = true;
            this._body.add_child(label);
        }
        const later = {};
        if (historyKeys(device).length > 0) {
            this._body.add_child(new St.Label({style_class: 'nook-room', text: _('Last 24 Hours')}));
            later.charts = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
            later.charts.add_child(skeletonBlock('nook-chart'));
            this._body.add_child(later.charts);
        }
        if (eventKeys.length > 0) {
            this._body.add_child(new St.Label({style_class: 'nook-room', text: _('History')}));
            later.log = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
            later.log.add_child(skeletonLines());
            this._body.add_child(later.log);
        }
        later.token = this._cardToken = {};
        if (later.charts || later.log)
            this._fillHistory(home, device, eventKeys, later).catch(logError);

        const kind = device.did.startsWith('lumi.') ? sensorKind(device.model) : null;
        if (kind)
            this._addAlertsRow(device, kind);

        this._addDeviceInfo(device, new Set([...live.map(row => row.key), ...h.said]));

        if (this._body.get_n_children() === 0)
            this._message(device.online ? _('Online, with nothing more to show.') : _('Offline.'));
    }

    _addDeviceInfo(device, shown = new Set()) {
        const names = readSetting(this._settings, 'names');
        const nameOf = did => names[did] || this._home?.devices.find(d => d.did === did)?.name || did;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const arrow = new St.Icon({style_class: 'nook-fold-arrow', icon_size: 12, y_align: Clutter.ActorAlign.CENTER});
        const line = new St.BoxLayout({style_class: 'nook-fold-line'});
        line.add_child(new St.Label({text: _('Device Info'), y_align: Clutter.ActorAlign.CENTER}));
        line.add_child(arrow);
        const heading = new St.Button({
            style_class: 'nook-room nook-fold',
            accessible_name: _('Device Info'),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            child: line,
        });
        const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
        const flow = statFlow();
        section.add_child(flow);
        this._body.add_child(heading);
        this._body.add_child(section);
        let rows = [];
        const show = () => {
            const open = this._infoOpen.has(device.did);
            arrow.icon_name = open ? 'pan-down-symbolic' : `pan-${rtl ? 'start' : 'end'}-symbolic`;
            heading.visible = rows.length > 0;
            section.visible = open && rows.length > 0;
        };
        heading.connect('clicked', () => {
            if (this._infoOpen.delete(device.did)) {
                show();
                return;
            }
            this._infoOpen.add(device.did);
            show();
            this._scrollToEnd();
        });
        const fill = () => {
            rows = aboutRows(device, nameOf).filter(row => !shown.has(row.key));
            fillStats(flow, rows);
            show();
        };
        fill();
        return fill;
    }

    _addSpecTiles(device, services, values, covered, lead = []) {
        const home = device.source;
        const type = deviceType(device);
        // BLE devices take commands only from a phone or gateway in range, not the cloud.
        const bluetooth = isBluetooth(device);
        const said = this._hero?.said ?? [];
        const [own] = device.primary.kind === 'switch' ? device.primary.props : [];
        let main = null;
        const tiles = [];
        const stats = [...lead];
        const actions = [];
        for (const service of services.filter(s => !PLUMBING.includes(s.name))) {
            for (const prop of service.properties) {
                const key = `${service.siid}/${prop.piid}`;
                const value = values.get(key);
                if (covered.has(key) || !worthShowing(prop, value, values.has(key)))
                    continue;
                const title = specTitle(service, prop, type);
                const glyph = PROP_GLYPHS[prop.name] ?? SERVICE_GLYPHS[service.name] ?? 'dot';
                const writable = prop.access.includes('write') && !bluetooth;
                const write = v => this._cardWrite(device, () => home.setProperty(device, service.siid, prop.piid, v))
                    .catch(logError);
                const [min, max] = prop.range ?? [];
                if (writable && prop.format === 'bool') {
                    const mine = own?.siid === service.siid && own?.piid === prop.piid;
                    tiles.push({
                        rank: 1,
                        title,
                        glyph,
                        on: value === true,
                        text: value === true ? _('On') : _('Off'),
                        // Extra tiles come only from Mi Home.
                        extra: mine || home !== this._home ? null : `${device.did}/${service.siid}/${prop.piid}/${prop.name}`,
                        pick: write,
                    });
                } else if (writable && prop.choices?.length > 0) {
                    const glyphs = prop.choices.map(c => choiceGlyph(c.description, null));
                    const pictured = glyphs.every(Boolean);
                    const choices = prop.choices.map((c, i) => [c.value, choiceText(c.description), pictured ? glyphs[i] : null]);
                    const current = choices.find(([v]) => v === value);
                    tiles.push({
                        rank: 0,
                        title,
                        glyph: current?.[2] ?? glyph,
                        value,
                        text: current?.[1] ?? '–',
                        choices,
                        pick: write,
                    });
                } else if (writable && NUMBER_FORMATS.includes(prop.format) && max > min) {
                    if (!main && service.name === type && MAIN_RANGES.includes(prop.name))
                        main = {title, prop, value, write};
                    else
                        tiles.push({rank: 2, title, glyph, text: formatValue(prop, value), range: {prop, value, write}});
                } else if (prop.access.includes('read') && !said.includes(prop.name)) {
                    stats.push({title, glyph, text: formatValue(prop, value) || '–'});
                }
            }
            const switched = service.properties.some(p => p.name === 'on' && p.access.includes('write'));
            for (const action of bluetooth ? [] : service.actions ?? []) {
                if (action.in.length === 0 && !RISKY_ACTION.test(action.name) &&
                    !covered.has(`${service.siid}/a${action.aiid}`) && !(action.name === 'toggle' && switched))
                    actions.push({service, action});
            }
        }

        if (main)
            this._stageAdd(this._sliderRow(main.title, main.prop, main.value, main.write, true));
        if (tiles.length > 0) {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-tiles'});
            this._addTileGrid(box, tiles.sort((a, b) => a.rank - b.rank));
            this._stageAdd(box);
        }
        const perRow = Math.ceil(actions.length / Math.ceil(actions.length / 4));
        let row = null;
        actions.forEach(({service, action}, i) => {
            if (i % perRow === 0) {
                row = new St.BoxLayout({style_class: 'nook-vacuum-actions', x_expand: true});
                row.layout_manager.homogeneous = true;
                this._stageAdd(row);
            }
            const label = humanize(action.name);
            const item = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-action'});
            const button = this._addRoundButton(item, actionIcon(action.name), label, () => {
                this._cardWrite(device, () => home.runAction(device, service.siid, action.aiid)).catch(logError);
            });
            button.x_align = Clutter.ActorAlign.CENTER;
            item.add_child(wordLabel(label));
            row.add_child(item);
        });
        for (let i = actions.length % perRow; i > 0 && i < perRow; i++)
            row.add_child(new St.Widget({x_expand: true}));
        if (stats.length > 0) {
            const box = statFlow();
            fillStats(box, stats);
            this._stageAdd(box, true);
        }
    }

    _addHero(device, services, values) {
        const h = {services, values, said: []};
        h.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-climate nook-stage'});

        const top = new St.BoxLayout({style_class: 'nook-climate-top'});
        h.dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        h.dot.connect('notify::mapped', () => breathe(h.dot, h.listening));
        top.add_child(h.dot);
        h.status = new St.Label({style_class: 'nook-climate-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        h.status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        top.add_child(h.status);
        const toggle = () => {
            const on = device.values?.[0] === true;
            this._cardWrite(device, () => device.source.setSwitch(device, !on)).catch(logError);
        };
        h.paint = isBluetooth(device) ? null : paintOf(services);
        if (ownSwitch(device) && !h.paint) {
            h.power = this._addRoundButton(top, 'system-shutdown-symbolic', _('Power'), toggle);
            h.power.add_style_class_name('nook-power');
        }
        h.box.add_child(top);

        h.middle = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-middle'});
        h.scene = h.paint ? null : new Scene('glyph', 'nook-stage-scene');
        if (h.paint) {
            const switched = lightSwitch(device, h.paint) || device.primary.kind === 'switch';
            h.wheel = new ColorWheel(value => this._paintWrite(device, h, value),
                switched ? () => this._cardWrite(device, () => this._paintSwitch(device, h, !this._lit(device, h))).catch(logError)
                    : null);
            h.middle.add_child(h.wheel);
        } else if (h.power) {
            h.middle.add_child(this._powerScene(h.scene, h.power));
        } else if (device.primary.kind === 'switch') {
            // A light that isn't the device's power, as on a gateway: no power button, but
            // the picture draws it, so pressing the picture toggles it.
            h.tap = new SceneButton({child: h.scene, can_focus: false});
            h.tap.connect('clicked', toggle);
            h.middle.add_child(h.tap);
        } else {
            h.middle.add_child(h.scene);
        }
        h.words = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-words'});
        h.wait = skeletonLines(['mid', 'name']);
        h.wait.x_align = Clutter.ActorAlign.CENTER;
        h.words.add_child(h.wait);
        h.big = new St.Label({style_class: 'nook-stage-big', x_align: Clutter.ActorAlign.CENTER});
        h.small = new St.Label({style_class: 'nook-hero-small', x_align: Clutter.ActorAlign.CENTER});
        for (const label of [h.big, h.small]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            h.words.add_child(label);
        }
        h.middle.add_child(h.words);
        h.box.add_child(h.middle);

        h.controls = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-controls'});
        h.box.add_child(h.controls);
        h.facts = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-facts'});
        this._body.add_child(h.box);
        this._hero = h;
        this._syncHero(device);
    }

    _stageAdd(actor, reading = false) {
        const h = this._hero;
        if (!h) {
            (this._stageTarget ?? this._body).add_child(actor);
        } else if (reading) {
            h.facts.add_child(actor);
        } else {
            h.controlled = true;
            h.controls.add_child(actor);
        }
    }

    _layHero(beside) {
        const h = this._hero;
        if (!h)
            return;
        if (!beside || h.wheel || !(h.big.visible || h.small.visible || h.wait.visible)) {
            h.controls.add_child(h.facts);
            return;
        }
        if (SHELL_MAJOR >= 48)
            h.middle.orientation = Clutter.Orientation.HORIZONTAL;
        else
            h.middle.vertical = false;
        h.box.add_style_class_name('nook-stage-beside');
        h.scene.y_align = Clutter.ActorAlign.CENTER;
        h.words.x_expand = true;
        h.words.y_align = Clutter.ActorAlign.CENTER;
        for (const label of [h.big, h.small, h.wait])
            label.x_align = Clutter.ActorAlign.START;
        h.words.add_child(h.facts);
    }

    _syncHero(device) {
        const h = this._hero;
        if (!h || !device || this._card?.did !== device.did)
            return;
        const hero = heroOf(this._card, h.services, h.values);
        h.said = IN_HERO[hero.scene] ?? [];
        const offline = this._card.online === false && !isBluetooth(this._card);
        h.big.text = hero.big ?? '';
        h.big.visible = Boolean(hero.big);
        h.big.style_class = /^[-−\d]/.test(h.big.text) ? 'nook-stage-big' : 'nook-stage-word';
        h.small.text = hero.small ?? '';
        h.small.visible = Boolean(hero.small);

        let status;
        let listening = false;
        h.wait.visible = false;
        if (isBluetooth(this._card)) {
            const time = beaconOf(this._card)?.time;
            if (time)
                status = _('Heard %s').replace('%s', whenText(time));
            else
                status = this._beacons?.off ? _('Bluetooth is off, so it cannot be heard.') : _('Listening for it nearby…');
            listening = this._awaits(this._card);
        } else {
            status = offline ? _('Offline') : _('Online');
        }
        h.status.text = status;
        if (h.big.text === status)
            h.big.visible = false;
        // Nothing heard yet: the big word is only "Bluetooth", so show bars instead.
        if (listening && h.big.text === stateText(this._card) && !h.small.visible) {
            h.big.visible = false;
            h.wait.visible = true;
        }
        h.dot.remove_style_class_name('nook-listening');
        if (listening)
            h.dot.add_style_class_name('nook-listening');
        if (h.listening !== listening) {
            h.listening = listening;
            breathe(h.dot, listening);
        }
        if (offline || listening || (isBluetooth(this._card) && !beaconOf(this._card)?.time))
            h.dot.remove_style_pseudo_class('checked');
        else
            h.dot.add_style_pseudo_class('checked');
        if (h.power) {
            const on = this._card.values?.[0] === true;
            h.power.checked = on;
            h.power.accessible_name = on ? _('Turn Off') : _('Turn On');
            h.power.reactive = !offline;
        }
        if (h.tap)
            h.tap.reactive = !offline;

        let color = hero.alarm ? ALARM : Scenes.tint(hero.scene, hero.state) ?? hero.color;
        if (offline)
            color = [0.42, 0.42, 0.46];
        const shade = share => color.map(v => Math.round(v * 255 * share));
        h.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(0.5)}); background-gradient-end: rgb(${shade(0.24)});`;

        if (h.wheel) {
            const {service, color} = h.paint;
            h.wheel.show(h.values.get(`${service.siid}/${color.piid}`), this._lit(device, h), !offline);
            return;
        }
        h.scene.setScene(hero.scene, hero.state);
        h.scene.run(Scenes.moves(hero.scene, hero.state) && this._menu.isOpen);
    }

    _lit(device, h) {
        const own = lightSwitch(device, h.paint);
        if (own)
            return h.values.get(`${h.paint.service.siid}/${own.piid}`) === true;
        return device.values?.[0] === true;
    }

    _paintSwitch(device, h, on) {
        const own = lightSwitch(device, h.paint);
        if (own)
            return device.source.setProperty(device, h.paint.service.siid, own.piid, on);
        return device.source.setSwitch(device, on);
    }

    // A picked colour turns the light on too, as in Mi Home. On first: some bridges (Hue)
    // don't take a colour while the light is off.
    _paintWrite(device, h, value) {
        const {service, color, temperature} = h.paint;
        const home = device.source;
        // Mi Home lights have no white sentinel; their white is a colour temperature.
        const kelvin = value === WHITE && !color.choices?.length && temperature
            ? Math.min(temperature.range[1], Math.max(temperature.range[0], 4000)) : null;
        this._cardWrite(device, async () => {
            if (!this._lit(device, h))
                await this._paintSwitch(device, h, true);
            if (kelvin)
                await home.setProperty(device, service.siid, temperature.piid, kelvin);
            else
                await home.setProperty(device, service.siid, color.piid, value);
        }).catch(logError);
    }

    _addColorControls(device, h, values, covered) {
        const {service, color, brightness, temperature} = h.paint;
        const home = device.source;
        const key = prop => `${service.siid}/${prop.piid}`;
        covered.add(key(color));
        const own = lightSwitch(device, h.paint);
        if (own)
            covered.add(key(own));
        const value = values.get(key(color));
        this._stageAdd(swatchRow(value, preset => this._paintWrite(device, h, preset)));
        const kelvin = temperature ? values.get(key(temperature)) : null;
        let tint = [1, 0.84, 0.55];
        if (typeof kelvin === 'number' && kelvin > 0)
            tint = Scenes.kelvinColor(kelvin);
        else if (typeof value === 'number' && value > 0 && value !== WHITE)
            tint = rgbOf(value);
        for (const [prop, paint] of [[brightness, () => [tint]], [temperature, () => temperature.range.slice(0, 2).map(Scenes.kelvinColor)]]) {
            if (!prop || !values.has(key(prop)))
                continue;
            covered.add(key(prop));
            const write = v => this._cardWrite(device, () => home.setProperty(device, service.siid, prop.piid, v)).catch(logError);
            this._stageAdd(this._sliderRow(specTitle(service, prop, deviceType(device)), prop, values.get(key(prop)), write,
                true, null, paint()));
        }
    }

    _syncControls() {
        const h = this._hero;
        if (!h)
            return;
        h.facts.visible = h.facts.get_children().some(child => child.visible);
        h.controls.visible = h.controls.get_children().some(child => child.visible);
    }

    _syncHeard(device) {
        this._syncHero(device);
        const box = this._heardSection;
        if (!box || !device || this._card?.did !== device.did)
            return;
        const said = this._hero?.said ?? [];
        const stats = beaconRows(beaconOf(device)).filter(row => row.key !== 'heard' && !said.includes(row.key));
        const text = JSON.stringify(stats);
        if (text === this._heardShown)
            return;
        this._heardShown = text;
        fillStats(box, stats);
        box.visible = stats.length > 0;
        this._syncControls();
    }

    _propertyRow(home, device, service, prop, value, name = humanize(prop.name)) {
        const writable = prop.access.includes('write') && device.online && !isBluetooth(device);
        const label = new St.Label({
            style_class: 'nook-card-label',
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const write = v => this._cardWrite(device, () => home.setProperty(device, service.siid, prop.piid, v))
            .catch(logError);

        if (writable && prop.format === 'bool') {
            const row = new St.BoxLayout({style_class: 'nook-card-row'});
            // PopupMenu.Switch handles its own clicks and drags, which never reach the
            // button around it; made non-reactive so the button does the toggling.
            const toggle = new PopupMenu.Switch(value === true);
            toggle.reactive = false;
            const button = new St.Button({child: toggle, can_focus: true, accessible_name: label.text});
            button.connect('clicked', () => write(!toggle.state));
            row.add_child(label);

            const primary = device.primary.kind === 'switch' &&
                device.primary.props[0].siid === service.siid && device.primary.props[0].piid === prop.piid;
            if (!primary) {
                const entry = `${device.did}/${service.siid}/${prop.piid}/${prop.name}`;
                const tiled = readSetting(this._settings, 'extra-tiles').includes(entry);
                const pin = new St.Button({
                    style_class: 'nook-more',
                    accessible_name: tiled ? _('Remove Its Tile') : _('Give It a Tile'),
                    can_focus: true,
                    checked: tiled,
                    y_align: Clutter.ActorAlign.CENTER,
                    child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 16}),
                });
                pin.connect('clicked', () => {
                    this._toggleIn('extra-tiles', entry);
                    pin.checked = !pin.checked;
                });
                row.add_child(pin);
            }
            row.add_child(button);
            return row;
        }

        if (writable && prop.choices?.length > 0) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const row = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-row'});
            const chips = new St.Widget({layout_manager: new WrapLayout(CHIP_SPACING * scale), x_expand: true});
            for (const choice of prop.choices) {
                const chip = new St.Button({
                    style_class: 'nook-chip',
                    label: choiceText(choice.description),
                    can_focus: true,
                    checked: choice.value === value,
                });
                chip.connect('clicked', () => write(choice.value));
                chips.add_child(chip);
            }
            row.add_child(label);
            row.add_child(chips);
            return row;
        }

        const [min, max] = prop.range ?? [];
        if (writable && NUMBER_FORMATS.includes(prop.format) && max > min)
            return this._sliderRow(name, prop, value, write);

        if (!prop.access.includes('read'))
            return null;
        const row = new St.BoxLayout({style_class: 'nook-card-row'});
        row.add_child(label);
        row.add_child(new St.Label({
            style_class: 'nook-card-value',
            text: value === undefined ? '–' : formatValue(prop, value) || '–',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return row;
    }

    _sliderRow(title, prop, value, write, steps = false, lead = null, paint = null) {
        const [min, max, step] = prop.range;
        const row = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-row'});
        const top = new St.BoxLayout();
        top.add_child(new St.Label({
            style_class: 'nook-card-label',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const shown = new St.Label({style_class: 'nook-card-value', text: formatValue(prop, value)});
        top.add_child(shown);
        row.add_child(top);
        const slider = new CardSlider(typeof value === 'number' ? (value - min) / (max - min) : 0);
        slider.x_expand = true;
        if (paint)
            slider.setPaint(paint);
        const pick = () => {
            const raw = min + slider.value * (max - min);
            return Math.min(max, Math.max(min, min + Math.round((raw - min) / (step || 1)) * (step || 1)));
        };
        let timer = 0;
        let dragging = false;
        const settle = () => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
        };
        slider.connect('drag-begin', () => {
            dragging = true;
            settle();
        });
        slider.connect('drag-end', () => {
            dragging = false;
            settle();
            write(pick());
        });
        slider.connect('notify::value', () => {
            shown.text = formatValue(prop, pick());
            if (dragging)
                return;
            settle();
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_SETTLE, () => {
                timer = 0;
                write(pick());
                return GLib.SOURCE_REMOVE;
            });
        });
        slider.connect('destroy', () => {
            if (timer) {
                settle();
                write(pick());
            }
        });
        if (!steps && !lead) {
            row.add_child(slider);
            return row;
        }
        if (!steps) {
            const line = new St.BoxLayout({style_class: 'nook-climate-range'});
            line.add_child(lead);
            line.add_child(slider);
            row.add_child(line);
            return row;
        }
        const unit = step || 1;
        const nudge = Math.max(unit, Math.round((max - min) / 20 / unit) * unit);
        const line = new St.BoxLayout({style_class: 'nook-climate-range'});
        const less = this._addRoundButton(line, 'list-remove-symbolic', _('Less'), () => {
            slider.value = Math.max(0, (pick() - nudge - min) / (max - min));
        });
        line.add_child(slider);
        const more = this._addRoundButton(line, 'list-add-symbolic', _('More'), () => {
            slider.value = Math.min(1, (pick() + nudge - min) / (max - min));
        });
        for (const button of [less, more])
            button.add_style_class_name('nook-step');
        row.add_child(line);
        return row;
    }
}
