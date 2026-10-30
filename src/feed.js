#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Separate process so the shell never blocks on RTSP or decoding. Writes raw RGB
// frames to stdout, each after a "width height" line.
// {url, user, password} come as one JSON line on stdin, never in argv (visible to
// other processes). Exits when killed or when stdout closes.
//
//   gjs -m feed.js               camera from the JSON on stdin
//   gjs -m feed.js --test        test pattern, no camera
//   gjs -m feed.js --still FILE  one JPEG at the stream's native size, then exit

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

// Must match NO_GSTREAMER, REFUSED and NO_PLUGIN in ui/camera.js.
const NO_GSTREAMER = 2;
const REFUSED = 3;
const NO_PLUGIN = 4;

const WIDTH = 640;
const RATE = 4;
const POLL_MS = 50;
// Early frames can be grey smears until the first keyframe; take the still later.
const STILL_AFTER_MS = 1500;
const STILL_GIVE_UP_MS = 20000;

const stillAt = ARGV.indexOf('--still');
const still = stillAt >= 0 ? ARGV[stillAt + 1] : null;

let Gst;
try {
    ({default: Gst} = await import('gi://Gst?version=1.0'));
    Gst.init(null);
} catch {
    System.exit(NO_GSTREAMER);
}

let source = 'videotestsrc is-live=true pattern=smpte ! video/x-raw,width=640,height=360';
let account = null;
let drain = '';
if (!ARGV.includes('--test')) {
    const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0})});
    const [line] = input.read_line_utf8(null);
    account = JSON.parse(line ?? '{}');
    source = 'rtspsrc name=camera protocols=tcp latency=300 ! application/x-rtp,media=video ! decodebin';
    // Sink the audio stream: left unlinked it stops the pipeline, and declining it at
    // RTSP setup makes the camera drop the video as well.
    drain = ' camera. ! application/x-rtp,media=audio ! fakesink sync=false async=false';
}

let pipeline;
try {
    pipeline = Gst.parse_launch([
        source,
        'videoconvert',
        'videoscale',
        'videorate',
        still ? 'video/x-raw,format=RGB' : `video/x-raw,format=RGB,width=${WIDTH},pixel-aspect-ratio=1/1,framerate=${RATE}/1`,
        'appsink name=sink max-buffers=1 drop=true sync=false',
    ].join(' ! ') + drain);
} catch {
    System.exit(NO_PLUGIN);
}

if (account) {
    const camera = pipeline.get_by_name('camera');
    camera.location = account.url;
    camera.user_id = account.user ?? '';
    camera.user_pw = account.password ?? '';
}

if (still) {
    pipeline.connect('deep-element-added', (_bin, _parent, element) => {
        Gst.util_set_object_arg(element, 'output-corrupt', 'false');
    });
}

const sink = pipeline.get_by_name('sink');
const stdout = new GioUnix.OutputStream({fd: 1, close_fd: false});
const encoder = new TextEncoder();
pipeline.set_state(Gst.State.PLAYING);

// Poll instead of blocking: rtspsrc needs the main loop to keep the RTSP session alive.
const loop = new GLib.MainLoop(null, false);
let status = still ? 1 : 0;
let firstFrame = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
    const sample = sink.emit('try-pull-sample', 0);
    if (!sample)
        return GLib.SOURCE_CONTINUE;
    if (still) {
        firstFrame ||= GLib.get_monotonic_time();
        if (GLib.get_monotonic_time() - firstFrame < STILL_AFTER_MS * 1000)
            return GLib.SOURCE_CONTINUE;
        try {
            saveStill(sample);
            status = 0;
        } catch (e) {
            printerr(e.message);
            GLib.unlink(still);
        }
        loop.quit();
        return GLib.SOURCE_REMOVE;
    }
    const structure = sample.get_caps().get_structure(0);
    const [, width] = structure.get_int('width');
    const [, height] = structure.get_int('height');
    const buffer = sample.get_buffer();
    const [mapped, info] = buffer.map(Gst.MapFlags.READ);
    if (!mapped)
        return GLib.SOURCE_CONTINUE;
    try {
        stdout.write_all(encoder.encode(`${width} ${height}\n`), null);
        stdout.write_all(info.data, null);
        stdout.flush(null);
    } catch {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    } finally {
        buffer.unmap(info);
    }
    return GLib.SOURCE_CONTINUE;
});

function saveStill(sample) {
    const structure = sample.get_caps().get_structure(0);
    const [, width] = structure.get_int('width');
    const [, height] = structure.get_int('height');
    const buffer = sample.get_buffer();
    const [mapped, info] = buffer.map(Gst.MapFlags.READ);
    if (!mapped)
        throw new Error('The frame could not be read');
    try {
        // Rows can be padded to 4-byte multiples; take rowstride from the buffer size.
        const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(info.data),
            GdkPixbuf.Colorspace.RGB, false, 8, width, height, info.data.length / height);
        GLib.mkdir_with_parents(GLib.path_get_dirname(still), 0o755);
        pixbuf.savev(still, 'jpeg', ['quality'], ['92']);
    } finally {
        buffer.unmap(info);
    }
}

if (still) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, STILL_GIVE_UP_MS, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}

// Auth failure gets its own exit code: retrying a refused login keeps the camera locked.
const bus = pipeline.get_bus();
bus.add_signal_watch();
bus.connect('message', (_bus, message) => {
    if (message.type === Gst.MessageType.ERROR) {
        const [error] = message.parse_error();
        if (error.matches(Gst.ResourceError, Gst.ResourceError.NOT_AUTHORIZED))
            status = REFUSED;
        // decodebin with no decoder for the camera's codec, e.g. H.264 without openh264 or libav.
        else if (error.matches(Gst.CoreError, Gst.CoreError.MISSING_PLUGIN) ||
                 error.matches(Gst.StreamError, Gst.StreamError.CODEC_NOT_FOUND))
            status = NO_PLUGIN;
        loop.quit();
    } else if (message.type === Gst.MessageType.EOS) {
        loop.quit();
    }
});

loop.run();
pipeline.set_state(Gst.State.NULL);
System.exit(status);
