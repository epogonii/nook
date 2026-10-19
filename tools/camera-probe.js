#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Discovers Tapo cameras and plays each through feed.js for a few seconds with the
// keyring's camera account. Prints frame count and size only.
//
//   gjs -m tools/camera-probe.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import * as Secrets from '../lib/secrets.js';
import * as Tapo from '../lib/tapo.js';

const SECONDS = 6;
const feed = GLib.build_filenamev([GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])), 'feed.js']);

function watch(account) {
    return new Promise(resolve => {
        const process = Gio.Subprocess.new(['gjs', '-m', feed],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const stdin = process.get_stdin_pipe();
        stdin.write_all(new TextEncoder().encode(`${JSON.stringify(account)}\n`), null);
        stdin.close(null);

        let frames = 0, size = '';
        const stream = new Gio.DataInputStream({base_stream: process.get_stdout_pipe(), buffer_size: 1 << 20});
        const next = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(result);
            } catch {
                return;
            }
            if (line === null)
                return;
            const [width, height] = line.split(' ').map(Number);
            size = `${width}x${height}`;
            const skip = left => stream.skip_async(left, GLib.PRIORITY_DEFAULT, null, (_t, done) => {
                let skipped;
                try {
                    skipped = stream.skip_finish(done);
                } catch {
                    return;
                }
                if (skipped === 0)
                    return;
                if (skipped < left) {
                    skip(left - skipped);
                    return;
                }
                frames++;
                next();
            });
            skip(width * height * 3);
        });
        next();
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SECONDS, () => {
            process.force_exit();
            resolve({frames, size});
            return GLib.SOURCE_REMOVE;
        });
    });
}

async function main() {
    const saved = await Secrets.lookup('tapo');
    if (!saved)
        throw new Error('no camera account in the keyring');
    const {user, password} = JSON.parse(saved);
    const cameras = await Tapo.discover(3000);
    if (cameras.length === 0)
        print('no camera answered');
    const home = new Tapo.TapoHome(cameras.filter(Tapo.isTapo));
    for (const device of home.devices) {
        const {live} = await home.streams(device, null, null);
        const {frames, size} = await watch({url: live, user, password});
        print(`${device.name} (${device.ip}): ${frames} frames in ${SECONDS} s${size ? `, ${size}` : ''}`);
    }
}

const loop = new GLib.MainLoop(null, false);
let status = 0;
main().catch(e => {
    printerr(`camera-probe: ${e.message}`);
    status = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(status);
