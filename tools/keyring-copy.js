#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Copies Nook's keyring secrets between session buses through a pipe, for
// tools/run-nested.sh. "get [service...]" prints them as JSON, "put" stores JSON from
// stdin. Nothing touches the disk; nothing else is printed.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import System from 'system';

Gio._promisify(Secret, 'password_lookup');
Gio._promisify(Secret, 'password_store');

// The Nook app's schema.
const SCHEMA = new Secret.Schema('io.github.epogonii.nook', Secret.SchemaFlags.NONE, {
    service: Secret.SchemaAttributeType.STRING,
});

const SERVICES = [
    ['xiaomi', 'Nook: Xiaomi account'],
    ['tapo', 'Nook: Tapo camera account'],
    ['tapo-admin', 'Nook: TP-Link password for Tapo cameras'],
];

async function main() {
    if (ARGV[0] === 'get') {
        const wanted = ARGV.slice(1);
        const found = {};
        for (const [service] of SERVICES) {
            if (wanted.length > 0 && !wanted.includes(service))
                continue;
            const saved = await Secret.password_lookup(SCHEMA, {service}, null);
            if (saved)
                found[service] = saved;
        }
        print(JSON.stringify(found));
    } else if (ARGV[0] === 'put') {
        const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0})});
        const [line] = input.read_line_utf8(null);
        const found = JSON.parse(line || '{}');
        for (const [service, label] of SERVICES) {
            if (found[service])
                await Secret.password_store(SCHEMA, {service}, Secret.COLLECTION_DEFAULT, label, found[service], null);
        }
    } else {
        throw new Error('usage: keyring-copy.js get|put');
    }
}

const loop = new GLib.MainLoop(null, false);
let status = 0;
main().catch(e => {
    printerr(`keyring-copy: ${e.message}`);
    status = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(status);
