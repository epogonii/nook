// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CastError} from './errors.js';
import {castAllows, castToggle, mediaColor, showCastPlay, speakerKind} from './hero.js';
import {playingNow} from './rows.js';
import {VERTICAL, readSetting, volumeIcon} from './text.js';
import {Scene, VolumeSlider} from './widgets.js';

function clock(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    const rest = String(whole % 60).padStart(2, '0');
    if (minutes < 60)
        return `${minutes}:${rest}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}

export class MediaCard {
    async _openMediaCard(device) {
        const source = device.source;
        const again = this._card === device;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!device.state)
            this._showLoading(true);
        else if (!again)
            this._fillMediaCard(device);
        await source.readDevice(device);
        if (this._card !== device || source !== this._cast)
            return;
        this._fillMediaCard(device);
    }

    _fillMediaCard(device) {
        if (!device.online || !device.state) {
            this._message(_('The speaker is not answering. Is it on the same network?'));
            return;
        }
        if (this._media?.device === device) {
            this._syncMediaCard();
            return;
        }
        this._clear();
        const home = device.source;
        const m = {device, tick: 0};
        m.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-media'});

        const hero = new St.BoxLayout({style_class: 'nook-media-hero'});
        m.scene = new Scene('speaker', 'nook-hero-scene', false);
        hero.add_child(m.scene);
        const text = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'nook-hero-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        m.song = new St.Label({style_class: 'nook-media-song'});
        m.artist = new St.Label({style_class: 'nook-hero-small'});
        for (const label of [m.song, m.artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        const status = new St.BoxLayout({style_class: 'nook-hero-status'});
        m.dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        status.add_child(m.dot);
        m.app = new St.Label({style_class: 'nook-hero-small', y_align: Clutter.ActorAlign.CENTER});
        status.add_child(m.app);
        text.add_child(status);
        hero.add_child(text);
        m.box.add_child(hero);

        m.time = new St.BoxLayout({...VERTICAL, style_class: 'nook-media-time'});
        m.progress = new Scene('progress', 'nook-media-progress');
        m.time.add_child(m.progress);
        const times = new St.BoxLayout({style_class: 'nook-media-times'});
        m.elapsed = new St.Label({x_expand: true});
        times.add_child(m.elapsed);
        m.length = new St.Label();
        times.add_child(m.length);
        m.time.add_child(times);
        m.box.add_child(m.time);

        const controls = new St.BoxLayout({style_class: 'nook-media-controls', x_align: Clutter.ActorAlign.CENTER});
        m.previous = this._addRoundButton(controls, 'media-skip-backward-symbolic', _('Previous'),
            () => this._castDo(device, () => home.skip(device, -1)));
        m.play = this._addRoundButton(controls, 'media-playback-start-symbolic', _('Play'),
            () => this._castDo(device, () => castToggle(home, device)));
        m.play.add_style_class_name('nook-play');
        m.play.child.icon_size = 22;
        m.next = this._addRoundButton(controls, 'media-skip-forward-symbolic', _('Next'),
            () => this._castDo(device, () => home.skip(device, 1)));
        m.box.add_child(controls);

        const volume = new St.BoxLayout({style_class: 'nook-media-volume'});
        m.mute = this._addRoundButton(volume, 'audio-volume-high-symbolic', _('Mute'),
            () => this._castDo(device, () => home.setMuted(device, !device.state.muted)));
        m.mute.add_style_class_name('nook-step');
        m.volume = new VolumeSlider(
            level => this._showVolume(level),
            level => this._castDo(device, () => home.setVolume(device, level)));
        volume.add_child(m.volume);
        m.level = new St.Label({style_class: 'nook-media-level', y_align: Clutter.ActorAlign.CENTER});
        volume.add_child(m.level);
        m.box.add_child(volume);

        this._body.add_child(m.box);
        const fillInfo = this._addDeviceInfo(device);
        home.details(device).then(() => {
            if (this._media === m)
                fillInfo();
        }).catch(logError);
        this._media = m;
        // Cast reports the position only on status changes; advance it locally.
        m.tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._showMediaTime();
            return GLib.SOURCE_CONTINUE;
        });
        this._syncMediaCard();
    }

    _forgetMedia() {
        const m = this._media;
        if (!m)
            return;
        if (m.tick)
            GLib.source_remove(m.tick);
        m.scene.run(false);
        this._media = null;
    }

    _syncMediaCard() {
        const m = this._media;
        const state = m.device.state ?? {};
        const media = state.media;
        const playing = playingNow(m.device);
        if (media?.title) {
            m.song.text = media.title;
            m.artist.text = media.artist ?? media.album ?? '';
        } else if (state.app) {
            m.song.text = state.app;
            m.artist.text = state.text && state.text !== state.app ? state.text : '';
        } else {
            m.song.text = _('Nothing playing');
            m.artist.text = '';
        }
        m.artist.visible = m.artist.text !== '';
        const paused = media?.state === 'PAUSED' ? _('Paused') : null;
        m.app.text = [state.group, state.app, paused].filter(Boolean).join(' · ') || _('Ready');
        if (playing)
            m.dot.add_style_pseudo_class('checked');
        else
            m.dot.remove_style_pseudo_class('checked');

        const color = mediaColor(m.device);
        const shade = share => color.map(v => Math.round(v * 255 * share));
        m.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(0.5)}); background-gradient-end: rgb(${shade(0.24)});`;

        showCastPlay(m.play, m.device);
        m.next.reactive = castAllows(media, 64);
        m.previous.reactive = castAllows(media, 128);

        const level = state.volume ?? 0;
        m.volume.showLevel(level);
        this._showVolume(level);
        m.scene.show({
            kind: speakerKind(m.device.castModel),
            playing,
            volume: level,
            muted: state.muted,
            color,
        });
        m.scene.run(playing && this._menu.isOpen);
        this._showMediaTime();
    }

    _showVolume(level) {
        const m = this._media;
        const muted = m.device.state?.muted === true;
        m.level.text = `${Math.round(level * 100)} %`;
        m.mute.child.icon_name = volumeIcon(level, muted);
        m.mute.accessible_name = muted ? _('Unmute') : _('Mute');
    }

    _showMediaTime() {
        const m = this._media;
        if (!m || !this._menu.isOpen)
            return;
        const media = m.device.state?.media;
        const duration = media?.duration;
        m.time.visible = typeof duration === 'number' && duration > 0;
        if (!m.time.visible)
            return;
        let position = media.position ?? 0;
        if (media.state === 'PLAYING' && media.at)
            position += (GLib.get_monotonic_time() - media.at) / 1e6;
        position = Math.min(duration, position);
        m.progress.show({share: position / duration});
        m.elapsed.text = clock(position);
        m.length.text = `-${clock(duration - position)}`;
    }

    async _castDo(device, action) {
        try {
            await action();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof CastError) && !(e instanceof GLib.Error)) {
                logError(e);
                return;
            }
            if (this._gone)
                return;
            Main.notifyError(device.name, e.message);
        }
        if (this._media?.device === device)
            this._syncMediaCard();
        else if (!this._card)
            this._tiles.forEach(tile => tile.sync());
    }

    _castChanged(cast, device) {
        if (cast !== this._cast)
            return;
        if (this._media?.device === device)
            this._syncMediaCard();
        else if (!this._card)
            this._tiles.forEach(tile => tile.sync());
    }
}
