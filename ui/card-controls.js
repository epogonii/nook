// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Scenes from '../lib/scenes.js';
import {choiceOf, wordLabel} from './hero.js';
import {NUMBER_FORMATS} from './humanize.js';
import {fillStats, statFlow} from './rows.js';
import {VERTICAL, choiceText, formatValue, numberFormat, specKey} from './text.js';
import {Scene} from './widgets.js';

export class ControlsCard {
    _addFanControls(device, services, values, covered) {
        const home = device.source;
        const find = (names, test = () => true) => {
            for (const name of names) {
                for (const service of services) {
                    const prop = service.properties.find(p => p.name === name && p.access.includes('write') && test(p, service));
                    const key = prop ? `${service.siid}/${prop.piid}` : null;
                    if (prop && values.has(key))
                        return {service, prop, key, value: values.get(key)};
                }
            }
            return null;
        };
        const write = (found, value) => {
            this._cardWrite(device, () => home.setProperty(device, found.service.siid, found.prop.piid, value))
                .catch(logError);
        };
        const tiles = [];
        const toggle = (found, title, glyph) => {
            if (!found || found.prop.format !== 'bool')
                return;
            covered.add(found.key);
            tiles.push({
                title,
                glyph,
                on: found.value === true,
                text: found.value === true ? _('On') : _('Off'),
                pick: on => write(found, on),
            });
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
        if (power && this._hero?.power)
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
        choose(find(['horizontal-angle', 'swing-angle']), _('Angle'), 'angle',
            c => [`${c.description}°`, `angle${c.value}`]);

        const timer = find(['off-delay-time'], p => NUMBER_FORMATS.includes(p.format) && p.range);
        if (timer) {
            covered.add(timer.key);
            const hours = timer.prop.unit === 'hours';
            const max = timer.prop.range[1];
            const span = minutes => (minutes < 60
                ? _('%s min').replace('%s', minutes)
                : _('%s h').replace('%s', numberFormat.format(Math.round(minutes / 6) / 10)));
            const choices = [[0, _('Off'), 'clock']];
            for (const minutes of [30, 60, 120, 240, 480]) {
                const value = hours ? minutes / 60 : minutes;
                if (Number.isInteger(value) && value <= max)
                    choices.push([value, span(minutes), 'clock']);
            }
            const minutes = hours ? timer.value * 60 : timer.value;
            tiles.push({
                title: _('Timer'),
                glyph: 'clock',
                value: timer.value,
                text: timer.value > 0 ? span(minutes) : _('Off'),
                choices,
                pick: value => write(timer, value),
            });
        }
        toggle(find(['on'], (p, s) => s.name === 'indicator-light'), _('Light'), 'bulb');
        toggle(find(['alarm'], (p, s) => s.name === 'alarm'), _('Sound'), 'bell');
        toggle(find(['physical-controls-locked']), _('Child Lock'), 'lock');

        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-fan'});
        if (tiles.length > 0)
            this._addTileGrid(box, tiles);

        for (const service of services) {
            const motor = service.properties.find(p => p.name === 'motor-control' && p.access.includes('write'));
            const left = motor?.choices?.find(c => /left/i.test(c.description));
            const right = motor?.choices?.find(c => /right/i.test(c.description));
            if (!left || !right)
                continue;
            covered.add(`${service.siid}/${motor.piid}`);
            const row = new St.BoxLayout({style_class: 'nook-fan-turn'});
            row.add_child(new St.Label({
                style_class: 'nook-card-label',
                text: _('Turn the Head'),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            for (const [icon, label, choice] of [
                ['go-previous-symbolic', _('Left'), left],
                ['go-next-symbolic', _('Right'), right],
            ]) {
                const button = this._addRoundButton(row, icon, label, () => {
                    this._cardWrite(device, () => home.setProperty(device, service.siid, motor.piid, choice.value))
                        .catch(logError);
                });
                button.add_style_class_name('nook-step');
            }
            box.add_child(row);
        }

        for (const service of tiles.length > 0 ? services : []) {
            for (const action of service.actions ?? []) {
                if (['toggle', 'toggle-mode', 'loop-gear'].includes(action.name))
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
        }
        if (box.get_n_children() > 0)
            this._stageAdd(box);
        else
            box.destroy();
    }

    _addGatewayControls(device, services, values, covered) {
        const home = this._home;
        const found = (serviceName, name) => {
            const service = services.find(s => s.name === serviceName);
            const prop = service?.properties.find(p => p.name === name);
            const key = prop ? `${service.siid}/${prop.piid}` : null;
            return prop && values.has(key) ? {service, prop, key, value: values.get(key)} : null;
        };
        const tiles = [];
        for (const [serviceName, name, title, glyph] of [
            ['light', 'on', _('Light'), 'bulb'],
            ['gateway', 'guard-mode', _('Guard'), 'shield'],
        ]) {
            const f = found(serviceName, name);
            if (f?.prop.format !== 'bool' || !f.prop.access.includes('write') || covered.has(f.key))
                continue;
            covered.add(f.key);
            tiles.push({
                title,
                glyph,
                on: f.value === true,
                text: f.value === true ? _('On') : _('Off'),
                pick: on => this._cardWrite(device, () => home.setProperty(device, f.service.siid, f.prop.piid, on))
                    .catch(logError),
            });
        }
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-fan'});
        if (tiles.length > 0)
            this._addTileGrid(box, tiles);
        // The siren stays a plain switch: a tile is too easy to hit.
        for (const [name, title] of [['alarm', _('Siren')], ['volume', _('Siren Volume')]]) {
            const f = found('alarm', name);
            if (!f)
                continue;
            covered.add(f.key);
            const row = this._propertyRow(home, device, f.service, f.prop, f.value, title);
            if (row)
                box.add_child(row);
        }
        const lux = found('motion-sensor', 'illumination');
        if (typeof lux?.value === 'number') {
            covered.add(lux.key);
            const stats = statFlow();
            fillStats(stats, [{title: _('Light Around It'), glyph: 'sun', text: formatValue(lux.prop, lux.value)}]);
            box.add_child(stats);
        }
        if (box.get_n_children() > 0)
            this._stageAdd(box);
        else
            box.destroy();
    }

    _addFryerControls(device, services, values, covered) {
        const home = this._home;
        const fryer = services.find(s => s.actions?.some(a => a.name === 'start-cook'));
        if (!fryer)
            return;
        const prop = name => fryer.properties.find(p => p.name === name);
        const keyOf = p => `${fryer.siid}/${p.piid}`;
        const value = name => (prop(name) ? values.get(keyOf(prop(name))) : undefined);
        const action = name => fryer.actions.find(a => a.name === name && a.in.length === 0);
        const write = (p, v) => this._cardWrite(device, () => home.setProperty(device, fryer.siid, p.piid, v))
            .catch(logError);
        for (const name of ['status', 'left-time', 'turn-pot', 'cooking-weight', 'target-cooking-measure', 'texture',
            'current-keep-warm'])
            covered.add(prop(name) ? keyOf(prop(name)) : null);

        const status = choiceOf(prop('status'), value('status')) ?? '';
        const running = /^\s*(cooking|preheat|keep warm|crispy roast|degrease)\s*$/i.test(status);
        const paused = /paused/i.test(status);
        const waiting = /delay/i.test(status);
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-fryer'});

        const left = value('left-time');
        const total = value('target-time');
        if ((running || paused) && typeof left === 'number') {
            const row = new St.BoxLayout({style_class: 'nook-fryer-left'});
            row.add_child(new St.Label({style_class: 'nook-fryer-minutes', text: String(left)}));
            row.add_child(new St.Label({
                style_class: 'nook-fryer-unit',
                text: paused ? _('min left, paused') : _('min left'),
                y_align: Clutter.ActorAlign.END,
            }));
            box.add_child(row);
            if (typeof total === 'number' && total > 0) {
                const bar = new Scene('progress', 'nook-wear-bar');
                const temperature = value('target-temperature');
                bar.show({
                    share: Math.min(1, Math.max(0, 1 - left / total)),
                    color: Scenes.tint('fryer', {cooking: true, temperature}) ?? [0.98, 0.62, 0.24],
                });
                box.add_child(bar);
            }
        }
        // turn-pot stays 'need' after cooking ends; only meaningful while running.
        if ((running || paused) && /need/i.test(choiceOf(prop('turn-pot'), value('turn-pot')) ?? ''))
            box.add_child(new St.Label({style_class: 'nook-fryer-note', text: _('Time to turn the food over.')}));

        const buttons = new St.BoxLayout({style_class: 'nook-vacuum-actions', x_expand: true});
        buttons.layout_manager.homogeneous = true;
        const add = (found, icon, label) => {
            if (!found)
                return;
            const item = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-action'});
            const button = this._addRoundButton(item, icon, label, () => {
                this._cardWrite(device, () => home.runAction(device, fryer.siid, found.aiid)).catch(logError);
            });
            button.x_align = Clutter.ActorAlign.CENTER;
            item.add_child(wordLabel(label));
            buttons.add_child(item);
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
        if (buttons.get_n_children() > 0)
            box.add_child(buttons);

        const tiles = [];
        const mode = prop('mode');
        if (mode?.choices?.length && values.has(keyOf(mode))) {
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

        const span = minutes => {
            if (minutes < 60)
                return _('%s min').replace('%s', minutes);
            const [hours, rest] = [Math.floor(minutes / 60), minutes % 60];
            return rest ? _('%s h %s min').replace('%s', hours).replace('%s', rest) : _('%s h').replace('%s', hours);
        };
        const stepped = (name, title, glyph, format, stepOf) => {
            const p = prop(name);
            const current = p ? values.get(keyOf(p)) : undefined;
            if (!p?.range || !p.access.includes('write') || typeof current !== 'number')
                return;
            covered.add(keyOf(p));
            tiles.push({
                title,
                glyph,
                text: format(current),
                fill: drawer => this._addStepper(drawer, title, current, p.range, format, stepOf, v => write(p, v)),
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
            const current = p ? values.get(keyOf(p)) : undefined;
            if (p?.format !== 'bool' || !p.access.includes('write') || typeof current !== 'boolean')
                continue;
            covered.add(keyOf(p));
            tiles.push({title, glyph, on: current, text: current ? _('On') : _('Off'), pick: on => write(p, on)});
        }
        this._addTileGrid(box, tiles);
        this._stageAdd(box);
    }
}
