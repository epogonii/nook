#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-2.0-or-later

// Discovers Gree ACs, binds to the first and prints its state. Read-only.
//
//   gjs -m tools/gree-probe.js [broadcast address]
//
// Pass 127.0.0.1 to talk to tools/fake-gree.py.

import GLib from 'gi://GLib';
import System from 'system';

import * as Gree from '../lib/gree.js';

async function main() {
    const units = await Gree.discover(ARGV[0] ?? '255.255.255.255');
    if (units.length === 0) {
        print('no air conditioner answered');
        return;
    }
    for (const unit of units)
        print(`${unit.name}  ${unit.ip}  mac=${unit.mac}  firmware=${unit.version ?? '?'}`);

    const ac = new Gree.GreeDevice(units[0]);
    try {
        const {cipher} = await ac.bind();
        print(`bound to ${units[0].name}, ${cipher === 'gcm' ? 'newer' : 'older'} protocol`);
        const state = await ac.status();
        for (const col of Gree.COLUMNS)
            print(`  ${col} = ${state[col]}`);
        print(`  room temperature: ${state.roomTemperature ?? 'unknown'}`);
    } finally {
        ac.close();
    }
}

const loop = new GLib.MainLoop(null, false);
let status = 0;
main().catch(e => {
    printerr(e instanceof Gree.GreeError ? `gree: ${e.message}` : e.stack ?? e);
    status = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(status);
