// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Glyphs from '../lib/glyphs.js';
import * as Scenes from '../lib/scenes.js';
import {TvError} from './errors.js';
import {VERTICAL, readSetting, tvShowing, tvTrouble, volumeIcon} from './text.js';
import {Scene} from './widgets.js';

function inputTitle(input) {
    if (input.title)
        return input.title;
    if (input.id === 'tv')
        return _('TV');
    const hdmi = /^hdmi(\d)$/.exec(input.id);
    return hdmi ? `HDMI ${hdmi[1]}` : String(input.id);
}

const TV_VOLUME = {name: 'volume', format: 'uint8', range: [0, 100, 1], access: ['read', 'write'], unit: null};

export class TvCard {
    async _openTvCard(device) {
        const source = device.source;
        const again = this._card === device;
        if (!again)
            this._drawer = null;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!device.state)
            this._showLoading(true);
        else if (!again)
            this._fillTvCard(device);
        await source.readDevice(device);
        if (this._card !== device || source !== this._tv)
            return;
        this._fillTvCard(device);
        // Lists come once per round, from some TVs only after ~20 s (Samsung's app lookups).
        if (device.online !== false && device.state?.on && device.state.paired &&
            (source.listed(device, 'sources') === null || source.listed(device, 'apps') === null)) {
            await Promise.all([source.sources(device), source.apps(device)].map(list => list.catch(() => [])));
            if (this._card !== device || source !== this._tv)
                return;
            this._fillTvCard(device);
        }
    }

    _fillTvCard(device) {
        const home = device.source;
        const state = device.state;
        if (!state) {
            this._message(_('The TV is not answering. Is it on the same network?'));
            return;
        }
        const scroll = this._tvCard?.device === device ? this._scroll.vadjustment.value : 0;
        this._clear();
        const act = task => this._tvDo(device, task).catch(logError);
        const online = device.online !== false;
        const on = online && state.on === true;
        const t = {device};
        let status = _('Offline');
        if (online && !state.paired)
            status = _('Not paired');
        else if (online)
            status = on ? _('On') : _('Off');

        t.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-climate nook-stage'});
        const top = new St.BoxLayout({style_class: 'nook-climate-top'});
        const dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        if (on)
            dot.add_style_pseudo_class('checked');
        top.add_child(dot);
        top.add_child(new St.Label({
            style_class: 'nook-climate-status',
            text: status,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        // Unpaired TVs reject every command, power included. Ignore clicks while a power
        // request is in flight, or the key is pressed twice.
        let power = null;
        if (state.paired && online) {
            power = this._addRoundButton(top, 'system-shutdown-symbolic', on ? _('Turn Off') : _('Turn On'), () => {
                if (this._tvBusy.has(device.did))
                    return;
                this._tvBusy.add(device.did);
                act(() => home.power(device, !on)).finally(() => this._tvBusy.delete(device.did));
            });
            power.add_style_class_name('nook-power');
            power.checked = on;
        }
        t.box.add_child(top);

        const showing = on ? tvShowing(device) : null;
        const scene = {
            on,
            volume: typeof state.volume === 'number' ? state.volume / (state.volumeMax || 100) : null,
            muted: state.muted === true,
            label: showing ?? '',
        };
        const middle = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-middle'});
        t.scene = new Scene('tv', 'nook-stage-scene');
        t.scene.setScene('tv', scene);
        middle.add_child(power ? this._powerScene(t.scene, power) : t.scene);
        middle.add_child(new St.Label({
            style_class: 'nook-stage-word',
            text: on ? (showing ?? _('On')) : _('Off'),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        let small = null;
        if (state.muted)
            small = _('Muted');
        else if (state.media)
            small = state.media;
        else if (!state.setsVolume && typeof state.volume === 'number')
            small = _('Volume %s').replace('%s', state.volume);
        if (on && small) {
            const label = new St.Label({
                style_class: 'nook-hero-small',
                text: small,
                x_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            middle.add_child(label);
        }
        t.box.add_child(middle);

        const [, color] = Glyphs.kindOf(null, null, 'tv');
        const tint = on ? color : [0.42, 0.42, 0.46];
        const shade = share => tint.map(v => Math.round(v * 255 * share));
        t.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(0.5)}); background-gradient-end: rgb(${shade(0.24)});`;

        if (!state.paired) {
            const note = new St.Label({
                style_class: 'nook-card-value',
                text: _('Pair it in Settings, under TVs, to control it from here.'),
            });
            note.clutter_text.line_wrap = true;
            t.box.add_child(note);
            const settings = new St.Button({style_class: 'nook-chip', label: _('Settings…'), can_focus: true,
                x_align: Clutter.ActorAlign.START});
            settings.connect('clicked', () => {
                this._closeMenu();
                this._openPreferences(`accounts-tv ${device.did}`);
            });
            t.box.add_child(settings);
        } else if (on) {
            const controls = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-controls'});
            // Without a mute reading the key toggles blind.
            const mute = this._roundButton(
                volumeIcon(typeof state.volume === 'number' ? state.volume / (state.volumeMax || 100) : 1, state.muted === true),
                state.muted ? _('Unmute') : _('Mute'),
                () => act(() => (state.muted === null
                    ? home.press(device, 'mute') : home.setMuted(device, !state.muted))));
            mute.add_style_class_name('nook-step');
            mute.checked = state.muted === true;
            const mutes = state.muted !== null || !state.keys || state.keys.includes('mute');
            if (state.setsVolume) {
                const range = {...TV_VOLUME, range: [0, state.volumeMax || 100, 1]};
                controls.add_child(this._sliderRow(_('Volume'), range, state.volume,
                    level => act(() => home.setVolume(device, level)), false, mutes ? mute : null));
            } else {
                const row = new St.BoxLayout({style_class: 'nook-climate-range'});
                const quieter = this._addRoundButton(row, 'list-remove-symbolic', _('Quieter'),
                    () => act(() => home.press(device, 'volume-down')));
                row.add_child(new St.Label({
                    style_class: 'nook-card-label',
                    text: _('Volume'),
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                const louder = this._addRoundButton(row, 'list-add-symbolic', _('Louder'),
                    () => act(() => home.press(device, 'volume-up')));
                for (const step of [quieter, louder])
                    step.add_style_class_name('nook-step');
                if (mutes)
                    row.add_child(mute);
                controls.add_child(row);
            }

            const tiles = [];
            const inputs = home.listed(device, 'sources') ?? [];
            if (inputs.length > 0) {
                const current = inputs.find(i => i.id === state.source || (i.app && [state.app, state.source].includes(i.app)));
                tiles.push({
                    title: _('Input'),
                    glyph: 'input',
                    value: current?.id ?? null,
                    text: current ? inputTitle(current) : (state.app ? _('Apps') : '–'),
                    choices: inputs.map(i => [i.id, inputTitle(i), null]),
                    pick: id => act(() => home.source(device, id)),
                });
            }
            const all = home.listed(device, 'apps') ?? [];
            const current = all.find(a => a.id === state.app);
            const apps = all.slice(0, 12);
            if (current && !apps.includes(current))
                apps.unshift(current);
            if (apps.length > 0) {
                tiles.push({
                    title: _('Apps'),
                    glyph: 'apps',
                    value: state.app,
                    text: current?.title ?? (state.app ? tvShowing(device) : null) ?? '–',
                    choices: apps.map(a => [a.id, a.title || String(a.id), null]),
                    icon: id => home.appIcon(device, id),
                    pick: id => act(() => home.launch(device, id)),
                });
            }
            tiles.push({
                title: _('Remote'),
                glyph: 'remote',
                text: _('Arrows, OK'),
                fill: drawer => this._fillTvRemote(drawer, device, act),
            });
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-tiles'});
            this._addTileGrid(box, tiles);
            controls.add_child(box);
            t.box.add_child(controls);
        }

        this._body.add_child(t.box);
        this._addDeviceInfo(device);
        this._tvCard = t;
        t.scene.run(Scenes.moves('tv', scene) && this._menu.isOpen);
        this._putScrollBack(scroll);
    }

    _fillTvRemote(drawer, device, act) {
        const home = device.source;
        const pad = new St.BoxLayout({...VERTICAL, style_class: 'nook-tv-remote', x_expand: true});
        const rows = [
            [['edit-undo-symbolic', _('Back'), 'back'], ['go-up-symbolic', _('Up'), 'up'],
                ['go-home-symbolic', _('Home'), 'home']],
            [['go-previous-symbolic', _('Left'), 'left'], ['object-select-symbolic', _('OK'), 'ok'],
                ['go-next-symbolic', _('Right'), 'right']],
            [['open-menu-symbolic', _('Menu'), 'menu'], ['go-down-symbolic', _('Down'), 'down'],
                ['media-playback-start-symbolic', _('Play'), 'play']],
            [['go-bottom-symbolic', _('Channel Down'), 'channel-down'],
                ['media-playback-pause-symbolic', _('Pause'), 'pause'], ['go-top-symbolic', _('Channel Up'), 'channel-up']],
        ];
        const has = device.state?.keys;
        for (const keys of rows) {
            const row = new St.BoxLayout({style_class: 'nook-tv-remote-row', x_align: Clutter.ActorAlign.CENTER});
            for (const [icon, label, key] of keys) {
                const button = this._addRoundButton(row, icon, label, () => act(() => home.press(device, key)));
                // Keep the grid: a missing key leaves its place empty.
                if (has && !has.includes(key)) {
                    button.opacity = 0;
                    button.reactive = false;
                    button.can_focus = false;
                }
            }
            pad.add_child(row);
        }
        drawer.add_child(pad);
    }

    // Errors only: TvHome re-reads the TV afterwards and calls _tvChanged().
    async _tvDo(device, task) {
        try {
            await task();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
            if (!this._gone)
                Main.notifyError(device.name, tvTrouble(e));
        }
    }

    _tvChanged(tv, device) {
        if (tv !== this._tv)
            return;
        if (this._card === device && this._tvCard?.device === device)
            this._fillTvCard(device);
        else if (!this._card)
            this._tiles.forEach(tile => tile.sync());
    }
}
