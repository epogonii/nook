// SPDX-License-Identifier: GPL-2.0-or-later

import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _, pgettext} from 'gettext';

import {TileGrid, actionsRow, roundButton, sliderRow, statChips, stepperLine} from './card-parts.js';
import {VacuumCard} from './card-vacuum.js';
import {ColorWheel, paintOf, swatchRow} from './color.js';
import {choiceOf} from './hero.js';
import {NUMBER_FORMATS, humanize} from './humanize.js';
import {WHITE} from './lib/spec-home.js';
import {MAIN_RANGES, PLUMBING, PROP_GLYPHS, RISKY_ACTION, SERVICE_GLYPHS, actionIcon, choiceGlyph, specTitle, worthShowing} from './props.js';
import {choiceText, deviceType, formatValue, numberFormat, ownSwitch, specKey} from './text.js';
import {glyphArea} from './widgets.js';

// ms a value just written stays over what a read brings: the device may not report it yet.
const TOUCHED = 4000;

// Shown big in the hero, not as a reading.
const HERO_STATES = ['contact-state', 'motion-state', 'occupancy-status', 'submersion-state', 'smoke-status', 'gas-status'];

const isBluetooth = device => String(device.did).startsWith('blt.');

// Mi Home's own devices have a bare did; their robots, fryers and gateways have cards of their own.
const isMi = device => !device.did.includes(':');

// The colour wheel's light has a switch of its own when it isn't the device's (a socket's ring).
function lightSwitch(device, {service, on}) {
    const [primary] = device.primary.kind === 'switch' ? device.primary.props : [];
    return on && !(primary?.siid === service.siid && primary?.piid === on.piid) ? on : null;
}

// Wide toggle with the state in words: a lone tile in a line would stretch.
function stateStrip(title, glyph, onToggle) {
    const box = new Gtk.Box({spacing: 10});
    const bubble = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['nook-ac-bubble']});
    bubble.append(glyphArea(glyph, 16));
    box.append(bubble);
    const words = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER});
    words.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['nook-strip-title']}));
    const state = new Gtk.Label({xalign: 0, css_classes: ['nook-strip-state']});
    words.append(state);
    box.append(words);
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER, can_target: false, can_focus: false});
    box.append(toggle);
    const strip = new Gtk.Button({child: box, tooltip_text: title, css_classes: ['nook-strip']});
    const set = on => {
        toggle.active = on;
        state.label = on ? _('On') : _('Off');
        if (on)
            strip.add_css_class('on');
        else
            strip.remove_css_class('on');
    };
    strip.connect('clicked', () => onToggle(!toggle.active));
    return {widget: strip, feed: set};
}

// A plain switch with its title, for what a tile would make too easy to hit.
function switchLine(title, onToggle) {
    const line = new Gtk.Box({spacing: 6});
    line.append(new Gtk.Label({label: title, xalign: 0, hexpand: true, css_classes: ['nook-slider-title']}));
    const toggle = new Gtk.Switch({valign: Gtk.Align.CENTER});
    let quiet = false;
    toggle.connect('notify::active', () => {
        if (!quiet)
            onToggle(toggle.active);
    });
    line.append(toggle);
    const set = on => {
        quiet = true;
        toggle.active = on;
        quiet = false;
    };
    return {widget: line, feed: set};
}

const span = minutes => {
    if (minutes < 60)
        return _('%s min').replace('%s', minutes);
    const [hours, rest] = [Math.floor(minutes / 60), minutes % 60];
    return rest ? _('%s h %s min').replace('%s', hours).replace('%s', rest) : _('%s h').replace('%s', hours);
};

// What a Mi Home, Hue, Home Assistant, Shelly or eWeLink device takes and tells, from its
// spec: the colour wheel of lights, the main slider, tiles with drawers, actions and
// readings, all in the hero's stage; fans, gateways, air fryers and robots get their own.
export class SpecCard {
    constructor(ctx) {
        const {device, toast, written} = ctx;
        this._device = device;
        this._toast = toast;
        this._written = written;
        this._services = [];
        this._values = new Map();
        this._said = [];
        this._touched = new Map();
        this._parts = [];
        this._shape = null;
        this._paint = null;
        this.stage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14, visible: false, css_classes: ['nook-stage']});
        // A robot's own controls first, then whatever else its spec has.
        this._vacuum = isMi(device) && deviceType(device) === 'vacuum' ? new VacuumCard(ctx) : null;
        if (this._vacuum) {
            this._vacuum.stage.margin_top = 0;
            this.stage.append(this._vacuum.stage);
        }
        this._body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14});
        this.stage.append(this._body);
        this.groups = this._vacuum?.groups ?? [];
        this.covered = new Set();
        // The wheel, shown in place of the hero's picture, with the light's switch in it.
        this.picture = null;
        this.ownsPower = false;
    }

    forget() {
        this._gone = true;
        this._vacuum?.forget();
    }

    // said: what the hero already tells.
    sync(spec, said = []) {
        if (!spec || this._gone)
            return;
        this._services = spec.services;
        this._values = spec.values;
        this._said = said;
        const now = Date.now();
        for (const [key, {value, at}] of this._touched) {
            if (now - at > TOUCHED)
                this._touched.delete(key);
            else
                this._values.set(key, value);
        }
        const device = this._device;
        this._vacuum?.sync(spec);
        const covered = new Set(this._vacuum?.covered);
        const parts = [];
        if (this._paint === null && !isBluetooth(device))
            this._paint = paintOf(this._services) ?? false;
        if (this._paint) {
            this._colorParts(parts, covered);
        } else if (ownSwitch(device)) {
            const [prop] = device.primary.props;
            covered.add(`${prop.siid}/${prop.piid}`);
        }
        const type = deviceType(device);
        const mi = isMi(device);
        if (type === 'fan')
            this._fanParts(parts, covered);
        else if (mi && type === 'air-fryer')
            this._fryerParts(parts, covered);
        else if (mi && type === 'gateway')
            this._gatewayParts(parts, covered);
        this._specParts(parts, covered);
        this.covered = covered;

        const shape = JSON.stringify(parts.map(part => part.key));
        if (shape !== this._shape) {
            this._shape = shape;
            for (let child = this._body.get_first_child(); child; child = this._body.get_first_child())
                this._body.remove(child);
            this._parts = parts.map(part => {
                const made = part.make();
                this._body.append(made.widget);
                return made;
            });
        }
        parts.forEach((part, i) => this._parts[i].feed?.(part.data));
        this._body.visible = parts.length > 0;
        this.stage.visible = parts.length > 0 || Boolean(this._vacuum?.stage.visible);
        this.stage.sensitive = device.online !== false || isBluetooth(device);
    }

    _key(service, prop) {
        return `${service.siid}/${prop.piid}`;
    }

    _write(service, prop, value) {
        const device = this._device;
        const key = this._key(service, prop);
        const before = this._values.get(key);
        this._touched.set(key, {value, at: Date.now()});
        this._values.set(key, value);
        this._again();
        return device.source.setProperty(device, service.siid, prop.piid, value).then(() => this._written(), e => {
            this._touched.delete(key);
            if (this._values.get(key) === value)
                this._values.set(key, before);
            this._again();
            this._toast(e.message);
        });
    }

    _run(service, action) {
        const device = this._device;
        device.source.runAction(device, service.siid, action.aiid).then(() => this._written(), e => this._toast(e.message));
    }

    _again() {
        this.sync({services: this._services, values: this._values}, this._said);
    }

    _colorParts(parts, covered) {
        const device = this._device;
        const paint = this._paint;
        const {service, color, brightness, temperature} = paint;
        const values = this._values;
        const own = lightSwitch(device, paint);
        const key = prop => this._key(service, prop);
        covered.add(key(color));
        if (own)
            covered.add(key(own));
        else if (device.primary.kind === 'switch')
            covered.add(this._key(service, device.primary.props[0]));
        const lit = () => (own ? values.get(key(own)) === true : device.values?.[0] === true);
        const setLit = on => {
            if (own)
                return this._write(service, own, on);
            return device.source.setSwitch(device, on).then(() => this._written(), e => this._toast(e.message));
        };
        // A picked colour turns the light on too, as in Mi Home. On first: some bridges
        // (Hue) don't take a colour while the light is off.
        const pick = async value => {
            const kelvin = value === WHITE && !color.choices?.length && temperature
                ? Math.min(temperature.range[1], Math.max(temperature.range[0], 4000)) : null;
            if (!lit())
                await setLit(true);
            if (kelvin)
                await this._write(service, temperature, kelvin);
            else
                await this._write(service, color, value);
        };
        const switched = Boolean(own) || device.primary.kind === 'switch';
        if (!this.picture) {
            this.picture = new ColorWheel(value => pick(value).catch(logError),
                switched ? () => setLit(!lit()).catch(logError) : null);
            this.ownsPower = true;
        }
        const value = values.get(key(color));
        this.picture.show(value, lit(), device.online !== false);
        parts.push({
            key: 'swatches',
            data: value,
            make: () => {
                const box = new Gtk.Box({halign: Gtk.Align.CENTER});
                let shown;
                return {widget: box, feed: next => {
                    if (next === shown && box.get_first_child())
                        return;
                    shown = next;
                    box.get_first_child() && box.remove(box.get_first_child());
                    box.append(swatchRow(next, preset => pick(preset).catch(logError)));
                }};
            },
        });
        for (const prop of [brightness, temperature]) {
            if (!prop || !values.has(key(prop)))
                continue;
            covered.add(key(prop));
            parts.push(this._sliderPart(service, prop, specTitle(service, prop, deviceType(device))));
        }
    }

    _sliderPart(service, prop, title) {
        const key = this._key(service, prop);
        return {
            key: `slider ${key}`,
            data: this._values.get(key),
            make: () => {
                const slider = sliderRow(title, prop, this._values.get(key), v => this._write(service, prop, v).catch(logError), true);
                return {widget: slider.widget, feed: slider.update};
            },
        };
    }

    // Fans: speed, wind, swing, angle, timer and the head's turn.
    _fanParts(parts, covered) {
        const services = this._services;
        const values = this._values;
        const find = (names, test = () => true) => {
            for (const name of names) {
                for (const service of services) {
                    const prop = service.properties.find(p => p.name === name && p.access.includes('write') && test(p, service));
                    const key = prop ? this._key(service, prop) : null;
                    if (prop && values.has(key))
                        return {service, prop, key, value: values.get(key)};
                }
            }
            return null;
        };
        const write = (found, value) => this._write(found.service, found.prop, value).catch(logError);
        const tiles = [];
        const toggle = (found, title, glyph) => {
            if (!found || found.prop.format !== 'bool')
                return;
            covered.add(found.key);
            tiles.push({title, glyph, on: found.value === true, text: found.value === true ? _('On') : _('Off'), pick: on => write(found, on)});
        };
        const choose = (found, title, glyph, shape) => {
            if (!found?.prop.choices?.length)
                return;
            covered.add(found.key);
            const choices = found.prop.choices.map(c => [c.value, ...shape(c)]);
            tiles.push({
                title,
                glyph: choices.find(([v]) => v === found.value)?.[2] ?? glyph,
                value: found.value,
                text: choices.find(([v]) => v === found.value)?.[1] ?? '–',
                choices,
                pick: value => write(found, value),
            });
        };
        const power = find(['on'], (p, s) => s.name === 'fan');
        if (power && ownSwitch(this._device))
            covered.add(power.key);
        else
            toggle(power, _('Power'), 'power');
        choose(find(['fan-level', 'speed-level', 'fan-speed']), _('Speed'), 'fan',
            c => [/\d/.test(c.description) ? c.description.replace(/\D+/g, '') : choiceText(c.description), 'fan']);
        choose(find(['mode']), _('Wind'), 'wind', c => {
            const text = c.description;
            let glyph = 'wind';
            if (/natur|nature/i.test(text))
                glyph = 'leaf';
            else if (/sleep/i.test(text))
                glyph = 'moon';
            else if (/auto|smart/i.test(text))
                glyph = 'auto';
            const short = {'straight-wind': _('Straight'), 'natural-wind': _('Natural')}[specKey(text)];
            return [short ?? choiceText(text), glyph];
        });
        toggle(find(['horizontal-swing', 'swing']), _('Swing'), 'swing');
        choose(find(['horizontal-angle', 'swing-angle']), _('Angle'), 'angle', c => [`${c.description}°`, `angle${c.value}`]);
        const timer = find(['off-delay-time'], p => NUMBER_FORMATS.includes(p.format) && p.range);
        if (timer) {
            covered.add(timer.key);
            const hours = timer.prop.unit === 'hours';
            const max = timer.prop.range[1];
            const say = minutes => (minutes < 60
                ? _('%s min').replace('%s', minutes)
                : _('%s h').replace('%s', numberFormat.format(Math.round(minutes / 6) / 10)));
            const choices = [[0, _('Off'), 'clock']];
            for (const minutes of [30, 60, 120, 240, 480]) {
                const value = hours ? minutes / 60 : minutes;
                if (Number.isInteger(value) && value <= max)
                    choices.push([value, say(minutes), 'clock']);
            }
            tiles.push({
                title: _('Timer'),
                glyph: 'clock',
                value: timer.value,
                text: timer.value > 0 ? say(hours ? timer.value * 60 : timer.value) : _('Off'),
                choices,
                pick: value => write(timer, value),
            });
        }
        toggle(find(['on'], (p, s) => s.name === 'indicator-light'), _('Light'), 'bulb');
        toggle(find(['alarm'], (p, s) => s.name === 'alarm'), _('Sound'), 'bell');
        toggle(find(['physical-controls-locked']), _('Child Lock'), 'lock');
        if (tiles.length > 0)
            parts.push(this._gridPart('fan', tiles));

        for (const service of services) {
            const motor = service.properties.find(p => p.name === 'motor-control' && p.access.includes('write'));
            const left = motor?.choices?.find(c => /left/i.test(c.description));
            const right = motor?.choices?.find(c => /right/i.test(c.description));
            if (!left || !right)
                continue;
            covered.add(this._key(service, motor));
            parts.push({
                key: `turn ${service.siid}`,
                make: () => {
                    const line = new Gtk.Box({spacing: 10});
                    line.append(new Gtk.Label({label: _('Turn the Head'), xalign: 0, hexpand: true, css_classes: ['nook-slider-title']}));
                    for (const [icon, label, choice] of [['go-previous-symbolic', _('Left'), left], ['go-next-symbolic', _('Right'), right]])
                        line.append(roundButton(icon, label, () => this._write(service, motor, choice.value).catch(logError)));
                    return {widget: line};
                },
            });
        }
        for (const service of tiles.length > 0 ? services : []) {
            for (const action of service.actions ?? []) {
                if (['toggle', 'toggle-mode', 'loop-gear'].includes(action.name))
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
        }
    }

    _gridPart(name, tiles) {
        return {
            key: `grid ${name} ${tiles.map(t => t.title).join('|')}`,
            data: tiles,
            make: () => {
                const grid = new TileGrid();
                return {widget: grid, feed: next => grid.show(next)};
            },
        };
    }

    // Mi Home's gateways: their light and guard, the siren as a plain switch, the light around it.
    _gatewayParts(parts, covered) {
        const found = (serviceName, name) => {
            const service = this._services.find(s => s.name === serviceName);
            const prop = service?.properties.find(p => p.name === name);
            const key = prop ? this._key(service, prop) : null;
            return prop && this._values.has(key) ? {service, prop, key, value: this._values.get(key)} : null;
        };
        for (const [serviceName, name, title, glyph] of [
            ['light', 'on', _('Light'), 'bulb'],
            ['gateway', 'guard-mode', _('Guard'), 'shield'],
        ]) {
            const f = found(serviceName, name);
            if (f?.prop.format !== 'bool' || !f.prop.access.includes('write') || covered.has(f.key))
                continue;
            covered.add(f.key);
            parts.push({
                key: `strip ${f.key}`,
                data: f.value === true,
                make: () => stateStrip(title, glyph, on => this._write(f.service, f.prop, on).catch(logError)),
            });
        }
        const siren = found('alarm', 'alarm');
        if (siren?.prop.format === 'bool' && siren.prop.access.includes('write')) {
            covered.add(siren.key);
            parts.push({
                key: `switch ${siren.key}`,
                data: siren.value === true,
                make: () => switchLine(_('Siren'), on => this._write(siren.service, siren.prop, on).catch(logError)),
            });
        }
        const volume = found('alarm', 'volume');
        if (volume?.prop.range && volume.prop.access.includes('write')) {
            covered.add(volume.key);
            parts.push(this._sliderPart(volume.service, volume.prop, _('Siren Volume')));
        }
        const lux = found('motion-sensor', 'illumination');
        if (typeof lux?.value === 'number') {
            covered.add(lux.key);
            parts.push(this._statsPart('lux', [{title: _('Light Around It'), glyph: 'sun', text: formatValue(lux.prop, lux.value)}]));
        }
    }

    _statsPart(name, stats) {
        const text = JSON.stringify(stats);
        return {
            key: `stats ${name}`,
            data: text,
            make: () => {
                const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
                let shown = null;
                return {widget: box, feed: next => {
                    if (next === shown)
                        return;
                    shown = next;
                    box.get_first_child() && box.remove(box.get_first_child());
                    box.append(statChips(JSON.parse(next)));
                }};
            },
        };
    }

    _fryerParts(parts, covered) {
        const fryer = this._services.find(s => s.actions?.some(a => a.name === 'start-cook'));
        if (!fryer)
            return;
        const prop = name => fryer.properties.find(p => p.name === name);
        const keyOf = p => this._key(fryer, p);
        const value = name => (prop(name) ? this._values.get(keyOf(prop(name))) : undefined);
        const action = name => fryer.actions.find(a => a.name === name && a.in.length === 0);
        const write = (p, v) => this._write(fryer, p, v).catch(logError);
        for (const name of ['status', 'left-time', 'turn-pot', 'cooking-weight', 'target-cooking-measure', 'texture', 'current-keep-warm']) {
            if (prop(name))
                covered.add(keyOf(prop(name)));
        }
        const status = choiceOf(prop('status'), value('status')) ?? '';
        const running = /^\s*(cooking|preheat|keep warm|crispy roast|degrease)\s*$/i.test(status);
        const paused = /paused/i.test(status);
        const waiting = /delay/i.test(status);

        const left = value('left-time');
        const total = value('target-time');
        if ((running || paused) && typeof left === 'number') {
            const words = paused ? _('min left, paused') : _('min left');
            const share = typeof total === 'number' && total > 0 ? Math.min(1, Math.max(0, 1 - left / total)) : null;
            parts.push({
                key: 'fryer left',
                data: {left, words, share},
                make: () => {
                    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
                    const line = new Gtk.Box({spacing: 6, halign: Gtk.Align.CENTER});
                    const minutes = new Gtk.Label({css_classes: ['nook-fryer-minutes', 'numeric']});
                    const unit = new Gtk.Label({valign: Gtk.Align.BASELINE, css_classes: ['nook-fryer-unit']});
                    line.append(minutes);
                    line.append(unit);
                    box.append(line);
                    const bar = new Gtk.ProgressBar({css_classes: ['nook-fryer-bar']});
                    box.append(bar);
                    return {widget: box, feed: next => {
                        minutes.label = String(next.left);
                        unit.label = next.words;
                        bar.visible = next.share !== null;
                        bar.fraction = next.share ?? 0;
                    }};
                },
            });
        }
        // turn-pot stays 'need' after cooking ends; only meaningful while running.
        if ((running || paused) && /need/i.test(choiceOf(prop('turn-pot'), value('turn-pot')) ?? '')) {
            parts.push({
                key: 'fryer turn',
                make: () => ({widget: new Gtk.Label({label: _('Time to turn the food over.'), wrap: true, css_classes: ['nook-fryer-note']})}),
            });
        }
        const buttons = [];
        const add = (found, icon, label) => {
            if (found)
                buttons.push({icon, label, run: () => this._run(fryer, found)});
        };
        if (running)
            add(action('pause'), 'media-playback-pause-symbolic', _('Pause'));
        else if (paused)
            add(action('resume-cook'), 'media-playback-start-symbolic', _('Go On'));
        else if (!waiting)
            add(action('start-cook'), 'media-playback-start-symbolic', _('Start'));
        if (running || paused || waiting)
            add(action('cancel-cooking'), 'media-playback-stop-symbolic', _('Stop'));
        for (const name of ['pause', 'resume-cook', 'start-cook', 'cancel-cooking']) {
            if (action(name))
                covered.add(`${fryer.siid}/a${action(name).aiid}`);
        }
        if (buttons.length > 0)
            parts.push({key: `fryer buttons ${buttons.map(b => b.label).join('|')}`, make: () => ({widget: actionsRow(buttons)})});

        const tiles = [];
        const mode = prop('mode');
        if (mode?.choices?.length && this._values.has(keyOf(mode))) {
            covered.add(keyOf(mode));
            const choices = mode.choices.map(c => [c.value, choiceText(c.description), null]);
            tiles.push({
                title: _('Program'),
                glyph: 'pot',
                value: value('mode'),
                text: choices.find(([v]) => v === value('mode'))?.[1] ?? '–',
                choices,
                pick: v => write(mode, v),
            });
        }
        const stepped = (name, title, glyph, format, stepOf) => {
            const p = prop(name);
            const current = p ? this._values.get(keyOf(p)) : undefined;
            if (!p?.range || !p.access.includes('write') || typeof current !== 'number')
                return;
            covered.add(keyOf(p));
            tiles.push({
                title,
                glyph,
                text: format(current),
                fill: drawer => drawer.append(stepperLine(title, current, p.range, format, stepOf, v => write(p, v))),
            });
        };
        stepped('target-temperature', pgettext('fryer', 'Heat'), 'thermometer', v => `${v} °C`,
            () => prop('target-temperature').range[2] || 5);
        stepped('target-time', _('Time'), 'timer', span, (v, direction) => {
            const at = direction > 0 ? v : v - 1;
            if (at < 10)
                return 1;
            return at < 60 ? 5 : 10;
        });
        stepped('reservation-left-time', _('Start In'), 'clock', v => (v > 0 ? span(v) : _('Now')), () => 30);
        for (const [name, title, glyph] of [
            ['preheat', _('Preheat'), 'sun'],
            ['auto-keep-warm', _('Keep Warm'), 'pot'],
            ['turn-pot-config', _('Turn Over'), 'swing'],
        ]) {
            const p = prop(name);
            const current = p ? this._values.get(keyOf(p)) : undefined;
            if (p?.format !== 'bool' || !p.access.includes('write') || typeof current !== 'boolean')
                continue;
            covered.add(keyOf(p));
            tiles.push({title, glyph, on: current, text: current ? _('On') : _('Off'), pick: on => write(p, on)});
        }
        if (tiles.length > 0)
            parts.push(this._gridPart('fryer', tiles));
    }

    // Whatever the kind's own controls left: the main slider, tiles, actions, readings.
    _specParts(parts, covered) {
        const device = this._device;
        const type = deviceType(device);
        const bluetooth = isBluetooth(device);
        const said = this._said;
        let main = null;
        const tiles = [];
        const stats = [];
        const actions = [];
        for (const service of this._services.filter(s => !PLUMBING.includes(s.name))) {
            for (const prop of service.properties) {
                const key = this._key(service, prop);
                const value = this._values.get(key);
                if (covered.has(key) || HERO_STATES.includes(prop.name) || !worthShowing(prop, value, this._values.has(key)))
                    continue;
                const title = specTitle(service, prop, type);
                const glyph = PROP_GLYPHS[prop.name] ?? SERVICE_GLYPHS[service.name] ?? 'dot';
                const writable = prop.access.includes('write') && !bluetooth;
                const write = v => this._write(service, prop, v).catch(logError);
                const [min, max] = prop.range ?? [];
                if (writable && prop.format === 'bool') {
                    tiles.push({rank: 1, title, glyph, on: value === true, text: value === true ? _('On') : _('Off'), pick: write});
                } else if (writable && prop.choices?.length > 0) {
                    const glyphs = prop.choices.map(c => choiceGlyph(c.description, null));
                    const pictured = glyphs.every(Boolean);
                    const choices = prop.choices.map((c, i) => [c.value, choiceText(c.description), pictured ? glyphs[i] : null]);
                    const current = choices.find(([v]) => v === value);
                    tiles.push({rank: 0, title, glyph: current?.[2] ?? glyph, value, text: current?.[1] ?? '–', choices, pick: write});
                } else if (writable && NUMBER_FORMATS.includes(prop.format) && max > min) {
                    if (!main && service.name === type && MAIN_RANGES.includes(prop.name))
                        main = this._sliderPart(service, prop, title);
                    else
                        tiles.push({rank: 2, title, glyph, text: formatValue(prop, value), range: {prop, value, write}});
                } else if (prop.access.includes('read') && !said.includes(prop.name)) {
                    stats.push({title, glyph, text: formatValue(prop, value) || '–'});
                }
            }
            const switched = service.properties.some(p => p.name === 'on' && p.access.includes('write'));
            for (const action of bluetooth ? [] : service.actions ?? []) {
                if (action.in.length === 0 && !RISKY_ACTION.test(action.name) &&
                    !covered.has(`${service.siid}/a${action.aiid}`) && !(action.name === 'toggle' && switched)) {
                    const label = humanize(action.name);
                    actions.push({icon: actionIcon(action.name), label, run: () => this._run(service, action)});
                }
            }
        }
        if (main)
            parts.push(main);
        if (tiles.length > 0)
            parts.push(this._gridPart('spec', tiles.sort((a, b) => a.rank - b.rank)));
        if (actions.length > 0)
            parts.push({key: `actions ${actions.map(a => a.label).join('|')}`, make: () => ({widget: actionsRow(actions)})});
        if (stats.length > 0)
            parts.push(this._statsPart('spec', stats));
    }
}
