// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CLOUD_AIRCONS} from '../lib/brands.js';
import * as Glyphs from '../lib/glyphs.js';
import {CastError, ClimateError, EwelinkError, SonoffError, SpecError, TapoError, TvError, XiaomiError} from './errors.js';
import {EVENT_KEYS} from './events.js';
import {API_VERSION, Beacons, homeKind} from './remote.js';
import {BEACON_FRESH, beaconOf, beacons, isBluetooth, playingNow, setLive, stateText} from './rows.js';
import {deviceType, formatValue, numberFormat, readSetting, tvShowing} from './text.js';
import {Glyph, skeletonBar} from './widgets.js';

// The button's device sources besides this._clouds.
const SOURCES = ['_home', '_aircon', '_tapo', '_cast', '_tv', '_sonoff', '_shelly', '_ewelink', '_hue', '_hass',
    '_homekit', '_smartlife', '_miScenes'];

// extra-tiles entry: "did/siid/piid/name". Neither a did nor a property name has '/'.
function parseExtra(entry) {
    const [did, siid, piid, name] = entry.split('/');
    if (!did || !name || Number.isNaN(Number(siid)) || Number.isNaN(Number(piid)))
        return null;
    return {did, siid: Number(siid), piid: Number(piid), name};
}

function panelText(device) {
    const {primary, values, online} = device;
    const beacon = beaconOf(device);
    if (beacon && Date.now() / 1000 - beacon.time < BEACON_FRESH && beacon.temperature !== undefined) {
        const degrees = `${numberFormat.format(beacon.temperature)}°`;
        return beacon.humidity !== undefined ? `${degrees} ${numberFormat.format(beacon.humidity)}%` : degrees;
    }
    if (isBluetooth(device) && !online)
        return '–';
    if (!online)
        return online === false ? '–' : '…';
    switch (primary.kind) {
    case 'switch':
        if (!values)
            return '…';
        return values[0] === true ? _('On') : _('Off');
    case 'climate': {
        const room = device.state?.roomTemperature;
        if (typeof room === 'number')
            return `${numberFormat.format(room)}°`;
        return device.state?.Pow === 1 ? `${numberFormat.format(device.state.SetTem)}°` : _('Off');
    }
    case 'media':
        if (playingNow(device))
            return _('Playing');
        return device.state?.media?.state === 'PAUSED' ? _('Paused') : _('Idle');
    case 'tv':
        if (!device.state?.paired)
            return _('Not paired');
        if (!device.state.on)
            return _('Off');
        return device.state.muted ? _('Muted') : tvShowing(device) ?? _('On');
    case 'reading':
        if (!values)
            return '…';
        return primary.props.map((p, i) => {
            const value = values[i];
            if (typeof value === 'number' && p.unit === 'celsius')
                return `${numberFormat.format(value)}°`;
            return formatValue(p, value);
        }).filter(Boolean).join(' ');
    default:
        return stateText(device);
    }
}

const LISTEN_SECONDS = 20;
// A Bluetooth device not heard this long into a scan (off, out of range) stops showing
// as loading, on later scans too, until it is heard.
const HEAR_SECONDS = 15;

function setBeacon(device, beacon) {
    beacons.set(device.did, beacon);
}

export class MenuRead {
    async reload() {
        this._stopRetry();
        this._card = null;
        this._setCardMode(false);
        this._stopReadings();
        this._readings.destroy_all_children();
        this._cancellable?.cancel();
        this._forgetSources();
        if (this._pushSync)
            GLib.source_remove(this._pushSync);
        this._pushSync = 0;
        this._loginNote = null;
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._title.text = _('Nook');
        this._showLoading();

        const app = this._app;
        let attached;
        try {
            if (!await app.installed()) {
                if (!cancellable.is_cancelled())
                    this._showNoApp();
                return;
            }
            await app.migrate(this._settings);
            attached = await app.attach();
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._message(_('The Nook app did not answer: %s').replace('%s', e.message));
            return;
        }
        if (cancellable.is_cancelled())
            return;
        if (attached.version !== API_VERSION) {
            this._message(attached.version > API_VERSION
                ? _('This version of the Nook app needs a newer Nook extension.')
                : _('Update the Nook app: this version of the extension needs a newer one.'));
            return;
        }
        for (const source of attached.homes)
            this._adopt(source);
        this._startReadings();

        let xiaomi;
        try {
            xiaomi = await app.xiaomi();
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._message(_('The keyring could not be read: %s').replace('%s', e.message));
            return;
        }
        if (cancellable.is_cancelled())
            return;
        switch (xiaomi.state) {
        case 'keyring':
            this._message(_('The keyring could not be read: %s').replace('%s', xiaomi.message));
            return;
        case 'none':
            this._showLogin();
            return;
        case 'unreadable':
            this._showLogin(_('The saved Mi Home login could not be read.'));
            return;
        }
        const home = this._home = xiaomi.homes.find(h => homeKind(h) === 'xiaomi');
        try {
            await home.load();
            // Cache predates stored homes: rediscover, refreshOnline() needs them.
            if (home.homes.length === 0 && home.devices.length > 0)
                await home.discover();
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._showFailure(home, e);
            return;
        }
        if (cancellable.is_cancelled())
            return;

        const scenes = this._miScenes = xiaomi.homes.find(h => homeKind(h) === 'scenes');
        scenes.onDevices = () => {
            if (this._miScenes === scenes)
                this._render();
        };
        scenes.onChange = () => this._pushed(scenes);
        scenes.load().catch(logError);
        this._syncExtras();
        this._render();
        this._startReadings();
        if (this._menu.isOpen)
            await this._read();
    }

    _adopt(source) {
        const note = (text, target) => {
            if (!this._sources().includes(source))
                return;
            this._loginNote = {text, target};
            this._render();
        };
        const back = target => {
            if (!this._sources().includes(source) || this._loginNote?.target !== target)
                return;
            this._loginNote = null;
            this._render();
        };
        switch (homeKind(source)) {
        case 'aircon':
            this._aircon = source;
            break;
        case 'tapo':
            this._tapo = source;
            break;
        case 'cast':
            this._cast = source;
            source.onChange = device => this._castChanged(source, device);
            break;
        case 'tv':
            this._tv = source;
            source.onChange = device => this._tvChanged(source, device);
            break;
        case 'sonoff':
            this._sonoff = source;
            break;
        case 'shelly':
            this._shelly = source;
            source.onExpired = () => note(_('A Shelly needs its password again.'), 'accounts-shelly');
            source.onBack = () => back('accounts-shelly');
            break;
        case 'ewelink':
            this._ewelink = source;
            source.onExpired = () => note(_('The eWeLink login has expired.'), 'accounts-ewelink');
            break;
        case 'hue':
            this._hue = source;
            source.onExpired = () => note(_('A Hue bridge needs to be paired again.'), 'accounts-hue');
            source.onChange = () => this._pushed(source);
            break;
        case 'hass':
            this._hass = source;
            source.onExpired = () => note(_('Home Assistant refused the access token.'), 'accounts-hass');
            source.onChange = () => this._pushed(source);
            break;
        case 'homekit':
            this._homekit = source;
            source.onExpired = () => note(_('A HomeKit accessory needs to be paired again.'), 'accounts-homekit');
            break;
        case 'smartlife':
            this._smartlife = source;
            source.onExpired = () => note(_('The Smart Life login has expired.'), 'accounts-smartlife');
            break;
        case 'cloud': {
            const brand = CLOUD_AIRCONS.find(b => b.label === source.label);
            const target = `accounts-${brand?.id ?? ''}`;
            source.onExpired = () => note(_('The %s login has expired.').replace('%s', source.label), target);
            // A login renewed in the app works again without a reload.
            source.onBack = () => back(target);
            this._clouds.push(source);
            break;
        }
        }
    }

    // No abort: the homes are the app's, and the next attach returns them.
    _forgetSources() {
        for (const name of SOURCES)
            this[name] = null;
        this._clouds = [];
    }

    _stopReadings() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        if (this._settle)
            GLib.source_remove(this._settle);
        this._settle = 0;
        if (this._listening) {
            GLib.source_remove(this._listening);
            if (!this._menu.isOpen)
                this._stopBeacons();
        }
        this._listening = 0;
    }

    _restartReadingsSoon() {
        this._syncReadings();
        if (this._settle)
            GLib.source_remove(this._settle);
        this._settle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._settle = 0;
            this._startReadings();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startReadings() {
        this._stopReadings();
        this._syncReadings();
        if (this._panelDevices().length === 0)
            return;
        const minutes = readSetting(this._settings, 'panel-interval');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, minutes * 60, () => {
            this._pollReadings().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
        this._pollReadings().catch(logError);
    }

    async _pollReadings() {
        const home = this._home;
        if (Main.sessionMode.isLocked)
            return;
        const devices = this._panelDevices();
        const fromCloud = devices.filter(d => d.source === home && !isBluetooth(d));
        const nearby = devices.filter(d => d.source !== home && d.source?.readPrimary);
        if (devices.some(isBluetooth))
            this._listenAWhile();
        const reads = [...new Set(nearby.map(d => d.source))].map(source => source.readPrimary());
        if (fromCloud.length > 0)
            reads.push(home.readPrimary(fromCloud.map(d => d.did)));
        for (const result of await Promise.allSettled(reads)) {
            const e = result.reason;
            if (!e)
                continue;
            if ([XiaomiError, GLib.Error, TvError, ClimateError, CastError, TapoError, SonoffError, EwelinkError, SpecError]
                .some(type => e instanceof type))
                console.debug(`nook: top bar: ${e.message}`);
            else
                logError(e);
        }
        if (!this._menu.isOpen) {
            this._cast?.rest();
            this._tv?.rest();
        }
        if (home !== this._home)
            return;
        this._syncReadings();
        for (const tile of this._tiles)
            tile.sync();
    }

    _listenAWhile() {
        if (this._beacons)
            return;
        this._startBeacons();
        this._listening = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, LISTEN_SECONDS, () => {
            this._listening = 0;
            if (!this._menu.isOpen)
                this._stopBeacons();
            this._syncReadings();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncReadings() {
        this._readings.destroy_all_children();
        for (const device of this._panelDevices()) {
            const reading = new St.BoxLayout({style_class: 'nook-reading'});
            const [glyph] = Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model);
            const picture = new Glyph(glyph);
            picture.add_style_class_name('nook-panel-glyph');
            reading.add_child(picture);
            const text = this._awaits(device) ? '…' : panelText(device);
            reading.add_child(text === '…' ? skeletonBar() : new St.Label({
                style_class: 'nook-reading-text',
                text,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._readings.add_child(reading);
        }
        this._readings.visible = this._readings.get_n_children() > 0;
    }

    _syncExtras() {
        if (this._home)
            this._home.extras = readSetting(this._settings, 'extra-tiles').map(parseExtra).filter(Boolean);
    }

    // Per-source sync: an offline camera's connect timeout must not delay the rest.
    async _read() {
        if (this._tiles.length === 0)
            return;
        for (const source of [this._aircon, this._tapo, this._cast, this._tv, this._sonoff, this._shelly, this._ewelink, this._hue, this._hass,
            this._homekit, this._smartlife, this._miScenes, ...this._clouds].filter(Boolean))
            source.readPrimary().then(() => this._syncTiles(source)).catch(logError);
        const home = this._home;
        if (!home)
            return;
        this._readGateway(home).then(heard => heard && this._syncTiles(home)).catch(logError);
        await this._readCloud(home);
    }

    async _readCloud(home) {
        let fresh = false;
        try {
            fresh = await home.readAll();
        } catch (e) {
            if (home !== this._home)
                return;
            if (!home.loggedIn) {
                this._showLogin(_('The Mi Home login has expired.'));
                return;
            }
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                logError(e);
            else
                console.debug(`nook: read: ${e.message}`);
        }
        if (home !== this._home)
            return;
        // Backoff after a failure: retry when it ends, or tiles wait for the next open.
        const wait = home.quietUntil - Date.now();
        if (wait > 0 && this._menu.isOpen && !this._retry) {
            this._retry = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait + 500, () => {
                this._retry = 0;
                if (this._menu.isOpen && home === this._home)
                    this._readCloud(home).catch(logError);
                return GLib.SOURCE_REMOVE;
            });
        }
        if (!fresh)
            return;
        this._syncTiles(home);
        await this._readLastEvents(home);
    }

    _stopRetry() {
        if (this._retry)
            GLib.source_remove(this._retry);
        this._retry = 0;
    }

    // Home Assistant and Hue push every change, scenes their runs; a power sensor can
    // report each second.
    _pushed(source) {
        if (this._pushSync || !this._sources().includes(source))
            return;
        this._pushSync = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._pushSync = 0;
            this._syncTiles(source);
            return GLib.SOURCE_REMOVE;
        });
    }

    // The network changed: the sources that keep a connection open start a new one.
    reconnect() {
        this._hass?.reconnect();
        this._hue?.reconnect();
        this._lightUpStep();
    }

    // Not under a flashing light: it would stay in the notification's colour.
    _letGo() {
        this._forgetSources();
        this._app.detachAfter([...this._flashes?.values() ?? []].map(f => f.done));
    }

    // The top bar stays in view under an open card.
    _syncTiles(source) {
        if (!this._sources().includes(source))
            return;
        this._syncReadings();
        if (this._card)
            return;
        for (const tile of this._tiles)
            tile.sync();
    }

    // Scan only while the menu is open: scanning keeps the radio busy.
    _startBeacons() {
        if (this._beacons || !this._home?.devices.some(isBluetooth))
            return;
        const byAddress = address => this._home?.devices.find(d => isBluetooth(d) && d.mac?.toUpperCase() === address);
        const scan = this._beacons = new Beacons(this._app, (address, beacon) => {
            const device = byAddress(address);
            if (!device)
                return;
            const before = stateText(device);
            const waited = this._awaits(device);
            this._unheard.delete(device.did);
            // Adverts may carry only some readings; keep the rest from earlier ones.
            setBeacon(device, {...beaconOf(device), ...beacon, time: Math.floor(Date.now() / 1000)});
            this._syncHeard(device);
            // Adverts come many times a second: redraw tiles only on a change.
            if (stateText(device) === before && !waited)
                return;
            for (const tile of this._tiles) {
                if (tile.device.did === device.did)
                    tile.sync();
            }
            if (readSetting(this._settings, 'panel-sensors').includes(device.did))
                this._syncReadings();
        });
        scan.onLocked = address => {
            const home = this._home;
            const device = byAddress(address);
            if (!device || !home)
                return;
            home.beaconKey(device).then(key => {
                if (key && this._beacons === scan)
                    scan.setKey(address, key);
            }).catch(e => console.debug(`nook: beacon key: ${e.message}`));
        };
        this._hearing = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, HEAR_SECONDS, () => {
            this._hearing = 0;
            for (const device of this._home?.devices ?? []) {
                if (this._awaits(device))
                    this._unheard.add(device.did);
            }
            this._syncListening();
            return GLib.SOURCE_REMOVE;
        });
        this._syncListening();
        scan.start()
            .then(() => this._syncListening())
            .catch(e => {
                console.debug(`nook: bluetooth: ${e.message}`);
                // Not scanning after all: don't leave tiles waiting.
                if (this._beacons === scan) {
                    scan.off = true;
                    this._syncListening();
                }
            });
    }

    // Scanning, and nothing fresh heard from it yet.
    _awaits(device) {
        if (!isBluetooth(device) || device.online === true || !this._beacons || this._beacons.off ||
            this._unheard.has(device.did))
            return false;
        const time = beaconOf(device)?.time;
        return !time || Date.now() / 1000 - time >= BEACON_FRESH;
    }

    _syncListening() {
        this._syncHeard(this._card);
        for (const tile of this._tiles) {
            if (isBluetooth(tile.device))
                tile.sync();
        }
        this._syncReadings();
    }

    _stopBeacons() {
        if (this._hearing)
            GLib.source_remove(this._hearing);
        this._hearing = 0;
        this._beacons?.stop();
        this._beacons = null;
    }

    // Some lumi sensors (old smoke detectors, leak sensors) say little via the cloud;
    // ask the gateway on the LAN.
    async _readGateway(home) {
        const quiet = home?.devices.filter(d => d.did.startsWith('lumi.') &&
            (d.unreadable || d.primary.kind === 'none')) ?? [];
        const states = await Promise.all(quiet.map(async device => {
            const state = await this._alerts.read(device.did.slice('lumi.'.length));
            if (state)
                setLive(device, state);
            return state;
        }));
        return states.some(Boolean);
    }

    _heardFromGateway(sid, data) {
        const device = this._home?.devices.find(d => d.did === `lumi.${sid}`);
        if (!device)
            return;
        setLive(device, this._alerts.state(sid));
        const now = Math.floor(Date.now() / 1000);
        const set = (name, value) => {
            const index = device.primary.props.findIndex(p => p.name === name);
            if (index < 0)
                return;
            device.values = device.primary.props.map((_p, i) => (i === index ? value : device.values?.[i] ?? null));
            device.times = device.primary.props.map((_p, i) => (i === index ? now : device.times?.[i] ?? null));
        };
        if (data.status === 'open' || data.status === 'close')
            set('contact-state', data.status === 'close');
        if (data.status === 'motion')
            set('motion-state', true);
        if (data.temperature !== undefined)
            set('temperature', Number(data.temperature) / 100);
        if (data.humidity !== undefined)
            set('relative-humidity', Number(data.humidity) / 100);
        if ((EVENT_KEYS()[deviceType(device)] ?? []).some(([key]) => key === data.status))
            this._home.noteEvent(device, {key: data.status, time: now});
        for (const tile of this._tiles)
            tile.sync();
        this._syncHero(device);
        this._syncReadings();
    }

    async _readLastEvents(home) {
        const keys = Object.fromEntries(home.devices.map(device => [device.did, device.primary.props.length === 0
            ? (EVENT_KEYS()[deviceType(device)] ?? []).map(([key]) => key) : []]));
        try {
            if (!await home.readLastEvents(home.devices, keys))
                return;
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                logError(e);
            return;
        }
        if (home !== this._home || this._card)
            return;
        for (const tile of this._tiles)
            tile.sync();
    }

    async _discover() {
        const home = this._home;
        if (!home) {
            await this.reload();
            return;
        }
        this._refreshButton.reactive = false;
        this._showLoading();
        try {
            await home.discover();
        } catch (e) {
            if (home === this._home)
                this._showFailure(home, e);
            return;
        } finally {
            if (!this._gone)
                this._refreshButton.reactive = true;
        }
        if (home !== this._home)
            return;
        this._render();
        await this._read();
    }
}
