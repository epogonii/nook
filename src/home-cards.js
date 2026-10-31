// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import {gettext as _, pgettext} from 'gettext';

import {ClimateWrites} from './card-climate.js';
import {castAllows, clock, playingNow} from './card-media.js';
import {roundButton} from './card-parts.js';
import {CastError} from './lib/cast-home.js';
import {MODES} from './lib/climate.js';
import {newSession, send} from './lib/net.js';
import {modeText, numberFormat} from './text.js';

// Covers by address, the last few. The speaker's app names one; the app's own server has it.
const COVERS_KEPT = 8;
const COVER_BYTES = 4 << 20;
const covers = new Map();
let session = null;

async function coverOf(url) {
    if (covers.has(url))
        return covers.get(url);
    const message = Soup.Message.new('GET', url);
    let texture = null;
    if (message) {
        session ??= newSession();
        const bytes = await send(session, message);
        const [type] = message.get_response_headers().get_content_type();
        if (message.status_code === Soup.Status.OK && type?.startsWith('image/') && bytes.get_size() <= COVER_BYTES) {
            try {
                texture = Gdk.Texture.new_from_bytes(bytes);
            } catch (e) {
                console.debug(`nook: cover ${url}: ${e.message}`);
            }
        }
    }
    covers.set(url, texture);
    if (covers.size > COVERS_KEPT)
        covers.delete(covers.keys().next().value);
    return texture;
}

let speaker;

// The speaker itself, where its app shows no cover.
function speakerPicture() {
    if (speaker === undefined) {
        const uri = GLib.Uri.resolve_relative(import.meta.url, 'pictures/speaker.png', GLib.UriFlags.NONE);
        try {
            speaker = Gdk.Texture.new_from_file(Gio.File.new_for_uri(uri));
        } catch (e) {
            console.warn(`nook: ${uri}: ${e.message}`);
            speaker = null;
        }
    }
    return speaker;
}

const COVER_SIZE = 120;

// Sized by its frame, whatever the picture's own size.
const Cover = GObject.registerClass(
class Cover extends Gtk.Picture {
    vfunc_measure() {
        return [0, 0, -1, -1];
    }
});

const line = classes => new Gtk.Label({xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: classes});

function toast(widget, text) {
    widget.get_root()?.add_toast?.(new Adw.Toast({title: text}));
}

// What a speaker plays: the cover, the title, how far along, and its transport.
export const PlayerCard = GObject.registerClass(
class PlayerCard extends Gtk.Box {
    _init(device, home) {
        super._init({spacing: 18, css_classes: ['card', 'nook-wide', 'nook-player']});
        this.device = device;
        this._home = home;
        this._tick = 0;
        this._gone = false;
        this._coverUrl = null;

        this._cover = new Cover();
        this._frame = new Adw.Bin({
            child: this._cover,
            overflow: Gtk.Overflow.HIDDEN,
            valign: Gtk.Align.CENTER,
            width_request: COVER_SIZE,
            height_request: COVER_SIZE,
            css_classes: ['nook-player-cover'],
        });
        this.append(this._frame);
        this._setCover(null);

        const text = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER});
        this._name = line(['caption-heading', 'dim-label']);
        this._title = line(['nook-player-title']);
        this._artist = line(['dim-label']);
        for (const label of [this._name, this._title, this._artist])
            text.append(label);
        this._progress = new Gtk.ProgressBar({margin_top: 12});
        text.append(this._progress);

        const source = device.source;
        this._previous = roundButton('media-skip-backward-symbolic', _('Previous'), () => this._do(() => source.skip(device, -1)));
        this._play = roundButton('media-playback-start-symbolic', pgettext('action', 'Play'),
            () => this._do(() => (playingNow(device) ? source.pause(device) : source.play(device))));
        this._next = roundButton('media-skip-forward-symbolic', _('Next'), () => this._do(() => source.skip(device, 1)));
        this._previous.add_css_class('flat');
        this._next.add_css_class('flat');
        this._play.add_css_class('nook-player-play');
        const controls = new Gtk.Box({spacing: 6});
        for (const button of [this._previous, this._play, this._next])
            controls.append(button);
        this._elapsed = new Gtk.Label({xalign: 0});
        this._duration = new Gtk.Label({xalign: 1});
        text.append(new Gtk.CenterBox({
            start_widget: this._elapsed,
            center_widget: controls,
            end_widget: this._duration,
            margin_top: 6,
            css_classes: ['numeric', 'caption', 'nook-player-times'],
        }));
        this.append(text);

        this.connect('map', () => this._runClock());
        this.connect('unmap', () => this._runClock());
        this.sync();
    }

    sync() {
        const state = this.device.state;
        const media = state?.media;
        if (this._gone || !media)
            return;
        const name = this._home.nameOf(this.device);
        this._name.label = state.group && state.group !== name ? `${name} · ${state.group}` : name;
        this._title.label = media.title || state.app || '';
        this._artist.label = media.artist ?? '';
        this._artist.visible = Boolean(media.artist);
        const playing = playingNow(this.device);
        this._play.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._play.tooltip_text = playing ? _('Pause') : pgettext('action', 'Play');
        this._next.sensitive = castAllows(media, 64);
        this._previous.sensitive = castAllows(media, 128);
        this._showTime();
        this._runClock();
        this._showCover(media.image ?? null);
    }

    forget() {
        this._gone = true;
        this._runClock();
    }

    _showTime() {
        const media = this.device.state?.media;
        const duration = media?.duration;
        const known = typeof duration === 'number' && duration > 0;
        this._progress.visible = known;
        this._elapsed.label = '';
        this._duration.label = '';
        if (!known)
            return;
        let position = media.position ?? 0;
        if (media.state === 'PLAYING' && media.at)
            position += (GLib.get_monotonic_time() - media.at) / 1e6;
        position = Math.min(duration, Math.max(0, position));
        this._progress.fraction = position / duration;
        this._elapsed.label = clock(position);
        this._duration.label = clock(duration);
    }

    // Cast reports the position only on status changes; advance it here.
    _runClock() {
        const media = this.device.state?.media;
        const wanted = !this._gone && this.get_mapped() && media?.state === 'PLAYING' && media.duration > 0;
        if (wanted && !this._tick) {
            this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._showTime();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._tick) {
            GLib.source_remove(this._tick);
            this._tick = 0;
        }
    }

    // The last cover stays until the next one comes.
    _showCover(url) {
        if (url === this._coverUrl)
            return;
        this._coverUrl = url;
        if (!url || covers.has(url)) {
            this._setCover(url ? covers.get(url) : null);
            return;
        }
        coverOf(url).catch(e => {
            console.debug(`nook: cover ${url}: ${e.message}`);
            return null;
        }).then(texture => {
            if (!this._gone && this._coverUrl === url)
                this._setCover(texture);
        });
    }

    _setCover(texture) {
        this._cover.content_fit = texture ? Gtk.ContentFit.COVER : Gtk.ContentFit.CONTAIN;
        this._cover.paintable = texture ?? speakerPicture();
        if (texture)
            this._frame.remove_css_class('empty');
        else
            this._frame.add_css_class('empty');
    }

    async _do(action) {
        try {
            await action();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof CastError) && !(e instanceof GLib.Error)) {
                logError(e);
                return;
            }
            if (!this._gone)
                toast(this, e.message);
            return;
        }
        this._home.onEvent();
    }
});

// An air conditioner that is on: how warm the room is, the target and the mode.
export const AirconCard = GObject.registerClass(
class AirconCard extends Gtk.Box {
    _init(device, home) {
        super._init({orientation: Gtk.Orientation.VERTICAL, spacing: 10, css_classes: ['card', 'nook-wide', 'nook-aircon']});
        this.device = device;
        this._home = home;
        this._gone = false;
        this._modes = null;
        this._writes = new ClimateWrites(device, {
            changed: () => this.sync(),
            toast: text => toast(this, text),
            done: () => home.onEvent(),
        });

        this._name = line(['caption-heading', 'dim-label']);
        this.append(this._name);
        const figures = new Gtk.Box({spacing: 10, vexpand: true});
        this._inside = this._figure(_('Inside'));
        this._inside.box.hexpand = true;
        figures.append(this._inside.box);
        this._minus = roundButton('list-remove-symbolic', _('Cooler'), () => this._writes.nudge(-1));
        this._plus = roundButton('list-add-symbolic', _('Warmer'), () => this._writes.nudge(1));
        this._target = this._figure(_('Target'));
        this._stepper = new Gtk.Box({spacing: 10, halign: Gtk.Align.END});
        for (const part of [this._minus, this._target.box, this._plus])
            this._stepper.append(part);
        figures.append(this._stepper);
        this.append(figures);
        this._chips = new Gtk.Box({spacing: 6, css_classes: ['nook-aircon-modes']});
        this.append(this._chips);
        this.sync();
    }

    // A big number, what it is under it.
    _figure(caption) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER});
        const value = new Gtk.Label({xalign: 0, css_classes: ['numeric', 'nook-aircon-figure']});
        box.append(value);
        box.append(new Gtk.Label({label: caption, xalign: 0, css_classes: ['caption', 'dim-label']}));
        return {box, value};
    }

    sync() {
        const {state, caps} = this.device;
        if (this._gone || !state || !caps)
            return;
        const shown = this._writes.shown(state);
        this._name.label = this._home.nameOf(this.device);
        const inside = state.roomTemperature;
        this._inside.box.visible = typeof inside === 'number';
        this._inside.value.label = typeof inside === 'number' ? `${numberFormat.format(inside)}°` : '';
        this._stepper.visible = Boolean(caps.range);
        if (caps.range) {
            const [min, max] = caps.range;
            const target = shown.SetTem;
            const known = typeof target === 'number';
            this._target.value.label = known ? `${numberFormat.format(target)}°` : '–';
            this._minus.sensitive = !known || target > min;
            this._plus.sensitive = !known || target < max;
        }
        this._showModes((caps.modes ?? []).filter(i => MODES[i]), shown.Mod);
        this.sensitive = this.device.online !== false;
    }

    // Chips made once for the unit's modes; the one it runs in is checked.
    _showModes(modes, mode) {
        const key = modes.join(' ');
        if (this._modes?.key !== key) {
            for (let child = this._chips.get_first_child(); child; child = this._chips.get_first_child())
                this._chips.remove(child);
            let group = null;
            const buttons = new Map();
            for (const i of modes) {
                const chip = new Gtk.ToggleButton({label: modeText(i), group});
                group ??= chip;
                chip.connect('toggled', () => {
                    if (chip.active && !this._modes.showing && this._writes.shown(this.device.state ?? {}).Mod !== i)
                        this._writes.write({Mod: i});
                });
                this._chips.append(chip);
                buttons.set(i, chip);
            }
            this._modes = {key, buttons, showing: false};
        }
        this._chips.visible = modes.length > 1;
        this._modes.showing = true;
        for (const [i, chip] of this._modes.buttons)
            chip.active = i === mode;
        this._modes.showing = false;
    }

    // A target still settling goes out now.
    forget() {
        this._gone = true;
        this._writes.forget();
    }
});
