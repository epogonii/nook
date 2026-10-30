// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {APP_ID} from './constants.js';
import * as Secrets from './lib/secrets.js';
import {TapoHome} from './lib/tapo.js';
import {CameraApi, TapoError} from './lib/tapo-local.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const FEED = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'feed.js']);

export class CameraError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

export class Cameras extends TapoHome {
    async _saved(device) {
        const saved = await Secrets.lookup(this.secret(device));
        if (!saved)
            return null;
        try {
            const {user, password} = JSON.parse(saved);
            return {user, password};
        } catch {
            return 'unreadable';
        }
    }

    // 'ok', 'none', 'unreadable', or 'unknown' (no tapo or xaddr kept yet).
    async account(device) {
        if (device.test)
            return 'ok';
        if (!device.tapo && !device.xaddr)
            return 'unknown';
        const saved = await this._saved(device);
        if (saved === 'unreadable')
            return 'unreadable';
        return saved ? 'ok' : 'none';
    }

    async controls(device) {
        if (device.test)
            return super.controls(device);
        const saved = await this._saved(device);
        if (!saved || saved === 'unreadable')
            throw new CameraError('No saved login for this camera', 'none');
        return super.controls(device, saved.user, saved.password);
    }

    async openApi(device) {
        let password = null;
        try {
            password = JSON.parse(await Secrets.lookup('tapo-admin') ?? 'null')?.password ?? null;
        } catch {}
        if (!password)
            throw new TapoError('No TP-Link password saved', 'no-password');
        return new CameraApi(device.ip, password);
    }

    async _input(device, which) {
        if (device.test)
            return null;
        const saved = await this._saved(device);
        if (!saved || saved === 'unreadable')
            throw new CameraError('No saved login for this camera', 'none');
        const streams = device.tapo || device.streams ? await this.streams(device, null) : null;
        if (!streams?.[which])
            throw new CameraError('The camera has not said where its stream is yet', 'no-stream');
        return `${JSON.stringify({...saved, url: streams[which]})}\n`;
    }

    async startFeed(device) {
        const input = await this._input(device, 'live');
        const argv = ['gjs', '-m', FEED];
        if (input === null)
            argv.push('--test');
        const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        // Credentials over stdin: argv is visible to other processes.
        const stdin = process.get_stdin_pipe();
        const close = () => stdin.close_async(GLib.PRIORITY_DEFAULT, null, null);
        if (input) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(input));
            stdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, (_stdin, result) => {
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
        return process;
    }

    async still(device) {
        const input = await this._input(device, 'still');
        const folder = GLib.build_filenamev([GLib.get_user_cache_dir(), APP_ID]);
        const path = GLib.build_filenamev([folder, `still-${GLib.uuid_string_random()}.jpg`]);
        const argv = ['gjs', '-m', FEED, '--still', path];
        if (input === null)
            argv.push('--test');
        const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        await process.communicate_utf8_async(input, null);
        const status = process.get_exit_status();
        if (status !== 0)
            throw new CameraError(`feed.js exited with ${status}`, status);
        const file = Gio.File.new_for_path(path);
        try {
            const [contents] = await file.load_contents_async(null);
            return contents;
        } finally {
            file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }
}
