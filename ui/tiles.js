// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TvError, TvHome} from '../lib/tv-home.js';
import * as Glyphs from '../lib/glyphs.js';
import * as Scenes from '../lib/scenes.js';
import {ClimateError, MODES} from '../lib/aircon-home.js';
import {SonoffError, SonoffHome} from '../lib/sonoff.js';
import {EwelinkError} from '../lib/ewelink.js';
import {SpecError} from '../lib/spec-home.js';
import {XiaomiError} from '../lib/xiaomi.js';
import {climateLook} from './climate.js';
import {castAllows, castToggle, heroOf, mediaColor, showCastPlay} from './hero.js';
import {humanize} from './humanize.js';
import {isBluetooth, playingNow, stateText} from './rows.js';
import {PRIMARY_SECONDARY, VERTICAL, booleanText, deviceType, sonoffTrouble, specTrouble, statusWorking, tvTrouble, volumeIcon} from './text.js';
import {Glyph, VolumeSlider, skeletonBar, skeletonLine} from './widgets.js';

const OFFLINE_OPACITY = 115;

const ON_INK = [0.1, 0.1, 0.12];

const WHITE = [1, 1, 1];

function isWorking(device) {
    const {primary, values, online} = device;
    if (primary.kind === 'media')
        return online === true && values?.[0] === true;
    if (primary.kind !== 'reading' || !online)
        return false;
    return primary.props.some((p, i) => {
        return p.name === 'status' && statusWorking(p.choices?.find(c => c.value === values?.[i])?.description);
    });
}

const NO_ROOM = '@other';

function tileTint(device) {
    if (device.primary.kind === 'climate') {
        const {Pow: power, Mod: mode, SetTem: target} = device.state ?? {};
        return power === 1 ? climateLook(MODES[mode], target ?? 24).color : null;
    }
    const hero = heroOf(device, [], new Map());
    if (hero.scene === 'aircon')
        return hero.state.on ? hero.color : null;
    return Scenes.tint(hero.scene, hero.state);
}

const DRAGGED_OPACITY = 90;

export function groupRooms(devices) {
    const rooms = new Map();
    for (const device of devices) {
        // || not ??: an empty room name would get the "All" tab's key ''.
        const name = device.room || null;
        const key = name?.toLocaleLowerCase() ?? NO_ROOM;
        if (!rooms.has(key))
            rooms.set(key, {key, name, devices: []});
        rooms.get(key).devices.push(device);
    }
    return [...rooms.values()].sort((a, b) =>
        (a.name === null) - (b.name === null) || (a.name ?? '').localeCompare(b.name ?? ''));
}

function alikeKind(device) {
    return Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model)[0];
}

// Sections of the module view in display order, by the glyphs they take; the rest are appliances.
export const SECTIONS = [
    ['lights', ['bulb', 'rocker']],
    ['climate', ['aircon', 'fan', 'thermometer', 'heater', 'humidifier', 'dehumidifier', 'purifier', 'thermostat']],
    ['media', ['tv', 'speaker']],
    ['cameras', ['camera']],
    ['security', ['shield', 'motion', 'door', 'drop', 'smoke', 'lock', 'doorbell']],
    ['appliances', []],
];

export function sectionTitle(id) {
    return {
        lights: _('Lights'),
        climate: _('Climate'),
        media: _('Media'),
        cameras: _('Cameras'),
        security: _('Security'),
        appliances: _('Appliances'),
    }[id];
}

// A glyph chosen in Settings moves the device along with its look.
function sectionOf(device, icons) {
    if (device.primary.kind === 'camera')
        return 'cameras';
    const icon = icons[device.did];
    const glyph = Glyphs.CHOICES.includes(icon) ? icon : alikeKind(device);
    return SECTIONS.find(([, glyphs]) => glyphs.includes(glyph))?.[0] ?? 'appliances';
}

// Guard mode shows with the sensors; other extra tiles ride with their device.
export function tileSection(device, extra, icons) {
    if (extra && Glyphs.kindOfProperty(extra.name, deviceType(device), device.model)[0] === 'shield')
        return 'security';
    return sectionOf(device, icons);
}

export function sectionSummary(id, tiles) {
    const devices = tiles.filter(tile => !tile.extra).map(tile => tile.device);
    const reachable = devices.filter(device => device.online !== false || isBluetooth(device));
    const on = tiles.filter(tile => tile.checked).length;
    switch (id) {
    case 'cameras':
        return reachable.length < devices.length
            ? _('%s of %s online').replace('%s', String(reachable.length)).replace('%s', String(devices.length))
            : '';
    case 'climate':
        if (on > 0)
            return _('%s on').replace('%s', String(on));
        return devices.filter(device => alikeKind(device) === 'thermometer').map(stateText)
            .find(text => /\d/.test(text)) ?? '';
    case 'security':
        if (reachable.some(device => heroOf(device, [], new Map()).alarm))
            return _('Alarm!');
        return reachable.length > 0 ? _('All quiet') : '';
    case 'appliances':
        return on > 0 ? _('%s working').replace('%s', String(on)) : '';
    default:
        if (on > 0)
            return _('%s on').replace('%s', String(on));
        return reachable.length > 0 ? _('All off') : '';
    }
}

// Alike devices in one module go by room, unless renamed in Nook.
export function roomLabels(items, names) {
    const devices = items.filter(([, extra]) => !extra).map(([device]) => device);
    const room = device => device.room?.toLocaleLowerCase();
    const labels = new Map();
    for (const device of devices) {
        if (!device.room || names[device.did])
            continue;
        const alike = devices.filter(other => alikeKind(other) === alikeKind(device));
        if (alike.length > 1 && alike.filter(other => room(other) === room(device)).length === 1)
            labels.set(device.did, device.room);
    }
    return labels;
}

export function skeletonTile(shape) {
    const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    text.add_child(skeletonLine('nook-name', 'name'));
    text.add_child(skeletonLine('nook-state'));
    const box = new St.BoxLayout({
        ...(shape === 'square' ? VERTICAL : {}),
        style_class: 'nook-tile-box',
        x_expand: true,
    });
    box.add_child(new St.Widget({
        style_class: 'nook-bubble',
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(text);
    return new St.Bin({style_class: `nook-tile nook-tile-${shape}`, child: box, x_expand: true});
}

export const Tile = GObject.registerClass(
class Tile extends St.Button {
    // label: shown instead of the name; synced: called after each sync.
    _init(home, device, {shape, typeColors, name, label = null, icon = '', extra = null, openCard, awaits, drop = null,
        synced = null}) {
        const switchable = extra !== null || ['switch', 'climate', 'tv'].includes(device.primary.kind);
        const modular = shape === 'row';
        super._init({
            style_class: modular ? `nook-cc-tile nook-cc-${shape}` : `nook-tile nook-tile-${shape}`,
            accessible_name: extra ? `${name}: ${humanize(extra.name)}` : name,
            x_expand: true,
            can_focus: true,
            track_hover: true,
            button_mask: PRIMARY_SECONDARY,
        });
        this._openCard = openCard;
        this._awaits = awaits;
        this._home = home;
        this._device = device;
        this._extra = extra;
        this._deviceName = name;
        this._synced = synced;
        this._shape = shape;
        this._modular = modular;
        this._switchable = switchable;
        this._busy = false;
        this._gone = false;
        this._picture = false;

        const [glyph, color] = extra
            ? Glyphs.kindOfProperty(extra.name, deviceType(device), device.model)
            : Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model);
        const chosen = !extra && Glyphs.CHOICES.includes(icon);
        const picture = !extra && icon.startsWith('/') ? Gio.File.new_for_path(icon) : null;
        if (picture?.query_exists(null)) {
            this._glyph = new St.Icon({
                style_class: 'nook-glyph',
                gicon: new Gio.FileIcon({file: picture}),
                icon_size: 16,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._picture = true;
        } else {
            this._glyph = new Glyph(chosen ? icon : glyph);
        }
        const look = chosen ? Glyphs.colorOf(icon, color) : color;
        this._color = typeColors ? look : null;
        this._typeColor = this._color;
        this._tinted = !extra && ['thermometer', 'kettle', 'aircon'].includes(glyph);

        const bubble = {
            style_class: 'nook-bubble',
            child: this._glyph,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        };
        if (switchable) {
            this._bubble = new St.Button({
                ...bubble,
                style_class: 'nook-bubble nook-toggle',
                accessible_name: _('Switch On or Off'),
                can_focus: true,
            });
            this._bubble.connect('clicked', () => {
                if (this._device.online === false || this._device.state?.paired === false)
                    this._openCard(device);
                else if (!this._busy)
                    this._toggle().catch(logError);
            });
        } else {
            this._bubble = new St.Bin(bubble);
        }

        this._name = new St.Label({
            style_class: 'nook-name',
            text: extra ? humanize(extra.name) : label ?? name,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // BinLayout centres children that don't expand.
        this._state = new St.Label({style_class: 'nook-state', x_expand: true});
        this._state.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._skeleton = skeletonBar();
        this._skeleton.set({visible: false, x_expand: true});
        const stateLine = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        stateLine.add_child(this._state);
        stateLine.add_child(this._skeleton);
        const text = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(this._name);
        text.add_child(stateLine);

        const box = new St.BoxLayout({
            ...(shape === 'square' ? VERTICAL : {}),
            style_class: 'nook-tile-box',
            x_expand: true,
        });
        box.add_child(this._bubble);
        box.add_child(text);
        this.set_child(box);

        this.connect('clicked', () => this._openCard(device));
        this.connect('destroy', () => {
            this._gone = true;
        });
        if (drop) {
            this._drop = drop;
            this._delegate = this;
            // An extra tile rides with its device.
            if (!extra) {
                const draggable = DND.makeDraggable(this);
                draggable.connect('drag-begin', () => {
                    this.opacity = DRAGGED_OPACITY;
                    drop.begin();
                });
                draggable.connect('drag-end', () => {
                    drop.end();
                    if (!this._gone)
                        this.sync();
                });
            }
        }
        this.sync();
    }

    get device() {
        return this._device;
    }

    get extra() {
        return this._extra;
    }

    get shape() {
        return this._shape;
    }

    // A row has no background of its own: the module behind it gives it one.
    getDragActor() {
        const [width, height] = this.get_size();
        return new St.Bin({
            style_class: 'nook-cc-drag',
            child: new Clutter.Clone({source: this, width, height}),
        });
    }

    getDragActorSource() {
        return this;
    }

    handleDragOver(source, _actor, x) {
        return source instanceof Tile ? this._drop.over(this, source, x) : DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, _actor, x) {
        return source instanceof Tile && this._drop.accept(this, source, x);
    }

    get _key() {
        return `${this._extra.siid}/${this._extra.piid}`;
    }

    _isOn() {
        if (this._extra)
            return this._device.extra?.[this._key] === true;
        if (this._switchable)
            return this._device.values?.[0] === true;
        return isWorking(this._device);
    }

    sync() {
        const on = this._isOn();
        this.checked = on;
        let state;
        if (this._extra) {
            state = _('Offline');
            if (this._device.online)
                state = this._key in (this._device.extra ?? {}) ? booleanText(this._extra.name, on) : '…';
            this._state.text = state === '…' ? '\u00a0' : `${state} · ${this._deviceName}`;
        } else {
            state = this._awaits?.(this._device) ? '…' : stateText(this._device);
            this._state.text = state === '…' ? '\u00a0' : state;
        }
        this._skeleton.visible = state === '…';
        this.opacity = this._device.online === false && !isBluetooth(this._device) ? OFFLINE_OPACITY : 255;
        if (this._typeColor && this._tinted)
            this._color = tileTint(this._device) ?? this._typeColor;
        this._paint(on);
        this._synced?.();
    }

    _paint(on) {
        if (this._modular) {
            this._paintCircle(on);
            return;
        }
        if (!this._color) {
            this.style = null;
            this._bubble.style = null;
            if (!this._picture)
                this._glyph.setColor(null);
            return;
        }
        const [r, g, b] = this._color.map(c => Math.round(c * 255));
        this.style = on ? `background-color: rgba(${r}, ${g}, ${b}, 0.3);` : null;
        if (this._shape !== 'compact')
            this._bubble.style = `background-color: rgba(${r}, ${g}, ${b}, ${on ? 1 : 0.2});`;
        if (this._picture)
            return;
        this._glyph.setColor(on && this._shape !== 'compact' ? ON_INK : this._color);
    }

    _paintCircle(on) {
        if (!this._color) {
            this.style = null;
            this._bubble.style = null;
            if (!this._picture)
                this._glyph.setColor(null);
            return;
        }
        const [r, g, b] = this._color;
        const rgb = this._color.map(c => Math.round(c * 255)).join(', ');
        this.style = on ? `background-color: rgba(${rgb}, 0.22);` : null;
        this._bubble.style = `background-color: rgba(${rgb}, ${on ? 1 : 0.2});`;
        if (this._picture)
            return;
        if (on)
            this._glyph.setColor(0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? ON_INK : WHITE);
        else
            this._glyph.setColor(this._color);
    }

    async _toggle() {
        const device = this._device;
        const on = !this._isOn();

        const before = this._extra ? {...device.extra} : device.values;
        this._busy = true;
        if (this._extra)
            device.extra = {...device.extra, [this._key]: on};
        else
            device.values = [on];
        this.sync();
        try {
            if (this._extra)
                await device.source.setProperty(device, this._extra.siid, this._extra.piid, on);
            else
                await device.source.setSwitch(device, on);
        } catch (e) {
            if (this._extra)
                device.extra = before;
            else
                device.values = before;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof XiaomiError) && !(e instanceof TvError) && !(e instanceof ClimateError) &&
                !(e instanceof SonoffError) && !(e instanceof EwelinkError) && !(e instanceof SpecError) &&
                !(e instanceof GLib.Error))
                throw e;
            if (!this._gone) {
                Main.notifyError(this._deviceName, device.source instanceof TvHome ? tvTrouble(e)
                    : device.source instanceof SonoffHome ? sonoffTrouble(e)
                        : e instanceof SpecError ? specTrouble(e) : e.message);
            }
        } finally {
            this._busy = false;
            if (!this._gone)
                this.sync();
        }
    }
});

// Now Playing module of the module view, with the volume, for the speaker playing or paused.
// Hides that speaker's row in the speaker list below.
export const NowPlaying = GObject.registerClass(
class NowPlaying extends St.BoxLayout {
    // rows: the speakers' tiles, each in a module's grid.
    _init(speakers, rows, {nameOf, openCard, act}) {
        super._init({...VERTICAL, style_class: 'nook-cc-module nook-cc-playing', x_expand: true});
        this._speakers = speakers;
        this._rows = rows;
        this._nameOf = nameOf;
        this._device = speakers[0];

        const row = new St.BoxLayout({style_class: 'nook-cc-playing-row', x_expand: true});
        const opener = new St.BoxLayout({style_class: 'nook-cc-open-box', x_expand: true});
        this._glyph = new Glyph('speaker');
        this._glyph.setColor(WHITE);
        this._art = new St.Bin({style_class: 'nook-cc-art', child: this._glyph, y_align: Clutter.ActorAlign.CENTER});
        opener.add_child(this._art);
        const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._song = new St.Label({style_class: 'nook-cc-song'});
        this._from = new St.Label({style_class: 'nook-cc-from'});
        for (const label of [this._song, this._from]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        opener.add_child(text);
        this._open = new St.Button({style_class: 'nook-cc-open', child: opener, x_expand: true, can_focus: true});
        this._open.connect('clicked', () => openCard(this._device));
        row.add_child(this._open);
        this._play = this._control(() => act(this._device, home => castToggle(home, this._device)));
        row.add_child(this._play);
        this._next = this._control(() => act(this._device, home => home.skip(this._device, 1)));
        this._next.child.icon_name = 'media-skip-forward-symbolic';
        this._next.accessible_name = _('Next');
        row.add_child(this._next);
        this.add_child(row);

        this._sound = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'nook-cc-volume',
            x_expand: true,
        });
        this._slider = new VolumeSlider(
            level => this._showLevel(level),
            level => act(this._device, home => home.setVolume(this._device, level)));
        this._slider.accessible_name = _('Volume');
        this._sound.add_child(this._slider);
        // Within the handle at zero volume, so it always sits on white.
        this._volumeIcon = new St.Icon({
            style_class: 'nook-cc-volume-icon',
            icon_size: 14,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sound.add_child(this._volumeIcon);
        this.add_child(this._sound);
        this.sync();
    }

    get device() {
        return this._device;
    }

    _control(onClick) {
        const button = new St.Button({
            style_class: 'nook-cc-control',
            child: new St.Icon({icon_size: 18}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    // An offline speaker keeps its last state.
    _pick() {
        const online = this._speakers.filter(d => d.online !== false);
        return online.find(playingNow) ?? online.find(d => d.state?.media?.state === 'PAUSED') ?? null;
    }

    sync() {
        const device = this._pick();
        this.visible = device !== null;
        for (const row of this._rows)
            row.visible = row.device !== device;
        // A module left with only the playing speaker goes with it.
        for (const grid of new Set(this._rows.map(row => row.get_parent())))
            grid.get_parent().visible = grid.get_children().some(child => child.visible);
        if (!device)
            return;
        this._device = device;
        const state = device.state ?? {};
        const media = state.media;
        const name = this._nameOf(device);
        this._song.text = media?.title ?? state.app ?? _('Nothing playing');
        const paused = media?.state === 'PAUSED' ? _('Paused') : null;
        this._from.text = [state.group ?? name, paused].filter(Boolean).join(' · ');
        this._open.accessible_name = name;
        this._glyph.setName(Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model)[0]);
        const shade = share => mediaColor(device).map(v => Math.round(v * 255 * share)).join(', ');
        this._art.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(1)}); background-gradient-end: rgb(${shade(0.7)});`;
        showCastPlay(this._play, device);
        this._next.reactive = castAllows(media, 64);
        this._sound.visible = typeof state.volume === 'number';
        if (!this._sound.visible)
            return;
        this._slider.showLevel(state.volume);
        this._showLevel(state.volume);
    }

    _showLevel(level) {
        this._volumeIcon.icon_name = volumeIcon(level, this._device.state?.muted === true);
    }
});
