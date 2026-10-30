// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import System from 'system';
import {gettext as _} from 'gettext';

import {CameraError} from './cameras.js';
import {loadingRow, noteRow, roundButton} from './card-parts.js';
import {OnvifError} from './lib/onvif.js';
import {TapoError, WRONG_PASSWORD} from './lib/tapo-local.js';
import {aspectBox, glyphArea, navigationRow} from './widgets.js';

Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

// feed.js exit codes.
const NO_GSTREAMER = 2;
const REFUSED = 3;
const NO_PLUGIN = 4;

// Pan per click: PAN_STEP ms at PAN_SPEED. The C200 ignores the time limit sent with a
// move; the stop that follows ends it.
const PAN_STEP = 500;
const PAN_SPEED = 0.5;

// Double click or double tap zooms the picture in on that point; doing it again zooms out.
// Zoomed in, a drag moves the picture.
const ZOOM = 2.5;
const ZOOM_MS = 200;

// s the siren stays armed after the first press.
const SIREN_ARMED = 4;

// Frames between collections: a frame's texture and bytes are freed only with their
// wrappers, and the GC doesn't count that memory (hundreds of MB within a minute).
const COLLECT_EVERY = 8;

function readLine(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            try {
                resolve(stream.read_line_finish_utf8(result)[0]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readExactly(stream, count, cancellable) {
    const frame = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
        const bytes = await stream.read_bytes_async(count - filled, GLib.PRIORITY_DEFAULT, cancellable);
        if (bytes.get_size() === 0)
            return null;
        frame.set(bytes.toArray(), filled);
        filled += bytes.get_size();
    }
    return new GLib.Bytes(frame);
}

async function saveSnapshot(folder, file, jpeg) {
    try {
        await folder.make_directory_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
    await file.replace_contents_bytes_async(new GLib.Bytes(jpeg), null, false, Gio.FileCreateFlags.NONE, null);
}

// Directions are the picture's, not the text direction's. The theme mirrors start/end
// arrows in RTL, so swap them there.
function panButtons() {
    const rtl = Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL;
    return [
        [rtl ? 'pan-end-symbolic' : 'pan-start-symbolic', _('Turn Left'), -1, 0],
        [rtl ? 'pan-start-symbolic' : 'pan-end-symbolic', _('Turn Right'), 1, 0],
        ['pan-up-symbolic', _('Turn Up'), 0, 1],
        ['pan-down-symbolic', _('Turn Down'), 0, -1],
    ];
}

// Requests are serialised so a stop never overtakes its move, and a move in flight when
// the page closes still gets its stop.
class Panner {
    constructor(camera, onError) {
        this._camera = camera;
        this._onError = onError;
        this._chain = Promise.resolve();
        this._timer = 0;
    }

    nudge(x, y) {
        this._queue(() => this._camera.move(x * PAN_SPEED, y * PAN_SPEED));
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAN_STEP, () => {
            this._timer = 0;
            this._queue(() => this._camera.stop());
            return GLib.SOURCE_REMOVE;
        });
    }

    home() {
        this.finish();
        this._queue(() => this._camera.home());
    }

    finish() {
        if (!this._timer)
            return;
        GLib.source_remove(this._timer);
        this._timer = 0;
        this._queue(() => this._camera.stop());
    }

    _queue(task) {
        this._chain = this._chain.then(task).catch(e => this._onError(e));
    }
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

// The picture, fitted in black, and zoomed in on a point.
const LiveView = GObject.registerClass(
class LiveView extends Gtk.Widget {
    _init() {
        super._init({accessible_role: Gtk.AccessibleRole.IMG});
        this._picture = null;
        this._zoomed = false;
        this._at = {scale: 1, x: 0, y: 0};
        this._animation = null;
        this._drag = null;
        const click = new Gtk.GestureClick();
        click.connect('pressed', (gesture, presses, x, y) => {
            if (presses !== 2)
                return;
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            this._zoom(x, y);
        });
        this.add_controller(click);
        const drag = new Gtk.GestureDrag();
        drag.connect('drag-begin', gesture => {
            this._drag = null;
            if (!this._zoomed || this._animation)
                return;
            // At once: the page's scroller takes a touch drag otherwise.
            gesture.set_state(Gtk.EventSequenceState.CLAIMED);
            this._drag = {x: this._at.x, y: this._at.y};
        });
        drag.connect('drag-update', (_gesture, dx, dy) => {
            if (!this._drag)
                return;
            this._at.x = clamp(this._drag.x + dx, this.get_width() * (1 - ZOOM), 0);
            this._at.y = clamp(this._drag.y + dy, this.get_height() * (1 - ZOOM), 0);
            this.queue_draw();
        });
        drag.connect('drag-end', () => {
            this._drag = null;
        });
        this.add_controller(drag);
        // A press the drag claims still counts toward a double click.
        drag.group(click);
    }

    setPicture(paintable) {
        if (paintable === this._picture)
            return;
        this._picture = paintable;
        this.queue_draw();
    }

    _zoom(x, y) {
        this._animation?.skip();
        this._zoomed = !this._zoomed;
        const from = {...this._at};
        // Shifting by what the scale moves the tapped point keeps it under the finger.
        const to = this._zoomed ? {scale: ZOOM, x: x * (1 - ZOOM), y: y * (1 - ZOOM)} : {scale: 1, x: 0, y: 0};
        const animation = new Adw.TimedAnimation({
            widget: this,
            value_from: 0,
            value_to: 1,
            duration: ZOOM_MS,
            easing: Adw.Easing.EASE_OUT_QUAD,
            target: Adw.CallbackAnimationTarget.new(t => {
                this._at = {
                    scale: from.scale + (to.scale - from.scale) * t,
                    x: from.x + (to.x - from.x) * t,
                    y: from.y + (to.y - from.y) * t,
                };
                this.queue_draw();
            }),
        });
        animation.connect('done', () => {
            if (this._animation === animation)
                this._animation = null;
        });
        this._animation = animation;
        animation.play();
    }

    vfunc_snapshot(snapshot) {
        const picture = this._picture;
        const width = this.get_width();
        const height = this.get_height();
        const pictureWidth = picture?.get_intrinsic_width() ?? 0;
        const pictureHeight = picture?.get_intrinsic_height() ?? 0;
        if (pictureWidth <= 0 || pictureHeight <= 0 || width <= 0 || height <= 0)
            return;
        const fit = Math.min(width / pictureWidth, height / pictureHeight);
        snapshot.save();
        snapshot.translate(new Graphene.Point({x: this._at.x, y: this._at.y}));
        snapshot.scale(this._at.scale, this._at.scale);
        snapshot.translate(new Graphene.Point({x: (width - pictureWidth * fit) / 2, y: (height - pictureHeight * fit) / 2}));
        picture.snapshot(snapshot, pictureWidth * fit, pictureHeight * fit);
        snapshot.restore();
    }
});

// A camera's page: its live picture in the card with pan and snapshot buttons, Tapo's
// own settings as rows. The feed runs only while the picture is on screen.
export class CameraCard {
    constructor(ctx) {
        this._ctx = ctx;
        this._device = ctx.device;
        this._gone = false;
        this._cancellable = new Gio.Cancellable();
        this._controls = null;
        this._ready = false;
        this._problem = false;
        this._feed = null;
        this._live = false;
        this._frame = null;
        this._panner = null;
        this._panAsked = false;
        this._turnFailed = false;
        this._api = null;
        this._apiAsked = false;
        this._sirenTimer = 0;
        this._taking = false;
        this._action = null;
        this._rows = [];

        this._view = new LiveView();
        this._idle = glyphArea('camera', 28);
        this._idle.can_target = false;
        this._idle.add_css_class('nook-live-idle');
        this._spinner = new Adw.Spinner({
            width_request: 32,
            height_request: 32,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            can_target: false,
        });
        this._says = new Gtk.Label({wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 44});
        this._sayButton = new Gtk.Button({halign: Gtk.Align.CENTER, visible: false});
        this._sayButton.connect('clicked', () => this._action?.());
        this._status = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
            visible: false,
            css_classes: ['nook-live-status'],
        });
        this._status.append(this._says);
        this._status.append(this._sayButton);
        const overlay = new Gtk.Overlay({child: this._view});
        overlay.add_overlay(this._idle);
        overlay.add_overlay(this._spinner);
        overlay.add_overlay(this._status);
        this._picture = aspectBox(overlay, 16 / 9, 2000, {overflow: Gtk.Overflow.HIDDEN, css_classes: ['nook-live']});
        this._picture.connect('map', () => this._update());
        // Closing the window doesn't forget() the page.
        this._picture.connect('unmap', () => this._stopFeed());

        this._info = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, css_classes: ['nook-hero-status']});
        this._pad = new Gtk.Box({spacing: 6, visible: false, sensitive: false});
        this._pad.set_direction(Gtk.TextDirection.LTR);
        this._shoot = roundButton('camera-photo-symbolic', _('Take a Snapshot'), () => this._takeSnapshot().catch(logError));
        this._shoot.sensitive = false;
        this._bar = new Gtk.Box({spacing: 6});
        this._bar.append(this._info);
        this._bar.append(this._pad);
        this._bar.append(this._shoot);

        this.stage = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.stage.append(this._picture);
        this.stage.append(this._bar);

        this._group = new Adw.PreferencesGroup({title: _('Controls'), visible: false});
        this.groups = this._device.tapo && !this._device.test ? [this._group] : [];

        this.sync();
        this._check().catch(logError);
    }

    sync() {
        if (this._gone)
            return;
        if (!this._turnFailed)
            this._info.label = this._about();
        this._paint();
        this._update();
    }

    forget() {
        this._gone = true;
        this._cancellable.cancel();
        this._stopFeed();
        this._panner?.finish();
        this._panner = null;
        this._api?.abort();
        this._api = null;
        if (this._sirenTimer)
            GLib.source_remove(this._sirenTimer);
        this._sirenTimer = 0;
    }

    _about() {
        const device = this._device;
        return [device.model?.replace(/^tapo /, 'Tapo '), device.test ? '' : device.ip].filter(Boolean).join(' · ');
    }

    // The feed's last frame, else the camera's last still.
    _paint() {
        const picture = this._frame ?? this._ctx.home.stillOf?.(this._device) ?? null;
        this._view.setPicture(picture);
        const waiting = !this._problem && !this._live && this._device.online !== false;
        this._spinner.visible = waiting;
        this._status.visible = this._problem;
        this._idle.visible = !picture && !waiting && !this._problem;
    }

    // Over the picture until the page opens again; action: [label, run].
    _say(text, action = null) {
        this._problem = true;
        this._says.label = text;
        this._sayButton.visible = Boolean(action);
        if (action)
            [this._sayButton.label, this._action] = action;
        this._paint();
    }

    _refused() {
        this._say(_('The camera refused the login: the password is wrong, or the camera locked it for a while after too many tries.'));
    }

    _open(target) {
        this._ctx.page.get_root()?.showPage?.(target);
    }

    async _check() {
        const device = this._device;
        let account;
        try {
            account = await device.source.account(device);
        } catch (e) {
            console.debug(`nook-app: keyring: ${e.message}`);
            account = 'none';
        }
        if (this._gone)
            return;
        const accounts = [_('Open Accounts'), () => this._open(`accounts-tapo ${device.did}`)];
        if (account === 'unknown') {
            this._bar.visible = false;
            this._say(_('Search for cameras again in Accounts, under Cameras, so Nook learns how to reach this one.'), accounts);
            return;
        }
        if (account === 'none') {
            this._bar.visible = false;
            this._say(device.tapo
                ? _('Add the camera account from the Tapo app in Accounts, under Cameras.')
                : _('Add the login of this camera in Accounts, under Cameras.'), accounts);
            return;
        }
        if (account === 'unreadable') {
            this._bar.visible = false;
            this._say(_('The saved camera account could not be read. Save it again in Accounts, under Cameras.'), accounts);
            return;
        }
        let controls;
        try {
            controls = await device.source.controls(device);
        } catch (e) {
            if (!this._gone) {
                this._bar.visible = false;
                this._say(e.message);
            }
            return;
        }
        if (this._gone)
            return;
        this._controls = controls;
        this._ready = true;
        this._update();
    }

    // Starts what is due: the pan buttons, the settings and the feed, once the camera answers.
    _update() {
        if (this._gone || !this._ready)
            return;
        const device = this._device;
        const online = device.online !== false;
        this._shoot.sensitive = online && !this._taking;
        this._pad.sensitive = online;
        if (!online)
            return;
        if (!this._panAsked) {
            this._panAsked = true;
            this._addPan().catch(logError);
        }
        if (device.tapo && !device.test && !this._apiAsked) {
            this._apiAsked = true;
            this._addSettings().catch(logError);
        }
        if (!this._feed && !this._problem && this._picture.get_mapped())
            this._startFeed().catch(logError);
    }

    async _startFeed() {
        const device = this._device;
        // Refused recently: don't retry yet, every attempt keeps the camera locked out.
        if (!device.test && device.source.isRefused(device)) {
            this._refused();
            return;
        }
        const feed = this._feed = {cancellable: new Gio.Cancellable(), process: null, frames: 0};
        this._live = false;
        this._paint();
        let process;
        try {
            // Other ONVIF cameras say where their stream is first.
            if (!device.test)
                await device.source.streams(device, this._controls, feed.cancellable);
            process = await device.source.startFeed(device);
        } catch (e) {
            if (this._feed !== feed)
                return;
            this._feed = null;
            if (!(e instanceof OnvifError) && !(e instanceof CameraError) && !(e instanceof GLib.Error))
                throw e;
            if (e.refused) {
                device.source.refused(device);
                this._refused();
            } else {
                this._say(e.message);
            }
            return;
        }
        if (this._feed !== feed) {
            process.force_exit();
            return;
        }
        feed.process = process;
        process.wait_async(null).then(() => {
            if (this._feed === feed)
                this._ended(process.get_if_exited() ? process.get_exit_status() : -1);
        }).catch(logError);
        const stream = new Gio.DataInputStream({base_stream: process.get_stdout_pipe(), buffer_size: 1 << 20});
        this._readFrames(stream, feed).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        });
    }

    async _readFrames(stream, feed) {
        try {
            for (;;) {
                const line = await readLine(stream, feed.cancellable);
                if (line === null)
                    return;
                const [width, height] = line.split(' ').map(Number);
                if (!(width > 0 && height > 0))
                    return;
                const frame = await readExactly(stream, width * height * 3, feed.cancellable);
                if (!frame || this._feed !== feed)
                    return;
                this._frame = Gdk.MemoryTexture.new(width, height, Gdk.MemoryFormat.R8G8B8, frame, width * 3);
                this._live = true;
                this._paint();
                if (++feed.frames % COLLECT_EVERY === 0)
                    System.gc();
            }
        } finally {
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
            // Not reading any more: feed.js would block on a full pipe.
            if (this._feed === feed)
                feed.process.force_exit();
        }
    }

    _ended(status) {
        this._feed = null;
        if (status === NO_GSTREAMER) {
            this._say(_('GStreamer is needed to show the picture.'));
        } else if (status === NO_PLUGIN) {
            this._say(_('The picture needs a GStreamer plugin that is not installed.'));
        } else if (status === REFUSED) {
            this._device.source.refused(this._device);
            this._refused();
        } else {
            this._say(_('The camera stopped sending its picture.'));
        }
    }

    _stopFeed() {
        const feed = this._feed;
        this._feed = null;
        this._live = false;
        feed?.cancellable.cancel();
        feed?.process?.force_exit();
    }

    async _addPan() {
        const device = this._device;
        let abilities;
        try {
            abilities = await device.source.abilities(device, this._controls, this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`nook-app: ${device.did}: ${e.message}`);
            return;
        }
        if (this._gone || !abilities.pan)
            return;
        const panner = this._panner = new Panner(this._controls, e => {
            if (!(e instanceof OnvifError) && !(e instanceof GLib.Error)) {
                logError(e);
                return;
            }
            if (this._gone)
                return;
            this._turnFailed = true;
            this._info.label = _('Could not turn the camera: %s').replace('%s', e.message);
        });
        const turn = run => () => {
            this._turnFailed = false;
            this._info.label = this._about();
            run();
        };
        for (const [icon, label, x, y] of panButtons())
            this._pad.append(roundButton(icon, label, turn(() => panner.nudge(x, y))));
        if (abilities.home)
            this._pad.append(roundButton('go-home-symbolic', _('Turn to the Home Position'), turn(() => panner.home())));
        this._pad.visible = true;
    }

    async _takeSnapshot() {
        const device = this._device;
        if (!device.test && device.source.isRefused(device)) {
            this._stopFeed();
            this._refused();
            return;
        }
        this._taking = true;
        this._shoot.sensitive = false;
        const name = this._ctx.home.nameOf(device);
        try {
            const jpeg = await device.source.still(device);
            const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir();
            const folder = Gio.File.new_for_path(GLib.build_filenamev([pictures, 'Nook']));
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
            const file = folder.get_child(`${name.replaceAll('/', '-')} ${stamp}.jpg`);
            await saveSnapshot(folder, file, jpeg);
            if (!this._gone)
                this._saved(file);
        } catch (e) {
            if (this._gone)
                return;
            if (!(e instanceof CameraError) && !(e instanceof GLib.Error))
                throw e;
            if (!(e instanceof CameraError)) {
                this._ctx.toast(e.message);
            } else if (e.code === NO_GSTREAMER) {
                this._ctx.toast(_('GStreamer is needed to show the picture.'));
            } else if (e.code === NO_PLUGIN) {
                this._ctx.toast(_('The picture needs a GStreamer plugin that is not installed.'));
            } else if (e.code === REFUSED) {
                device.source.refused(device);
                this._stopFeed();
                this._refused();
            } else if (e.code !== 'no-stream') {
                // 'no-stream': the camera hasn't said where its stream is yet.
                this._ctx.toast(_('The camera sent no picture to save.'));
            }
        } finally {
            this._taking = false;
            this._update();
        }
    }

    _saved(file) {
        const root = this._ctx.page.get_root();
        if (typeof root?.add_toast !== 'function') {
            this._ctx.toast(_('Snapshot saved'));
            return;
        }
        const toast = new Adw.Toast({title: _('Snapshot saved'), button_label: _('Show in Files'), timeout: 6});
        toast.connect('button-clicked', () => {
            new Gtk.FileLauncher({file}).open_containing_folder(root, null, (launcher, result) => {
                try {
                    launcher.open_containing_folder_finish(result);
                } catch (e) {
                    console.debug(`nook-app: show in files: ${e.message}`);
                }
            });
        });
        root.add_toast(toast);
    }

    // Privacy, light, motion detection, night vision and the siren go through Tapo's own API.
    async _addSettings() {
        const device = this._device;
        this._group.visible = true;
        this._fill([loadingRow()]);
        let api;
        try {
            api = await device.source.openApi(device);
        } catch (e) {
            if (this._gone)
                return;
            if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
                throw e;
            this._fill(e.code === 'no-password'
                ? [noteRow(_('Privacy mode, the light, night vision and the siren need your TP-Link password, in Accounts under Cameras.')), this._passwordRow()]
                : [noteRow(e.message)]);
            return;
        }
        if (this._gone) {
            api.abort();
            return;
        }
        this._api = api;
        let state;
        try {
            state = await api.read();
        } catch (e) {
            if (this._gone || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
                throw e;
            this._fill(e.code === WRONG_PASSWORD
                ? [noteRow(_('The TP-Link password in Accounts is not the one this camera knows.')), this._passwordRow()]
                : [noteRow(e.message)]);
            return;
        }
        if (this._gone)
            return;
        // For Details the next time the page opens.
        if (state.about)
            device.about = {...device.about, ...state.about};
        const rows = [];
        for (const [key, title, set] of [
            ['privacy', _('Privacy Mode'), on => api.setPrivacy(on)],
            ['light', _('Status Light'), on => api.setLight(on)],
            ['motion', _('Motion Detection'), on => api.setMotion(on)],
            ['alarm', _('Siren on Motion'), on => api.setAlarm(on)],
        ]) {
            if (typeof state[key] === 'boolean')
                rows.push(this._switchRow(title, state[key], set));
        }
        if (state.night)
            rows.push(this._nightRow(state.night, mode => api.setNight(mode)));
        rows.push(this._sirenRow(api));
        this._fill(rows);
    }

    _fill(rows) {
        for (const row of this._rows)
            this._group.remove(row);
        this._rows = rows;
        for (const row of rows)
            this._group.add(row);
    }

    _passwordRow() {
        const row = navigationRow(_('TP-Link Password'));
        row.connect('activated', () => this._open('accounts-tapo admin'));
        return row;
    }

    _failed(e) {
        if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
            logError(e);
        else if (!this._gone && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            this._ctx.toast(e.message);
    }

    // Shows each pick at once; when no write is in flight any more, settles on the last one
    // the camera took.
    _optimistic(initial, show) {
        let acked = initial, ackedAsk = 0, asks = 0, pending = 0;
        return (value, write) => {
            const ask = ++asks;
            pending++;
            show(value);
            write(value).then(() => {
                if (ask > ackedAsk) {
                    acked = value;
                    ackedAsk = ask;
                }
                this._ctx.written?.();
            }, e => this._failed(e)).finally(() => {
                if (--pending === 0 && !this._gone)
                    show(acked);
            });
        };
    }

    _switchRow(title, active, set) {
        const row = new Adw.SwitchRow({title, active});
        let quiet = false;
        const pick = this._optimistic(active, on => {
            quiet = true;
            row.active = on;
            quiet = false;
        });
        row.connect('notify::active', () => {
            if (!quiet)
                pick(row.active, set);
        });
        return row;
    }

    _nightRow(night, set) {
        const modes = [['auto', _('Auto')], ['on', _('On')], ['off', _('Off')]];
        const row = new Adw.ComboRow({title: _('Night Vision'), model: Gtk.StringList.new(modes.map(([, label]) => label))});
        let quiet = false;
        const show = mode => {
            const index = modes.findIndex(([value]) => value === mode);
            quiet = true;
            row.selected = index >= 0 ? index : Gtk.INVALID_LIST_POSITION;
            quiet = false;
        };
        show(night);
        const pick = this._optimistic(night, show);
        row.connect('notify::selected', () => {
            const mode = modes[row.selected]?.[0];
            if (!quiet && mode)
                pick(mode, set);
        });
        return row;
    }

    // The first press arms it, the second within SIREN_ARMED s sounds it.
    _sirenRow(api) {
        const row = new Adw.ButtonRow({title: _('Sound the Siren')});
        row.add_css_class('destructive-action');
        let armed = false;
        let sounding = false;
        let pending = false;
        row.connect('activated', () => {
            if (pending)
                return;
            if (!sounding && !armed) {
                armed = true;
                row.title = _('Click Again to Sound It');
                this._sirenTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SIREN_ARMED, () => {
                    this._sirenTimer = 0;
                    armed = false;
                    row.title = _('Sound the Siren');
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            if (this._sirenTimer)
                GLib.source_remove(this._sirenTimer);
            this._sirenTimer = 0;
            const next = !sounding;
            armed = false;
            pending = true;
            api.siren(next).then(() => {
                sounding = next;
            }, e => this._failed(e)).finally(() => {
                pending = false;
                if (!this._gone)
                    row.title = sounding ? _('Stop the Siren') : _('Sound the Siren');
            });
        });
        return row;
    }
}
