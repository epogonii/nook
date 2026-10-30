// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _, pgettext} from 'gettext';

import {TileGrid, roundButton, sliderRow, volumeIcon} from './card-parts.js';
import {tvShowing} from './hero.js';
import {TvError} from './lib/net.js';

// ms between reads while the page shows, and since the last press before one, as the
// extension's open card.
const READ_EVERY = 5000;

const TV_VOLUME = {name: 'volume', format: 'uint8', range: [0, 100, 1], access: ['read', 'write'], unit: null};

function inputTitle(input) {
    if (input.title)
        return input.title;
    if (input.id === 'tv')
        return _('TV');
    const hdmi = /^hdmi(\d)$/.exec(input.id);
    return hdmi ? `HDMI ${hdmi[1]}` : String(input.id);
}

function tvTrouble(e) {
    if (e.code === 'unpaired')
        return _('Pair it under TVs, in Accounts, to control it from here.');
    if (e.code === 'denied')
        return _('The TV did not let Nook in.');
    if (e.code === 'asleep')
        return _('The TV did not wake up. Turn on network standby (Powered On by Apps) in its network settings.');
    if (e instanceof GLib.Error || ['timeout', 'closed'].includes(e.code))
        return _('The TV is not answering. Is it on the same network?');
    return e.message;
}

// [icon, label, key], row by row.
function remoteKeys() {
    return [
        [['edit-undo-symbolic', _('Back'), 'back'], ['go-up-symbolic', _('Up'), 'up'],
            ['go-home-symbolic', _('Home'), 'home']],
        [['go-previous-symbolic', _('Left'), 'left'], ['object-select-symbolic', _('OK'), 'ok'],
            ['go-next-symbolic', _('Right'), 'right']],
        [['open-menu-symbolic', _('Menu'), 'menu'], ['go-down-symbolic', _('Down'), 'down'],
            ['media-playback-start-symbolic', pgettext('action', 'Play'), 'play']],
        [['go-bottom-symbolic', _('Channel Down'), 'channel-down'],
            ['media-playback-pause-symbolic', _('Pause'), 'pause'], ['go-top-symbolic', _('Channel Up'), 'channel-up']],
    ];
}

// A TV's page: volume, inputs, apps and a remote under the hero's text, the extension's
// TV card (ui/card-tv.js). device.source is the TvHome.
export class TvCard {
    constructor(ctx) {
        this._ctx = ctx;
        this._device = ctx.device;
        this._gone = false;
        this._reading = false;
        this._readAt = 0;
        this._usedAt = 0;
        this._timer = 0;
        this._tilesKey = null;
        this._pad = null;
        this._keys = [];
        this.groups = [];

        this._note = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 10});
        this._noteText = new Gtk.Label({wrap: true, xalign: 0, css_classes: ['nook-tv-note']});
        this._note.append(this._noteText);
        this._pair = new Gtk.Button({
            label: _('Open Accounts'),
            halign: Gtk.Align.START,
            action_name: 'app.show-page',
            action_target: GLib.Variant.new_string(`accounts-tv ${this._device.did}`),
            css_classes: ['nook-tv-pair'],
        });
        this._note.append(this._pair);

        // Both ways to set the volume: a read without a level turns the slider into keys.
        this._slider = null;
        this._sliderMax = null;
        this._sliderMute = null;
        this._sliderBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const device = this._device;
        const quieter = roundButton('list-remove-symbolic', _('Quieter'), () => this._act(() => device.source.press(device, 'volume-down')));
        const louder = roundButton('list-add-symbolic', _('Louder'), () => this._act(() => device.source.press(device, 'volume-up')));
        this._level = new Gtk.Label({hexpand: true, ellipsize: Pango.EllipsizeMode.END, css_classes: ['nook-slider-title', 'numeric']});
        this._stepsMute = this._muteButton();
        this._steps = new Gtk.Box({spacing: 10});
        for (const widget of [quieter, this._level, louder, this._stepsMute])
            this._steps.append(widget);

        this._grid = new TileGrid();
        this._controls = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 14});
        for (const widget of [this._sliderBox, this._steps, this._grid])
            this._controls.append(widget);

        this.stage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, css_classes: ['nook-stage', 'nook-tv']});
        this.stage.append(this._note);
        this.stage.append(this._controls);

        // Reads only while the page is on screen: a closed window leaves it unmapped.
        const page = ctx.page;
        this._handlers = [page.connect('map', () => this._watch(true)), page.connect('unmap', () => this._watch(false))];
        this.sync();
        if (page.get_mapped())
            this._watch(true);
    }

    // Unpaired TVs reject every command, power included: the hero shows no power button.
    get ownsPower() {
        return Boolean(this._device.state) && !this._device.state.paired;
    }

    sync() {
        const device = this._device;
        const state = device.state;
        const online = device.online !== false;
        const unpaired = Boolean(state) && !state.paired;
        this._noteText.label = unpaired ? _('Pair it under TVs, in Accounts, to control it from here.')
            : _('The TV is not answering. Is it on the same network?');
        this._pair.visible = unpaired;
        this._note.visible = unpaired || (!state && !online);
        const on = online && !unpaired && state?.on === true;
        this._controls.visible = on;
        if (on) {
            this._syncVolume(state);
            this._syncTiles(state);
        }
        if (this._pad)
            this._syncRemote();
        this.stage.visible = this._note.visible || on;
    }

    forget() {
        this._gone = true;
        this._watch(false);
        for (const id of this._handlers)
            this._ctx.page.disconnect(id);
        this._handlers = [];
    }

    _watch(on) {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (!on || this._gone)
            return;
        const tick = () => {
            const now = Date.now();
            if (!this._reading && now - this._readAt >= READ_EVERY && now - this._usedAt >= READ_EVERY)
                this._read().catch(logError);
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, tick);
    }

    // HomePage.onEvent() is where a push from the TvHome lands too: the page and the
    // home grid both follow.
    async _read() {
        const device = this._device;
        const home = device.source;
        this._reading = true;
        this._readAt = Date.now();
        try {
            await home.readDevice(device);
            if (this._gone)
                return;
            this._ctx.home.onEvent();
            // Lists come once per round, from some TVs only after ~20 s (Samsung's app
            // lookups); no status read meanwhile, as that TV answers one request at a time.
            const state = device.state;
            if (device.online !== false && state?.on && state.paired &&
                (home.listed(device, 'sources') === null || home.listed(device, 'apps') === null)) {
                await Promise.all([home.sources(device), home.apps(device)].map(list => list.catch(() => [])));
                if (!this._gone)
                    this._ctx.home.onEvent();
            }
        } finally {
            this._reading = false;
        }
    }

    // Errors only, as a toast: the TvHome reads the TV again after a write and reports it.
    _act(task) {
        this._usedAt = Date.now();
        task().then(() => {
            if (!this._gone)
                this._ctx.written();
        }, e => {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
            if (!this._gone)
                this._ctx.toast(tvTrouble(e));
        }).catch(logError);
    }

    // Without a mute reading the key toggles blind.
    _muteButton() {
        const device = this._device;
        return roundButton('audio-volume-high-symbolic', _('Mute'), () => this._act(() => {
            const muted = device.state?.muted;
            return muted === null ? device.source.press(device, 'mute') : device.source.setMuted(device, !muted);
        }));
    }

    _buildSlider(max) {
        const device = this._device;
        for (let child = this._sliderBox.get_first_child(); child; child = this._sliderBox.get_first_child())
            this._sliderBox.remove(child);
        this._sliderMax = max;
        this._sliderMute = this._muteButton();
        this._slider = sliderRow(_('Volume'), {...TV_VOLUME, range: [0, max, 1]}, device.state?.volume,
            level => this._act(() => device.source.setVolume(device, level)), false, this._sliderMute);
        this._sliderBox.append(this._slider.widget);
    }

    _syncVolume(state) {
        const max = state.volumeMax || 100;
        const sets = state.setsVolume === true;
        if (sets && this._sliderMax !== max)
            this._buildSlider(max);
        this._sliderBox.visible = sets;
        this._steps.visible = !sets;
        const known = typeof state.volume === 'number';
        if (sets)
            this._slider.update(state.volume);
        else
            this._level.label = known ? _('Volume %s').replace('%s', state.volume) : _('Volume');
        const mutes = state.muted !== null || !state.keys || state.keys.includes('mute');
        for (const mute of [this._sliderMute, this._stepsMute].filter(Boolean)) {
            mute.visible = mutes;
            mute.icon_name = volumeIcon(known ? state.volume / max : 1, state.muted === true);
            mute.tooltip_text = state.muted ? _('Unmute') : _('Mute');
            if (state.muted === true)
                mute.add_css_class('on');
            else
                mute.remove_css_class('on');
        }
    }

    // TileGrid.show() fills an open drawer again: only when a tile changed.
    _syncTiles(state) {
        const device = this._device;
        const home = device.source;
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
                pick: id => this._act(() => home.source(device, id)),
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
                pick: id => this._act(() => home.launch(device, id)),
            });
        }
        tiles.push({
            title: _('Remote'),
            glyph: 'remote',
            text: _('Arrows, OK'),
            fill: drawer => drawer.append(this._remote()),
        });
        const key = JSON.stringify(tiles.map(t => [t.title, t.text, t.value ?? null,
            t.choices?.map(([id, label]) => [id, label, Boolean(t.icon?.(id))]) ?? null]));
        if (key === this._tilesKey)
            return;
        this._tilesKey = key;
        this._grid.show(tiles);
    }

    // One pad for the card's life: the drawer takes it again on each fill.
    _remote() {
        if (!this._pad) {
            const device = this._device;
            this._pad = new Gtk.Grid({column_spacing: 22, row_spacing: 8, halign: Gtk.Align.CENTER, css_classes: ['nook-tv-remote']});
            this._keys = remoteKeys().flatMap((row, y) => row.map(([icon, label, key], x) => {
                const button = roundButton(icon, label, () => this._act(() => device.source.press(device, key)));
                this._pad.attach(button, x, y, 1, 1);
                return [key, button];
            }));
            // Keys sit where a remote has them, also in a right-to-left language.
            for (const widget of [this._pad, ...this._keys.flatMap(([, button]) => [button, button.get_child()])])
                widget.set_direction(Gtk.TextDirection.LTR);
            this._syncRemote();
        }
        this._pad.get_parent()?.remove(this._pad);
        return this._pad;
    }

    // A key the TV lacks keeps its place empty, so the arrows stay a cross.
    _syncRemote() {
        const has = this._device.state?.keys;
        for (const [key, button] of this._keys) {
            const there = !has || has.includes(key);
            button.opacity = there ? 1 : 0;
            button.can_target = there;
            button.focusable = there;
        }
    }
}
