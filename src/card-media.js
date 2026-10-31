// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _, pgettext} from 'gettext';

import {roundButton, sliderRow, volumeIcon} from './card-parts.js';
import {heroOf} from './hero.js';
import {CastError} from './lib/cast-home.js';

const VOLUME = {name: 'volume', range: [0, 100, 1], unit: 'percentage'};

// An app with no media session and no playing group takes no pause, only a receiver STOP.
export const onlyStops = device => Boolean(device.state?.app) && !device.state.media;
export const playingNow = device => ['PLAYING', 'BUFFERING'].includes(device.state?.media?.state) || onlyStops(device);

// Cast supportedMediaCommands bits: 64 next, 128 previous. A media status
// without the field allows everything.
export const castAllows = (media, bit) => Boolean(media) && (typeof media.commands !== 'number' || (media.commands & bit) !== 0);

export function clock(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    const rest = String(whole % 60).padStart(2, '0');
    if (minutes < 60)
        return `${minutes}:${rest}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}

// A Cast speaker's player in its page's card: how far along, the transport and the volume.
// The card's own scene and text say what plays.
export class MediaCard {
    constructor({device, toast, written}) {
        this._device = device;
        this._home = device.source;
        this._toast = toast;
        this._written = written;
        this._tick = 0;
        this._gone = false;
        this.groups = [];
        const home = this._home;

        const stage = this.stage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ['nook-stage', 'nook-media']});
        this._line = new Gtk.Label({justify: Gtk.Justification.CENTER, wrap: true, css_classes: ['nook-media-line']});
        stage.append(this._line);

        this._time = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        this._progress = new Gtk.ProgressBar();
        this._time.append(this._progress);
        const times = new Gtk.Box({css_classes: ['nook-media-times', 'numeric']});
        this._elapsed = new Gtk.Label({xalign: 0, hexpand: true});
        times.append(this._elapsed);
        this._remaining = new Gtk.Label({xalign: 1});
        times.append(this._remaining);
        this._time.append(times);
        stage.append(this._time);

        const controls = new Gtk.Box({spacing: 20, halign: Gtk.Align.CENTER});
        this._previous = roundButton('media-skip-backward-symbolic', _('Previous'),
            () => this._do(() => home.skip(device, -1)));
        this._play = roundButton('media-playback-start-symbolic', pgettext('action', 'Play'),
            () => this._do(() => this._toggle()));
        this._play.add_css_class('nook-media-play');
        this._next = roundButton('media-skip-forward-symbolic', _('Next'),
            () => this._do(() => home.skip(device, 1)));
        for (const button of [this._previous, this._play, this._next])
            controls.append(button);
        stage.append(controls);

        this._mute = roundButton('audio-volume-high-symbolic', _('Mute'),
            () => this._do(() => home.setMuted(device, device.state?.muted !== true)));
        const level = device.state?.volume;
        this._volume = sliderRow(_('Volume'), VOLUME, typeof level === 'number' ? Math.round(level * 100) : null,
            value => this._do(() => home.setVolume(device, value / 100)), false, this._mute);
        this._volumeLine = this._volume.widget;
        // The icon follows the slider before the speaker takes the level.
        this._volume.scale.connect('value-changed', () => this._showMute());
        stage.append(this._volumeLine);

        stage.connect('map', () => this._runClock());
        stage.connect('unmap', () => this._runClock());
        this.sync();

        home.readDevice(device).then(() => {
            if (this._gone)
                return;
            this.sync();
            written();
        }).catch(logError);
        // Firmware, MAC, network and uptime for the page's details.
        home.details(device).then(() => {
            if (!this._gone)
                written();
        }).catch(logError);
    }

    sync() {
        if (this._gone)
            return;
        const device = this._device;
        const state = device.state;
        this.stage.visible = Boolean(state) && device.online !== false;
        if (this.stage.visible)
            this._show(state);
        this._runClock();
    }

    forget() {
        this._gone = true;
        this._runClock();
    }

    _show(state) {
        const device = this._device;
        const media = state.media;
        const stops = onlyStops(device);

        // Only what the card's text above leaves out: the group, a paused app, a follower's status.
        const hero = heroOf(device);
        const said = new Set([hero.big, ...hero.small?.split(' · ') ?? []]);
        const parts = [
            state.group,
            state.app,
            stops && state.text !== state.app ? state.text : null,
            media?.state === 'PAUSED' ? _('Paused') : null,
        ].filter(part => part && !said.has(part));
        this._line.label = parts.join(' · ');
        this._line.visible = parts.length > 0;

        let [icon, label] = ['media-playback-start-symbolic', pgettext('action', 'Play')];
        if (stops)
            [icon, label] = ['media-playback-stop-symbolic', _('Stop')];
        else if (playingNow(device))
            [icon, label] = ['media-playback-pause-symbolic', _('Pause')];
        this._play.icon_name = icon;
        this._play.tooltip_text = label;
        this._play.sensitive = Boolean(media) || stops;
        this._next.sensitive = castAllows(media, 64);
        this._previous.sensitive = castAllows(media, 128);

        const known = typeof state.volume === 'number';
        this._volume.update(known ? Math.round(state.volume * 100) : null);
        this._volumeLine.sensitive = known;
        this._showMute();
        this._showTime();
    }

    // As the slider shows it: a level just dragged may not be the speaker's yet.
    _showMute() {
        const state = this._device.state;
        const muted = state?.muted === true;
        let level = 1;
        if (typeof state?.volume === 'number')
            level = this._volume.scale.get_value() / 100;
        this._mute.icon_name = volumeIcon(level, muted);
        this._mute.tooltip_text = muted ? _('Unmute') : _('Mute');
    }

    _showTime() {
        const media = this._device.state?.media;
        const duration = media?.duration;
        this._time.visible = typeof duration === 'number' && duration > 0;
        if (!this._time.visible)
            return;
        let position = media.position ?? 0;
        if (media.state === 'PLAYING' && media.at)
            position += (GLib.get_monotonic_time() - media.at) / 1e6;
        position = Math.min(duration, Math.max(0, position));
        this._progress.fraction = position / duration;
        this._elapsed.label = clock(position);
        this._remaining.label = `-${clock(duration - position)}`;
    }

    // Cast reports the position only on status changes; advance it locally.
    _runClock() {
        const media = this._device.state?.media;
        const wanted = !this._gone && this.stage.get_mapped() && media?.state === 'PLAYING' && media.duration > 0;
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

    _toggle() {
        const device = this._device;
        if (onlyStops(device))
            return this._home.stop(device);
        return playingNow(device) ? this._home.pause(device) : this._home.play(device);
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
            if (!this._gone) {
                this._toast(e.message);
                this.sync();
            }
            return;
        }
        if (this._gone)
            return;
        this.sync();
        this._written();
    }
}
