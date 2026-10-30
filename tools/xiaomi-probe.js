#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Logs in to the Xiaomi cloud and lists every device with its MIoT properties and
// current values, outside the shell.
//
//   gjs -m tools/xiaomi-probe.js [--login] [--out devices.json]
//
// The login is stored in the keyring, where the extension finds it too. --login
// discards it and shows a new QR code; --out also writes full specs and values as JSON.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import System from 'system';

import * as Secrets from '../src/lib/secrets.js';
import {SERVERS, XiaomiCloud, XiaomiError} from '../src/lib/xiaomi.js';

const SPEC = 'https://miot-spec.org/miot-spec-v2';

const decoder = new TextDecoder();
const session = new Soup.Session({timeout: 30});

function option(name) {
    const i = ARGV.indexOf(name);
    return i >= 0 ? ARGV[i + 1] : null;
}

async function getJson(url) {
    const msg = Soup.Message.new('GET', url);
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    if (msg.status_code !== Soup.Status.OK)
        throw new Error(`${url}: HTTP ${msg.status_code}`);
    return JSON.parse(decoder.decode(bytes.toArray()));
}

const short = urn => urn.split(':')[3];

async function save(cloud) {
    await Secrets.store('xiaomi', 'Nook: Xiaomi account', JSON.stringify(cloud.credentials));
}

async function login(cloud) {
    const {imageUrl, loginUrl, wait} = await cloud.startQrLogin();
    const png = await cloud.downloadQr(imageUrl);
    const path = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'nook-qr.png']);
    GLib.file_set_contents(path, png.toArray());

    print('Scan the QR code with the Mi Home app (Profile, scan icon at the top).');
    print(`  image: ${path}`);
    print(`  link:  ${loginUrl}`);
    try {
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(path, null), null);
    } catch {
        print('  (could not open the image, open it by hand)');
    }

    try {
        await wait();
    } finally {
        GLib.unlink(path);
    }
    await save(cloud);
    print('logged in, login saved to the keyring');
}

async function findDevices(cloud) {
    const found = [];
    for (const server of SERVERS) {
        let homes;
        try {
            homes = await cloud.homes(server);
        } catch (e) {
            if (!(e instanceof XiaomiError))
                throw e;
            print(`${server}: ${e.message}`);
            continue;
        }
        for (const home of homes) {
            for (const device of await cloud.devices(server, home))
                found.push({server, home: home.name, device});
        }
    }
    return found;
}

async function main() {
    const out = option('--out');
    const saved = ARGV.includes('--login') ? null : await Secrets.lookup('xiaomi');
    const cloud = new XiaomiCloud(saved ? JSON.parse(saved) : {});

    if (!cloud.loggedIn)
        await login(cloud);

    try {
        await cloud.refresh();
        await save(cloud);
        print('token refresh: ok');
    } catch (e) {
        if (!(e instanceof XiaomiError))
            throw e;
        print(`token refresh: ${e.message}`);
    }

    const found = await findDevices(cloud);
    print(`\n${found.length} devices`);
    if (found.length === 0)
        return;

    const {instances} = await getJson(`${SPEC}/instances?status=released`);
    const urns = new Map();
    for (const instance of instances) {
        const known = urns.get(instance.model);
        if (!known || known.version < instance.version)
            urns.set(instance.model, instance);
    }

    const report = [];
    for (const {server, home, device} of found) {
        const {name, model, did, parent_id: parent, isOnline: online} = device;
        print(`\n${name}  [${model}]  ${server} / ${home}  did=${did}${parent ? ` parent=${parent}` : ''}  ${online ? 'online' : 'offline'}`);
        const entry = {server, home, name, model, did, parent, online, spec: null, values: null};
        report.push(entry);

        const urn = urns.get(model)?.type;
        if (!urn) {
            print('  no MIoT spec for this model');
            continue;
        }
        entry.spec = await getJson(`${SPEC}/instance?type=${encodeURIComponent(urn)}`);

        // siid 1 is the standard device-information service.
        const readable = [];
        for (const service of entry.spec.services ?? []) {
            if (service.iid === 1)
                continue;
            const props = (service.properties ?? []).map(p => {
                if (p.access?.includes('read'))
                    readable.push({did, siid: service.iid, piid: p.iid, label: `${short(service.type)}.${short(p.type)}`});
                return `${short(p.type)}${p.access?.includes('write') ? '*' : ''}`;
            });
            const actions = (service.actions ?? []).map(a => `${short(a.type)}()`);
            print(`  s${service.iid} ${short(service.type)}: ${[...props, ...actions].join(', ')}`);
        }

        if (!online || readable.length === 0)
            continue;
        try {
            const values = await cloud.getProperties(server, readable.map(({did, siid, piid}) => ({did, siid, piid})));
            entry.values = values;
            const labels = new Map(readable.map(r => [`${r.siid}.${r.piid}`, r.label]));
            const shown = values.map(v => `${labels.get(`${v.siid}.${v.piid}`)}=${v.code === 0 ? JSON.stringify(v.value) : `error ${v.code}`}`);
            print(`  now: ${shown.join('  ')}`);
        } catch (e) {
            if (!(e instanceof XiaomiError))
                throw e;
            print(`  reading failed: ${e.message}`);
        }
    }

    if (out) {
        GLib.file_set_contents(out, new TextEncoder().encode(JSON.stringify(report, null, 2)));
        print(`\nfull report: ${out}`);
    }
}

const loop = new GLib.MainLoop(null, false);
let status = 0;
main().catch(e => {
    printerr(e instanceof XiaomiError ? `xiaomi: ${e.message}` : e.stack ?? e);
    status = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(status);
