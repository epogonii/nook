// SPDX-License-Identifier: GPL-2.0-or-later

// Test extension loaded only by tools/run-nested.sh --shot. Once Nook has devices, it
// screenshots the menu in each view and color mode to $NOOK_SHOT_DIR and finally writes
// a "done" file. Never clicks a tile: the devices are real.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const NOOK = 'nook@epogonii.github.io';
const SHOTS = [
    ['tabs', true],
    ['tabs', false],
    ['grid', true],
    ['rooms', true],
    ['control', true],
];

// GNOME 51 PopupMenu.open/close take a params object instead of an animation flag.
const NO_ANIMATION = Number.parseInt(Config.PACKAGE_VERSION, 10) >= 51 ? {animate: false} : false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The lock screen disables and re-enables extensions; run only once.
let started = false;

// Fake Xiaomi gateway report for a door sensor. Multicast TTL 0 keeps it on this host,
// and only the nested session enables alerts for it, so the real Nook stays quiet.
function fakeReport(sid, status) {
    const socket = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.DATAGRAM, Gio.SocketProtocol.UDP);
    socket.set_multicast_ttl(0);
    const report = {cmd: 'report', model: 'magnet', sid, data: JSON.stringify({status})};
    socket.send_to(Gio.InetSocketAddress.new_from_string('224.0.0.50', 9898),
        new TextEncoder().encode(JSON.stringify(report)), null);
    socket.close();
}

function shoot(path) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
            try {
                shooter.screenshot_finish(result);
                stream.close(null);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
}

export default class Probe extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        this._run().catch(e => console.error(`nook probe: ${e.message}\n${e.stack}`));
    }

    disable() {
    }

    async _run() {
        const dir = GLib.getenv('NOOK_SHOT_DIR');
        const nook = Main.extensionManager.lookup(NOOK);
        const source = Gio.SettingsSchemaSource.new_from_directory(
            nook.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const settings = new Gio.Settings({
            settings_schema: source.lookup('org.gnome.shell.extensions.nook', false),
        });

        try {
            const cast = await import(nook.dir.get_child('lib').get_child('cast-home.js').get_uri());
            settings.set_string('cast-speakers', JSON.stringify(await cast.discover(3000)));
        } catch (e) {
            console.log(`nook probe: no speakers: ${e.message}`);
        }

        settings.set_string('gree-units', JSON.stringify([{
            mac: 'f4911e000001', ip: '127.0.0.1', name: 'Fake AC',
            key: '0123456789abcdef', cipher: 'ecb',
        }]));
        // ip 'test' makes lib/tapo.js treat it as a test camera (feed.js --test).
        settings.set_string('tapo-cameras', JSON.stringify([{
            id: 'test', ip: 'test', name: 'Test camera', model: 'C200',
        }]));
        settings.set_string('tvs', JSON.stringify([{
            id: 'probe', brand: 'panasonic', name: '49FX740_Series', model: 'Panasonic VIErA',
            ip: '192.168.100.46', mac: null,
        }]));
        await sleep(1000);

        let button = null;
        for (let i = 0; i < 60 && !button?._home?.devices.length; i++) {
            await sleep(500);
            button = Main.panel.statusArea[NOOK];
        }
        console.log(`nook probe: ${button?._home?.devices.length ?? 0} devices`);

        const devices = button._home.devices;
        const thermometers = devices.filter(d => d.primary.props.some(p => p.name === 'temperature')).map(d => d.did);
        const firstSwitch = devices.find(d => d.primary.kind === 'switch')?.did;
        const repeater = devices.find(d => d.urn?.includes(':repeater:'))?.did;
        settings.set_strv('panel-sensors', thermometers);
        settings.set_strv('pinned', [firstSwitch, thermometers[0]].filter(Boolean));
        settings.set_strv('hidden', [repeater].filter(Boolean));
        const gateway = devices.find(d => d.urn?.includes(':gateway:'));
        if (gateway)
            settings.set_strv('extra-tiles', [`${gateway.did}/2/1/guard-mode`]);
        const fryer = devices.find(d => d.urn?.includes(':air-fryer:'));
        if (fryer)
            settings.set_value('names', new GLib.Variant('a{ss}', {[fryer.did]: 'Аэрогриль'}));
        await sleep(3000);
        await shoot(`${dir}/bar.png`);
        settings.set_boolean('colored-icon', true);
        await sleep(500);
        await shoot(`${dir}/bar-green.png`);
        settings.set_boolean('colored-icon', false);

        for (const [view, colors] of SHOTS) {
            settings.set_string('view', view);
            settings.set_boolean('type-colors', colors);
            await sleep(300);
            button.menu.open(NO_ANIMATION);
            await sleep(4000);
            await shoot(`${dir}/${view}-${colors ? 'type' : 'accent'}.png`);
            button.menu.close(NO_ANIMATION);
            await sleep(500);
        }
        settings.set_string('view', 'tabs');
        settings.set_boolean('type-colors', true);
        button.menu.open(NO_ANIMATION);
        await sleep(500);
        button._chips.get_children()[2]?.emit('clicked', 1);
        await sleep(1000);
        await shoot(`${dir}/tabs-room.png`);
        button.menu.close(NO_ANIMATION);
        settings.set_string('room', '');

        const conditioner = Main.panel.statusArea[NOOK]._aircon?.devices[0];
        const camera = Main.panel.statusArea[NOOK]._tapo?.devices[0];
        if (camera) {
            button.menu.open(NO_ANIMATION);
            await sleep(300);
            await button._openCard(camera);
            await sleep(3000);
            await shoot(`${dir}/card-camera.png`);
            const find = actor => actor.child?.icon_name === 'camera-photo-symbolic' ? actor
                : actor.get_children().map(find).find(Boolean);
            find(button.menu.box)?.emit('clicked', 1);
            await sleep(4000);
            await shoot(`${dir}/snapshot.png`);
            button.menu.close(NO_ANIMATION);
            await sleep(500);
        }

        if (conditioner) {
            await conditioner.source.set(conditioner, {Pow: 1, Mod: 1, SetTem: 18});
            button.menu.open(NO_ANIMATION);
            await sleep(300);
            await button._openCard(conditioner);
            await sleep(800);
            await shoot(`${dir}/card-climate.png`);
            await button._climateWrite(conditioner, {Mod: 4, SetTem: 29});
            await sleep(800);
            await shoot(`${dir}/card-climate-warm.png`);
            button.menu.close(NO_ANIMATION);
            await sleep(500);
        }

        const speaker = button._cast?.devices.find(d => /audio/i.test(d.castModel)) ?? button._cast?.devices[0];
        if (speaker) {
            button.menu.open(NO_ANIMATION);
            await sleep(300);
            await button._openCard(speaker);
            await sleep(900);
            await shoot(`${dir}/card-speaker.png`);
            button.menu.close(NO_ANIMATION);
            await sleep(500);
        }

        const tv = button._tv?.devices[0];
        if (tv) {
            button.menu.open(NO_ANIMATION);
            await sleep(300);
            await button._openCard(tv);
            await sleep(900);
            await shoot(`${dir}/card-tv.png`);
            button.menu.close(NO_ANIMATION);
            await sleep(500);
        }

        for (const kind of [':fan:', ':vacuum:']) {
            const device = devices.find(d => d.urn?.includes(kind));
            if (!device)
                continue;
            button.menu.open(NO_ANIMATION);
            await sleep(300);
            await button._openCard(device);
            await sleep(kind === ':vacuum:' ? 12000 : 1000);
            await shoot(`${dir}/card${kind.replaceAll(':', '-')}.png`.replace('-.png', '.png'));
            if (kind === ':vacuum:') {
                const adjustment = button._scroll.vadjustment;
                for (const page of [2, 3]) {
                    adjustment.value = Math.min(adjustment.value + adjustment.page_size * 0.9,
                        adjustment.upper - adjustment.page_size);
                    await sleep(400);
                    await shoot(`${dir}/card-vacuum-${page}.png`);
                }
            }
            button.menu.close(NO_ANIMATION);
            await sleep(500);
        }

        GLib.mkdir_with_parents(`${dir}/cards`, 0o700);
        const picked = devices.filter(d => d.online && d.urn);
        for (const test of [d => d.online === false && d.urn, d => !d.urn]) {
            const other = devices.find(test);
            if (other)
                picked.push(other);
        }
        for (const device of picked) {
            const name = device.did.replace(/[^\w.-]/g, '_');
            button.menu.open(NO_ANIMATION);
            await sleep(300);
            await button._openCard(device);
            await sleep(700);
            await shoot(`${dir}/cards/${name}.png`);
            const fold = (function find(actor) {
                return actor.has_style_class_name?.('nook-fold') ? actor
                    : actor.get_children().map(find).find(Boolean);
            })(button.menu.box);
            fold?.emit('clicked', 1);
            await sleep(400);
            const adjustment = button._scroll.vadjustment;
            if (adjustment.upper > adjustment.page_size + 1) {
                adjustment.value = adjustment.upper - adjustment.page_size;
                await sleep(400);
                await shoot(`${dir}/cards/${name}-end.png`);
            }
            button.menu.close(NO_ANIMATION);
            await sleep(300);
        }

        Main.extensionManager.openExtensionPrefs(NOOK, '', {});
        await sleep(5000);
        await shoot(`${dir}/prefs.png`);

        const again = Main.panel.statusArea[NOOK];
        again.menu.open(NO_ANIMATION);
        await sleep(1500);
        Main.extensionManager.disableExtension(NOOK);
        await sleep(2000);
        console.log(`nook probe: after disable, button ${Main.panel.statusArea[NOOK] ? 'still there' : 'gone'}`);
        Main.extensionManager.enableExtension(NOOK);
        await sleep(4000);
        console.log(`nook probe: after enable, ${Main.panel.statusArea[NOOK]?._home?.devices.length ?? 0} devices`);

        settings.set_value('alerts', new GLib.Variant('a{sb}', {'lumi.nooktest': true}));
        await sleep(300);
        fakeReport('nooktest', 'open');
        await sleep(1500);
        await shoot(`${dir}/notify.png`);
        if (Main.screenShield) {
            Main.screenShield.lock(false);
            await sleep(3000);
            console.log(`nook probe: locked, button ${Main.panel.statusArea[NOOK] ? 'still there' : 'gone'}`);
            fakeReport('nooktest', 'close');
            await sleep(1500);
            await shoot(`${dir}/locked.png`);
            Main.screenShield.deactivate(false);
            await sleep(3000);
            console.log(`nook probe: unlocked, button ${Main.panel.statusArea[NOOK] ? 'back' : 'missing'}`);
        }

        GLib.file_set_contents(`${dir}/done`, '');
    }
}
