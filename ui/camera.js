// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SHELL_MAJOR} from './text.js';
import {skeletonBlock} from './widgets.js';

// Must match NO_GSTREAMER, REFUSED and NO_PLUGIN in feed.js.
export const NO_GSTREAMER = 2;
export const REFUSED = 3;
export const NO_PLUGIN = 4;

// Wrapped by hand, not with Gio._promisify(): the shell already promisifies these for
// its own use, and re-patching them would change them shell-wide.
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

function readBytes(stream, count, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(count, GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            try {
                resolve(stream.read_bytes_finish(result));
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
        const bytes = await readBytes(stream, count - filled, cancellable);
        if (bytes.get_size() === 0)
            return null;
        frame.set(bytes.toArray(), filled);
        filled += bytes.get_size();
    }
    return new GLib.Bytes(frame);
}

export function showInFiles(file) {
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                connection.call_finish(result);
            } catch (e) {
                console.debug(`nook: show in files: ${e.message}`);
            }
        });
}

// Pan per click: PAN_STEP ms at PAN_SPEED. The C200 ignores the time limit sent with a
// move; the stop that follows ends it.
const PAN_STEP = 500;
const PAN_SPEED = 0.5;

// Double click or double tap zooms the picture in on that point; doing it again zooms out.
// Zoomed in, a drag moves the picture.
const ZOOM = 2.5;
const ZOOM_MS = 200;
// Logical px; a finger lands farther from its first tap than Clutter's double-click distance.
const TAP_SLOP = 32;

// Directions are the image's, not the text direction's. The theme mirrors start/end
// arrows in RTL, so swap them there.
export function panButtons() {
    const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
    return [
        [rtl ? 'pan-end-symbolic' : 'pan-start-symbolic', _('Turn Left'), -1, 0],
        [rtl ? 'pan-start-symbolic' : 'pan-end-symbolic', _('Turn Right'), 1, 0],
        ['pan-up-symbolic', _('Turn Up'), 0, 1],
        ['pan-down-symbolic', _('Turn Down'), 0, -1],
    ];
}

// Requests are serialised so a stop never overtakes its move, and a move in flight when
// the card closes still gets its stop.
export class Panner {
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

// Pointer events have no sequence.
function slotOf(event) {
    return event.get_event_sequence()?.get_slot() ?? -1;
}

export const CameraView = GObject.registerClass(
class CameraView extends St.Widget {
    _init(onRefused = null) {
        super._init({
            style_class: 'nook-camera',
            x_expand: true,
            reactive: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });
        // Frames go on a plain child actor: St.Widget paints its themed background over
        // its own content.
        this._content = St.ImageContent.new_with_preferred_size(16, 9);
        this._picture = new Clutter.Actor({
            content: this._content,
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._picture);
        this._zoomed = false;
        this._lastTap = null;
        this._drag = null;
        this._waiting = skeletonBlock();
        this.add_child(this._waiting);
        this._status = new St.Label({
            style_class: 'nook-camera-status',
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._status.clutter_text.line_wrap = true;
        this.add_child(this._status);
        this._process = null;
        this._cancellable = null;
        this._onRefused = onRefused;
        this.connect('destroy', () => this.stop());
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        return this._press(event);
    }

    vfunc_motion_event(event) {
        return this._move(event);
    }

    vfunc_button_release_event(event) {
        return this._release(event);
    }

    vfunc_touch_event(event) {
        switch (event.type()) {
        case Clutter.EventType.TOUCH_BEGIN:
            return this._press(event);
        case Clutter.EventType.TOUCH_UPDATE:
            return this._move(event);
        default:
            return this._release(event);
        }
    }

    _press(event) {
        this._drag = null;
        if (this._tap(event) || !this._zoomed || this._picture.get_transition('scale-x'))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = this._point(event);
        this._drag = {slot: slotOf(event), x, y, left: this._picture.translation_x, top: this._picture.translation_y};
        return Clutter.EVENT_STOP;
    }

    _move(event) {
        const drag = this._drag;
        if (!drag || slotOf(event) !== drag.slot)
            return Clutter.EVENT_PROPAGATE;
        // A release taken by another grab never arrives here; the button state tells.
        if (event.type() === Clutter.EventType.MOTION && !(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
            this._drag = null;
            return Clutter.EVENT_PROPAGATE;
        }
        const [x, y] = this._point(event);
        if (Math.hypot(x - drag.x, y - drag.y) > this._slop())
            this._lastTap = null;
        const [width, height] = this._picture.get_size();
        this._picture.translation_x = Math.min(Math.max(drag.left + x - drag.x, width * (1 - ZOOM)), 0);
        this._picture.translation_y = Math.min(Math.max(drag.top + y - drag.y, height * (1 - ZOOM)), 0);
        return Clutter.EVENT_STOP;
    }

    _release(event) {
        if (!this._drag || slotOf(event) !== this._drag.slot)
            return Clutter.EVENT_PROPAGATE;
        this._drag = null;
        return Clutter.EVENT_STOP;
    }

    // Returns whether it zoomed.
    _tap(event) {
        const [x, y] = this._point(event);
        const time = event.get_time();
        const last = this._lastTap;
        // Clutter.Settings.get_default() is gone in GNOME 51.
        const settings = global.stage.context?.get_settings?.() ?? Clutter.Settings.get_default();
        if (last && time !== last.time && time - last.time <= settings.double_click_time &&
            Math.hypot(x - last.x, y - last.y) <= this._slop()) {
            this._lastTap = null;
            this._zoom(x, y);
            return true;
        }
        this._lastTap = {x, y, time};
        return false;
    }

    _zoom(x, y) {
        this._zoomed = !this._zoomed;
        const scale = this._zoomed ? ZOOM : 1;
        // Shifting by what the scale moves the tapped point keeps it under the finger.
        this._picture.ease({
            scale_x: scale,
            scale_y: scale,
            translation_x: this._zoomed ? x * (1 - ZOOM) : 0,
            translation_y: this._zoomed ? y * (1 - ZOOM) : 0,
            duration: ZOOM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _point(event) {
        const [, x, y] = this.transform_stage_point(...event.get_coords());
        return [x, y];
    }

    _slop() {
        return TAP_SLOP * (St.ThemeContext.get_for_stage(global.stage).scale_factor || 1);
    }

    showRefused() {
        this._show(_('The camera refused the login: the password is wrong, or the camera locked it for a while after too many tries.'));
    }

    showProblem(text) {
        this._show(text);
    }

    start(path, account) {
        this.stop();
        const argv = ['gjs', '-m', `${path}/feed.js`];
        if (!account)
            argv.push('--test');
        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._show(e.message);
            return;
        }
        this._process = process;
        const cancellable = this._cancellable = new Gio.Cancellable();

        // Credentials go over stdin, never argv. If the helper already exited, the write
        // fails and wait_async below reports the exit.
        const stdin = process.get_stdin_pipe();
        const close = () => stdin.close_async(GLib.PRIORITY_DEFAULT, null, null);
        if (account) {
            const input = new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(account)}\n`));
            stdin.write_bytes_async(input, GLib.PRIORITY_DEFAULT, null, (_stdin, result) => {
                try {
                    stdin.write_bytes_finish(result);
                } catch (e) {
                    console.debug(`nook: camera: ${e.message}`);
                }
                close();
            });
        } else {
            close();
        }

        process.wait_async(cancellable, (_process, result) => {
            try {
                process.wait_finish(result);
            } catch {
                return;
            }
            if (this._process !== process)
                return;
            const status = process.get_exit_status();
            if (status === NO_GSTREAMER)
                this._show(_('GStreamer is needed to show the picture.'));
            else if (status === NO_PLUGIN)
                this._show(_('The picture needs a GStreamer plugin that is not installed.'));
            else if (status === REFUSED) {
                this.showRefused();
                this._onRefused?.();
            } else
                this._show(_('The camera stopped sending its picture.'));
        });

        const stream = new Gio.DataInputStream({base_stream: process.get_stdout_pipe(), buffer_size: 1 << 20});
        this._readFrames(stream, cancellable).catch(e => {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e);
        });
    }

    _show(text) {
        this._waiting.visible = false;
        this._status.text = text;
        this._status.visible = true;
    }

    async _readFrames(stream, cancellable) {
        // Before 48 St.ImageContent is a Clutter.Image, whose set_bytes() takes no CoglContext.
        const context = SHELL_MAJOR >= 48 ? [global.stage.context.get_backend().get_cogl_context()] : [];
        for (;;) {
            const line = await readLine(stream, cancellable);
            if (line === null)
                return;
            const [width, height] = line.split(' ').map(Number);
            const frame = await readExactly(stream, width * height * 3, cancellable);
            if (!frame)
                return;
            this._content.set_bytes(...context, frame, Cogl.PixelFormat.RGB_888, width, height, width * 3);
            this._waiting.visible = false;
            this._status.visible = false;
        }
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._process?.force_exit();
        this._process = null;
    }
});
