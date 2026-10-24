// SPDX-License-Identifier: GPL-2.0-or-later

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {Extension, gettext as _, pgettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {arrange, move} from './lib/arrange.js';
import {BeaconScan} from './lib/ble.js';
import {CastError, CastHome, parseSpeakers} from './lib/cast-home.js';
import {TvError, TvHome, parseTvs} from './lib/tv-home.js';
import * as Gateway from './lib/gateway.js';
import * as Glyphs from './lib/glyphs.js';
import * as Scenes from './lib/scenes.js';
import {AirconHome, ClimateError, MODES, parseAircons, parseUnits} from './lib/aircon-home.js';
import {snapTemperature, specClimate} from './lib/climate.js';
import {CloudAirconHome, parseEntries} from './lib/cloud-aircon.js';
import {BRAND as ELECTROLUX} from './lib/electrolux.js';
import {BRAND as LG} from './lib/lg.js';
import {BRAND as MELCLOUD} from './lib/melcloud.js';
import {BRAND as SMARTTHINGS} from './lib/smartthings.js';
import * as Secrets from './lib/secrets.js';
import {SonoffError, SonoffHome, parseSwitches} from './lib/sonoff.js';
import {EwelinkError} from './lib/ewelink.js';
import {EwelinkHome, parseDevices as parseEwelinkDevices} from './lib/ewelink-home.js';
import {HassHome, parseDevices as parseHassDevices} from './lib/hass-home.js';
import {HomeKitHome, parseHosts as parseHomeKitHosts} from './lib/homekit-home.js';
import {HueHome} from './lib/hue-home.js';
import {parseBridges as parseHueBridges, parseDevices as parseHueDevices} from './lib/hue.js';
import {SmartLifeHome, parseDevices as parseSmartLifeDevices} from './lib/smartlife-home.js';
import {SpecError} from './lib/spec-home.js';
import {MiHome, cachedDevices, clearPacing} from './lib/mihome.js';
import {MapError, decodeMap, parsePath} from './lib/vacuum-map.js';
import {OnvifError} from './lib/onvif.js';
import * as Tapo from './lib/tapo.js';
import {CameraApi, TapoError, WRONG_PASSWORD} from './lib/tapo-local.js';
import {XiaomiCloud, XiaomiError} from './lib/xiaomi.js';
import * as Timers from './lib/timers.js';

const SECRET_LABEL = 'Nook: Xiaomi account';

// Air conditioners behind a maker's account; each keeps its list in <id>-devices.
const CLOUD_AIRCONS = [LG, SMARTTHINGS, MELCLOUD, ELECTROLUX];

// Must match NO_GSTREAMER, REFUSED and NO_PLUGIN in feed.js.
const NO_GSTREAMER = 2;
const REFUSED = 3;
const NO_PLUGIN = 4;

const SHELL_MAJOR = Number.parseInt(Config.PACKAGE_VERSION.split('.')[0], 10);

// St.BoxLayout gained "orientation" in GNOME 48; earlier versions use "vertical: true".
const VERTICAL = SHELL_MAJOR >= 48
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

// GNOME 51 renamed St.ButtonMask.ONE and THREE, and the old names log a warning there.
const PRIMARY_SECONDARY = (St.ButtonMask.PRIMARY ?? St.ButtonMask.ONE) |
    (St.ButtonMask.SECONDARY ?? St.ButtonMask.THREE);

const DEFAULTS = {
    'view': 'tabs',
    'type-colors': true,
    'room': '',
    'panel-sensors': [],
    'panel-interval': 5,
    'pinned': [],
    'order': [],
    'hidden': [],
    'names': {},
    'icons': {},
    'extra-tiles': [],
    'groups': {},
    'gree-units': '[]',
    'aircons': '[]',
    'tapo-cameras': '[]',
    'cast-speakers': '[]',
    'tvs': '[]',
    'sonoff-switches': '[]',
    'ewelink-devices': '[]',
    'ewelink-region': '',
    'hue-bridges': '[]',
    'hue-devices': '[]',
    'hass-server': '',
    'hass-devices': '[]',
    'homekit-accessories': '[]',
    'smartlife-user': '',
    'smartlife-devices': '[]',
    'lg-devices': '[]',
    'smartthings-devices': '[]',
    'melcloud-devices': '[]',
    'electrolux-devices': '[]',
    'hidden-rooms': [],
    'alerts': {},
    'sensor-rules': '{}',
    'location': 'panel',
    'panel-box': 'right',
    'panel-index': 0,
    'middle-click': 'none',
    'hover-switch': false,
};

const OFFLINE_OPACITY = 115;

// µs; a middle press and its click gesture land within this and count as one click.
const MIDDLE_TWICE = 250 * 1000;

// Logical px; WrapLayout isn't styled, so callers multiply by the scale factor.
const CHIP_SPACING = 6;

const MENU_SHARE = 0.7;
const QUICK_SETTINGS_MARGIN = 12;

const ON_INK = [0.1, 0.1, 0.12];
const WHITE = [1, 1, 1];

let units = null;

function unitText(unit) {
    units ??= {
        celsius: '°C',
        percentage: '%',
        lux: pgettext('unit', 'lx'),
        ppm: 'ppm',
        seconds: pgettext('unit', 's'),
        minutes: pgettext('unit', 'min'),
        hours: pgettext('unit', 'h'),
        days: pgettext('unit', 'd'),
        arcdegrees: '°',
        kelvin: 'K',
        watt: pgettext('unit', 'W'),
        volt: pgettext('unit', 'V'),
        ampere: pgettext('unit', 'A'),
        kWh: pgettext('unit', 'kWh'),
        pascal: pgettext('unit', 'Pa'),
    };
    return units[unit];
}

const numberFormat = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});

function readSetting(settings, key) {
    if (!settings?.settings_schema?.has_key(key))
        return DEFAULTS[key];

    try {
        return settings.get_value(key).deepUnpack();
    } catch (e) {
        console.debug(`nook: ${key}: ${e.message}`);
        return DEFAULTS[key];
    }
}

function booleanText(name, value) {
    switch (name) {
    case 'contact-state':
        return value ? _('Closed') : _('Open');
    case 'motion-state':
        return value ? _('Motion') : _('No motion');
    case 'submersion-state':
        return value ? _('Leak') : _('Dry');
    case 'smoke-status':
        return value ? _('Smoke!') : _('No smoke');
    case 'gas-status':
        return value ? _('Gas!') : _('No gas');
    default:
        return value ? _('On') : _('Off');
    }
}

// Common spec words get translated, anything else is shown as is. Tables are built on
// first use, once translations are loaded; keys go through specKey().
const specKey = text => String(text).trim().toLowerCase().replace(/[\s_]+/g, '-');

let choiceWords = null;

function choiceText(description) {
    choiceWords ??= {
        'off': _('Off'),
        'on': _('On'),
        'idle': _('Idle'),
        'sweeping': _('Cleaning'),
        'cleaning': _('Cleaning'),
        'paused': _('Paused'),
        'error': _('Error'),
        'fault': _('Error'),
        'charging': _('Charging'),
        'not-charging': _('Not charging'),
        'go-charging': _('Returning to dock'),
        'charging-completed': _('Charged'),
        'busy': _('Busy'),
        'open': _('Open'),
        'close': _('Closed'),
        'closed': _('Closed'),
        'auto': _('Auto'),
        'sleep': _('Sleep'),
        'favorite': _('Favourite'),
        'low': _('Low'),
        'middle': _('Medium'),
        'medium': _('Medium'),
        'high': _('High'),
        'normal': _('Normal'),
        'ultralow': _('Very low'),
        'cool': _('Cool'),
        'heat': _('Heat'),
        'dry': pgettext('mode', 'Dry'),
        'fan': pgettext('mode', 'Fan'),
        'left': _('Left'),
        'right': _('Right'),
        'none': _('None'),
        'null': _('None'),
        'no-faults': _('No faults'),
        'straight-wind': _('Straight wind'),
        'natural-wind': _('Natural wind'),
        // Dreame suction levels; their spec has only these Chinese descriptions.
        '安静': _('Quiet'),
        '标准': _('Standard'),
        '中档': _('Medium'),
        '强力': _('Turbo'),
        'quiet': _('Quiet'),
        'standard': _('Standard'),
        'strong': _('Turbo'),
        'turbo': _('Turbo'),
        'delay': _('Waiting to start'),
        'cooking': _('Cooking'),
        'preheat': _('Preheating'),
        'cooking-completed': _('Done'),
        'preheat-completed': _('Preheated'),
        'preheat-paused': _('Preheat paused'),
        'turn-pot-paused': _('Paused to turn the food'),
        'keep-warm': _('Keeping warm'),
        'keep-warm-paused': _('Keeping warm, paused'),
        'keep-warm-completed': _('Kept warm'),
        'crispy-roast': _('Crispy roast'),
        'tender-roast': _('Tender roast'),
        'degrease': _('Less fat'),
        'ntc-disconnect': _('Sensor disconnected'),
        'ntc-short-circuit': _('Sensor short circuit'),
        'ntc-failure': _('Sensor failure'),
        'french-fries': _('French fries'),
        'chicken-wing': _('Chicken wings'),
        'steak': _('Steak'),
        'lamb-chops': _('Lamb chops'),
        'fish': _('Fish'),
        'shrimp': _('Shrimp'),
        'vegetables': _('Vegetables'),
        'cake': _('Cake'),
        'pizza': _('Pizza'),
        'defrost': _('Defrost'),
        'dried-fruit': _('Dried fruit'),
        'yogurt': _('Yoghurt'),
        'manual': _('Manual'),
        'no-need-turn-over-pot': _('No need to turn'),
        'need-turn-over-pot': _('Turn the food'),
        'one-layer': _('One layer'),
        'double-layer': _('Two layers'),
        'half-pot': _('Half a basket'),
        'full-pot': _('Full basket'),
        'kilogram': _('Kilograms'),
        'pound': _('Pounds'),
        'battery-enough': _('Battery fine'),
        'battery-low': _('Battery low'),
        'battery-ultra-low': _('Battery very low'),
        'white': _('White'),
        'red': _('Red'),
        'orange': _('Orange'),
        'yellow': _('Yellow'),
        'green': _('Green'),
        'cyan': _('Cyan'),
        'blue': _('Blue'),
        'purple': _('Purple'),
        'pink': _('Pink'),
        'heat-and-cool': _('Heat and cool'),
        'opening': _('Opening'),
        'closing': _('Closing'),
        'stopped': _('Stopped'),
        'locked': _('Locked'),
        'unlocked': _('Unlocked'),
        'locking': _('Locking'),
        'unlocking': _('Unlocking'),
        'jammed': _('Jammed'),
        'playing': _('Playing'),
        'standby': _('Standby'),
        'buffering': _('Buffering'),
        'humidify': _('Humidify'),
        'dehumidify': _('Dehumidify'),
        'excellent': _('Excellent'),
        'good': _('Good'),
        'fair': _('Fair'),
        'inferior': _('Inferior'),
        'poor': _('Poor'),
        'eco': _('Eco'),
        'smart': _('Smart'),
        'mid': _('Medium'),
    };
    const key = specKey(description);
    const level = /^(level|gear)-?(\d+)$/.exec(key);
    if (level)
        return _('Level %s').replace('%s', level[2]);
    const minutes = /^(\d+)-minutes?$/.exec(key);
    if (minutes)
        return _('%s min').replace('%s', minutes[1]);
    return choiceWords[key] ?? String(description).trim();
}

function formatValue(prop, value) {
    if (value === null || value === undefined)
        return '';
    const choice = prop.choices?.find(c => c.value === value);
    if (choice)
        return choiceText(choice.description);
    if (typeof value === 'boolean')
        return booleanText(prop.name, value);
    if (typeof value === 'string')
        return plainString(value) ?? value;
    if (typeof value !== 'number')
        return String(value);

    const number = numberFormat.format(value);
    const unit = unitText(prop.unit) ?? prop.suffix;
    if (!unit)
        return number;
    return unit === '%' ? `${number}%` : `${number} ${unit}`;
}

function plainString(value) {
    if (typeof value !== 'string')
        return null;
    const text = value.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16))).trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text))
        return text.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
    return text.length <= 24 && /^\p{L}[\p{L}\p{M} '/._-]*$/u.test(text) ? text : null;
}

// ONVIF cameras have no urn, and their model ('IPC-model') names no kind.
const deviceType = device => device.urn?.split(':')[3] ?? (device.primary?.kind === 'camera' ? 'camera' : null);

const TV_APPS = [
    [/youtube/i, 'YouTube'],
    [/netflix/i, 'Netflix'],
    [/amazon|primevideo/i, 'Prime Video'],
    [/disney/i, 'Disney+'],
    [/spotify/i, 'Spotify'],
    [/kinopoisk/i, 'Kinopoisk'],
    [/browser/i, 'Browser'],
];

function tvShowing(device) {
    const named = device.source?.showing?.(device);
    if (named)
        return named;
    const {source, app} = device.state ?? {};
    if (!app && source === 'tv')
        return _('TV');
    const id = String(app ?? source ?? '');
    const hdmi = /hdmi[\W_]*(\d)/i.exec(id);
    if (hdmi)
        return `HDMI ${hdmi[1]}`;
    return TV_APPS.find(([pattern]) => pattern.test(id))?.[1] ?? null;
}

function inputTitle(input) {
    if (input.title)
        return input.title;
    if (input.id === 'tv')
        return _('TV');
    const hdmi = /^hdmi(\d)$/.exec(input.id);
    return hdmi ? `HDMI ${hdmi[1]}` : String(input.id);
}

const TV_VOLUME = {name: 'volume', format: 'uint8', range: [0, 100, 1], access: ['read', 'write'], unit: null};

function volumeIcon(level, muted) {
    if (muted || level === 0)
        return 'audio-volume-muted-symbolic';
    if (level < 0.34)
        return 'audio-volume-low-symbolic';
    return level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
}

function sonoffTrouble(e) {
    if (e instanceof SonoffError)
        return e.code === 401 ? _('The switch is not in DIY mode.') : _('The switch did not take the command.');
    if (e instanceof GLib.Error)
        return _('The switch is not answering. Is it on and on this network?');
    return e.message;
}

// SpecError codes in words; the rest as the device or service put it.
function specTrouble(e) {
    switch (e.code) {
    case 'busy':
        return _('The device is busy. Try again in a moment.');
    case 'unreachable':
        return _('The accessory cannot be reached.');
    case 'refused':
        return _('The device refused it.');
    case 'broken':
        return _('The device sent an answer Nook cannot read.');
    case 'unsupported':
        return _('The device cannot do that.');
    case 'tls':
        return _('The certificate of this Home Assistant is not trusted. Use its http:// address on this network, or give it a trusted certificate.');
    case 'unpaired':
        return _('The device no longer knows Nook. Pair it again.');
    case 'certificate':
        return _('The bridge answered with another certificate. Pair it again if it was replaced.');
    case 'unauthorized':
        return _('Home Assistant refused the access token.');
    case 'expired':
        return e.label ? _('The %s login has expired.').replace('%s', e.label) : _('The Smart Life login has expired.');
    case 'timeout':
        return _('The device did not answer in time.');
    case 'closed':
        return _('The connection closed. Try again.');
    default:
        return e.message;
    }
}

function tvTrouble(e) {
    if (e.code === 'unpaired')
        return _('Pair it in Settings, under TVs, to control it from here.');
    if (e.code === 'denied')
        return _('The TV did not let Nook in.');
    if (e.code === 'asleep')
        return _('The TV did not wake up. Turn on network standby (Powered On by Apps) in its network settings.');
    if (e instanceof GLib.Error || ['timeout', 'closed'].includes(e.code))
        return _('The TV is not answering. Is it on the same network?');
    return e.message;
}

const BRAND = /^(Xiaomi Smart|Xiaomi|Mi Smart|Mi)\s+/;

function shortName(name) {
    const rest = name.replace(BRAND, '');
    return rest.length >= 3 ? rest : name;
}

const WORKING = /cook|clean|sweep|mop|work|run|heat|bake|fry|boil|brew|busy|wash|rinse|spin|drying|grind/i;
// Overrides WORKING: "Cooking completed", "Preheat paused".
const NOT_WORKING = /complete|pause|finish|done|stop|wait|fault|error|charg/i;

function statusWorking(description) {
    return Boolean(description) && WORKING.test(description) && !NOT_WORKING.test(description);
}

function isWorking(device) {
    const {primary, values, online} = device;
    if (primary.kind === 'media')
        return online === true && values?.[0] === true;
    if (primary.kind !== 'reading' || !online)
        return false;
    return primary.props.some((p, i) => {
        return p.name === 'status' && statusWorking(p.choices?.find(c => c.value === values?.[i])?.description);
    });
}

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

function modeText(mode) {
    switch (MODES[mode]) {
    case 'auto':
        return _('Auto');
    case 'cool':
        return _('Cool');
    case 'dry':
        return pgettext('mode', 'Dry');
    case 'fan':
        return pgettext('mode', 'Fan');
    case 'heat':
        return _('Heat');
    default:
        return '';
    }
}

// BLE devices reach the cloud via a nearby phone or gateway; its "offline" means little.
const isBluetooth = device => String(device.did).startsWith('blt.');

function shortWhen(seconds) {
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const now = GLib.DateTime.new_now_local();
    if (then.format('%Y-%m-%d') === now.format('%Y-%m-%d'))
        return then.format('%H:%M');
    return then.format('%e %b').trim();
}

// Non-enumerable, so it stays out of the cached device list (stale by the next start).
function setLive(device, state) {
    Object.defineProperty(device, 'live', {value: state, writable: true, configurable: true, enumerable: false});
}

// Last BLE advertisement per did. Module-level so it outlives device list reloads and the
// indicator, which the lock screen destroys; a kettle advertises only every ~30 s.
// Cleared in disable().
const beacons = new Map();

// Seconds. Older readings stay off tiles, where they'd look current; cards date them.
const BEACON_FRESH = 10 * 60;
const LISTEN_SECONDS = 20;

function setBeacon(device, beacon) {
    beacons.set(device.did, beacon);
}

function beaconOf(device) {
    return beacons.get(device.did) ?? null;
}

function kettleStatus(status) {
    return [_('Idle'), _('Heating'), _('Cooling down'), _('Keeping warm')][status] ?? null;
}

function beaconText(beacon) {
    const parts = [];
    if (beacon.temperature !== undefined)
        parts.push(`${numberFormat.format(beacon.temperature)} °C`);
    if (beacon.humidity !== undefined)
        parts.push(`${numberFormat.format(beacon.humidity)} %`);
    if (beacon.status > 0 && kettleStatus(beacon.status))
        parts.push(kettleStatus(beacon.status));
    return parts.join(' · ') || null;
}

function beaconRows(beacon) {
    const rows = [];
    if (!beacon)
        return rows;
    const kettle = beacon.status !== undefined;
    if (beacon.temperature !== undefined) {
        rows.push({key: 'temperature', title: kettle ? _('Water') : _('Temperature'), glyph: 'thermometer',
            text: `${numberFormat.format(beacon.temperature)} °C`});
    }
    if (kettle && kettleStatus(beacon.status))
        rows.push({key: 'status', title: _('Status'), glyph: 'kettle', text: kettleStatus(beacon.status)});
    if (beacon.humidity !== undefined)
        rows.push({key: 'humidity', title: _('Humidity'), glyph: 'drop', text: `${numberFormat.format(beacon.humidity)} %`});
    if (beacon.battery !== undefined)
        rows.push({key: 'battery', title: _('Battery'), glyph: 'bolt', text: `${beacon.battery} %`});
    if (beacon.rssi !== undefined)
        rows.push({key: 'signal', title: _('Signal'), glyph: 'wifi', text: `${beacon.rssi} ${pgettext('unit', 'dBm')}`});
    if (beacon.time)
        rows.push({key: 'heard', title: _('Heard'), glyph: 'clock', text: whenText(beacon.time)});
    return rows;
}

function statChip({title, glyph, text}) {
    const chip = new St.BoxLayout({style_class: 'nook-stat-chip'});
    chip._glyph = new Glyph(glyph);
    chip.add_child(chip._glyph);
    chip._title = new St.Label({style_class: 'nook-stat-title', text: title, y_align: Clutter.ActorAlign.CENTER});
    chip.add_child(chip._title);
    chip._value = new St.Label({style_class: 'nook-stat-value', text, y_align: Clutter.ActorAlign.CENTER});
    chip.add_child(chip._value);
    return chip;
}

function statFlow() {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    return new St.Widget({style_class: 'nook-stats', layout_manager: new WrapLayout(CHIP_SPACING * scale), x_expand: true});
}

function fillStats(box, stats) {
    // Same chips, new numbers: retext in place, rebuilding makes the card jump.
    const chips = box.get_children();
    if (chips.length === stats.length && chips.every((chip, i) => chip._title?.text === stats[i].title)) {
        chips.forEach((chip, i) => {
            chip._glyph.setName(stats[i].glyph);
            chip._value.text = stats[i].text;
        });
        return;
    }
    box.destroy_all_children();
    for (const stat of stats)
        box.add_child(statChip(stat));
}

// miIO.info of spec-less devices (range extenders). Never show the token it also carries.
function infoRows(info) {
    const rows = [];
    if (info?.ap?.ssid)
        rows.push({key: 'network', title: _('Network'), glyph: 'wifi', text: info.ap.ssid});
    if (info?.ap?.rssi !== undefined)
        rows.push({key: 'signal', title: _('Signal'), glyph: 'wifi', text: `${info.ap.rssi} ${pgettext('unit', 'dBm')}`});
    if (info?.sta?.count !== undefined)
        rows.push({key: 'devices', title: _('Devices connected'), glyph: 'hub', text: String(info.sta.count)});
    if (info?.netif?.localIp)
        rows.push({key: 'address', title: _('Address'), glyph: 'home', text: info.netif.localIp});
    if (info?.fw_ver)
        rows.push({key: 'firmware', title: _('Firmware'), glyph: 'appliance', text: info.fw_ver});
    if (info?.life > 0)
        rows.push({key: 'uptime', title: _('Up for'), glyph: 'clock', text: spanText(info.life)});
    return rows;
}

function spanText(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (days > 0)
        return _('%s d %s h').replace('%s', days).replace('%s', hours);
    if (hours > 0)
        return _('%s h %s min').replace('%s', hours).replace('%s', minutes);
    return _('%s min').replace('%s', minutes);
}

function macText(mac) {
    const hex = String(mac).replace(/[^0-9a-f]/gi, '');
    return hex.length === 12 ? hex.toUpperCase().match(/../g).join(':') : String(mac).toUpperCase();
}

function aboutRows(device, nameOf) {
    const about = device.about ?? {};
    const rows = [];
    if (about.parent)
        rows.push({key: 'gateway', title: _('Gateway'), glyph: 'hub', text: nameOf(about.parent)});
    if (about.ssid)
        rows.push({key: 'network', title: _('Network'), glyph: 'wifi', text: about.ssid});
    if (about.rssi)
        rows.push({key: 'signal', title: _('Signal'), glyph: 'wifi', text: `${about.rssi} ${pgettext('unit', 'dBm')}`});
    if (about.ip)
        rows.push({key: 'address', title: _('Address'), glyph: 'home', text: about.ip});
    if (about.mac) {
        const title = isBluetooth(device) ? _('Bluetooth address') : _('MAC address');
        rows.push({key: 'mac', title, glyph: isBluetooth(device) ? 'dot' : 'wifi', text: macText(about.mac)});
    }
    if (about.firmware)
        rows.push({key: 'firmware', title: _('Firmware'), glyph: 'appliance', text: about.firmware});
    if (about.mcu)
        rows.push({key: 'mcu', title: _('MCU firmware'), glyph: 'appliance', text: about.mcu});
    if (about.hardware)
        rows.push({key: 'hardware', title: _('Hardware'), glyph: 'appliance', text: about.hardware});
    if (about.uptime > 0)
        rows.push({key: 'uptime', title: _('Up for'), glyph: 'clock', text: spanText(about.uptime)});
    const model = 'model' in about ? about.model : device.model;
    if (model)
        rows.push({key: 'model', title: _('Model'), glyph: 'appliance', text: model});
    if (device.online === false && about.lastOnline)
        rows.push({key: 'last-online', title: _('Last online'), glyph: 'clock', text: whenText(about.lastOnline)});
    return rows;
}

function liveText(device) {
    const data = device.live;
    if (!data)
        return null;
    const kind = sensorKind(device.model);
    if ((kind === 'smoke' || kind === 'gas') && data.alarm !== undefined) {
        const alarm = String(data.alarm);
        if (alarm === '0')
            return kind === 'smoke' ? _('No smoke') : _('No gas');
        if (alarm === '1' || alarm === '2')
            return kind === 'smoke' ? _('Smoke!') : _('Gas!');
        return _('Fault');
    }
    if (data.status === 'leak')
        return _('Leak!');
    if (data.status === 'no_leak')
        return _('No leak');
    return null;
}

function eventText(device) {
    const last = device.lastEvent;
    if (sensorKind(device.model) === 'leak') {
        const live = liveText(device);
        if (live)
            return live;
        if (last === undefined)
            return null;
        // null: the history answered empty (undefined: not loaded yet).
        return last?.key === 'leak' ? `${_('Leak!')} · ${shortWhen(last.time)}` : _('No leak');
    }
    if (!last)
        return null;
    const label = (EVENT_KEYS()[deviceType(device)] ?? []).find(([key]) => key === last.key)?.[1];
    return label ? `${label} · ${shortWhen(last.time)}` : null;
}

// Xiaomi Zigbee coin cell mV to %, zigbee2mqtt's scale: 2850 mV empty, 3000 mV full.
function batteryShare(millivolts) {
    return Math.max(0, Math.min(100, Math.round((millivolts - 2850) / 1.5)));
}

const HERO_STATES = ['contact-state', 'motion-state', 'occupancy-status', 'submersion-state', 'smoke-status', 'gas-status'];

const SAID_LIVE = {
    status: ['contact-state', 'submersion-state', 'motion-state'],
    temperature: ['temperature'],
    humidity: ['relative-humidity'],
    pressure: ['atmospheric-pressure'],
    lux: ['illumination'],
    voltage: ['battery-level', 'voltage'],
};

function liveRows(data) {
    const rows = [];
    const scaled = (value, divisor) => numberFormat.format(Number(value) / divisor);
    if (data.alarm !== undefined) {
        const alarm = String(data.alarm);
        rows.push({key: 'alarm', title: _('Alarm'), glyph: 'bell',
            text: alarm === '0' ? _('None') : (alarm === '1' || alarm === '2') ? _('Alarm!') : _('Fault')});
    }
    if (data.density !== undefined)
        rows.push({key: 'density', title: _('Density'), glyph: 'smoke', text: String(data.density)});
    if (data.temperature !== undefined)
        rows.push({key: 'temperature', title: _('Temperature'), glyph: 'thermometer', text: `${scaled(data.temperature, 100)} °C`});
    if (data.humidity !== undefined)
        rows.push({key: 'humidity', title: _('Humidity'), glyph: 'drop', text: `${scaled(data.humidity, 100)} %`});
    if (data.pressure !== undefined)
        rows.push({key: 'pressure', title: _('Pressure'), glyph: 'wind', text: `${scaled(data.pressure, 100)} hPa`});
    if (data.lux !== undefined)
        rows.push({key: 'light', title: _('Light'), glyph: 'sun', text: `${data.lux} ${pgettext('unit', 'lx')}`});
    if (data.voltage !== undefined) {
        rows.push({key: 'battery', title: _('Battery'), glyph: 'bolt',
            text: `${batteryShare(data.voltage)} % · ${scaled(data.voltage, 1000)} ${pgettext('unit', 'V')}`});
    }
    return rows;
}

function stateText(device) {
    const {primary, values, online} = device;
    const beacon = beaconOf(device);
    if (beacon && Date.now() / 1000 - beacon.time < BEACON_FRESH) {
        const heard = beaconText(beacon);
        if (heard)
            return heard;
    }
    if (online === null || online === undefined)
        return '…';
    if (!online && isBluetooth(device))
        return _('Bluetooth');
    if (!online)
        return _('Offline');

    if (primary.kind === 'camera')
        return _('Online');

    if (primary.kind === 'climate') {
        const {Pow: power, Mod: mode, SetTem: target} = device.state;
        return power === 1 ? `${modeText(mode)} · ${numberFormat.format(target)}°` : _('Off');
    }

    if (primary.kind === 'media') {
        const media = device.state?.media;
        if (playingNow(device))
            return media?.title ?? device.state.app ?? _('Playing');
        if (media?.state === 'PAUSED')
            return _('Paused');
        return device.state?.app ?? _('Idle');
    }

    if (primary.kind === 'tv') {
        if (!device.state?.paired)
            return _('Not paired');
        if (!device.state.on)
            return _('Off');
        return device.state.muted ? _('Muted') : tvShowing(device) ?? _('On');
    }

    if (primary.kind === 'switch') {
        if (!values)
            return '…';
        const on = values[0] === true;
        if (primary.props[0].service === 'light' && deviceType(device) !== 'light')
            return on ? _('Light on') : _('Light off');
        return on ? _('On') : _('Off');
    }

    if (device.unreadable)
        return liveText(device) ?? _('Online');
    if (primary.kind === 'none') {
        const text = eventText(device) ?? liveText(device);
        if (text)
            return text;
        return sensorKind(device.model) === 'leak' ? '…' : _('Online');
    }

    if (primary.kind === 'reading' && !values)
        return '…';
    const parts = primary.props.map((p, i) => formatValue(p, values?.[i])).filter(Boolean);
    if (parts.length === 0)
        return liveText(device) ?? _('Online');
    const time = primary.props.length === 1 && primary.props[0].format === 'bool' ? device.times?.[0] : null;
    if (time)
        parts.push(shortWhen(time));
    return parts.join(' · ');
}

const HERO_SCENES = {
    thermometer: 'thermo',
    motion: 'motion',
    door: 'door',
    drop: 'leak',
    smoke: 'smoke',
    fan: 'fan',
    kettle: 'kettle',
    vacuum: 'vacuum',
    scale: 'scale',
    hub: 'gateway',
    wifi: 'repeater',
    button: 'button',
    pot: 'fryer',
    scooter: 'scooter',
    aircon: 'aircon',
    speaker: 'speaker',
    bulb: 'light',
    plug: 'plug',
    rocker: 'plug',
    washer: 'washer',
    dishwasher: 'dishwasher',
    purifier: 'purifier',
    humidifier: 'humidifier',
    dehumidifier: 'dehumidifier',
    heater: 'heater',
    curtain: 'curtain',
    lock: 'lock',
    fridge: 'fridge',
    coffee: 'coffee',
    thermostat: 'thermostat',
    doorbell: 'doorbell',
    plant: 'plant',
    cooker: 'cooker',
    filter: 'water',
};

// PM2.5 in µg/m³, banded like purifiers' ring lights.
function airQuality(pm) {
    if (pm <= 35)
        return [0.36, 0.8, 0.5];
    if (pm <= 75)
        return [0.95, 0.78, 0.3];
    if (pm <= 115)
        return [0.98, 0.55, 0.25];
    return [0.9, 0.3, 0.3];
}

const ALARM = [0.9, 0.3, 0.3];
const RESTING = [0.52, 0.52, 0.57];

// Vacuum map refetch: after MAP_FRESH ms; every MAP_FRESH_WORKING s while cleaning.
const MAP_FRESH = 5 * 60 * 1000;
const MAP_FRESH_WORKING = 20;
const MAP_LIVE = 5;
const MAP_TRAIL = 20000;

// Open card: checked every CARD_TICK s, re-read when the last read is older than
// CARD_LOCAL/CARD_CLOUD ms and it has been untouched for CARD_TOUCHED ms.
const CARD_TICK = 1;
const CARD_LOCAL = 5000;
const CARD_CLOUD = 10000;
const CARD_TOUCHED = 5000;

const APP_COLORS = [
    [/spotify/i, [0.12, 0.73, 0.33]],
    [/youtube/i, [0.9, 0.22, 0.2]],
    [/apple/i, [0.98, 0.3, 0.42]],
    [/deezer/i, [0.64, 0.3, 0.95]],
];
const SPEAKER = [0.66, 0.46, 0.95];
const SILENT = [0.4, 0.44, 0.52];

function playingNow(device) {
    return ['PLAYING', 'BUFFERING'].includes(device.state?.media?.state) || onlyStops(device);
}

// An app with no media session and no playing group takes no pause, only a receiver STOP.
function onlyStops(device) {
    return Boolean(device.state?.app) && !device.state.media;
}

function castToggle(home, device) {
    if (onlyStops(device))
        return home.stop(device);
    return playingNow(device) ? home.pause(device) : home.play(device);
}

function showCastPlay(button, device) {
    let look = ['media-playback-start-symbolic', _('Play')];
    if (onlyStops(device))
        look = ['media-playback-stop-symbolic', _('Stop')];
    else if (playingNow(device))
        look = ['media-playback-pause-symbolic', _('Pause')];
    [button.child.icon_name, button.accessible_name] = look;
    button.reactive = Boolean(device.state?.media) || onlyStops(device);
}

// Cast supportedMediaCommands bits: 64 next, 128 previous. A media status
// without the field allows everything.
function castAllows(media, bit) {
    return Boolean(media) && (typeof media.commands !== 'number' || (media.commands & bit) !== 0);
}

function mediaColor(device) {
    const app = device.state?.app ?? '';
    if (!app && !playingNow(device))
        return SILENT;
    return APP_COLORS.find(([pattern]) => pattern.test(app))?.[1] ?? SPEAKER;
}

function speakerKind(model) {
    if (/group/i.test(model))
        return 'group';
    if (/mini|l05|lx01/i.test(model))
        return 'puck';
    if (/hub|display|tv|chromecast|lx04|x08|x10/i.test(model))
        return 'display';
    return 'tower';
}

function clock(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    const rest = String(whole % 60).padStart(2, '0');
    if (minutes < 60)
        return `${minutes}:${rest}`;
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}

function freeze(actor) {
    if (actor instanceof St.Button || actor instanceof CardSlider) {
        actor.reactive = false;
        actor.can_focus = false;
    }
    for (const child of actor.get_children())
        freeze(child);
}

// A gateway's or socket's built-in light gets its own tile; it isn't the device's switch.
function ownSwitch(device) {
    const [prop] = device.primary.props;
    return device.primary.kind === 'switch' && !(prop.service === 'light' && deviceType(device) !== 'light');
}

// Never ellipsized: the label may be allocated less than the room it really has.
function wordLabel(text) {
    const label = new St.Label({style_class: 'nook-vacuum-word', text, x_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function choiceOf(prop, value) {
    return prop?.choices?.find(c => c.value === value)?.description ?? null;
}

// Dreame fault codes; their spec describes only "No faults".
const DREAME_FAULTS = () => ({
    1: _('The wheels are off the floor'),
    2: _('A cliff sensor is dirty or blocked'),
    3: _('The bumper is stuck'),
    4: _('The robot is tilted'),
    5: _('The bumper keeps getting stuck'),
    6: _('The wheels keep coming off the floor'),
    7: _('The floor sensor underneath is dirty'),
    8: _('The dust bin is missing'),
    9: _('The water tank is missing'),
    10: _('The water tank is empty'),
    11: _('The dust bin is full'),
    12: _('The main brush is stuck'),
    13: _('The side brush is stuck'),
    14: _('The fan is blocked'),
    15: _('The left wheel is stuck'),
    16: _('The right wheel is stuck'),
    17: _('The robot is stuck and cannot turn'),
    18: _('The robot is stuck and cannot go on'),
    19: _('The robot cannot find its dock'),
    20: _('The battery is low'),
    21: _('It is not charging'),
    22: _('The battery is too low to start'),
    23: _('Something is wrong inside the robot'),
    24: _('The camera is covered'),
    25: _('The camera does not work'),
    26: _('Something is wrong with the battery'),
    27: _('The front sensor is dirty'),
    28: _('The gyroscope does not work'),
});

function faultText(device, prop, value) {
    const own = choiceOf(prop, value);
    if (own)
        return choiceText(own);
    if (String(device.model).startsWith('dreame.'))
        return DREAME_FAULTS()[value] ?? null;
    return null;
}

// Matched on the spec's status words; the numbers differ per model.
function vacuumMode(description) {
    const text = description ?? '';
    if (/go charging|return/i.test(text))
        return 'returning';
    if (/charging/i.test(text) && !/not charging|charging not/i.test(text))
        return 'charging';
    if (/sweep|clean|mop/i.test(text))
        return 'cleaning';
    if (/error|fault/i.test(text))
        return 'error';
    return 'idle';
}

function heroOf(device, services, values) {
    const [glyph, color] = Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model);
    const scene = deviceType(device) === 'gateway' ? 'gateway' : HERO_SCENES[glyph] ?? 'glyph';
    // Smoke detectors' type colour is red; keep red for an actual alarm.
    const calm = scene === 'smoke' ? [0.45, 0.5, 0.58] : color;
    const hero = {scene, state: {glyph}, color: calm, big: null, small: null, alarm: false};
    const find = name => {
        const index = device.primary.props.findIndex(p => p.name === name);
        if (index >= 0 && device.values?.[index] !== null && device.values?.[index] !== undefined)
            return {prop: device.primary.props[index], value: device.values[index]};
        for (const service of services) {
            const prop = service.properties.find(p => p.name === name);
            const key = prop ? `${service.siid}/${prop.piid}` : null;
            if (key && values.has(key))
                return {prop, value: values.get(key)};
        }
        return null;
    };
    const live = device.live ?? {};
    const heard = beaconOf(device);
    const beacon = heard && Date.now() / 1000 - heard.time < BEACON_FRESH ? heard : {};
    const degrees = value => `${numberFormat.format(value)}°`;
    // Gateway values are hundredths, as strings; anything non-numeric is no reading.
    const hundredths = value => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) / 100 : null);

    switch (hero.scene) {
    case 'thermo': {
        let temperature = find('temperature')?.value ?? null;
        let humidity = find('relative-humidity')?.value ?? null;
        temperature = hundredths(live.temperature) ?? temperature;
        humidity = hundredths(live.humidity) ?? humidity;
        temperature = beacon.temperature ?? temperature;
        humidity = beacon.humidity ?? humidity;
        hero.state = {temperature, humidity};
        if (typeof temperature === 'number')
            hero.big = degrees(temperature);
        if (typeof humidity === 'number')
            hero.small = _('Humidity %s %').replace('%s', numberFormat.format(humidity));
        break;
    }
    case 'motion': {
        const motion = find('motion-state');
        const occupancy = find('occupancy-status');
        const presence = choiceOf(occupancy?.prop, occupancy?.value);
        const active = motion || !presence ? motion?.value === true : !/^\s*(no|un)/i.test(presence);
        hero.state = {active};
        hero.big = motion || !presence ? booleanText('motion-state', active) : choiceText(presence);
        const time = device.times?.[device.primary.props.findIndex(p => p.name === 'motion-state')];
        if (time)
            hero.small = _('Last seen %s').replace('%s', whenText(time));
        break;
    }
    case 'door': {
        const closed = find('contact-state')?.value;
        if (typeof closed === 'boolean') {
            hero.state = {open: !closed};
            hero.big = booleanText('contact-state', closed);
            const time = device.times?.[device.primary.props.findIndex(p => p.name === 'contact-state')];
            if (time)
                hero.small = _('Since %s').replace('%s', whenText(time));
        }
        break;
    }
    case 'leak': {
        const submersion = find('submersion-state')?.value;
        const told = live.status !== undefined || Boolean(device.lastEvent);
        const wet = live.status === 'leak' || (live.status === undefined && device.lastEvent?.key === 'leak') ||
            (!told && submersion === true);
        hero.state = {wet};
        hero.alarm = wet;
        hero.big = eventText(device) ?? (typeof submersion === 'boolean' ? booleanText('submersion-state', submersion) : null);
        break;
    }
    case 'smoke': {
        const said = ['smoke-status', 'gas-status'].map(name => find(name)).find(Boolean);
        const alarm = live.alarm !== undefined ? ['1', '2'].includes(String(live.alarm)) : said?.value === true;
        hero.state = {alarm};
        hero.alarm = alarm;
        hero.big = liveText(device);
        if (!hero.big && live.alarm === undefined && said) {
            if (said.prop.name === 'gas-status')
                hero.big = alarm ? _('Gas!') : _('No gas');
            else
                hero.big = alarm ? _('Smoke!') : _('No smoke');
        }
        const concentration = find('smoke-concentration');
        if (concentration && typeof concentration.value === 'number')
            hero.small = _('Smoke %s').replace('%s', formatValue(concentration.prop, concentration.value));
        break;
    }
    case 'fan': {
        const on = device.values?.[0] === true;
        const level = find('fan-level');
        hero.state = {on, level: typeof level?.value === 'number' ? level.value : 1};
        hero.big = on ? _('On') : _('Off');
        if (!on)
            hero.color = RESTING;
        const speed = choiceOf(level?.prop, level?.value);
        const wind = choiceOf(find('mode')?.prop, find('mode')?.value);
        const parts = [];
        if (speed)
            parts.push(/\d/.test(speed) ? _('Speed %s').replace('%s', speed.replace(/\D+/g, '')) : choiceText(speed));
        if (wind)
            parts.push(choiceText(wind));
        hero.small = parts.join(' · ') || null;
        break;
    }
    case 'kettle': {
        const water = find('temperature')?.value;
        const doing = choiceOf(find('status')?.prop, find('status')?.value) ?? '';
        let status = beacon.status;
        if (status === undefined && doing)
            status = /heat|boil/i.test(doing) ? 1 : /cool/i.test(doing) ? 2 : /warm|keep/i.test(doing) ? 3 : 0;
        const temperature = beacon.temperature ?? (typeof water === 'number' ? water : null);
        hero.state = {temperature, status: status ?? 0};
        if (temperature !== null)
            hero.big = degrees(temperature);
        if (status !== undefined)
            hero.small = kettleStatus(status);
        break;
    }
    case 'aircon': {
        const on = device.values?.[0] === true;
        const mode = find('mode');
        const description = choiceOf(mode?.prop, mode?.value);
        const target = find('target-temperature')?.value;
        const room = find('temperature')?.value;
        const known = typeof target === 'number';
        const look = climateLook(climateMode(description), known ? target : 24);
        const level = choiceOf(find('fan-level')?.prop, find('fan-level')?.value) ?? '';
        const step = Number(/\d+/.exec(level)?.[0]);
        hero.state = {
            on,
            ...look,
            target: known ? Math.round(target) : null,
            swing: find('vertical-swing')?.value === true || find('horizontal-swing')?.value === true ? 1 : 0,
            speed: /auto/i.test(level) || !step ? 1 : 0.6 + Math.min(step, 5) * 0.18,
            light: known,
        };
        hero.color = on ? look.color : RESTING;
        hero.big = on ? (description ? choiceText(description) : _('On')) : _('Off');
        hero.small = [
            known ? _('Set to %s').replace('%s', degrees(target)) : null,
            typeof room === 'number' ? _('Room %s°').replace('%s', numberFormat.format(room)) : null,
        ].filter(Boolean).join(' · ') || null;
        break;
    }
    case 'speaker': {
        const playing = /^\s*play/i.test(choiceOf(find('playing-state')?.prop, find('playing-state')?.value) ?? '');
        const volume = find('volume')?.value;
        const muted = find('mute')?.value === true;
        hero.state = {kind: speakerKind(device.model), playing, muted, volume: typeof volume === 'number' ? volume / 100 : 0.5};
        hero.color = playing ? SPEAKER : SILENT;
        hero.big = playing ? _('Playing') : _('Nothing playing');
        if (typeof volume === 'number')
            hero.small = _('Volume %s %').replace('%s', volume);
        break;
    }
    case 'light': {
        const on = device.values?.[0] === true;
        const brightness = find('brightness')?.value;
        const kelvin = find('color-temperature')?.value;
        const rgb = find('color')?.value;
        let color = [1, 0.84, 0.55];
        if (typeof kelvin === 'number' && kelvin > 0)
            color = Scenes.kelvinColor(kelvin);
        else if (typeof rgb === 'number' && rgb > 0)
            color = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map(v => v / 255);
        hero.state = {on, color, brightness: typeof brightness === 'number' ? brightness : 100};
        hero.color = on ? Scenes.mix([0.97, 0.66, 0.26], color, 0.3) : RESTING;
        hero.big = on ? _('On') : _('Off');
        if (on) {
            hero.small = [
                typeof brightness === 'number' ? _('Brightness %s %').replace('%s', brightness) : null,
                typeof kelvin === 'number' && kelvin > 0 ? `${kelvin} K` : null,
            ].filter(Boolean).join(' · ') || null;
        }
        break;
    }
    case 'plug': {
        const on = device.values?.[0] === true;
        const power = find('electric-power');
        hero.state = {on, kind: glyph === 'rocker' ? 'switch' : 'outlet'};
        hero.color = on ? [0.24, 0.62, 0.46] : RESTING;
        // Never read: stateText says "Offline" or "…" rather than a made-up "Off".
        if (device.values)
            hero.big = on ? _('On') : _('Off');
        if (on && typeof power?.value === 'number')
            hero.small = _('Drawing %s').replace('%s', formatValue(power.prop, power.value));
        break;
    }
    case 'vacuum': {
        const status = find('status');
        const description = choiceOf(status?.prop, status?.value);
        hero.state = {mode: vacuumMode(description)};
        hero.alarm = hero.state.mode === 'error';
        hero.color = {
            cleaning: [0.3, 0.55, 0.98],
            charging: [0.3, 0.72, 0.5],
            returning: [0.96, 0.62, 0.26],
        }[hero.state.mode] ?? hero.color;
        if (description)
            hero.big = choiceText(description);
        const fault = find('fault');
        const trouble = fault && fault.value !== 0 ? faultText(device, fault.prop, fault.value) : null;
        if (trouble)
            hero.big = trouble;
        const battery = find('battery-level');
        if (typeof battery?.value === 'number')
            hero.small = _('Battery %s %').replace('%s', battery.value);
        if (battery?.value <= 15 && !['charging', 'returning', 'error'].includes(hero.state.mode)) {
            hero.small = _('Battery %s %, needs charging').replace('%s', battery.value);
            hero.color = [0.96, 0.62, 0.26];
        }
        break;
    }
    case 'fryer': {
        const status = find('status');
        const description = choiceOf(status?.prop, status?.value);
        const cooking = /^\s*(cooking|preheat)\s*$/i.test(description ?? '');
        const target = find('target-temperature')?.value;
        hero.state = {cooking, temperature: cooking && typeof target === 'number' ? target : null};
        if (!cooking)
            hero.color = RESTING;
        if (description)
            hero.big = choiceText(description);
        if (typeof target === 'number')
            hero.small = _('Set to %s').replace('%s', degrees(target));
        break;
    }
    case 'gateway': {
        const light = device.values?.[0] === true;
        hero.state = {light};
        hero.big = light ? _('Light on') : _('Light off');
        hero.color = light ? [0.97, 0.62, 0.26] : [0.45, 0.5, 0.58];
        break;
    }
    case 'repeater': {
        hero.state = {online: device.online !== false};
        const rssi = device.info?.ap?.rssi ?? device.about?.rssi;
        hero.big = device.info?.ap?.ssid ?? device.about?.ssid ?? null;
        if (rssi !== undefined && rssi !== null)
            hero.small = _('Signal %s dBm').replace('%s', rssi);
        break;
    }
    case 'button':
        hero.big = eventText(device);
        break;
    case 'washer':
    case 'dishwasher':
    case 'coffee':
    case 'cooker': {
        const status = find('status');
        const description = choiceOf(status?.prop, status?.value);
        const power = find('on')?.value;
        const working = statusWorking(description);
        hero.state = {working, cooking: working};
        if (!working)
            hero.color = RESTING;
        if (description)
            hero.big = choiceText(description);
        else if (typeof power === 'boolean')
            hero.big = power ? _('On') : _('Off');
        const left = find('left-time');
        if (working && typeof left?.value === 'number' && left.value > 0)
            hero.small = _('%s left').replace('%s', formatValue(left.prop, left.value));
        break;
    }
    case 'purifier': {
        const on = find('on')?.value === true;
        const pm = find('pm2.5-density');
        const level = find('fan-level')?.value;
        const filter = find('filter-life-level')?.value;
        const quality = typeof pm?.value === 'number' ? airQuality(pm.value) : null;
        hero.state = {on, level: typeof level === 'number' ? level : 1, color: quality ?? undefined};
        hero.color = on ? quality ?? hero.color : RESTING;
        hero.big = typeof pm?.value === 'number' ? formatValue(pm.prop, pm.value) : on ? _('On') : _('Off');
        hero.small = [typeof pm?.value === 'number' ? 'PM2.5' : null,
            typeof filter === 'number' ? _('Filter %s %').replace('%s', filter) : null].filter(Boolean).join(' · ') || null;
        break;
    }
    case 'humidifier':
    case 'dehumidifier': {
        const on = find('on')?.value === true;
        const humidity = find('relative-humidity')?.value;
        const target = find('target-humidity')?.value;
        const water = find('water-level');
        const most = water?.prop.range?.[1];
        hero.state = {on, water: typeof water?.value === 'number' && most ? water.value / most : null};
        if (!on)
            hero.color = RESTING;
        hero.big = typeof humidity === 'number' ? `${numberFormat.format(humidity)} %` : on ? _('On') : _('Off');
        if (typeof target === 'number')
            hero.small = _('Set to %s').replace('%s', `${target} %`);
        break;
    }
    case 'heater':
    case 'thermostat': {
        // Some thermostats have no power switch; treat them as on.
        const power = find('on')?.value;
        const on = typeof power === 'boolean' ? power : true;
        const target = find('target-temperature')?.value;
        const temperature = find('temperature')?.value ?? find('indoor-temperature')?.value;
        hero.state = {
            on,
            target: typeof target === 'number' ? target : null,
            temperature: typeof temperature === 'number' ? temperature : null,
        };
        if (!on)
            hero.color = RESTING;
        if (typeof temperature === 'number')
            hero.big = degrees(temperature);
        else if (typeof power === 'boolean')
            hero.big = on ? _('On') : _('Off');
        if (typeof target === 'number')
            hero.small = _('Set to %s').replace('%s', degrees(target));
        break;
    }
    case 'curtain': {
        const position = find('current-position') ?? find('target-position');
        const share = typeof position?.value === 'number' ? position.value / (position.prop.range?.[1] || 100) : null;
        hero.state = {position: share};
        if (share !== null && share >= 0.98)
            hero.big = _('Open');
        else if (share !== null && share <= 0.02)
            hero.big = _('Closed');
        else if (share !== null)
            hero.big = _('Open %s %').replace('%s', Math.round(share * 100));
        break;
    }
    case 'lock':
        // Most locks don't report their state to the cloud; show the last event.
        hero.state = {locked: null};
        hero.big = eventText(device);
        break;
    case 'fridge': {
        const part = name => {
            const service = services.find(s => s.name === name);
            const prop = service?.properties.find(p => p.name === 'target-temperature') ??
                service?.properties.find(p => p.name === 'temperature');
            const value = prop ? values.get(`${service.siid}/${prop.piid}`) : undefined;
            return typeof value === 'number' ? degrees(value) : null;
        };
        hero.state = {fridge: part('fridge-chamber'), freezer: part('freezer-chamber')};
        hero.big = hero.state.fridge;
        if (hero.state.freezer)
            hero.small = _('Freezer %s').replace('%s', hero.state.freezer);
        break;
    }
    case 'doorbell': {
        const last = device.lastEvent;
        hero.state = {ringing: Boolean(last?.time) && Date.now() / 1000 - last.time < 60};
        hero.big = eventText(device);
        break;
    }
    case 'plant': {
        const moisture = find('soil-moisture');
        hero.state = {moisture: typeof moisture?.value === 'number' ? moisture.value : null};
        if (typeof moisture?.value === 'number')
            hero.big = _('Soil %s %').replace('%s', moisture.value);
        hero.small = ['temperature', 'illumination'].map(find).filter(f => typeof f?.value === 'number')
            .map(f => formatValue(f.prop, f.value)).join(' · ') || null;
        break;
    }
    case 'water': {
        const tds = find('tds-out');
        hero.state = {tds: typeof tds?.value === 'number' ? tds.value : null};
        if (hero.state.tds !== null)
            hero.big = `${hero.state.tds} TDS`;
        break;
    }
    case 'scale': {
        const weight = find('weight');
        const text = weight ? formatValue(weight.prop, weight.value) : null;
        hero.state = {weight: text || null};
        if (text)
            hero.big = text;
        break;
    }
    case 'scooter': {
        const battery = find('ble-battery-level');
        if (typeof battery?.value === 'number')
            hero.big = `${battery.value} %`;
        break;
    }
    }
    hero.big ??= stateText(device);
    return hero;
}

const NO_ROOM = '@other';
const PINNED = '@pinned';

// Cloud event-history keys by device type. A function so the labels are translated
// at call time, not at import.
const EVENT_KEYS = () => ({
    'submersion-sensor': [['leak', _('Leak')], ['no_leak', _('Dry again')]],
    'remote-control': [['click', _('Pressed')], ['double_click', _('Pressed twice')], ['long_click_press', _('Held')]],
    'motion-sensor': [['motion', _('Motion')]],
    'magnet-sensor': [['open', _('Opened')], ['close', _('Closed')]],
});

function whenText(seconds) {
    const then = GLib.DateTime.new_from_unix_local(seconds);
    const now = GLib.DateTime.new_now_local();
    const day = d => d.format('%Y-%m-%d');
    if (day(then) === day(now))
        return _('today, %s').replace('%s', then.format('%H:%M'));
    if (day(then) === day(now.add_days(-1)))
        return _('yesterday, %s').replace('%s', then.format('%H:%M'));
    return then.format('%e %b, %H:%M').trim();
}

// Matches both the gateway's model names ("magnet", "sensor_wleak.aq1") and Mi Home's
// ("lumi.sensor_magnet").
function sensorKind(model) {
    if (/wleak/.test(model))
        return 'leak';
    if (/smoke/.test(model))
        return 'smoke';
    if (/natgas/.test(model))
        return 'gas';
    if (/magnet/.test(model))
        return 'door';
    if (/motion/.test(model))
        return 'motion';
    if (/vibration/.test(model))
        return 'vibration';
    if (/switch|86sw|remote\.b/.test(model))
        return 'button';
    if (/sensor_ht|weather/.test(model))
        return 'climate';
    return null;
}

const ALARM_KINDS = ['leak', 'smoke', 'gas'];

function alertsOn(settings, did, kind) {
    return readSetting(settings, 'alerts')[did] ?? ALARM_KINDS.includes(kind);
}

function sensorRules(settings) {
    try {
        const rules = JSON.parse(readSetting(settings, 'sensor-rules'));
        return rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {};
    } catch {
        return {};
    }
}

const LOW_BATTERY = 15;

const ALERT_SCOPE = () => ({
    leak: _('A leak, and when it is dry again'),
    smoke: _('An alarm, and when it is over'),
    gas: _('An alarm, and when it is over'),
    door: _('Every opening and closing'),
    motion: _('Every motion it sees'),
    vibration: _('Every knock, tilt and fall'),
    button: _('Every press'),
});

function reportText(kind, data) {
    const status = data.status ?? data.wleak_status ?? data.window_status ?? data.motion_status ?? data.channel_0;
    switch (kind) {
    case 'leak':
        if (status === 'leak')
            return [_('Water leak!'), true];
        return status === 'no_leak' ? [_('Dry again.'), false] : null;
    case 'smoke':
    case 'gas': {
        const alarm = data.alarm === undefined ? null : String(data.alarm);
        if (alarm === null)
            return null;
        if (alarm === '1' || alarm === '2')
            return [kind === 'smoke' ? _('Smoke alarm!') : _('Gas alarm!'), true];
        return alarm === '0' ? [_('The alarm is over.'), false] : [_('The detector reports a fault.'), false];
    }
    case 'door':
        if (data.no_close)
            return [_('Still open.'), false];
        return {open: [_('Opened.'), false], close: [_('Closed.'), false]}[status] ?? null;
    case 'motion':
        return status === 'motion' ? [_('Motion.'), false] : null;
    case 'vibration':
        return {
            vibrate: [_('A knock.'), false],
            tilt: [_('Tilted.'), false],
            free_fall: [_('Dropped.'), false],
        }[status] ?? null;
    case 'button':
        return {
            click: [_('Pressed.'), false],
            double_click: [_('Pressed twice.'), false],
            long_click_press: [_('Held down.'), false],
            both_click: [_('Pressed.'), false],
            shake: [_('Shaken.'), false],
        }[status] ?? null;
    }
    return null;
}

// Destructive actions are left off cards: too easy to hit by a stray click in a menu.
const RISKY_ACTION = /^(reset|del|delete)-/;

const PLUMBING = ['user-management', 'offline-data', 'sync-info', 'cancel-share', 'customized-service-for-ble',
    'device-information', 'ota'];

const MAIN_RANGES = ['brightness', 'target-temperature', 'target-humidity', 'fan-percent', 'target-position', 'volume'];

const PROP_GLYPHS = {
    'on': 'power',
    'mode': 'auto',
    'fan-level': 'fan',
    'speed-level': 'fan',
    'fan-percent': 'fan',
    'speed': 'fan',
    'horizontal-swing': 'swing',
    'vertical-swing': 'swing',
    'swing': 'swing',
    'horizontal-angle': 'swing',
    'brightness': 'sun',
    'color-temperature': 'bulb',
    'color': 'bulb',
    'temperature': 'thermometer',
    'target-temperature': 'thermometer',
    'indoor-temperature': 'thermometer',
    'relative-humidity': 'drop',
    'target-humidity': 'drop',
    'water-level': 'drop',
    'physical-controls-locked': 'lock',
    'child-lock': 'lock',
    'alarm': 'bell',
    'fault': 'bell',
    'volume': 'speaker',
    'mute': 'quiet',
    'battery-level': 'bolt',
    'charging-state': 'bolt',
    'electric-power': 'bolt',
    'electric-current': 'bolt',
    'voltage': 'bolt',
    'power-consumption': 'bolt',
    'off-delay-time': 'clock',
    'left-time': 'clock',
    'countdown-time': 'clock',
    'target-time': 'clock',
    'reservation-left-time': 'clock',
    'filter-life-level': 'leaf',
    'filter-left-time': 'leaf',
    'pm2.5-density': 'leaf',
    'pm10-density': 'leaf',
    'soil-moisture': 'drop',
    'tds-out': 'filter',
    'current-position': 'curtain',
    'target-position': 'curtain',
    'spin-speed': 'washer',
    'co2-density': 'leaf',
    'tvoc-density': 'leaf',
    'air-quality': 'leaf',
    'anion': 'leaf',
    'eco': 'leaf',
    'illumination': 'sun',
    'guard-mode': 'shield',
    'sleep-mode': 'moon',
    'no-disturb': 'moon',
    'heater': 'sun',
    'preheat': 'sun',
    'auto-keep-warm': 'pot',
};
const SERVICE_GLYPHS = {
    'indicator-light': 'bulb',
    'light': 'bulb',
    'alarm': 'bell',
    'physical-controls-locked': 'lock',
    'battery': 'bolt',
    'filter': 'leaf',
    'environment': 'thermometer',
    'screen': 'sun',
    'audio': 'speaker',
    'motor-controller': 'swing',
    'annoy': 'moon',
    'timer': 'clock',
};

const IN_HERO = {
    repeater: ['network', 'signal'],
    thermo: ['temperature', 'humidity', 'relative-humidity'],
    kettle: ['temperature', 'status'],
    smoke: ['alarm', 'smoke-concentration'],
    plug: ['electric-power'],
    vacuum: ['status', 'battery-level', 'fault'],
    fryer: ['status'],
    scooter: ['ble-battery-level'],
    washer: ['status', 'left-time'],
    dishwasher: ['status', 'left-time'],
    coffee: ['status', 'left-time'],
    cooker: ['status', 'left-time'],
    purifier: ['pm2.5-density', 'filter-life-level'],
    humidifier: ['relative-humidity'],
    dehumidifier: ['relative-humidity'],
    heater: ['temperature'],
    thermostat: ['temperature'],
    curtain: ['current-position'],
    plant: ['soil-moisture', 'temperature', 'illumination'],
    water: ['tds-out'],
};

function specTitle(service, prop, type) {
    if (prop.name === 'on' && service.name !== type)
        return humanize(service.name);
    return humanize(prop.name);
}

function choiceGlyph(description, fallback) {
    const text = description ?? '';
    if (/auto|smart/i.test(text))
        return 'auto';
    if (/sleep|night|silent/i.test(text))
        return 'moon';
    if (/natur|eco|energy|sav/i.test(text))
        return 'leaf';
    if (/strong|turbo|boost|max|high/i.test(text))
        return 'bolt';
    if (/quiet|low|mute/i.test(text))
        return 'quiet';
    if (/cool|cold/i.test(text))
        return 'snowflake';
    if (/heat|warm|hot/i.test(text))
        return 'sun';
    if (/dry/i.test(text))
        return 'drop';
    if (/fan|wind/i.test(text))
        return 'wind';
    return fallback;
}

function actionIcon(name) {
    if (/pause/.test(name))
        return 'media-playback-pause-symbolic';
    if (/stop|cancel|end/.test(name))
        return 'media-playback-stop-symbolic';
    if (/toggle/.test(name))
        return 'system-shutdown-symbolic';
    if (/charge|home|dock|back/.test(name))
        return 'go-home-symbolic';
    if (/find|locate|identify/.test(name))
        return 'find-location-symbolic';
    if (/^open/.test(name))
        return 'go-up-symbolic';
    if (/^close/.test(name))
        return 'go-down-symbolic';
    if (/^lock/.test(name))
        return 'changes-prevent-symbolic';
    if (/^next/.test(name))
        return 'media-skip-forward-symbolic';
    return 'media-playback-start-symbolic';
}

// Hidden: firmware-internal strings (recipe codes, sync lists, map keys), status numbers
// the spec gives no meaning, and unanswered values, which would show as off or zero.
function worthShowing(prop, value, answered) {
    if (!prop.access.includes('read') && !prop.access.includes('write'))
        return false;
    if (prop.access.includes('read') && !answered)
        return false;
    if (prop.format === 'string')
        return plainString(value) !== null;
    if (prop.name === 'status' && !(prop.choices?.length > 0))
        return false;
    if (prop.name === 'fault' && !value)
        return false;
    return !prop.choices?.length || prop.access.includes('write') || prop.choices.some(c => c.value === value);
}

// Zigbee sensor history: [history key, spec property, label, unit, raw divisor, colour].
const HISTORY_KEYS = () => [
    ['temperature', 'temperature', _('Temperature'), '°C', 100, [0.95, 0.47, 0.35]],
    ['humidity', 'relative-humidity', _('Humidity'), '%', 100, [0.3, 0.62, 0.95]],
    ['pressure', 'atmospheric-pressure', _('Pressure'), 'hPa', 100, [0.6, 0.48, 0.88]],
];
const HISTORY_SPAN = 24 * 3600;

function historyKeys(device) {
    if (!device.did.startsWith('lumi.'))
        return [];
    return HISTORY_KEYS().filter(([, prop]) => device.primary.props.some(p => p.name === prop));
}

// The colour scale; a unit's own range is in its caps.
const CLIMATE_MIN = 16;
const CLIMATE_MAX = 30;

const COOL = [0.21, 0.52, 0.89];
const WARM = [0.96, 0.55, 0.23];
const TEAL = [0.22, 0.66, 0.62];
const ICE = [0.14, 0.42, 0.98];
const MILD = [0.3, 0.6, 0.84];
const AMBER = [0.97, 0.64, 0.24];
const EMBER = [0.93, 0.34, 0.2];
const VIOLET = [0.56, 0.44, 0.88];
const SAND = [0.78, 0.66, 0.42];

const CLIMATE_TOGGLES = () => [
    ['SvSt', _('Eco'), 'leaf'],
    ['SwhSlp', _('Sleep'), 'moon'],
    ['Tur', _('Turbo'), 'bolt'],
    ['Quiet', _('Quiet'), 'quiet'],
    ['Lig', _('Display'), 'bulb'],
    ['Health', _('Ionizer'), 'purifier'],
    ['Blo', _('X-Fan'), 'fan'],
    ['StHt', _('8° heat'), 'heater'],
    ['Air', _('Fresh air'), 'wind'],
];

// Quiet stays 1: greeclimate sends 2, which firmware 3.75 ignores.
const climateToggle = (state, key) => ({[key]: state[key] ? 0 : 1});

const MODE_GLYPHS = {auto: 'auto', cool: 'snowflake', dry: 'drop', fan: 'fan', heat: 'sun'};

const CLIMATE_MODES = caps => caps.modes.map(i => [i, modeText(i), MODE_GLYPHS[MODES[i]]]);

let fanWords = null;

// [label, value text] of a fan speed; numbered ones count among the unit's own steps.
function fanText(fan, caps) {
    fanWords ??= {
        auto: _('Auto'),
        quiet: _('Quiet'),
        low: _('Low'),
        medium: _('Medium'),
        high: _('High'),
        max: _('Max'),
        turbo: _('Turbo'),
    };
    if (fan.word)
        return [fanWords[fan.word] ?? fan.word, fanWords[fan.word] ?? fan.word];
    if (fan.label)
        return [choiceText(fan.label), choiceText(fan.label)];
    const steps = caps.fans.filter(f => !f.word && !f.label);
    const n = String(steps.indexOf(fan) + 1);
    return [n, `${n} / ${steps.length}`];
}

const fanGlyph = fan => (fan?.level >= 1 && fan.level <= 5 ? `speed${fan.level}` : 'auto');

const CLIMATE_FANS = caps => caps.fans.map(fan => [fan.value, fanText(fan, caps)[0], fanGlyph(fan)]);

const swingChoice = (value, swing, prefix) => {
    if (value === 1)
        return [1, _('Swing'), swing];
    if (value >= 2 && value <= 6)
        return [value, String(value - 1), `${prefix}${value - 1}`];
    return [0, _('Off'), `${prefix}0`];
};

const CLIMATE_AIRFLOWS = caps => caps.airflows.map(v => swingChoice(v, 'flow-swing', 'flow'));

const CLIMATE_SIDES = caps => caps.sides.map(v => swingChoice(v, 'side-swing', 'side'));

// Swing or off is a switch, not a choice.
const swingsOnly = choices => choices.length === 2 && choices.every(([v]) => v === 0 || v === 1);

// The card's view of an air conditioner: native units carry state and caps, a spec one
// gets them from its services (_readClimate).
const climateView = device => (device.primary.kind === 'climate'
    ? device.state && {state: device.state, caps: device.caps}
    : device.climate ?? null);

function climateLook(mode, temperature) {
    const depth = Math.min(1, Math.max(0, (temperature - CLIMATE_MIN) / (CLIMATE_MAX - CLIMATE_MIN)));
    let color = COOL;
    if (mode === 'heat')
        color = Scenes.mix(AMBER, EMBER, depth);
    else if (mode === 'fan')
        color = TEAL;
    else if (mode === 'dry')
        color = SAND;
    else if (mode === 'auto')
        color = VIOLET;
    else if (mode === 'cool')
        color = Scenes.mix(ICE, MILD, depth);
    return {color, air: mode === 'fan' ? [0.86, 0.9, 0.96] : color};
}

function tileTint(device) {
    if (device.primary.kind === 'climate') {
        const {Pow: power, Mod: mode, SetTem: target} = device.state ?? {};
        return power === 1 ? climateLook(MODES[mode], target ?? 24).color : null;
    }
    const hero = heroOf(device, [], new Map());
    if (hero.scene === 'aircon')
        return hero.state.on ? hero.color : null;
    return Scenes.tint(hero.scene, hero.state);
}

function climateMode(description) {
    const text = description ?? '';
    if (/cool/i.test(text))
        return 'cool';
    if (/heat|warm/i.test(text))
        return 'heat';
    if (/dry|dehumid/i.test(text))
        return 'dry';
    if (/fan|wind|vent|air/i.test(text))
        return 'fan';
    return 'auto';
}

function climateStatus(mode) {
    switch (MODES[mode]) {
    case 'cool':
        return _('Cooling');
    case 'heat':
        return _('Heating');
    case 'dry':
        return _('Drying');
    case 'fan':
        return _('Fan only');
    default:
        return _('Auto');
    }
}

// SwUpDn 7-11 are partial swings; shown as Swing.
const airflowChoice = value => (value >= 7 ? 1 : value);

function climateSpeed(state, caps) {
    if (state.Tur)
        return 1.8;
    if (state.Quiet)
        return 0.55;
    const level = caps.fans.find(f => f.value === state.WdSpd)?.level ?? 0;
    return level > 0 ? 0.6 + level * 0.18 : 1;
}

const SLIDER_SETTLE = 700;
const NUDGE_SETTLE = 600;

const NUMBER_FORMATS = ['uint8', 'uint16', 'uint32', 'int8', 'int16', 'int32', 'int64', 'float'];

let nameWords = null;

function humanize(name) {
    nameWords ??= {
        'air-fryer': _('Air fryer'),
        'fan': _('Fan'),
        'light': _('Light'),
        'indicator-light': _('Indicator light'),
        'alarm': _('Alarm'),
        'gateway': _('Gateway'),
        'motion-sensor': _('Motion sensor'),
        'magnet-sensor': _('Door and window sensor'),
        'switch-sensor': _('Wireless switch'),
        'battery': _('Battery'),
        'smoke-sensor': _('Smoke detector'),
        'submersion-sensor': _('Leak sensor'),
        'temperature-humidity-sensor': _('Temperature and humidity'),
        'environment': _('Environment'),
        'vacuum': _('Vacuum'),
        'clean': _('Cleaning'),
        'audio': _('Sound'),
        'annoy': _('Do not disturb'),
        'scale': _('Scale'),
        'physical-controls-locked': _('Child lock'),
        'child-lock': _('Child lock'),
        'off-delay-time': _('Timer'),
        'timer': _('Timer'),
        'countdown-time': _('Timer'),
        'motor-controller': _('Motor'),
        'device-information': _('Device information'),
        'filter': _('Filter'),
        'brush-cleaner': _('Brush'),
        'main-cleaning-brush': _('Main brush'),
        'side-cleaning-brush': _('Side brush'),
        'consumable': _('Consumables'),
        'map': _('Map'),
        'identify': _('Find'),
        'air-purifier': _('Air purifier'),
        'humidifier': _('Humidifier'),
        'heater': _('Heater'),
        'washer': _('Washing machine'),
        'dishwasher': _('Dishwasher'),
        'dehumidifier': _('Dehumidifier'),
        'curtain': _('Curtain'),
        'lock': _('Lock'),
        'fridge': _('Fridge'),
        'fridge-chamber': _('Fridge'),
        'freezer-chamber': _('Freezer'),
        'coffee-machine': _('Coffee machine'),
        'thermostat': _('Thermostat'),
        'doorbell': _('Doorbell'),
        'plant-monitor': _('Plant sensor'),
        'cooker': _('Cooker'),
        'water-purifier': _('Water purifier'),
        'switch': _('Switch'),
        'outlet': _('Socket'),
        'plug': _('Socket'),
        'power-consumption': _('Energy used'),
        'kettle': _('Kettle'),
        'screen': _('Screen'),
        'remote': _('Remote control'),
        'warn': _('Warnings'),
        'time': _('Time'),
        'user-management': _('Users'),
        'on': _('Power'),
        'pm2.5-density': _('PM2.5'),
        'air-quality': _('Air quality'),
        'soil-moisture': _('Soil moisture'),
        'tds-out': _('Water purity'),
        'current-position': _('Position'),
        'target-position': _('Open to'),
        'cook-mode': _('Program'),
        'spin-speed': _('Spin speed'),
        'mode': _('Mode'),
        'fan-level': _('Speed'),
        'speed-level': _('Speed'),
        'speed': _('Speed'),
        'horizontal-swing': _('Swing'),
        'swing': _('Swing'),
        'horizontal-angle': _('Swing angle'),
        'status': _('Status'),
        'work-status': _('Status'),
        'work-mode': _('Work mode'),
        'fault': _('Fault'),
        'brightness': _('Brightness'),
        'color-temperature': _('Colour temperature'),
        'color': _('Colour'),
        'temperature': _('Temperature'),
        'relative-humidity': _('Humidity'),
        'target-humidity': _('Target humidity'),
        'illumination': _('Light level'),
        'battery-level': _('Battery'),
        'voltage': _('Voltage'),
        'contact-state': _('State'),
        'motion-state': _('Motion'),
        'no-motion-duration': _('No motion for'),
        'smoke-concentration': _('Smoke'),
        'volume': _('Volume'),
        'guard-mode': _('Guard'),
        'target-temperature': _('Temperature'),
        'target-time': _('Time'),
        'left-time': _('Time left'),
        'preheat': _('Preheat'),
        'auto-keep-warm': _('Keep warm'),
        'current-keep-warm': _('Keep warm now'),
        'reservation-left-time': _('Start in'),
        'cooking-weight': _('Weight'),
        'target-cooking-measure': _('Amount'),
        'texture': _('Texture'),
        'turn-pot-config': _('Turn reminder'),
        'turn-pot': _('Turn the food'),
        'charging-state': _('Charging'),
        'unit': _('Unit'),
        'firmware-version': _('Firmware'),
        'firmware-revision': _('Firmware'),
        'manufacturer': _('Maker'),
        'model': _('Model'),
        'serial-number': _('Serial number'),
        'electric-power': _('Power draw'),
        'electric-current': _('Current'),
        'anion': _('Ionizer'),
        'water-level': _('Water level'),
        'water-box': _('Water tank'),
        'heat-level': _('Heat level'),
        'filter-life-level': _('Filter life'),
        'filter-left-time': _('Filter time left'),
        'brush-life-level': _('Brush life'),
        'brush-left-time': _('Brush time left'),
        'enable': _('Enabled'),
        'start-time': _('Starts at'),
        'stop-time': _('Ends at'),
        'time-duration': _('Duration'),
        'area': _('Area'),
        'toggle': _('Toggle'),
        'toggle-mode': _('Next mode'),
        'loop-gear': _('Next speed'),
        'start-cook': _('Start'),
        'cancel-cooking': _('Stop'),
        'pause': _('Pause'),
        'resume-cook': _('Go on'),
        'start-sweep': _('Clean'),
        'start-clean': _('Clean'),
        'stop-sweeping': _('Stop'),
        'stop-clean': _('Stop'),
        'start-charge': _('Dock'),
        'play-sound': _('Play a sound'),
        'position': _('Locate'),
        'brightness-up': _('Brighter'),
        'brightness-down': _('Dimmer'),
        'fan-percent': _('Speed'),
        'vertical-swing': _('Vertical swing'),
        'submersion-state': _('Leak'),
        'smoke-status': _('Smoke'),
        'gas-status': _('Gas'),
        'co2-density': _('CO₂'),
        'pm10-density': _('PM10'),
        'atmospheric-pressure': _('Pressure'),
        'mute': _('Mute'),
        'playing-state': _('Playback'),
        'open-cover': pgettext('action', 'Open'),
        'close-cover': pgettext('action', 'Close'),
        'stop-cover': pgettext('action', 'Stop'),
        'lock-door': pgettext('action', 'Lock'),
        'play-media': pgettext('action', 'Play'),
        'next-track': _('Next'),
    };
    const word = nameWords[specKey(name)];
    if (word)
        return word;
    const text = name.replace(/-/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function groupRooms(devices) {
    const rooms = new Map();
    for (const device of devices) {
        // || not ??: an empty room name would get the "All" tab's key ''.
        const name = device.room || null;
        const key = name?.toLocaleLowerCase() ?? NO_ROOM;
        if (!rooms.has(key))
            rooms.set(key, {key, name, devices: []});
        rooms.get(key).devices.push(device);
    }
    return [...rooms.values()].sort((a, b) =>
        (a.name === null) - (b.name === null) || (a.name ?? '').localeCompare(b.name ?? ''));
}

// Wraps children at their natural widths. Clutter.FlowLayout uses equal-width columns,
// which leave gaps around short room names.
const WrapLayout = GObject.registerClass(
class WrapLayout extends Clutter.LayoutManager {
    _init(spacing) {
        super._init();
        this._spacing = spacing;
    }

    _lines(container, width) {
        const lines = [];
        let line = null;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, childWidth] = child.get_preferred_width(-1);
            const [, childHeight] = child.get_preferred_height(childWidth);
            const w = Math.min(childWidth, width);
            if (!line || line.width + this._spacing + w > width) {
                line = {width: 0, height: 0, items: []};
                lines.push(line);
            } else {
                line.width += this._spacing;
            }
            line.items.push([child, w, childHeight]);
            line.width += w;
            line.height = Math.max(line.height, childHeight);
        }
        return lines;
    }

    vfunc_get_preferred_width(container, _forHeight) {
        let min = 0, natural = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const [, childWidth] = child.get_preferred_width(-1);
            min = Math.max(min, childWidth);
            natural += childWidth + this._spacing;
        }
        return [min, Math.max(0, natural - this._spacing)];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const lines = this._lines(container, forWidth < 0 ? Infinity : forWidth);
        const height = lines.reduce((sum, l) => sum + l.height + this._spacing, 0);
        return [Math.max(0, height - this._spacing), Math.max(0, height - this._spacing)];
    }

    vfunc_allocate(container, box) {
        let y = box.y1;
        for (const line of this._lines(container, box.get_width())) {
            let x = box.x1;
            for (const [child, w, h] of line.items) {
                child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
                x += w + this._spacing;
            }
            y += line.height + this._spacing;
        }
    }
});

// Rows of equal cells, filled left to right as the drop markers (left, right) assume. A lone
// child spans the row; hidden children leave no gap.
const ColumnsLayout = GObject.registerClass(
class ColumnsLayout extends Clutter.LayoutManager {
    _init(columns, spacing) {
        super._init();
        this._columns = columns;
        this._spacing = spacing;
    }

    // Visible children by row, and the number of columns they fill.
    _grid(container) {
        const children = container.get_children().filter(child => child.visible);
        const rows = [];
        for (let i = 0; i < children.length; i += this._columns)
            rows.push(children.slice(i, i + this._columns));
        return [rows, Math.max(1, Math.min(children.length, this._columns))];
    }

    _cellWidth(columns, width) {
        return (width - this._spacing * (columns - 1)) / columns;
    }

    _heights(rows, width) {
        return rows.map(row => Math.max(...row.map(child => child.get_preferred_height(width)[1])));
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const [rows, columns] = this._grid(container);
        let min = 0, natural = 0;
        for (const child of rows.flat()) {
            const [childMin, childNatural] = child.get_preferred_width(-1);
            min = Math.max(min, childMin);
            natural = Math.max(natural, childNatural);
        }
        const gaps = this._spacing * (columns - 1);
        return [min * columns + gaps, natural * columns + gaps];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [rows, columns] = this._grid(container);
        const width = forWidth < 0 ? -1 : this._cellWidth(columns, forWidth);
        const height = this._heights(rows, width).reduce((sum, h) => sum + h + this._spacing, 0);
        return [Math.max(0, height - this._spacing), Math.max(0, height - this._spacing)];
    }

    vfunc_allocate(container, box) {
        const [rows, columns] = this._grid(container);
        const width = this._cellWidth(columns, box.get_width());
        const heights = this._heights(rows, width);
        let y = box.y1;
        rows.forEach((row, i) => {
            row.forEach((child, j) => {
                const x = box.x1 + j * (width + this._spacing);
                child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + heights[i]}));
            });
            y += heights[i] + this._spacing;
        });
    }
});

// Wheel scrolls the card instead of moving the slider and sending the new value.
const CardSlider = GObject.registerClass(
class CardSlider extends Slider.Slider {
    vfunc_scroll_event() {
        return Clutter.EVENT_PROPAGATE;
    }
});

const TemperatureSlider = GObject.registerClass(
class TemperatureSlider extends CardSlider {
    _init([min, max, step], preview, set) {
        super._init(0);
        this._min = min;
        this._max = max;
        this._step = step;
        this.x_expand = true;
        this._dragging = false;
        this.connect('notify::value', () => {
            if (this._dragging)
                preview(this.temperature);
        });
        this.connect('drag-begin', () => {
            this._dragging = true;
        });
        this.connect('drag-end', () => {
            this._dragging = false;
            set(this.temperature);
        });
    }

    get temperature() {
        const raw = this._min + this.value * (this._max - this._min);
        const snapped = Math.round(Math.round(raw / this._step) * this._step * 10) / 10;
        return Math.min(this._max, Math.max(this._min, snapped));
    }

    showTemperature(temperature) {
        if (!this._dragging)
            this.value = (temperature - this._min) / (this._max - this._min);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const node = this.get_theme_node();
        const [width, height] = this.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        const bar = node.get_length('-barlevel-height') || 6;
        const radius = node.get_length('-slider-handle-radius') || 10;
        const handleX = radius + (width - 2 * radius) * this.value / (this.maximum_value || 1);
        const y = height * 0.42;
        const gradient = new Cairo.LinearGradient(radius, 0, width - radius, 0);
        gradient.addColorStopRGB(0, ...COOL);
        gradient.addColorStopRGB(1, ...WARM);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(bar);
        cr.setSource(gradient);
        cr.moveTo(radius, y);
        cr.lineTo(width - radius, y);
        cr.pushGroup();
        cr.stroke();
        cr.popGroupToSource();
        cr.paintWithAlpha(0.3);
        cr.setSource(gradient);
        cr.moveTo(radius, y);
        cr.lineTo(handleX, y);
        cr.stroke();

        cr.setLineWidth(scale);
        cr.setSourceRGBA(1, 1, 1, 0.35);
        for (let degree = Math.ceil(this._min); degree <= this._max; degree++) {
            const x = radius + (width - 2 * radius) * (degree - this._min) / (this._max - this._min);
            const long = degree % 5 === 0;
            cr.moveTo(x, y + bar / 2 + 3 * scale);
            cr.lineTo(x, y + bar / 2 + (long ? 7 : 5) * scale);
        }
        cr.stroke();

        cr.setSourceRGBA(0, 0, 0, 0.25);
        cr.arc(handleX, y + scale, radius, 0, 2 * Math.PI);
        cr.fill();
        cr.setSourceRGB(1, 1, 1);
        cr.arc(handleX, y, radius, 0, 2 * Math.PI);
        cr.fill();
        const t = this.value / (this.maximum_value || 1);
        cr.setSourceRGB(...COOL.map((cool, i) => cool + (WARM[i] - cool) * t));
        cr.arc(handleX, y, radius * 0.38, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});

const VolumeSlider = GObject.registerClass(
class VolumeSlider extends CardSlider {
    _init(preview, set) {
        super._init(0);
        this.x_expand = true;
        this._dragging = false;
        this.connect('notify::value', () => {
            if (this._dragging)
                preview(this.value);
        });
        this.connect('drag-begin', () => {
            this._dragging = true;
        });
        this.connect('drag-end', () => {
            this._dragging = false;
            set(this.value);
        });
    }

    showLevel(level) {
        if (!this._dragging)
            this.value = level;
    }
});

const Scene = GObject.registerClass(
class Scene extends St.DrawingArea {
    _init(name, styleClass, expand = true) {
        super._init({style_class: styleClass, x_expand: expand});
        this._name = name;
        this._state = {};
        this._timeline = null;
        this.connect('destroy', () => this.run(false));
    }

    show(state) {
        this._state = state;
        this.queue_repaint();
    }

    setScene(name, state) {
        this._name = name;
        this.show(state);
    }

    run(on) {
        if (on && !this._timeline) {
            this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
            let last = 0;
            this._timeline.connect('new-frame', () => {
                const now = GLib.get_monotonic_time();
                if (now - last < 1e6 / Scenes.framesPerSecond(this._name) - 4000)
                    return;
                last = now;
                this.queue_repaint();
            });
            this._timeline.start();
        } else if (!on && this._timeline) {
            this._timeline.stop();
            this._timeline = null;
            this.queue_repaint();
        }
    }

    // The device drawn, in this actor's coordinates. Not get_surface_size(): it only
    // works while repainting.
    body() {
        return Scenes.body(this._name, this.width, this.height, this._state);
    }

    // Dispose the context even if drawing throws, or every later frame leaks one.
    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (width <= 0 || height <= 0)
                return;
            const font = this.get_theme_node().get_font();
            Scenes.draw(cr, this._name, width, height, GLib.get_monotonic_time() / 1e6, {...this._state, font});
        } finally {
            cr.$dispose();
        }
    }
});

// Pressed on the device its scene draws, not anywhere on the stage around it.
const SceneButton = GObject.registerClass(
class SceneButton extends St.Button {
    vfunc_pick(context) {
        const scene = this.child;
        const body = this.reactive ? scene.body() : null;
        if (!body)
            return;
        const [x, y, width, height] = body;
        const left = scene.x + x;
        const top = scene.y + y;
        this.pick_box(context, new Clutter.ActorBox({x1: left, y1: top, x2: left + width, y2: top + height}));
    }
});

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

function showInFiles(file) {
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
function panButtons() {
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

// Pointer events have no sequence.
function slotOf(event) {
    return event.get_event_sequence()?.get_slot() ?? -1;
}

const CameraView = GObject.registerClass(
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

// Up to three gridline values, in steps of 1, 2, 2.5 or 5 times a power of ten. No 0.25:
// numberFormat shows one decimal at most.
function chartLevels(low, high) {
    if (!Number.isFinite(high - low))
        return [];
    for (let unit = 0.1; ; unit *= 10) {
        for (const factor of unit < 1 ? [1, 2, 5] : [1, 2, 2.5, 5]) {
            const step = unit * factor;
            const first = Math.ceil(low / step);
            const last = Math.floor(high / step);
            if (last - first < 3)
                return Array.from({length: last - first + 1}, (_, i) => (first + i) * step);
        }
    }
}

// Ticks every 6 clock hours in (start, end]; midnight shows the date. A 24 h span
// touches a third date only across a DST change.
function chartTimes(start, end) {
    const times = [];
    const first = GLib.DateTime.new_from_unix_local(start);
    for (let days = 0; days < 3; days++) {
        const date = first.add_days(days);
        for (let hour = 0; hour < 24; hour += 6) {
            const tick = GLib.DateTime.new_local(date.get_year(), date.get_month(), date.get_day_of_month(), hour, 0, 0);
            const time = tick.to_unix();
            if (time > start && time <= end)
                times.push({time, text: hour === 0 ? tick.format('%e %b').trim() : tick.format('%H:%M')});
        }
    }
    return times;
}

const Chart = GObject.registerClass(
class Chart extends St.DrawingArea {
    _init(points, color, onHover) {
        super._init({style_class: 'nook-chart', x_expand: true, reactive: true});
        this._points = points;
        this._color = color;
        this._onHover = onHover;
        this._hovered = null;
        this._x = null;
        // The card may be rebuilt under the pointer: the leave event then comes after the label is gone.
        this.connect('destroy', () => (this._onHover = null));
    }

    vfunc_motion_event(event) {
        if (this._x) {
            const [, at] = this.transform_stage_point(...event.get_coords());
            let nearest = this._points[0];
            for (const point of this._points) {
                if (Math.abs(this._x(point.time) - at) < Math.abs(this._x(nearest.time) - at))
                    nearest = point;
            }
            this._hover(nearest);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(event) {
        this._hover(null);
        return super.vfunc_leave_event(event);
    }

    _hover(point) {
        if (point === this._hovered)
            return;
        this._hovered = point;
        this._onHover?.(point);
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        try {
            const [width, height] = this.get_surface_size();
            if (this._points.length > 0 && width > 0 && height > 0)
                this._draw(cr, width, height);
        } finally {
            cr.$dispose();
        }
    }

    _draw(cr, width, height) {
        const points = this._points;
        const end = Date.now() / 1000;
        const start = end - HISTORY_SPAN;
        const values = points.map(p => p.value);
        let low = Math.min(...values);
        let high = Math.max(...values);
        if (high - low < 1) {
            const middle = (high + low) / 2;
            low = middle - 0.5;
            high = middle + 0.5;
        }

        const node = this.get_theme_node();
        const font = node.get_font();
        const word = text => {
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(font);
            layout.set_text(text, -1);
            const [w, h] = layout.get_pixel_size();
            return {layout, width: w, height: h};
        };
        const levels = chartLevels(low, high).map(value => ({value, ...word(numberFormat.format(value))}));
        const times = chartTimes(start, end).map(({time, text}) => ({time, ...word(text)}));
        const gap = 4;
        const textHeight = Math.max(0, ...levels.map(l => l.height), ...times.map(t => t.height));
        const right = width - Math.max(0, ...levels.map(l => l.width + 2 * gap));
        const top = textHeight / 2;
        const bottom = height - textHeight - gap;
        const pad = (bottom - top) * 0.08;
        const x = time => Math.max(0, (time - start) / HISTORY_SPAN) * right;
        const y = value => top + pad + (1 - (value - low) / (high - low)) * (bottom - top - 2 * pad);
        const marked = levels.filter(level => y(level.value) + level.height / 2 <= bottom);
        this._x = x;

        const ink = node.get_foreground_color();
        const [ir, ig, ib, ia] = [ink.red, ink.green, ink.blue, ink.alpha].map(c => c / 255);
        cr.setSourceRGBA(ir, ig, ib, ia * 0.2);
        cr.setLineWidth(1);
        for (const level of marked) {
            const at = Math.round(y(level.value)) + 0.5;
            cr.moveTo(0, at);
            cr.lineTo(right, at);
        }
        for (const tick of times) {
            const at = Math.round(x(tick.time)) + 0.5;
            cr.moveTo(at, top);
            cr.lineTo(at, bottom);
        }
        cr.stroke();

        cr.moveTo(x(points[0].time), y(points[0].value));
        for (const point of points.slice(1))
            cr.lineTo(x(point.time), y(point.value));
        cr.lineTo(right, y(points.at(-1).value));
        const [r, g, b] = this._color;
        cr.setSourceRGB(r, g, b);
        cr.setLineWidth(Math.max(1.5, (bottom - top) / 32));
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.strokePreserve();
        cr.lineTo(right, bottom);
        cr.lineTo(x(points[0].time), bottom);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, 0, 0, bottom);
        fill.addColorStopRGBA(0, r, g, b, 0.3);
        fill.addColorStopRGBA(1, r, g, b, 0);
        cr.setSource(fill);
        cr.fill();

        cr.setSourceRGBA(ir, ig, ib, ia);
        for (const level of marked) {
            cr.moveTo(width - level.width, y(level.value) - level.height / 2);
            PangoCairo.show_layout(cr, level.layout);
        }
        for (const tick of times) {
            const middle = Math.min(Math.max(x(tick.time), tick.width / 2), width - tick.width / 2);
            cr.moveTo(middle - tick.width / 2, bottom + gap);
            PangoCairo.show_layout(cr, tick.layout);
        }

        if (this._hovered) {
            const hx = Math.round(x(this._hovered.time)) + 0.5;
            const hy = y(this._hovered.value);
            cr.setSourceRGBA(ir, ig, ib, ia * 0.6);
            cr.setLineWidth(1);
            cr.moveTo(hx, top);
            cr.lineTo(hx, bottom);
            cr.stroke();
            cr.setSourceRGB(r, g, b);
            cr.arc(hx, hy, Math.max(3, (bottom - top) / 18), 0, 2 * Math.PI);
            cr.fill();
        }
    }
});

const Glyph = GObject.registerClass(
class Glyph extends St.DrawingArea {
    _init(name) {
        super._init({
            style_class: 'nook-glyph',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._name = name;
        this._color = null;
        this.connect('style-changed', () => this.queue_repaint());
    }

    setName(name) {
        if (name !== this._name) {
            this._name = name;
            this.queue_repaint();
        }
    }

    // [r, g, b] in 0-1, or null for the theme foreground.
    setColor(color) {
        this._color = color;
        this.queue_repaint();
    }

    _ink(cr) {
        const ink = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(ink.red / 255, ink.green / 255, ink.blue / 255, ink.alpha / 255);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (this._color)
            cr.setSourceRGB(...this._color);
        else
            this._ink(cr);
        cr.scale(width / 16, height / 16);
        try {
            Glyphs.draw(cr, this._name);
        } finally {
            cr.$dispose();
        }
    }
});

// Clutter drops transitions on unmapped actors, so the pulse starts on map.
// It stops on unmap: an endless ease holds off unredirection.
const Skeleton = GObject.registerClass(
class Skeleton extends St.Widget {
    _init(params = {}) {
        super._init({style_class: 'nook-skeleton', ...params});
        this.connect('notify::mapped', () => breathe(this));
    }
});

function breathe(actor, on = true) {
    actor.remove_all_transitions();
    actor.opacity = 255;
    if (!on || !actor.mapped || !St.Settings.get().enable_animations)
        return;
    actor.ease({
        opacity: 80,
        duration: 750,
        mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
        repeatCount: -1,
        autoReverse: true,
    });
}

function skeletonBar(width = '') {
    return new Skeleton({
        style_class: width ? `nook-skeleton nook-skeleton-${width}` : 'nook-skeleton',
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function skeletonLines(widths = ['wide', 'mid', '']) {
    const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-skeleton-lines'});
    for (const width of widths)
        box.add_child(skeletonBar(width));
    return box;
}

// Shows each pick at once; when no write is in flight any more, settles on the last one
// the device took.
function optimistic(actor, initial, show) {
    let acked = initial, ackedAsk = 0, asks = 0, pending = 0, gone = false;
    actor.connect('destroy', () => {
        gone = true;
    });
    return (value, write) => {
        const ask = ++asks;
        pending++;
        show(value);
        write(value).then(() => {
            if (ask > ackedAsk) {
                acked = value;
                ackedAsk = ask;
            }
        }, () => {}).finally(() => {
            if (--pending === 0 && !gone)
                show(acked);
        });
    };
}

function skeletonBlock(styleClass = '') {
    return new Skeleton({style_class: `nook-skeleton-block ${styleClass}`.trim(), x_expand: true, y_expand: true});
}

// A blank label under the bar keeps the line as tall as the text.
function skeletonLine(textClass, width = '') {
    const line = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
    line.add_child(new St.Label({style_class: textClass, text: ' ', x_expand: true}));
    const bar = skeletonBar(width);
    bar.x_expand = true;
    line.add_child(bar);
    return line;
}

function alikeKind(device) {
    return Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model)[0];
}

// Sections of the module view in display order, by the glyphs they take; the rest are appliances.
const SECTIONS = [
    ['lights', ['bulb', 'rocker']],
    ['climate', ['aircon', 'fan', 'thermometer', 'heater', 'humidifier', 'dehumidifier', 'purifier', 'thermostat']],
    ['media', ['tv', 'speaker']],
    ['cameras', ['camera']],
    ['security', ['shield', 'motion', 'door', 'drop', 'smoke', 'lock', 'doorbell']],
    ['appliances', []],
];

function sectionTitle(id) {
    return {
        lights: _('Lights'),
        climate: _('Climate'),
        media: _('Media'),
        cameras: _('Cameras'),
        security: _('Security'),
        appliances: _('Appliances'),
    }[id];
}

// A glyph chosen in Settings moves the device along with its look.
function sectionOf(device, icons) {
    if (device.primary.kind === 'camera')
        return 'cameras';
    const icon = icons[device.did];
    const glyph = Glyphs.CHOICES.includes(icon) ? icon : alikeKind(device);
    return SECTIONS.find(([, glyphs]) => glyphs.includes(glyph))?.[0] ?? 'appliances';
}

// Guard mode shows with the sensors; other extra tiles ride with their device.
function tileSection(device, extra, icons) {
    if (extra && Glyphs.kindOfProperty(extra.name, deviceType(device), device.model)[0] === 'shield')
        return 'security';
    return sectionOf(device, icons);
}

function sectionSummary(id, tiles) {
    const devices = tiles.filter(tile => !tile.extra).map(tile => tile.device);
    const reachable = devices.filter(device => device.online !== false || isBluetooth(device));
    const on = tiles.filter(tile => tile.checked).length;
    switch (id) {
    case 'cameras':
        return reachable.length < devices.length
            ? _('%s of %s online').replace('%s', String(reachable.length)).replace('%s', String(devices.length))
            : '';
    case 'climate':
        if (on > 0)
            return _('%s on').replace('%s', String(on));
        return devices.filter(device => alikeKind(device) === 'thermometer').map(stateText)
            .find(text => /\d/.test(text)) ?? '';
    case 'security':
        if (reachable.some(device => heroOf(device, [], new Map()).alarm))
            return _('Alarm!');
        return reachable.length > 0 ? _('All quiet') : '';
    case 'appliances':
        return on > 0 ? _('%s working').replace('%s', String(on)) : '';
    default:
        if (on > 0)
            return _('%s on').replace('%s', String(on));
        return reachable.length > 0 ? _('All off') : '';
    }
}

// Alike devices in one module go by room, unless renamed in Nook.
function roomLabels(items, names) {
    const devices = items.filter(([, extra]) => !extra).map(([device]) => device);
    const room = device => device.room?.toLocaleLowerCase();
    const labels = new Map();
    for (const device of devices) {
        if (!device.room || names[device.did])
            continue;
        const alike = devices.filter(other => alikeKind(other) === alikeKind(device));
        if (alike.length > 1 && alike.filter(other => room(other) === room(device)).length === 1)
            labels.set(device.did, device.room);
    }
    return labels;
}

const DROP_ZONES = ['drop-before', 'drop-after', 'drop-into'];
// Share of a tile at each end that reorders; the middle groups.
const DROP_EDGE = 0.3;
const DRAGGED_OPACITY = 90;
// Logical px: band at the list's top and bottom that scrolls it during a drag, and the
// speed per second at the very edge.
const SCROLL_EDGE = 48;
const SCROLL_SPEED = 800;
const SCROLL_TICK = 16;

// Module view drag and drop. Order moves only show within a module, so a tile dropped on a
// loose one of another section groups with it.
class TileDrop {
    constructor(settings, devices, scroll) {
        this._settings = settings;
        this._devices = devices;
        this._scroll = scroll;
        this._marked = null;
        this._later = 0;
        this._scrolling = 0;
        this._pointer = null;
        this._source = null;
        this._monitor = {
            dragMotion: event => {
                this._pointer = [event.x, event.y];
                this._source = event.source;
                this._mark(null);
                this._autoscroll();
                return DND.DragMotionResult.CONTINUE;
            },
        };
    }

    begin() {
        DND.addDragMonitor(this._monitor);
    }

    end() {
        DND.removeDragMonitor(this._monitor);
        this._mark(null);
        if (this._scrolling)
            GLib.source_remove(this._scrolling);
        this._scrolling = 0;
        this._pointer = null;
        this._source = null;
    }

    _speed() {
        if (!this._pointer)
            return 0;
        const [x, y] = this._pointer;
        const [left, top] = this._scroll.get_transformed_position();
        const [width, height] = this._scroll.get_transformed_size();
        if (x < left || x > left + width || y < top || y > top + height)
            return 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const edge = SCROLL_EDGE * scale;
        if (y < top + edge)
            return -SCROLL_SPEED * scale * (1 - (y - top) / edge);
        if (y > top + height - edge)
            return SCROLL_SPEED * scale * (1 - (top + height - y) / edge);
        return 0;
    }

    _autoscroll() {
        if (this._scrolling || this._speed() === 0)
            return;
        let last = GLib.get_monotonic_time();
        this._scrolling = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_TICK, () => {
            const now = GLib.get_monotonic_time();
            const speed = this._speed();
            const adjustment = this._scroll.vadjustment;
            const value = Math.min(Math.max(adjustment.value + speed * (now - last) / 1e6, adjustment.lower),
                adjustment.upper - adjustment.page_size);
            last = now;
            if (speed === 0 || value === adjustment.value) {
                this._scrolling = 0;
                return GLib.SOURCE_REMOVE;
            }
            adjustment.value = value;
            this._hover();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // The list moved under a still pointer: find the drop target again, as a motion would.
    _hover() {
        const [x, y] = this._pointer;
        this._mark(null);
        for (let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y); actor; actor = actor.get_parent()) {
            if (!actor._delegate?.handleDragOver)
                continue;
            const [, targetX, targetY] = actor.transform_stage_point(x, y);
            if (actor._delegate.handleDragOver(this._source, null, targetX, targetY, 0) !== DND.DragMotionResult.CONTINUE)
                break;
        }
    }

    stop() {
        this.end();
        if (this._later)
            GLib.source_remove(this._later);
        this._later = 0;
    }

    _groups() {
        return readSetting(this._settings, 'groups');
    }

    _section(tile) {
        return tileSection(tile.device, tile.extra, readSetting(this._settings, 'icons'));
    }

    // Before or after only where the dragged tile then shows: in the target's group, or in its
    // own section when that is the target's.
    _zone(target, source, x) {
        if (target.device === source.device)
            return null;
        if (!(target.device.did in this._groups()) && this._section(target) !== this._section(source))
            return 'into';
        const [width] = target.get_size();
        const at = x / width;
        if (at < DROP_EDGE)
            return 'before';
        return at > 1 - DROP_EDGE ? 'after' : 'into';
    }

    _mark(actor, zone = null) {
        if (this._marked) {
            this._marked.disconnectObject(this);
            for (const name of DROP_ZONES)
                this._marked.remove_style_pseudo_class(name);
        }
        this._marked = actor;
        if (!actor)
            return;
        actor.add_style_pseudo_class(`drop-${zone}`);
        actor.connectObject('destroy', () => {
            this._marked = null;
        }, this);
    }

    over(target, source, x) {
        const zone = this._zone(target, source, x);
        if (!zone)
            return DND.DragMotionResult.NO_DROP;
        this._mark(target, zone);
        return DND.DragMotionResult.MOVE_DROP;
    }

    // Settings are written after the drop: the redraw destroys the dragged tile.
    _soon(write) {
        if (this._later)
            GLib.source_remove(this._later);
        this._later = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._later = 0;
            write();
            return GLib.SOURCE_REMOVE;
        });
    }

    accept(target, source, x) {
        const zone = this._zone(target, source, x);
        // dnd.js offers a refused drop to the parents, and the panel would take the tile out.
        if (!zone)
            return true;
        const [did, onto] = [source.device.did, target.device.did];
        const [one, other] = [source.device, target.device];
        this._soon(() => {
            const groups = {...this._groups()};
            if (zone === 'into')
                groups[onto] ??= this._newName(groups, one, other);
            if (onto in groups)
                groups[did] = groups[onto];
            else
                delete groups[did];
            this._samePin(did, onto);
            this._write(groups, did, onto, zone !== 'before');
        });
        return true;
    }

    // Drop target for a group's module outside its tiles.
    group(name, members, box) {
        return {
            handleDragOver: source => {
                if (!(source instanceof Tile))
                    return DND.DragMotionResult.CONTINUE;
                if (this._groups()[source.device.did] === name)
                    return DND.DragMotionResult.NO_DROP;
                this._mark(box, 'into');
                return DND.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: source => {
                if (!(source instanceof Tile))
                    return false;
                // Swallowed: the panel behind would take it out.
                if (this._groups()[source.device.did] === name)
                    return true;
                const did = source.device.did;
                this._soon(() => {
                    const last = members.at(-1);
                    this._samePin(did, last);
                    this._write({...this._groups(), [did]: name}, did, last, true);
                });
                return true;
            },
        };
    }

    // Drop target for the panel around the modules and for the sections: takes a tile out of
    // its group, back to its section.
    outside() {
        const takes = source => source instanceof Tile && source.device.did in this._groups();
        return {
            handleDragOver: source => takes(source) ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP,
            acceptDrop: source => {
                if (!takes(source))
                    return false;
                const did = source.device.did;
                this._soon(() => {
                    const groups = {...this._groups()};
                    delete groups[did];
                    this._write(groups);
                });
                return true;
            },
        };
    }

    rename(name, to) {
        const groups = this._groups();
        for (const did of Object.keys(groups)) {
            if (groups[did] === name)
                groups[did] = to;
        }
        this._write(groups);
    }

    _newName(groups, one, other) {
        const taken = new Set(Object.values(groups));
        if (one.room && one.room === other.room && !taken.has(one.room))
            return one.room;
        for (let n = 1; ; n++) {
            const name = _('Group %s').replace('%s', String(n));
            if (!taken.has(name))
                return name;
        }
    }

    // Pinned devices sort first; a move across that line would not show.
    _samePin(did, onto) {
        const pinned = readSetting(this._settings, 'pinned');
        if (pinned.includes(did) === pinned.includes(onto))
            return;
        this._settings.set_strv('pinned', pinned.includes(onto) ? [...pinned, did] : pinned.filter(p => p !== did));
    }

    _write(groups, moved = null, onto = null, after = false) {
        const sizes = {};
        for (const name of Object.values(groups))
            sizes[name] = (sizes[name] ?? 0) + 1;
        for (const [did, name] of Object.entries(groups)) {
            if (sizes[name] < 2)
                delete groups[did];
        }
        this._settings.set_value('groups', new GLib.Variant('a{ss}', groups));
        if (!moved)
            return;
        // Devices not loaded right now keep their place.
        const order = readSetting(this._settings, 'order');
        const ids = arrange(this._devices(), {
            pinned: readSetting(this._settings, 'pinned'),
            order,
            hidden: [],
        }, true).map(d => d.did);
        this._settings.set_strv('order', [...move(ids, moved, onto, after), ...order.filter(did => !ids.includes(did))]);
    }
}

function skeletonTile(shape) {
    const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    text.add_child(skeletonLine('nook-name', 'name'));
    text.add_child(skeletonLine('nook-state'));
    const box = new St.BoxLayout({
        ...(shape === 'square' ? VERTICAL : {}),
        style_class: 'nook-tile-box',
        x_expand: true,
    });
    box.add_child(new St.Widget({
        style_class: 'nook-bubble',
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    box.add_child(text);
    return new St.Bin({style_class: `nook-tile nook-tile-${shape}`, child: box, x_expand: true});
}

const Tile = GObject.registerClass(
class Tile extends St.Button {
    // label: shown instead of the name; synced: called after each sync.
    _init(home, device, {shape, typeColors, name, label = null, icon = '', extra = null, openCard, awaits, drop = null,
        synced = null}) {
        const switchable = extra !== null || ['switch', 'climate', 'tv'].includes(device.primary.kind);
        const modular = shape === 'row';
        super._init({
            style_class: modular ? `nook-cc-tile nook-cc-${shape}` : `nook-tile nook-tile-${shape}`,
            accessible_name: extra ? `${name}: ${humanize(extra.name)}` : name,
            x_expand: true,
            can_focus: true,
            track_hover: true,
            button_mask: PRIMARY_SECONDARY,
        });
        this._openCard = openCard;
        this._awaits = awaits;
        this._home = home;
        this._device = device;
        this._extra = extra;
        this._deviceName = name;
        this._synced = synced;
        this._shape = shape;
        this._modular = modular;
        this._switchable = switchable;
        this._busy = false;
        this._gone = false;
        this._picture = false;

        const [glyph, color] = extra
            ? Glyphs.kindOfProperty(extra.name, deviceType(device), device.model)
            : Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model);
        const chosen = !extra && Glyphs.CHOICES.includes(icon);
        const picture = !extra && icon.startsWith('/') ? Gio.File.new_for_path(icon) : null;
        if (picture?.query_exists(null)) {
            this._glyph = new St.Icon({
                style_class: 'nook-glyph',
                gicon: new Gio.FileIcon({file: picture}),
                icon_size: 16,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._picture = true;
        } else {
            this._glyph = new Glyph(chosen ? icon : glyph);
        }
        const look = chosen ? Glyphs.colorOf(icon, color) : color;
        this._color = typeColors ? look : null;
        this._typeColor = this._color;
        this._tinted = !extra && ['thermometer', 'kettle', 'aircon'].includes(glyph);

        const bubble = {
            style_class: 'nook-bubble',
            child: this._glyph,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        };
        if (switchable) {
            this._bubble = new St.Button({
                ...bubble,
                style_class: 'nook-bubble nook-toggle',
                accessible_name: _('Switch On or Off'),
                can_focus: true,
            });
            this._bubble.connect('clicked', () => {
                if (this._device.online === false || this._device.state?.paired === false)
                    this._openCard(device);
                else if (!this._busy)
                    this._toggle().catch(logError);
            });
        } else {
            this._bubble = new St.Bin(bubble);
        }

        this._name = new St.Label({
            style_class: 'nook-name',
            text: extra ? humanize(extra.name) : label ?? name,
            x_align: Clutter.ActorAlign.FILL,
        });
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // BinLayout centres children that don't expand.
        this._state = new St.Label({style_class: 'nook-state', x_expand: true});
        this._state.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._skeleton = skeletonBar();
        this._skeleton.set({visible: false, x_expand: true});
        const stateLine = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        stateLine.add_child(this._state);
        stateLine.add_child(this._skeleton);
        const text = new St.BoxLayout({
            ...VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        text.add_child(this._name);
        text.add_child(stateLine);

        const box = new St.BoxLayout({
            ...(shape === 'square' ? VERTICAL : {}),
            style_class: 'nook-tile-box',
            x_expand: true,
        });
        box.add_child(this._bubble);
        box.add_child(text);
        this.set_child(box);

        this.connect('clicked', () => this._openCard(device));
        this.connect('destroy', () => {
            this._gone = true;
        });
        if (drop) {
            this._drop = drop;
            this._delegate = this;
            // An extra tile rides with its device.
            if (!extra) {
                const draggable = DND.makeDraggable(this);
                draggable.connect('drag-begin', () => {
                    this.opacity = DRAGGED_OPACITY;
                    drop.begin();
                });
                draggable.connect('drag-end', () => {
                    drop.end();
                    if (!this._gone)
                        this.sync();
                });
            }
        }
        this.sync();
    }

    get device() {
        return this._device;
    }

    get extra() {
        return this._extra;
    }

    get shape() {
        return this._shape;
    }

    // A row has no background of its own: the module behind it gives it one.
    getDragActor() {
        const [width, height] = this.get_size();
        return new St.Bin({
            style_class: 'nook-cc-drag',
            child: new Clutter.Clone({source: this, width, height}),
        });
    }

    getDragActorSource() {
        return this;
    }

    handleDragOver(source, _actor, x) {
        return source instanceof Tile ? this._drop.over(this, source, x) : DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, _actor, x) {
        return source instanceof Tile && this._drop.accept(this, source, x);
    }

    get _key() {
        return `${this._extra.siid}/${this._extra.piid}`;
    }

    _isOn() {
        if (this._extra)
            return this._device.extra?.[this._key] === true;
        if (this._switchable)
            return this._device.values?.[0] === true;
        return isWorking(this._device);
    }

    sync() {
        const on = this._isOn();
        this.checked = on;
        let state;
        if (this._extra) {
            state = _('Offline');
            if (this._device.online)
                state = this._key in (this._device.extra ?? {}) ? booleanText(this._extra.name, on) : '…';
            this._state.text = state === '…' ? '\u00a0' : `${state} · ${this._deviceName}`;
        } else {
            state = this._awaits?.(this._device) ? '…' : stateText(this._device);
            this._state.text = state === '…' ? '\u00a0' : state;
        }
        this._skeleton.visible = state === '…';
        this.opacity = this._device.online === false && !isBluetooth(this._device) ? OFFLINE_OPACITY : 255;
        if (this._typeColor && this._tinted)
            this._color = tileTint(this._device) ?? this._typeColor;
        this._paint(on);
        this._synced?.();
    }

    _paint(on) {
        if (this._modular) {
            this._paintCircle(on);
            return;
        }
        if (!this._color) {
            this.style = null;
            this._bubble.style = null;
            if (!this._picture)
                this._glyph.setColor(null);
            return;
        }
        const [r, g, b] = this._color.map(c => Math.round(c * 255));
        this.style = on ? `background-color: rgba(${r}, ${g}, ${b}, 0.3);` : null;
        if (this._shape !== 'compact')
            this._bubble.style = `background-color: rgba(${r}, ${g}, ${b}, ${on ? 1 : 0.2});`;
        if (this._picture)
            return;
        this._glyph.setColor(on && this._shape !== 'compact' ? ON_INK : this._color);
    }

    _paintCircle(on) {
        if (!this._color) {
            this.style = null;
            this._bubble.style = null;
            if (!this._picture)
                this._glyph.setColor(null);
            return;
        }
        const [r, g, b] = this._color;
        const rgb = this._color.map(c => Math.round(c * 255)).join(', ');
        this.style = on ? `background-color: rgba(${rgb}, 0.22);` : null;
        this._bubble.style = `background-color: rgba(${rgb}, ${on ? 1 : 0.2});`;
        if (this._picture)
            return;
        if (on)
            this._glyph.setColor(0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? ON_INK : WHITE);
        else
            this._glyph.setColor(this._color);
    }

    async _toggle() {
        const device = this._device;
        const on = !this._isOn();

        const before = this._extra ? {...device.extra} : device.values;
        this._busy = true;
        if (this._extra)
            device.extra = {...device.extra, [this._key]: on};
        else
            device.values = [on];
        this.sync();
        try {
            if (this._extra)
                await device.source.setProperty(device, this._extra.siid, this._extra.piid, on);
            else
                await device.source.setSwitch(device, on);
        } catch (e) {
            if (this._extra)
                device.extra = before;
            else
                device.values = before;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof XiaomiError) && !(e instanceof TvError) && !(e instanceof ClimateError) &&
                !(e instanceof SonoffError) && !(e instanceof EwelinkError) && !(e instanceof SpecError) &&
                !(e instanceof GLib.Error))
                throw e;
            if (!this._gone) {
                Main.notifyError(this._deviceName, device.source instanceof TvHome ? tvTrouble(e)
                    : device.source instanceof SonoffHome ? sonoffTrouble(e)
                        : e instanceof SpecError ? specTrouble(e) : e.message);
            }
        } finally {
            this._busy = false;
            if (!this._gone)
                this.sync();
        }
    }
});

// Now Playing module of the module view, with the volume, for the speaker playing or paused.
// Hides that speaker's row in the speaker list below.
const NowPlaying = GObject.registerClass(
class NowPlaying extends St.BoxLayout {
    // rows: the speakers' tiles, each in a module's grid.
    _init(speakers, rows, {nameOf, openCard, act}) {
        super._init({...VERTICAL, style_class: 'nook-cc-module nook-cc-playing', x_expand: true});
        this._speakers = speakers;
        this._rows = rows;
        this._nameOf = nameOf;
        this._device = speakers[0];

        const row = new St.BoxLayout({style_class: 'nook-cc-playing-row', x_expand: true});
        const opener = new St.BoxLayout({style_class: 'nook-cc-open-box', x_expand: true});
        this._glyph = new Glyph('speaker');
        this._glyph.setColor(WHITE);
        this._art = new St.Bin({style_class: 'nook-cc-art', child: this._glyph, y_align: Clutter.ActorAlign.CENTER});
        opener.add_child(this._art);
        const text = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._song = new St.Label({style_class: 'nook-cc-song'});
        this._from = new St.Label({style_class: 'nook-cc-from'});
        for (const label of [this._song, this._from]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        opener.add_child(text);
        this._open = new St.Button({style_class: 'nook-cc-open', child: opener, x_expand: true, can_focus: true});
        this._open.connect('clicked', () => openCard(this._device));
        row.add_child(this._open);
        this._play = this._control(() => act(this._device, home => castToggle(home, this._device)));
        row.add_child(this._play);
        this._next = this._control(() => act(this._device, home => home.skip(this._device, 1)));
        this._next.child.icon_name = 'media-skip-forward-symbolic';
        this._next.accessible_name = _('Next');
        row.add_child(this._next);
        this.add_child(row);

        this._sound = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'nook-cc-volume',
            x_expand: true,
        });
        this._slider = new VolumeSlider(
            level => this._showLevel(level),
            level => act(this._device, home => home.setVolume(this._device, level)));
        this._slider.accessible_name = _('Volume');
        this._sound.add_child(this._slider);
        // Within the handle at zero volume, so it always sits on white.
        this._volumeIcon = new St.Icon({
            style_class: 'nook-cc-volume-icon',
            icon_size: 14,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sound.add_child(this._volumeIcon);
        this.add_child(this._sound);
        this.sync();
    }

    get device() {
        return this._device;
    }

    _control(onClick) {
        const button = new St.Button({
            style_class: 'nook-cc-control',
            child: new St.Icon({icon_size: 18}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', onClick);
        return button;
    }

    // An offline speaker keeps its last state.
    _pick() {
        const online = this._speakers.filter(d => d.online !== false);
        return online.find(playingNow) ?? online.find(d => d.state?.media?.state === 'PAUSED') ?? null;
    }

    sync() {
        const device = this._pick();
        this.visible = device !== null;
        for (const row of this._rows)
            row.visible = row.device !== device;
        // A module left with only the playing speaker goes with it.
        for (const grid of new Set(this._rows.map(row => row.get_parent())))
            grid.get_parent().visible = grid.get_children().some(child => child.visible);
        if (!device)
            return;
        this._device = device;
        const state = device.state ?? {};
        const media = state.media;
        const name = this._nameOf(device);
        this._song.text = media?.title ?? state.app ?? _('Nothing playing');
        const paused = media?.state === 'PAUSED' ? _('Paused') : null;
        this._from.text = [state.group ?? name, paused].filter(Boolean).join(' · ');
        this._open.accessible_name = name;
        this._glyph.setName(Glyphs.kindOf(deviceType(device), device.primary.props[0]?.service, device.model)[0]);
        const shade = share => mediaColor(device).map(v => Math.round(v * 255 * share)).join(', ');
        this._art.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(1)}); background-gradient-end: rgb(${shade(0.7)});`;
        showCastPlay(this._play, device);
        this._next.reactive = castAllows(media, 64);
        this._sound.visible = typeof state.volume === 'number';
        if (!this._sound.visible)
            return;
        this._slider.showLevel(state.volume);
        this._showLevel(state.volume);
    }

    _showLevel(level) {
        this._volumeIcon.icon_name = volumeIcon(level, this._device.state?.muted === true);
    }
});

// Gateway sensor events as notifications. The only part of Nook kept on the lock screen.
class Alerts {
    constructor(settings, path) {
        this._settings = settings;
        this._icon = Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/nook-symbolic.svg`));
        this._listener = new Gateway.Listener(report => this._report(report).catch(logError));
        this._source = null;
        this._last = new Map();
        this._crossed = new Set();
        this._lowNoticed = new Set();
        this._openTimers = new Map();
        this.onReport = null;
    }

    state(sid) {
        return this._listener.state(sid);
    }

    read(sid) {
        return this._listener.read(sid);
    }

    start() {
        try {
            this._listener.start();
        } catch (e) {
            console.debug(`nook: gateway: ${e.message}`);
        }
    }

    get heard() {
        return this._listener.heard;
    }

    async _report({sid, model, data, cmd}) {
        const did = `lumi.${sid}`;
        // Sub-device heartbeats repeat the state about hourly; only their voltage is news.
        if (cmd === 'heartbeat') {
            for (const [body, alarm] of this._checkRules(did, model, null, {voltage: data.voltage}))
                await this._tell(did, model, body, alarm);
            return;
        }
        this.onReport?.(sid, data);
        const kind = sensorKind(model);
        const notices = this._checkRules(did, model, kind, data);
        const text = kind ? reportText(kind, data) : null;
        if (text && alertsOn(this._settings, did, kind))
            notices.unshift(text);
        for (const [body, alarm] of notices)
            await this._tell(did, model, body, alarm);
    }

    // Names come from the cached device list: no cloud requests from here, which also
    // runs on the lock screen.
    async _tell(did, model, body, alarm) {
        const devices = await cachedDevices(this._settings.get_string('xiaomi-user-id'));
        if (!this._listener.running)
            return;
        const device = devices.find(d => d.did === did);
        const name = readSetting(this._settings, 'names')[did] || device?.name || model;
        this._notify(did, name, device?.room ? `${body} · ${device.room}` : body, alarm);
    }

    // Each threshold notifies once per crossing and re-arms when the reading is back past
    // its margin.
    _checkRules(did, model, kind, data) {
        const rule = sensorRules(this._settings)[did] ?? {};
        const notices = [];
        if (kind === 'door' && data.status === 'open' && rule.openFor > 0) {
            this._stopTimer(did);
            const minutes = rule.openFor;
            this._openTimers.set(did, GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
                this._openTimers.delete(did);
                this._tell(did, model, _('Open for %s min.').replace('%s', minutes), false).catch(logError);
                return GLib.SOURCE_REMOVE;
            }));
        } else if (kind === 'door' && data.status === 'close') {
            this._stopTimer(did);
        }
        const check = (name, value, limit, above, margin, text) => {
            if (typeof limit !== 'number' || !Number.isFinite(value))
                return;
            const key = `${did}/${name}`;
            if (above ? value > limit : value < limit) {
                if (!this._crossed.has(key))
                    notices.push([text, false]);
                this._crossed.add(key);
            } else if (above ? value <= limit - margin : value >= limit + margin) {
                this._crossed.delete(key);
            }
        };
        const reading = (raw, unit) => `${numberFormat.format(Number(raw) / 100)} ${unit}`;
        if (data.temperature !== undefined) {
            const value = Number(data.temperature) / 100;
            const now = reading(data.temperature, '°C');
            check('warm', value, rule.warm, true, 0.5,
                _('%s now, warmer than %s.').replace('%s', now).replace('%s', `${rule.warm} °C`));
            check('cold', value, rule.cold, false, 0.5,
                _('%s now, colder than %s.').replace('%s', now).replace('%s', `${rule.cold} °C`));
        }
        if (data.humidity !== undefined) {
            const value = Number(data.humidity) / 100;
            const now = reading(data.humidity, '%');
            check('wet', value, rule.wet, true, 3,
                _('Humidity %s now, above %s.').replace('%s', now).replace('%s', `${rule.wet} %`));
            check('dry', value, rule.dry, false, 3,
                _('Humidity %s now, below %s.').replace('%s', now).replace('%s', `${rule.dry} %`));
        }
        if (data.voltage !== undefined && rule.battery !== false) {
            const share = batteryShare(Number(data.voltage));
            if (share < LOW_BATTERY && !this._lowNoticed.has(did)) {
                this._lowNoticed.add(did);
                notices.push([_('The battery is at %s %. Time for a new one.').replace('%s', share), false]);
            } else if (share >= LOW_BATTERY + 10) {
                this._lowNoticed.delete(did);
            }
        }
        return notices;
    }

    _stopTimer(did) {
        const timer = this._openTimers.get(did);
        if (timer)
            GLib.source_remove(timer);
        this._openTimers.delete(did);
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Nook', icon: this._icon});
            this._source.connect('destroy', () => {
                this._source = null;
                this._last.clear();
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    snapshotSaved(camera, file) {
        const notification = new MessageTray.Notification({
            source: this._ensureSource(),
            title: _('Snapshot saved'),
            body: camera,
            gicon: new Gio.FileIcon({file}),
        });
        notification.connect('activated', () => {
            Gio.app_info_launch_default_for_uri(file.get_uri(), global.create_app_launch_context(0, -1));
        });
        notification.addAction(_('Show in Files'), () => showInFiles(file));
        this._source.addNotification(notification);
    }

    _notify(did, title, body, alarm) {
        this._ensureSource();
        const notification = new MessageTray.Notification({
            source: this._source,
            title,
            body,
            urgency: alarm ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL,
        });
        // Alarms stay until seen. Other events replace the sensor's last notification,
        // destroyed only after adding the new one: removing a source's last notification
        // destroys the source.
        const last = this._last.get(did);
        if (alarm) {
            this._last.delete(did);
        } else {
            this._last.set(did, notification);
            notification.connect('destroy', () => {
                if (this._last.get(did) === notification)
                    this._last.delete(did);
            });
        }
        this._source.addNotification(notification);
        last?.destroy();
    }

    stop() {
        for (const did of [...this._openTimers.keys()])
            this._stopTimer(did);
        this._listener.stop();
        this._source?.destroy();
        this._source = null;
    }
}

const NookButton = GObject.registerClass(
class NookButton extends PanelMenu.Button {
    _init(settings, openPreferences, path, alerts) {
        super._init(0.5, _('Nook'));
        this._settings = settings;
        this._path = path;
        this._alerts = alerts;
        this._beacons = null;
        alerts.onReport = (sid, data) => this._heardFromGateway(sid, data);
        this._openPreferences = openPreferences;
        this._cancellable = null;
        this._home = null;
        this._aircon = null;
        this._tapo = null;
        this._cast = null;
        this._tv = null;
        this._sonoff = null;
        this._ewelink = null;
        this._hue = null;
        this._hass = null;
        this._hassSync = 0;
        this._homekit = null;
        this._smartlife = null;
        this._clouds = [];
        this._keepingSpeaker = false;
        this._loginNote = null;
        this._tiles = [];
        // Offline devices when the tiles were last drawn; null while something else shows.
        this._drawnOffline = null;

        const box = new St.BoxLayout({style_class: 'nook-panel-box'});
        this._mark = new Glyph('nook');
        this._mark.add_style_class_name('nook-mark');
        this._mark.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(this._mark);
        // Hidden while empty, or the box spacing pushes the mark off centre.
        this._readings = new St.BoxLayout({
            style_class: 'nook-readings',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._readings);
        this.add_child(box);
        this._markBox = box;
        this._timer = 0;
        this._listenForMiddleClick();
        this._activitiesHeld = false;
        this.menu.actor.connect('captured-event', (actor, event) => this._holdOpen(actor, event));
        this.menu.connect('open-state-changed', (_menu, open) => this._pauseMenuManager(open));

        this._panel = new St.BoxLayout({...VERTICAL, style_class: 'nook-panel'});
        this.menu.box.add_child(this._panel);

        const header = this._header = new St.BoxLayout({style_class: 'nook-header'});
        this._backButton = this._addRoundButton(header, 'go-previous-symbolic', _('Back'),
            () => this._closeCard());
        this._title = new St.Label({
            style_class: 'nook-title',
            text: _('Nook'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._title);
        this._panelButton = this._addRoundButton(header, null, _('Show in the Top Bar'),
            () => this._toggleIn('panel-sensors', this._card.did));
        this._panelButton.child.gicon = Gio.FileIcon.new(Gio.File.new_for_path(`${this._path}/icons/nook-top-bar-symbolic.svg`));
        this._pinButton = this._addRoundButton(header, 'non-starred-symbolic', _('Pin'),
            () => this._togglePin(this._card.did));
        this._hideButton = this._addRoundButton(header, 'view-reveal-symbolic', _('Hide from the Menu'),
            () => this._toggleHidden(this._card.did));
        this._refreshButton = this._addRoundButton(header, 'view-refresh-symbolic', _('Find Devices Again'),
            () => this._discover().catch(logError));
        this._addRoundButton(header, 'emblem-system-symbolic', _('Settings'), () => {
            this._closeMenu();
            this._openPreferences();
        });
        this._panel.add_child(header);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        this._chips = new St.Widget({
            style_class: 'nook-chips',
            layout_manager: new WrapLayout(CHIP_SPACING * scale),
            x_expand: true,
            visible: false,
        });
        this._panel.add_child(this._chips);

        this._body = new St.BoxLayout({...VERTICAL, style_class: 'nook-body'});
        this._scroll = new St.ScrollView({
            child: this._body,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._drop = new TileDrop(settings, () => this._devices(), this._scroll);
        this._panel._delegate = this._drop.outside();
        // No card refresh while a control is held, or within CARD_TOUCHED ms of input.
        this._scroll.connect('captured-event', (_actor, event) => {
            switch (event.type()) {
            case Clutter.EventType.BUTTON_PRESS:
            case Clutter.EventType.TOUCH_BEGIN:
                this._pressed = true;
                this._touchedAt = Date.now();
                break;
            case Clutter.EventType.BUTTON_RELEASE:
            case Clutter.EventType.TOUCH_END:
            case Clutter.EventType.TOUCH_CANCEL:
                this._pressed = false;
                this._touchedAt = Date.now();
                break;
            case Clutter.EventType.SCROLL:
            case Clutter.EventType.KEY_PRESS:
                this._touchedAt = Date.now();
                break;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._scroll.connect('notify::vscrollbar-visible', () => {
            if (this._scroll.vscrollbar_visible)
                this._body.add_style_class_name('nook-body-scrolls');
            else
                this._body.remove_style_class_name('nook-body-scrolls');
        });
        this._panel.add_child(this._scroll);
        this._card = null;
        this._heardSection = null;
        this._heardShown = null;
        this._settle = 0;
        this._scrollRestore = 0;
        this._infoOpen = new Set();
        this._tvBusy = new Set();
        this._cardTimer = 0;
        this._cardReadAt = 0;
        this._cardReading = false;
        this._touchedAt = 0;
        this._pressed = false;
        this._climate = null;
        this._hero = null;
        this._media = null;
        this._map = null;
        this._maps = new Map();
        this._setCardMode(false);

        this._menu = this.menu;
        this._outerMenu = null;
        this._closeHost = null;
        this._menuOpened = open => {
            if (!open) {
                this._stopRetry();
                this._stopBeacons();
                this._syncReadings();
                if (this._card)
                    this._closeCard();
                this._cast?.rest();
                this._tv?.rest();
                this._infoOpen.clear();
                this._stopCardTimer();
                return;
            }
            // Offline tiles sort apart: catch up with what the last open learned, never under the pointer.
            if (this._drawnOffline !== null && this._offlineKey() !== this._drawnOffline)
                this._render();
            // Under Quick Settings, hostIn()'s 'show' handler fits the height.
            if (!this._outerMenu)
                this._fitHeight();
            this._startBeacons();
            this._read().catch(logError);
            this._stopCardTimer();
            this._cardTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CARD_TICK, () => {
                this._refreshCard();
                return GLib.SOURCE_CONTINUE;
            });
        };
        this._watchMenu();
        settings.connectObject(
            'changed::view', () => this._render(),
            'changed::type-colors', () => this._render(),
            'changed::room', () => this._render(),
            'changed::panel-sensors', () => {
                this._restartReadingsSoon();
                if (this._card)
                    this._syncCardHeader();
            },
            'changed::panel-interval', () => this._restartReadingsSoon(),
            'changed::pinned', () => this._render(),
            'changed::order', () => {
                this._render();
                this._syncReadings();
            },
            'changed::hidden', () => this._render(),
            'changed::hidden-rooms', () => this._render(),
            'changed::groups', () => this._render(),
            'changed::names', () => this._render(),
            'changed::icons', () => this._render(),
            'changed::gree-units', () => this.reload().catch(logError),
            'changed::aircons', () => this.reload().catch(logError),
            'changed::tapo-cameras', () => this.reload().catch(logError),
            'changed::cast-speakers', () => {
                if (!this._keepingSpeaker)
                    this.reload().catch(logError);
            },
            'changed::tvs', () => this.reload().catch(logError),
            'changed::sonoff-switches', () => this.reload().catch(logError),
            'changed::ewelink-devices', () => this.reload().catch(logError),
            'changed::hue-bridges', () => this.reload().catch(logError),
            'changed::hue-devices', () => this.reload().catch(logError),
            'changed::hass-devices', () => this.reload().catch(logError),
            'changed::homekit-accessories', () => this.reload().catch(logError),
            'changed::smartlife-devices', () => this.reload().catch(logError),
            ...CLOUD_AIRCONS.flatMap(brand => [`changed::${brand.id}-devices`, () => this.reload().catch(logError)]),
            'changed::extra-tiles', () => {
                this._syncExtras();
                this._render();
            },
            this);
        this._gone = false;
        this.connect('destroy', () => {
            this._gone = true;
            this.stop();
        });
    }

    _watchMenu() {
        this._menu.connectObject('open-state-changed', (_menu, open) => this._menuOpened(open), this);
    }

    _closeMenu() {
        if (this._closeHost)
            this._closeHost();
        else
            this._menu.close();
    }

    hostIn(menu, outer) {
        this._menu.disconnectObject(this);
        this._menu.box.remove_child(this._panel);
        menu.box.add_child(this._panel);
        this._menu = menu;
        this._outerMenu = outer;
        this._closeHost = () => outer.close();
        this._watchMenu();
        // The tile menu shows before measuring its height, so fit on 'show'. Hide it
        // while shut, as closing would, so the first open emits 'show' too.
        if (!menu.isOpen)
            menu.actor.hide();
        menu.actor.connectObject('show', () => this._fitHeight(), this);
    }

    takeMark() {
        this.remove_child(this._markBox);
        return this._markBox;
    }

    // GNOME 49+ opens the menu from a click gesture that accepts any button unless
    // told otherwise; middle clicks run the configured action instead.
    _listenForMiddleClick() {
        this._middleAt = 0;
        this.connect('button-press-event', (_actor, event) =>
            this._clicked(event.get_button()) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        if (this._clickGesture?.set_required_button)
            this._clickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        else
            this._clickGesture?.connect('recognize', gesture =>
                this._clicked(gesture.get_button?.() ?? Clutter.BUTTON_PRIMARY));
    }

    // Connected before the panel's menu manager, which opens whichever top bar button
    // the pointer crosses while a menu is up. A click on one still opens its menu.
    _holdOpen(actor, event) {
        const type = event.type();
        const target = global.stage.get_event_actor(event);
        if (type === Clutter.EventType.TOUCH_END ||
            (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY))
            return this._releaseActivities(target);
        const press = type === Clutter.EventType.TOUCH_BEGIN ||
            (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY);
        if (type !== Clutter.EventType.ENTER && !press)
            return Clutter.EVENT_PROPAGATE;
        if (press)
            this._activitiesHeld = false;
        if (!target || actor.contains(target) || this.contains(target) ||
            readSetting(this._settings, 'hover-switch'))
            return Clutter.EVENT_PROPAGATE;
        if (!press) {
            // EVENT_STOP on a crossing event trips a Clutter runtime check.
            if (!(event.get_flags() & Clutter.EventFlags.FLAG_GRAB_NOTIFY))
                GObject.signal_stop_emission_by_name(actor, 'captured-event::pointer-focus');
            return Clutter.EVENT_PROPAGATE;
        }
        const other = this._topBarButtonAt(target);
        // Activities has no menu and toggles the overview on release.
        if (other === Main.panel.statusArea.activities) {
            this._activitiesHeld = true;
            return Clutter.EVENT_STOP;
        }
        other?.menu.toggle();
        return other?.menu.isOpen ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _topBarButtonAt(target) {
        const {statusArea} = Main.panel;
        if (statusArea.activities?.contains(target))
            return statusArea.activities;
        return Object.values(statusArea).find(button =>
            button.menu instanceof PopupMenu.PopupMenu && button.menu.sourceActor.contains(target));
    }

    // GNOME 51's menu manager adds capture-phase actions on open that run before
    // captured-event: a hover controller, paused meanwhile, and a click gesture that
    // would close the menu on a press _holdOpen handles itself.
    _pauseMenuManager(open) {
        if (this._hoverSwitch)
            this._hoverSwitch.enabled = true;
        this._hoverSwitch = null;
        if (!open || readSetting(this._settings, 'hover-switch'))
            return;
        // Added after this handler runs.
        Promise.resolve().then(() => {
            if (!this.menu?.isOpen)
                return;
            this._hoverSwitch = this.menu.actor.get_action('popup-manager-motion-controller');
            if (this._hoverSwitch)
                this._hoverSwitch.enabled = false;
            const click = this.menu.actor.get_action('popup-manager-click-gesture');
            if (click && click !== this._managerClick) {
                this._managerClick = click;
                click.connectObject('may-recognize', () => !this._holdsPress(click), this);
            }
        });
    }

    _holdsPress(click) {
        if (click.get_actor() !== this.menu.actor || readSetting(this._settings, 'hover-switch'))
            return false;
        const event = click.get_point_event(0);
        const target = global.stage.get_event_actor(event);
        const primary = event.type() === Clutter.EventType.TOUCH_BEGIN ||
            event.get_button() === Clutter.BUTTON_PRIMARY;
        return primary && Boolean(target) && !this.contains(target) && Boolean(this._topBarButtonAt(target));
    }

    _releaseActivities(target) {
        const held = this._activitiesHeld;
        this._activitiesHeld = false;
        if (!held || !target || !Main.panel.statusArea.activities?.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this.menu.close();
        if (Main.overview.shouldToggleByCornerOrButton())
            Main.overview.toggle();
        return Clutter.EVENT_STOP;
    }

    _clicked(button) {
        if (button !== Clutter.BUTTON_MIDDLE)
            return false;
        const action = readSetting(this._settings, 'middle-click');
        if (action === 'none')
            return false;
        this.menu.close();
        // Press event and gesture may both report one click; ignore the second.
        const now = GLib.get_monotonic_time();
        if (now - this._middleAt < MIDDLE_TWICE)
            return true;
        this._middleAt = now;
        if (action === 'refresh')
            this._discover().catch(logError);
        else if (action === 'settings')
            this._openPreferences();
        return true;
    }

    _roundButton(iconName, label, onClick) {
        const button = new St.Button({
            style_class: 'nook-round-button',
            accessible_name: label,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', onClick);
        return button;
    }

    _addRoundButton(box, iconName, label, onClick) {
        const button = this._roundButton(iconName, label, onClick);
        box.add_child(button);
        return button;
    }

    // The picture presses its power button too. Not focusable: the button already is.
    _powerScene(scene, power) {
        const button = new SceneButton({child: scene, can_focus: false});
        power.bind_property('reactive', button, 'reactive', GObject.BindingFlags.SYNC_CREATE);
        button.connect('clicked', () => power.emit('clicked', 1));
        return button;
    }

    // Work area is in device pixels, style lengths aren't: divide by the scale factor.
    _fitHeight() {
        const anchor = this._outerMenu?.box ?? this;
        const monitor = Main.layoutManager.findMonitorForActor(anchor) ?? Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        if (!this._outerMenu) {
            this._scroll.style = `max-height: ${Math.round(workArea.height * MENU_SHARE / scale)}px;`;
            return;
        }
        // Panel max-height: room below Quick Settings with the tile shut. The tile menu
        // opens in between, pushing later tiles down; only the list scrolls.
        const [, top] = this._outerMenu.box.get_transformed_position();
        const [, height] = this._outerMenu.box.get_transformed_size();
        const [, panel] = this._panel.get_preferred_height(-1);
        const [, box] = this._menu.box.get_preferred_height(-1);
        const edges = node => node.get_vertical_padding() +
            node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        // Tile menu chrome and the panel's padding and border, which max-height excludes.
        const frame = box - panel + edges(this._menu.actor.get_theme_node()) +
            this._menu.actor.margin_top + this._menu.actor.margin_bottom +
            edges(this._panel.get_theme_node());
        const room = workArea.y + workArea.height - (top + height) - frame -
            QUICK_SETTINGS_MARGIN * scale;
        this._panel.style = `max-height: ${Math.max(0, Math.round(room / scale))}px;`;
    }

    // Idempotent: disable() calls it, then the destroy handler again.
    stop() {
        this._drop.stop();
        this._stopRetry();
        this._stopBeacons();
        this._stopCardTimer();
        this._cameraApi?.abort();
        this._cameraApi = null;
        if (this._sirenTimer)
            GLib.source_remove(this._sirenTimer);
        this._sirenTimer = 0;
        this._alerts.onReport = null;
        this._camera?.stop();
        this._camera = null;
        this._panner?.finish();
        this._panner = null;
        if (this._climate?.nudging)
            GLib.source_remove(this._climate.nudging);
        this._climate?.scene.run(false);
        this._hero?.scene.run(false);
        this._forgetMedia();
        this._forgetMap();
        this._card = null;
        this._forgetScroll();
        this._stopReadings();
        this._menu.disconnectObject(this);
        if (this._outerMenu)
            this._menu.actor.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._cancellable?.cancel();
        this._cancellable = null;
        this._home?.abort();
        this._home = null;
        this._aircon?.abort();
        this._aircon = null;
        this._tapo?.abort();
        this._tapo = null;
        this._cast?.abort();
        this._cast = null;
        this._tv?.abort();
        this._tv = null;
        this._sonoff?.abort();
        this._sonoff = null;
        this._ewelink?.abort();
        this._ewelink = null;
        this._hue?.abort();
        this._hue = null;
        this._hass?.abort();
        this._hass = null;
        this._homekit?.abort();
        this._homekit = null;
        this._smartlife?.abort();
        this._smartlife = null;
        for (const cloud of this._clouds)
            cloud.abort();
        this._clouds = [];
        if (this._hassSync)
            GLib.source_remove(this._hassSync);
        this._hassSync = 0;
    }

    _clear() {
        this._camera?.stop();
        this._camera = null;
        this._cameraApi?.abort();
        this._cameraApi = null;
        if (this._sirenTimer)
            GLib.source_remove(this._sirenTimer);
        this._sirenTimer = 0;
        this._panner?.finish();
        this._panner = null;
        this._climate?.flush?.();
        this._climate?.scene.run(false);
        this._climate = null;
        this._tvCard?.scene.run(false);
        this._tvCard = null;
        this._hero?.scene.run(false);
        this._hero = null;
        this._forgetMedia();
        this._forgetMap();
        this._forgetScroll();
        this._heardSection = null;
        this._heardShown = null;
        this._body.destroy_all_children();
        this._chips.destroy_all_children();
        this._chips.visible = false;
        this._tiles = [];
        this._drawnOffline = null;
    }

    _message(text, action = null) {
        this._clear();
        const label = new St.Label({style_class: 'nook-message', text});
        label.clutter_text.line_wrap = true;
        this._body.add_child(label);
        if (action) {
            const [actionLabel, onClick] = action;
            const button = new St.Button({
                style_class: 'nook-action',
                label: actionLabel,
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
            });
            button.connect('clicked', onClick);
            this._body.add_child(button);
        }
    }

    _showLoading(card = false) {
        this._clear();
        if (card) {
            const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
            section.add_child(skeletonLines());
            this._body.add_child(section);
            return;
        }
        const [columns, shape] = {grid: [3, 'square'], rooms: [2, 'compact']}[readSetting(this._settings, 'view')] ??
            [2, 'wide'];
        for (let i = 0; i < 3; i++) {
            const row = new St.BoxLayout({style_class: 'nook-row', x_expand: true});
            row.layout_manager.homogeneous = true;
            for (let j = 0; j < columns; j++)
                row.add_child(skeletonTile(shape));
            this._body.add_child(row);
        }
    }

    // Mi Home is one source of many: only a login that was there and is lost gets a note.
    _showLogin(text = null) {
        if (this._sources().some(source => source && source !== this._home)) {
            if (text)
                this._loginNote = {text, target: 'accounts-mihome'};
            this._render();
            return;
        }
        const open = () => {
            this._closeMenu();
            this._openPreferences('accounts-mihome');
        };
        if (text)
            this._message(text, [_('Log In…'), open]);
        else
            this._message(_('Add an account or a device in Settings, and your home shows up here.'), [_('Open Settings…'), open]);
    }

    _addLoginNote() {
        const {text, target} = this._loginNote;
        const label = new St.Label({style_class: 'nook-message', text});
        label.clutter_text.line_wrap = true;
        this._body.add_child(label);
        const button = new St.Button({
            style_class: 'nook-action',
            label: _('Log In…'),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        button.connect('clicked', () => {
            this._closeMenu();
            this._openPreferences(target);
        });
        this._body.add_child(button);
    }

    _devices() {
        return [
            ...this._home?.devices ?? [],
            ...this._aircon?.devices ?? [],
            ...this._tapo?.devices ?? [],
            ...this._cast?.devices ?? [],
            ...this._tv?.devices ?? [],
            ...this._sonoff?.devices ?? [],
            ...this._ewelink?.devices ?? [],
            ...this._hue?.devices ?? [],
            ...this._hass?.devices ?? [],
            ...this._homekit?.devices ?? [],
            ...this._smartlife?.devices ?? [],
            ...this._clouds.flatMap(cloud => cloud.devices),
        ];
    }

    _offlineKey() {
        return this._devices().filter(d => d.online === false && !isBluetooth(d)).map(d => d.did).join(' ');
    }

    _sources() {
        return [this._home, this._aircon, this._tapo, this._cast, this._tv, this._sonoff, this._ewelink, this._hue, this._hass,
            this._homekit, this._smartlife, ...this._clouds];
    }

    _showFailure(home, e) {
        if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
            logError(e);
        if (!home.loggedIn)
            this._showLogin(_('The Mi Home login has expired.'));
        else
            this._message(e.message, [_('Try Again'), () => this.reload().catch(logError)]);
    }

    async reload() {
        this._stopRetry();
        this._card = null;
        this._setCardMode(false);
        this._stopReadings();
        this._readings.destroy_all_children();
        this._cancellable?.cancel();
        this._home?.abort();
        this._home = null;
        this._aircon?.abort();
        this._aircon = null;
        this._tapo?.abort();
        this._tapo = null;
        this._cast?.abort();
        this._cast = null;
        this._tv?.abort();
        this._tv = null;
        this._sonoff?.abort();
        this._sonoff = null;
        this._ewelink?.abort();
        this._ewelink = null;
        this._hue?.abort();
        this._hue = null;
        this._hass?.abort();
        this._hass = null;
        if (this._hassSync)
            GLib.source_remove(this._hassSync);
        this._hassSync = 0;
        this._homekit?.abort();
        this._homekit = null;
        this._smartlife?.abort();
        this._smartlife = null;
        for (const cloud of this._clouds)
            cloud.abort();
        this._clouds = [];
        this._loginNote = null;
        const cancellable = this._cancellable = new Gio.Cancellable();
        this._title.text = _('Nook');
        this._showLoading();

        const aircons = [...parseUnits(readSetting(this._settings, 'gree-units')),
            ...parseAircons(readSetting(this._settings, 'aircons'))];
        if (aircons.length > 0)
            this._aircon = new AirconHome(aircons);
        const cameras = Tapo.parseCameras(readSetting(this._settings, 'tapo-cameras'));
        if (cameras.length > 0)
            this._tapo = new Tapo.TapoHome(cameras);
        const speakers = parseSpeakers(readSetting(this._settings, 'cast-speakers'));
        if (speakers.length > 0) {
            const cast = this._cast = new CastHome(speakers);
            cast.onChange = device => this._castChanged(cast, device);
            cast.onMoved = speaker => this._keepSpeaker(speaker);
        }
        const tvs = parseTvs(readSetting(this._settings, 'tvs'));
        if (tvs.length > 0) {
            const tv = this._tv = new TvHome(tvs);
            tv.onChange = device => this._tvChanged(tv, device);
        }
        const switches = parseSwitches(readSetting(this._settings, 'sonoff-switches'));
        if (switches.length > 0)
            this._sonoff = new SonoffHome(switches);
        const ewelinkDevices = parseEwelinkDevices(readSetting(this._settings, 'ewelink-devices'));
        if (ewelinkDevices.length > 0 && readSetting(this._settings, 'ewelink-region')) {
            const ewelink = this._ewelink = new EwelinkHome(ewelinkDevices);
            ewelink.onExpired = () => {
                if (this._ewelink !== ewelink)
                    return;
                this._loginNote = {text: _('The eWeLink login has expired.'), target: 'accounts-ewelink'};
                this._render();
            };
        }
        const hueDevices = parseHueDevices(readSetting(this._settings, 'hue-devices'));
        if (hueDevices.length > 0) {
            const hue = this._hue = new HueHome(parseHueBridges(readSetting(this._settings, 'hue-bridges')), hueDevices);
            hue.onExpired = () => {
                if (this._hue !== hue)
                    return;
                this._loginNote = {text: _('A Hue bridge needs to be paired again.'), target: 'accounts-hue'};
                this._render();
            };
        }
        const hassDevices = parseHassDevices(readSetting(this._settings, 'hass-devices'));
        if (hassDevices.length > 0 && readSetting(this._settings, 'hass-server')) {
            const hass = this._hass = new HassHome(hassDevices);
            hass.onExpired = () => {
                if (this._hass !== hass)
                    return;
                this._loginNote = {text: _('Home Assistant refused the access token.'), target: 'accounts-hass'};
                this._render();
            };
            hass.onChange = () => this._hassChanged(hass);
        }
        const accessories = parseHomeKitHosts(readSetting(this._settings, 'homekit-accessories'));
        if (accessories.length > 0) {
            const homekit = this._homekit = new HomeKitHome(accessories);
            homekit.onExpired = () => {
                if (this._homekit !== homekit)
                    return;
                this._loginNote = {text: _('A HomeKit accessory needs to be paired again.'), target: 'accounts-homekit'};
                this._render();
            };
        }
        const smartDevices = parseSmartLifeDevices(readSetting(this._settings, 'smartlife-devices'));
        if (smartDevices.length > 0 && readSetting(this._settings, 'smartlife-user')) {
            const smartlife = this._smartlife = new SmartLifeHome(smartDevices);
            smartlife.onExpired = () => {
                if (this._smartlife !== smartlife)
                    return;
                this._loginNote = {text: _('The Smart Life login has expired.'), target: 'accounts-smartlife'};
                this._render();
            };
        }
        for (const brand of CLOUD_AIRCONS) {
            const entries = parseEntries(readSetting(this._settings, `${brand.id}-devices`));
            if (entries.length === 0)
                continue;
            const cloud = new CloudAirconHome(brand, entries);
            cloud.onExpired = () => {
                if (!this._clouds.includes(cloud))
                    return;
                this._loginNote = {text: _('The %s login has expired.').replace('%s', brand.label), target: `accounts-${brand.id}`};
                this._render();
            };
            // A login renewed in the settings works again without a reload.
            cloud.onBack = () => {
                if (!this._clouds.includes(cloud) || this._loginNote?.target !== `accounts-${brand.id}`)
                    return;
                this._loginNote = null;
                this._render();
            };
            this._clouds.push(cloud);
        }
        this._startReadings();

        let saved;
        try {
            saved = await Secrets.lookup('xiaomi', cancellable);
        } catch (e) {
            if (!cancellable.is_cancelled())
                this._message(_('The keyring could not be read: %s').replace('%s', e.message));
            return;
        }
        if (cancellable.is_cancelled())
            return;
        if (!saved) {
            this._showLogin();
            return;
        }

        let credentials;
        try {
            credentials = JSON.parse(saved);
        } catch {
            this._showLogin(_('The saved Mi Home login could not be read.'));
            return;
        }
        const cloud = new XiaomiCloud(credentials);
        const home = this._home = new MiHome(cloud);
        // A token refresh finishing after logout must not re-store the login.
        cloud.onRefresh = fresh => {
            if (this._home === home)
                Secrets.store('xiaomi', SECRET_LABEL, JSON.stringify(fresh)).catch(logError);
        };
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

        this._syncExtras();
        this._render();
        this._startReadings();
        if (this._menu.isOpen)
            await this._read();
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

    // Tile order, hidden devices included: hiding a tile keeps its top bar reading.
    _panelDevices() {
        const dids = readSetting(this._settings, 'panel-sensors');
        return arrange(this._devices(), this._choices(), true).filter(d => dids.includes(d.did));
    }

    _choices() {
        return {
            pinned: readSetting(this._settings, 'pinned'),
            order: readSetting(this._settings, 'order'),
            hidden: readSetting(this._settings, 'hidden'),
        };
    }

    _togglePin(did) {
        this._toggleIn('pinned', did);
    }

    _toggleHidden(did) {
        this._toggleIn('hidden', did);
    }

    _toggleIn(key, did) {
        const list = readSetting(this._settings, key);
        this._settings.set_strv(key, list.includes(did) ? list.filter(d => d !== did) : [...list, did]);
    }

    _setCardMode(on) {
        this._backButton.visible = on;
        this._panelButton.visible = on;
        this._pinButton.visible = on;
        this._hideButton.visible = on;
        this._refreshButton.visible = !on;
        this._quietHeader(!on && readSetting(this._settings, 'view') === 'control');
        if (on)
            this._syncCardHeader();
    }

    _quietHeader(on) {
        if (on)
            this._header.add_style_class_name('nook-header-quiet');
        else
            this._header.remove_style_class_name('nook-header-quiet');
    }

    _syncCardHeader() {
        const pinned = readSetting(this._settings, 'pinned').includes(this._card.did);
        const hidden = readSetting(this._settings, 'hidden').includes(this._card.did);
        this._pinButton.child.icon_name = pinned ? 'starred-symbolic' : 'non-starred-symbolic';
        this._pinButton.accessible_name = pinned ? _('Unpin') : _('Pin');
        this._hideButton.child.icon_name = hidden ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        this._hideButton.accessible_name = hidden ? _('Show in the Menu') : _('Hide from the Menu');
        const shown = readSetting(this._settings, 'panel-sensors').includes(this._card.did);
        this._panelButton.visible = this._devices().includes(this._card);
        this._panelButton.checked = shown;
        this._panelButton.accessible_name = shown ? _('Take Off the Top Bar') : _('Show in the Top Bar');
    }

    _stopCardTimer() {
        if (this._cardTimer)
            GLib.source_remove(this._cardTimer);
        this._cardTimer = 0;
    }

    _refreshCard() {
        const device = this._card;
        if (!device || !this._menu.isOpen || this._cardReading || this._pressed ||
            device.primary.kind === 'camera' || device.listed === false)
            return;
        const now = Date.now();
        const every = [this._home, this._ewelink, this._smartlife, ...this._clouds].includes(device.source) ? CARD_CLOUD : CARD_LOCAL;
        if (now - this._touchedAt < CARD_TOUCHED || now - this._cardReadAt < every)
            return;
        this._cardReading = true;
        this._openCard(device).catch(logError).finally(() => {
            this._cardReading = false;
        });
    }

    async _openCard(device) {
        this._cardReadAt = Date.now();
        if (device.primary.kind === 'camera') {
            await this._openCameraCard(device);
            return;
        }
        if (device.primary.kind === 'climate' || (deviceType(device) === 'air-conditioner' && device.climate !== null)) {
            await this._openClimateCard(device);
            return;
        }
        if (device.primary.kind === 'media') {
            await this._openMediaCard(device);
            return;
        }
        if (device.primary.kind === 'tv') {
            await this._openTvCard(device);
            return;
        }
        if (device.source === this._sonoff) {
            await this._openSwitchCard(device);
            return;
        }
        const home = device.source;
        const again = this._card === device;
        const scroll = again ? this._scroll.vadjustment.value : 0;
        if (!again)
            this._drawer = null;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!again)
            this._showLoading(true);

        let services, values;
        const eventKeys = home === this._home ? EVENT_KEYS()[deviceType(device)] ?? [] : [];
        const live = device.did.startsWith('lumi.')
            ? this._alerts.read(device.did.slice('lumi.'.length)).catch(() => null) : Promise.resolve(null);
        try {
            services = await home.services(device);
            const readable = services.flatMap(s => s.properties
                .filter(p => p.access.includes('read'))
                .map(p => ({siid: s.siid, piid: p.piid})));
            const reading = home.readProperties(device, readable);
            // Asked now so it queues right behind the values, ahead of background reads;
            // _fillHistory then gets it from MiHome's cache.
            this._readHistory(home, device, eventKeys).catch(() => {});
            values = await reading;
            // No spec (e.g. a range extender), but miIO answers. Copy only shown fields:
            // miIO.info also carries the device token, which must never reach the cache.
            if (services.length === 0 && home === this._home && !isBluetooth(device) && device.online) {
                const info = await home.rpc(device, 'miIO.info').catch(e => {
                    console.debug(`nook: miIO.info: ${e.message}`);
                    return null;
                });
                Object.defineProperty(device, 'info', {
                    value: info ? {
                        ap: {ssid: info.ap?.ssid, rssi: info.ap?.rssi},
                        sta: {count: info.sta?.count},
                        netif: {localIp: info.netif?.localIp},
                        fw_ver: info.fw_ver,
                        life: info.life,
                    } : null,
                    writable: true,
                    configurable: true,
                    enumerable: false,
                });
            }
        } catch (e) {
            if (this._card === device && !again)
                this._message(e instanceof SpecError ? specTrouble(e) : e.message);
            if (!(e instanceof XiaomiError) && !(e instanceof EwelinkError) && !(e instanceof SpecError) &&
                !(e instanceof GLib.Error))
                throw e;
            return;
        }
        if (this._card !== device || !this._sources().includes(home))
            return;

        device.values = device.primary.props.map((p, i) => values.get(`${p.siid}/${p.piid}`) ?? device.values?.[i] ?? null);
        device.extra = {...device.extra};
        for (const extra of home.extras.filter(e => e.did === device.did)) {
            const key = `${extra.siid}/${extra.piid}`;
            if (values.has(key))
                device.extra[key] = values.get(key);
        }
        const state = await live;
        if (this._card !== device || !this._sources().includes(home))
            return;
        if (state)
            setLive(device, state);
        this._fillCard(device, services, values, eventKeys);
        this._putScrollBack(scroll);
    }

    async _openSwitchCard(device) {
        const source = device.source;
        const again = this._card === device;
        const scroll = again ? this._scroll.vadjustment.value : 0;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (device.online === null)
            this._showLoading(true);
        else if (!again)
            this._fillCard(device, [], new Map());
        await source.readDevice(device);
        if (this._card !== device || source !== this._sonoff)
            return;
        this._fillCard(device, [], new Map());
        this._putScrollBack(scroll);
    }

    // New rows aren't laid out yet: restore once the adjustment's upper bound covers it.
    _putScrollBack(scroll) {
        this._forgetScroll();
        if (scroll <= 0)
            return;
        const adjustment = this._scroll.vadjustment;
        this._scrollRestore = adjustment.connect('notify::upper', () => {
            if (adjustment.upper - adjustment.page_size >= scroll) {
                this._forgetScroll();
                adjustment.value = scroll;
            }
        });
    }

    _forgetScroll() {
        if (this._scrollRestore)
            this._scroll.vadjustment.disconnect(this._scrollRestore);
        this._scrollRestore = 0;
    }

    _scrollToEnd() {
        this._forgetScroll();
        const adjustment = this._scroll.vadjustment;
        this._scrollRestore = adjustment.connect('notify::upper', () => {
            this._forgetScroll();
            adjustment.value = adjustment.upper - adjustment.page_size;
        });
    }

    async _openCameraCard(device) {
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        this._clear();

        let account = null;
        let controls;
        const toSettings = [_('Settings…'), () => {
            this._closeMenu();
            this._openPreferences(`accounts-tapo ${device.did}`);
        }];
        if (device.test) {
            controls = device.source.controls(device);
        } else if (!device.tapo && !device.xaddr) {
            this._message(_('Search for cameras again in Settings, under Cameras, so Nook learns how to reach this one.'), toSettings);
            return;
        } else {
            let saved = null;
            try {
                saved = await Secrets.lookup(device.source.secret(device));
            } catch (e) {
                console.debug(`nook: keyring: ${e.message}`);
            }
            if (this._card !== device)
                return;
            if (!saved) {
                this._message(device.tapo
                    ? _('Add the camera account from the Tapo app in Settings, under Cameras.')
                    : _('Add the login of this camera in Settings, under Cameras.'), toSettings);
                return;
            }
            let user, password;
            try {
                ({user, password} = JSON.parse(saved));
            } catch {
                this._message(_('The saved camera account could not be read. Save it again in Settings, under Cameras.'));
                return;
            }
            account = {user, password};
            controls = device.source.controls(device, user, password);
        }

        const view = new CameraView(() => device.source.refused(device));
        this._body.add_child(view);
        this._camera = view;
        // Refused recently: don't retry yet, every attempt keeps the camera locked out.
        if (!device.test && device.source.isRefused(device))
            view.showRefused();
        else if (device.test)
            view.start(this._path, null);
        else
            this._watchCamera(device, view, account, controls).catch(logError);

        const row = new St.BoxLayout({style_class: 'nook-card-row'});
        const about = [device.model.replace(/^tapo /, 'Tapo '), device.test ? '' : device.ip].filter(Boolean).join(' · ');
        const info = new St.Label({
            style_class: 'nook-card-value',
            text: about,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        info.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(info);
        const snapshot = this._addRoundButton(row, 'camera-photo-symbolic', _('Take a Snapshot'), () => {
            this._takeSnapshot(device, account, view, snapshot).catch(logError);
        });
        this._body.add_child(row);
        this._addPanButtons(device, view, controls, row, info).catch(logError);
        this._addCameraControls(device, view).catch(logError);
    }

    async _watchCamera(device, view, account, controls) {
        try {
            const {live, still} = await device.source.streams(device, controls, this._cancellable);
            Object.assign(account, {url: live, still});
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._camera !== view)
                return;
            if (!(e instanceof OnvifError) && !(e instanceof GLib.Error))
                throw e;
            if (e.refused) {
                device.source.refused(device);
                view.showRefused();
            } else {
                view.showProblem(e.message);
            }
            return;
        }
        if (this._camera === view)
            view.start(this._path, account);
    }

    async _takeSnapshot(device, account, view, button) {
        if (!device.test && device.source.isRefused(device)) {
            view.showRefused();
            return;
        }
        // The camera has not said where its stream is yet.
        if (account && !account.still)
            return;
        button.reactive = false;
        button.opacity = 110;
        const name = readSetting(this._settings, 'names')[device.did] || device.name;
        try {
            const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir();
            const folder = Gio.File.new_for_path(GLib.build_filenamev([pictures, 'Nook']));
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
            const file = folder.get_child(`${name.replaceAll('/', '-')} ${stamp}.jpg`);
            const argv = ['gjs', '-m', `${this._path}/feed.js`, '--still', file.get_path()];
            if (!account)
                argv.push('--test');
            const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            const input = account ? `${JSON.stringify({...account, url: account.still})}\n` : null;
            await new Promise((resolve, reject) => {
                process.communicate_utf8_async(input, null, (_process, result) => {
                    try {
                        resolve(process.communicate_utf8_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const status = process.get_exit_status();
            if (this._gone)
                return;
            if (status === 0)
                this._alerts.snapshotSaved(name, file);
            else if (status === NO_GSTREAMER)
                Main.notifyError(name, _('GStreamer is needed to show the picture.'));
            else if (status === NO_PLUGIN)
                Main.notifyError(name, _('The picture needs a GStreamer plugin that is not installed.'));
            else if (status === REFUSED) {
                device.source.refused(device);
                if (this._camera === view)
                    view.showRefused();
            } else
                Main.notifyError(name, _('The camera sent no picture to save.'));
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            Main.notifyError(name, e.message);
        } finally {
            if (this._camera === view) {
                button.reactive = true;
                button.opacity = 255;
            }
        }
    }

    async _addCameraControls(device, view) {
        // Privacy, light, night vision and siren go through Tapo's own API.
        if (device.test || !device.tapo) {
            this._addDeviceInfo(device);
            return;
        }
        let saved = null;
        try {
            saved = await Secrets.lookup('tapo-admin');
        } catch (e) {
            console.debug(`nook: keyring: ${e.message}`);
        }
        if (this._camera !== view)
            return;
        this._body.add_child(new St.Label({style_class: 'nook-room', text: _('Camera')}));
        const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
        this._body.add_child(section);
        const fillInfo = this._addDeviceInfo(device);
        const say = text => {
            section.destroy_all_children();
            const label = new St.Label({style_class: 'nook-card-value', text});
            label.clutter_text.line_wrap = true;
            section.add_child(label);
        };
        let password = null;
        try {
            password = saved ? JSON.parse(saved).password : null;
        } catch {}
        if (!password) {
            say(_('Privacy mode, the light, night vision and the siren need your TP-Link password, in Settings under Cameras.'));
            const settings = new St.Button({style_class: 'nook-chip', label: _('Settings…'), can_focus: true, x_align: Clutter.ActorAlign.START});
            settings.connect('clicked', () => {
                this._closeMenu();
                this._openPreferences('accounts-tapo admin');
            });
            section.add_child(settings);
            return;
        }

        section.destroy_all_children();
        section.add_child(skeletonLines());
        const api = this._cameraApi = new CameraApi(device.ip, password);
        let state;
        try {
            state = await api.read();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._camera !== view)
                return;
            if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
                throw e;
            say(e.code === WRONG_PASSWORD
                ? _('The TP-Link password in Settings is not the one this camera knows.')
                : e.message);
            return;
        }
        if (this._camera !== view)
            return;
        section.destroy_all_children();
        if (state.about) {
            device.about = {...device.about, ...state.about};
            fillInfo();
        }

        const fail = e => {
            if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
                logError(e);
            else if (!this._gone && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                Main.notifyError(device.name, e.message);
        };
        const switches = [
            ['privacy', _('Privacy Mode'), on => api.setPrivacy(on)],
            ['light', _('Status Light'), on => api.setLight(on)],
            ['motion', _('Motion Detection'), on => api.setMotion(on)],
            ['alarm', _('Siren on Motion'), on => api.setAlarm(on)],
        ];
        for (const [key, label, set] of switches) {
            if (state[key] !== null)
                section.add_child(this._switchRow(label, state[key], on => set(on).catch(e => {
                    fail(e);
                    throw e;
                })));
        }

        if (state.night) {
            const row = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-row'});
            row.add_child(new St.Label({style_class: 'nook-card-label', text: _('Night Vision')}));
            const chips = new St.BoxLayout({style_class: 'nook-card-row'});
            const modes = [['auto', _('Auto')], ['on', _('On')], ['off', _('Off')]];
            const pick = optimistic(chips, state.night, night => {
                buttons.forEach((b, i) => {
                    b.checked = modes[i][0] === night;
                });
            });
            const buttons = modes.map(([mode, label]) => {
                const chip = new St.Button({style_class: 'nook-chip', label, can_focus: true, checked: state.night === mode});
                chip.connect('clicked', () => pick(mode, m => api.setNight(m).catch(e => {
                    fail(e);
                    throw e;
                })));
                chips.add_child(chip);
                return chip;
            });
            row.add_child(chips);
            section.add_child(row);
        }

        const siren = new St.Button({style_class: 'nook-chip', label: _('Sound the Siren'), can_focus: true, x_align: Clutter.ActorAlign.START});
        let armed = false;
        let sounding = false;
        let pending = false;
        let gone = false;
        siren.connect('destroy', () => {
            gone = true;
        });
        siren.connect('clicked', () => {
            if (pending)
                return;
            if (!sounding && !armed) {
                armed = true;
                siren.label = _('Click Again to Sound It');
                this._sirenTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                    this._sirenTimer = 0;
                    armed = false;
                    siren.label = _('Sound the Siren');
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            if (this._sirenTimer) {
                GLib.source_remove(this._sirenTimer);
                this._sirenTimer = 0;
            }
            const next = !sounding;
            armed = false;
            pending = true;
            api.siren(next).then(() => {
                sounding = next;
            }).catch(e => {
                if (!gone)
                    fail(e);
            }).finally(() => {
                pending = false;
                if (!gone)
                    siren.label = sounding ? _('Stop the Siren') : _('Sound the Siren');
            });
        });
        section.add_child(siren);
    }

    _switchRow(text, active, onToggle) {
        const row = new St.BoxLayout({style_class: 'nook-card-row'});
        const label = new St.Label({style_class: 'nook-card-label', text, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const toggle = new PopupMenu.Switch(active);
        toggle.reactive = false;
        const button = new St.Button({child: toggle, can_focus: true, accessible_name: text});
        const pick = optimistic(button, active, on => {
            toggle.state = on;
        });
        button.connect('clicked', () => pick(!toggle.state, onToggle));
        row.add_child(label);
        row.add_child(button);
        return row;
    }

    async _addPanButtons(device, view, controls, row, info) {
        let abilities;
        try {
            abilities = await device.source.abilities(device, controls, this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`nook: ${device.name}: ${e.message}`);
            return;
        }
        if (this._camera !== view || !abilities.pan)
            return;

        const panner = this._panner = new Panner(controls, e => {
            if (!(e instanceof OnvifError) && !(e instanceof GLib.Error)) {
                logError(e);
                return;
            }
            if (this._camera === view)
                info.text = _('Could not turn the camera: %s').format(e.message);
        });
        const pad = new St.BoxLayout({style_class: 'nook-card-row'});
        for (const [icon, label, x, y] of panButtons())
            this._addRoundButton(pad, icon, label, () => panner.nudge(x, y));
        if (abilities.home)
            this._addRoundButton(pad, 'go-home-symbolic', _('Turn to the Home Position'), () => panner.home());
        // After adding buttons: Clutter passes text direction to children only when set.
        pad.set_text_direction(Clutter.TextDirection.LTR);
        row.insert_child_above(pad, info);
    }

    async _openMediaCard(device) {
        const source = device.source;
        const again = this._card === device;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!device.state)
            this._showLoading(true);
        else if (!again)
            this._fillMediaCard(device);
        await source.readDevice(device);
        if (this._card !== device || source !== this._cast)
            return;
        this._fillMediaCard(device);
    }

    _fillMediaCard(device) {
        if (!device.online || !device.state) {
            this._message(_('The speaker is not answering. Is it on the same network?'));
            return;
        }
        if (this._media?.device === device) {
            this._syncMediaCard();
            return;
        }
        this._clear();
        const home = device.source;
        const m = {device, tick: 0};
        m.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-media'});

        const hero = new St.BoxLayout({style_class: 'nook-media-hero'});
        m.scene = new Scene('speaker', 'nook-hero-scene', false);
        hero.add_child(m.scene);
        const text = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'nook-hero-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        m.song = new St.Label({style_class: 'nook-media-song'});
        m.artist = new St.Label({style_class: 'nook-hero-small'});
        for (const label of [m.song, m.artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        const status = new St.BoxLayout({style_class: 'nook-hero-status'});
        m.dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        status.add_child(m.dot);
        m.app = new St.Label({style_class: 'nook-hero-small', y_align: Clutter.ActorAlign.CENTER});
        status.add_child(m.app);
        text.add_child(status);
        hero.add_child(text);
        m.box.add_child(hero);

        m.time = new St.BoxLayout({...VERTICAL, style_class: 'nook-media-time'});
        m.progress = new Scene('progress', 'nook-media-progress');
        m.time.add_child(m.progress);
        const times = new St.BoxLayout({style_class: 'nook-media-times'});
        m.elapsed = new St.Label({x_expand: true});
        times.add_child(m.elapsed);
        m.length = new St.Label();
        times.add_child(m.length);
        m.time.add_child(times);
        m.box.add_child(m.time);

        const controls = new St.BoxLayout({style_class: 'nook-media-controls', x_align: Clutter.ActorAlign.CENTER});
        m.previous = this._addRoundButton(controls, 'media-skip-backward-symbolic', _('Previous'),
            () => this._castDo(device, () => home.skip(device, -1)));
        m.play = this._addRoundButton(controls, 'media-playback-start-symbolic', _('Play'),
            () => this._castDo(device, () => castToggle(home, device)));
        m.play.add_style_class_name('nook-play');
        m.play.child.icon_size = 22;
        m.next = this._addRoundButton(controls, 'media-skip-forward-symbolic', _('Next'),
            () => this._castDo(device, () => home.skip(device, 1)));
        m.box.add_child(controls);

        const volume = new St.BoxLayout({style_class: 'nook-media-volume'});
        m.mute = this._addRoundButton(volume, 'audio-volume-high-symbolic', _('Mute'),
            () => this._castDo(device, () => home.setMuted(device, !device.state.muted)));
        m.mute.add_style_class_name('nook-step');
        m.volume = new VolumeSlider(
            level => this._showVolume(level),
            level => this._castDo(device, () => home.setVolume(device, level)));
        volume.add_child(m.volume);
        m.level = new St.Label({style_class: 'nook-media-level', y_align: Clutter.ActorAlign.CENTER});
        volume.add_child(m.level);
        m.box.add_child(volume);

        this._body.add_child(m.box);
        const fillInfo = this._addDeviceInfo(device);
        home.details(device).then(() => {
            if (this._media === m)
                fillInfo();
        }).catch(logError);
        this._media = m;
        // Cast reports the position only on status changes; advance it locally.
        m.tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._showMediaTime();
            return GLib.SOURCE_CONTINUE;
        });
        this._syncMediaCard();
    }

    _forgetMedia() {
        const m = this._media;
        if (!m)
            return;
        if (m.tick)
            GLib.source_remove(m.tick);
        m.scene.run(false);
        this._media = null;
    }

    _syncMediaCard() {
        const m = this._media;
        const state = m.device.state ?? {};
        const media = state.media;
        const playing = playingNow(m.device);
        if (media?.title) {
            m.song.text = media.title;
            m.artist.text = media.artist ?? media.album ?? '';
        } else if (state.app) {
            m.song.text = state.app;
            m.artist.text = state.text && state.text !== state.app ? state.text : '';
        } else {
            m.song.text = _('Nothing playing');
            m.artist.text = '';
        }
        m.artist.visible = m.artist.text !== '';
        const paused = media?.state === 'PAUSED' ? _('Paused') : null;
        m.app.text = [state.group, state.app, paused].filter(Boolean).join(' · ') || _('Ready');
        if (playing)
            m.dot.add_style_pseudo_class('checked');
        else
            m.dot.remove_style_pseudo_class('checked');

        const color = mediaColor(m.device);
        const shade = share => color.map(v => Math.round(v * 255 * share));
        m.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(0.5)}); background-gradient-end: rgb(${shade(0.24)});`;

        showCastPlay(m.play, m.device);
        m.next.reactive = castAllows(media, 64);
        m.previous.reactive = castAllows(media, 128);

        const level = state.volume ?? 0;
        m.volume.showLevel(level);
        this._showVolume(level);
        m.scene.show({
            kind: speakerKind(m.device.castModel),
            playing,
            volume: level,
            muted: state.muted,
            color,
        });
        m.scene.run(playing && this._menu.isOpen);
        this._showMediaTime();
    }

    _showVolume(level) {
        const m = this._media;
        const muted = m.device.state?.muted === true;
        m.level.text = `${Math.round(level * 100)} %`;
        m.mute.child.icon_name = volumeIcon(level, muted);
        m.mute.accessible_name = muted ? _('Unmute') : _('Mute');
    }

    _showMediaTime() {
        const m = this._media;
        if (!m || !this._menu.isOpen)
            return;
        const media = m.device.state?.media;
        const duration = media?.duration;
        m.time.visible = typeof duration === 'number' && duration > 0;
        if (!m.time.visible)
            return;
        let position = media.position ?? 0;
        if (media.state === 'PLAYING' && media.at)
            position += (GLib.get_monotonic_time() - media.at) / 1e6;
        position = Math.min(duration, position);
        m.progress.show({share: position / duration});
        m.elapsed.text = clock(position);
        m.length.text = `-${clock(duration - position)}`;
    }

    async _castDo(device, action) {
        try {
            await action();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof CastError) && !(e instanceof GLib.Error)) {
                logError(e);
                return;
            }
            if (this._gone)
                return;
            Main.notifyError(device.name, e.message);
        }
        if (this._media?.device === device)
            this._syncMediaCard();
        else if (!this._card)
            this._tiles.forEach(tile => tile.sync());
    }

    _castChanged(cast, device) {
        if (cast !== this._cast)
            return;
        if (this._media?.device === device)
            this._syncMediaCard();
        else if (!this._card)
            this._tiles.forEach(tile => tile.sync());
    }

    _keepSpeaker(speaker) {
        const speakers = parseSpeakers(readSetting(this._settings, 'cast-speakers'))
            .map(s => (s.id === speaker.id ? {...s, ip: speaker.ip, port: speaker.port} : s));
        this._keepingSpeaker = true;
        try {
            this._settings.set_string('cast-speakers', JSON.stringify(speakers));
        } finally {
            this._keepingSpeaker = false;
        }
    }

    async _openTvCard(device) {
        const source = device.source;
        const again = this._card === device;
        if (!again)
            this._drawer = null;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!device.state)
            this._showLoading(true);
        else if (!again)
            this._fillTvCard(device);
        await source.readDevice(device);
        if (this._card !== device || source !== this._tv)
            return;
        this._fillTvCard(device);
        // Lists come once per round, from some TVs only after ~20 s (Samsung's app lookups).
        if (device.online !== false && device.state?.on && device.state.paired &&
            (source.listed(device, 'sources') === null || source.listed(device, 'apps') === null)) {
            await Promise.all([source.sources(device), source.apps(device)].map(list => list.catch(() => [])));
            if (this._card !== device || source !== this._tv)
                return;
            this._fillTvCard(device);
        }
    }

    _fillTvCard(device) {
        const home = device.source;
        const state = device.state;
        if (!state) {
            this._message(_('The TV is not answering. Is it on the same network?'));
            return;
        }
        const scroll = this._tvCard?.device === device ? this._scroll.vadjustment.value : 0;
        this._clear();
        const act = task => this._tvDo(device, task).catch(logError);
        const online = device.online !== false;
        const on = online && state.on === true;
        const t = {device};
        let status = _('Offline');
        if (online && !state.paired)
            status = _('Not paired');
        else if (online)
            status = on ? _('On') : _('Off');

        t.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-climate nook-stage'});
        const top = new St.BoxLayout({style_class: 'nook-climate-top'});
        const dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        if (on)
            dot.add_style_pseudo_class('checked');
        top.add_child(dot);
        top.add_child(new St.Label({
            style_class: 'nook-climate-status',
            text: status,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        // Unpaired TVs reject every command, power included. Ignore clicks while a power
        // request is in flight, or the key is pressed twice.
        let power = null;
        if (state.paired && online) {
            power = this._addRoundButton(top, 'system-shutdown-symbolic', on ? _('Turn Off') : _('Turn On'), () => {
                if (this._tvBusy.has(device.did))
                    return;
                this._tvBusy.add(device.did);
                act(() => home.power(device, !on)).finally(() => this._tvBusy.delete(device.did));
            });
            power.add_style_class_name('nook-power');
            power.checked = on;
        }
        t.box.add_child(top);

        const showing = on ? tvShowing(device) : null;
        const scene = {
            on,
            volume: typeof state.volume === 'number' ? state.volume / (state.volumeMax || 100) : null,
            muted: state.muted === true,
            label: showing ?? '',
        };
        const middle = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-middle'});
        t.scene = new Scene('tv', 'nook-stage-scene');
        t.scene.setScene('tv', scene);
        middle.add_child(power ? this._powerScene(t.scene, power) : t.scene);
        middle.add_child(new St.Label({
            style_class: 'nook-stage-word',
            text: on ? (showing ?? _('On')) : _('Off'),
            x_align: Clutter.ActorAlign.CENTER,
        }));
        let small = null;
        if (state.muted)
            small = _('Muted');
        else if (state.media)
            small = state.media;
        else if (!state.setsVolume && typeof state.volume === 'number')
            small = _('Volume %s').replace('%s', state.volume);
        if (on && small) {
            const label = new St.Label({
                style_class: 'nook-hero-small',
                text: small,
                x_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            middle.add_child(label);
        }
        t.box.add_child(middle);

        const [, color] = Glyphs.kindOf(null, null, 'tv');
        const tint = on ? color : [0.42, 0.42, 0.46];
        const shade = share => tint.map(v => Math.round(v * 255 * share));
        t.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(0.5)}); background-gradient-end: rgb(${shade(0.24)});`;

        if (!state.paired) {
            const note = new St.Label({
                style_class: 'nook-card-value',
                text: _('Pair it in Settings, under TVs, to control it from here.'),
            });
            note.clutter_text.line_wrap = true;
            t.box.add_child(note);
            const settings = new St.Button({style_class: 'nook-chip', label: _('Settings…'), can_focus: true,
                x_align: Clutter.ActorAlign.START});
            settings.connect('clicked', () => {
                this._closeMenu();
                this._openPreferences(`accounts-tv ${device.did}`);
            });
            t.box.add_child(settings);
        } else if (on) {
            const controls = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-controls'});
            // Without a mute reading the key toggles blind.
            const mute = this._roundButton(
                volumeIcon(typeof state.volume === 'number' ? state.volume / (state.volumeMax || 100) : 1, state.muted === true),
                state.muted ? _('Unmute') : _('Mute'),
                () => act(() => (state.muted === null
                    ? home.press(device, 'mute') : home.setMuted(device, !state.muted))));
            mute.add_style_class_name('nook-step');
            mute.checked = state.muted === true;
            const mutes = state.muted !== null || !state.keys || state.keys.includes('mute');
            if (state.setsVolume) {
                const range = {...TV_VOLUME, range: [0, state.volumeMax || 100, 1]};
                controls.add_child(this._sliderRow(_('Volume'), range, state.volume,
                    level => act(() => home.setVolume(device, level)), false, mutes ? mute : null));
            } else {
                const row = new St.BoxLayout({style_class: 'nook-climate-range'});
                const quieter = this._addRoundButton(row, 'list-remove-symbolic', _('Quieter'),
                    () => act(() => home.press(device, 'volume-down')));
                row.add_child(new St.Label({
                    style_class: 'nook-card-label',
                    text: _('Volume'),
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                const louder = this._addRoundButton(row, 'list-add-symbolic', _('Louder'),
                    () => act(() => home.press(device, 'volume-up')));
                for (const step of [quieter, louder])
                    step.add_style_class_name('nook-step');
                if (mutes)
                    row.add_child(mute);
                controls.add_child(row);
            }

            const tiles = [];
            const inputs = home.listed(device, 'sources') ?? [];
            if (inputs.length > 0) {
                const current = inputs.find(i => i.id === state.source || (i.app && [state.app, state.source].includes(i.app)));
                tiles.push({
                    title: _('Input'),
                    glyph: 'input',
                    value: current?.id ?? null,
                    text: current ? inputTitle(current) : (state.app ? _('Apps') : '–'),
                    choices: inputs.map(i => [i.id, inputTitle(i), null]),
                    pick: id => act(() => home.source(device, id)),
                });
            }
            const all = home.listed(device, 'apps') ?? [];
            const current = all.find(a => a.id === state.app);
            const apps = all.slice(0, 12);
            if (current && !apps.includes(current))
                apps.unshift(current);
            if (apps.length > 0) {
                tiles.push({
                    title: _('Apps'),
                    glyph: 'apps',
                    value: state.app,
                    text: current?.title ?? (state.app ? tvShowing(device) : null) ?? '–',
                    choices: apps.map(a => [a.id, a.title || String(a.id), null]),
                    icon: id => home.appIcon(device, id),
                    pick: id => act(() => home.launch(device, id)),
                });
            }
            tiles.push({
                title: _('Remote'),
                glyph: 'remote',
                text: _('Arrows, OK'),
                fill: drawer => this._fillTvRemote(drawer, device, act),
            });
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-tiles'});
            this._addTileGrid(box, tiles);
            controls.add_child(box);
            t.box.add_child(controls);
        }

        this._body.add_child(t.box);
        this._addDeviceInfo(device);
        this._tvCard = t;
        t.scene.run(Scenes.moves('tv', scene) && this._menu.isOpen);
        this._putScrollBack(scroll);
    }

    _fillTvRemote(drawer, device, act) {
        const home = device.source;
        const pad = new St.BoxLayout({...VERTICAL, style_class: 'nook-tv-remote', x_expand: true});
        const rows = [
            [['edit-undo-symbolic', _('Back'), 'back'], ['go-up-symbolic', _('Up'), 'up'],
                ['go-home-symbolic', _('Home'), 'home']],
            [['go-previous-symbolic', _('Left'), 'left'], ['object-select-symbolic', _('OK'), 'ok'],
                ['go-next-symbolic', _('Right'), 'right']],
            [['open-menu-symbolic', _('Menu'), 'menu'], ['go-down-symbolic', _('Down'), 'down'],
                ['media-playback-start-symbolic', _('Play'), 'play']],
            [['go-bottom-symbolic', _('Channel Down'), 'channel-down'],
                ['media-playback-pause-symbolic', _('Pause'), 'pause'], ['go-top-symbolic', _('Channel Up'), 'channel-up']],
        ];
        const has = device.state?.keys;
        for (const keys of rows) {
            const row = new St.BoxLayout({style_class: 'nook-tv-remote-row', x_align: Clutter.ActorAlign.CENTER});
            for (const [icon, label, key] of keys) {
                const button = this._addRoundButton(row, icon, label, () => act(() => home.press(device, key)));
                // Keep the grid: a missing key leaves its place empty.
                if (has && !has.includes(key)) {
                    button.opacity = 0;
                    button.reactive = false;
                    button.can_focus = false;
                }
            }
            pad.add_child(row);
        }
        drawer.add_child(pad);
    }

    // Errors only: TvHome re-reads the TV afterwards and calls _tvChanged().
    async _tvDo(device, task) {
        try {
            await task();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof TvError) && !(e instanceof GLib.Error))
                throw e;
            if (!this._gone)
                Main.notifyError(device.name, tvTrouble(e));
        }
    }

    _tvChanged(tv, device) {
        if (tv !== this._tv)
            return;
        if (this._card === device && this._tvCard?.device === device)
            this._fillTvCard(device);
        else if (!this._card)
            this._tiles.forEach(tile => tile.sync());
    }

    async _openClimateCard(device) {
        const home = device.source;
        const again = this._card === device;
        const scroll = again ? this._scroll.vadjustment.value : 0;
        if (!again)
            this._drawer = null;
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        if (!again) {
            if (climateView(device))
                this._fillClimateCard(device);
            else
                this._showLoading(true);
        }
        let read;
        try {
            read = await this._readClimate(device);
        } catch (e) {
            if (this._card === device && !again)
                this._message(e instanceof SpecError ? specTrouble(e) : e.message);
            if (!(e instanceof XiaomiError) && !(e instanceof SpecError) && !(e instanceof GLib.Error))
                throw e;
            return;
        }
        if (this._card !== device || !this._sources().includes(home))
            return;
        // A spec unit that is offline, unreadable or lacks the basics gets the plain card.
        if (read && (!device.climate || device.online === false)) {
            this._fillCard(device, read.services, read.values);
            this._putScrollBack(scroll);
            return;
        }
        this._fillClimateCard(device);
    }

    // Native units keep their own state; a spec unit's is made from its services each read.
    async _readClimate(device) {
        const home = device.source;
        if (device.primary.kind === 'climate') {
            await home.readDevice(device);
            return null;
        }
        const services = await home.services(device);
        const readable = services.flatMap(s => s.properties
            .filter(p => p.access.includes('read'))
            .map(p => ({siid: s.siid, piid: p.piid})));
        const values = await home.readProperties(device, readable);
        device.values = device.primary.props.map((p, i) => values.get(`${p.siid}/${p.piid}`) ?? device.values?.[i] ?? null);
        device.extra = {...device.extra};
        for (const extra of home.extras.filter(e => e.did === device.did)) {
            const key = `${extra.siid}/${extra.piid}`;
            if (values.has(key))
                device.extra[key] = values.get(key);
        }
        const view = device.unreadable ? null : specClimate(services, values, device.values?.[0] ?? null);
        if (view)
            Object.assign(view, {services, values});
        Object.defineProperty(device, 'climate', {value: view, writable: true, configurable: true, enumerable: false});
        return {services, values};
    }

    // One write at a time: sources without a queue of their own (the HTTP clouds) could
    // otherwise apply quick changes out of order.
    _climateWrite(device, changes) {
        const run = (this._climateWrites ?? Promise.resolve()).then(() => this._writeClimate(device, changes));
        this._climateWrites = run.catch(() => {});
        return run;
    }

    async _writeClimate(device, changes) {
        if (!climateView(device))
            return;
        try {
            if (device.primary.kind === 'climate') {
                await device.source.set(device, changes);
            } else {
                for (const [siid, piid, value] of device.climate.writes(changes))
                    await device.source.setProperty(device, siid, piid, value);
            }
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof ClimateError) && !(e instanceof XiaomiError) && !(e instanceof SpecError) &&
                !(e instanceof GLib.Error))
                throw e;
            if (this._gone)
                return;
            Main.notifyError(device.name, e instanceof SpecError ? specTrouble(e) : e.message);
        }
        // A write that went through stays done when the read after it fails.
        if (device.primary.kind !== 'climate') {
            await this._readClimate(device).catch(e => {
                if (!(e instanceof XiaomiError) && !(e instanceof SpecError) && !(e instanceof GLib.Error))
                    throw e;
                console.debug(`nook: ${device.name}: ${e.message}`);
            });
        }
        if (this._card === device && climateView(device))
            this._fillClimateCard(device);
    }

    // A spec unit's settings and readings the climate box has no place for, as the plain
    // card shows them.
    _fillClimateExtras() {
        const c = this._climate;
        const view = climateView(c.device);
        if (!c.extras || !view?.services)
            return;
        c.extras.destroy_all_children();
        this._stageTarget = c.extras;
        try {
            this._addSpecTiles(c.device, view.services, view.values, view.keys);
        } finally {
            this._stageTarget = null;
        }
    }

    // Built once, then updated in place so colours transition rather than redraw.
    _fillClimateCard(device) {
        const view = climateView(device);
        if (!device.online || !view) {
            this._message(_('The air conditioner is not answering. Is it plugged in and on the same network?'));
            return;
        }
        const {state, caps} = view;
        const tiles = [
            ['Mod', _('Mode'), 'snowflake', CLIMATE_MODES(caps)],
            ['WdSpd', _('Fan'), 'fan', CLIMATE_FANS(caps)],
            ['SwUpDn', _('Up and down'), 'flow-swing', CLIMATE_AIRFLOWS(caps)],
            ['SwingLfRig', _('Left and right'), 'side-swing', CLIMATE_SIDES(caps)],
            ...CLIMATE_TOGGLES(),
        ].filter(([key, , , choices]) => state[key] !== undefined && (!choices || choices.length > 1))
            .map(([key, title, glyph, choices = null]) => [key, title, glyph,
                choices && !(['SwUpDn', 'SwingLfRig'].includes(key) && swingsOnly(choices)) ? choices : null]);
        const shape = JSON.stringify([caps.range, tiles]);
        if (this._climate?.device === device && this._climate.shape === shape) {
            this._syncClimateCard();
            this._fillClimateExtras();
            return;
        }
        this._clear();
        const write = changes => this._climateWrite(device, changes).catch(logError);
        const c = {device, shape, tiles: new Map(), choosing: null};

        c.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-climate'});

        const top = new St.BoxLayout({style_class: 'nook-climate-top'});
        top.add_child(new Glyph('thermometer'));
        c.room = new St.Label({style_class: 'nook-climate-room', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(c.room);
        c.dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(c.dot);
        c.status = new St.Label({style_class: 'nook-climate-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        top.add_child(c.status);
        c.power = this._addRoundButton(top, 'system-shutdown-symbolic', _('Power'),
            () => write({Pow: climateView(device)?.state.Pow === 1 ? 0 : 1}));
        c.power.add_style_class_name('nook-power');
        c.box.add_child(top);

        c.scene = new Scene('aircon', 'nook-ac-scene');
        c.box.add_child(this._powerScene(c.scene, c.power));

        const middle = new St.BoxLayout({style_class: 'nook-climate-middle', x_align: Clutter.ActorAlign.CENTER});
        c.target = new St.Label({style_class: 'nook-climate-target'});
        middle.add_child(c.target);
        middle.add_child(new St.Label({style_class: 'nook-climate-unit', text: '°C', y_align: Clutter.ActorAlign.START}));
        c.box.add_child(middle);

        const [min, max, step] = caps.range;
        const range = new St.BoxLayout({style_class: 'nook-climate-range'});
        // Quick presses go out as one write once they stop.
        const nudge = delta => {
            const now = climateView(device);
            if (!now)
                return;
            const next = snapTemperature(now.caps, (c.pending ?? now.state.SetTem ?? (min + max) / 2) + delta);
            c.pending = next;
            this._showTarget(next);
            if (c.nudging)
                GLib.source_remove(c.nudging);
            c.flush = () => {
                if (c.nudging)
                    GLib.source_remove(c.nudging);
                c.nudging = 0;
                c.flush = null;
                write({SetTem: next}).finally(() => {
                    if (c.pending === next)
                        c.pending = null;
                });
            };
            c.nudging = GLib.timeout_add(GLib.PRIORITY_DEFAULT, NUDGE_SETTLE, () => {
                c.nudging = 0;
                c.flush?.();
                return GLib.SOURCE_REMOVE;
            });
        };
        c.minus = this._addRoundButton(range, 'list-remove-symbolic', _('Cooler'), () => nudge(-step));
        const track = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        c.slider = new TemperatureSlider(caps.range,
            temperature => this._showTarget(temperature),
            temperature => write({SetTem: temperature}));
        track.add_child(c.slider);
        const ends = new St.BoxLayout({style_class: 'nook-climate-ends'});
        ends.add_child(new St.Label({text: `${numberFormat.format(min)}°`, x_expand: true}));
        ends.add_child(new St.Label({text: `${numberFormat.format(max)}°`}));
        track.add_child(ends);
        range.add_child(track);
        c.plus = this._addRoundButton(range, 'list-add-symbolic', _('Warmer'), () => nudge(step));
        for (const button of [c.minus, c.plus])
            button.add_style_class_name('nook-step');
        c.box.add_child(range);

        let row = null;
        tiles.forEach(([key, title, glyph, choices], i) => {
            if (i % 4 === 0) {
                row = new St.BoxLayout({style_class: 'nook-climate-tiles', x_expand: true});
                row.layout_manager.homogeneous = true;
                c.box.add_child(row);
            }
            const tile = this._climateTile(title, glyph, choices);
            tile.row = row;
            tile.button.connect('clicked', () => {
                if (choices)
                    this._chooseClimate(key);
                else
                    write(climateToggle(climateView(device)?.state ?? {}, key));
            });
            row.add_child(tile.button);
            c.tiles.set(key, tile);
        });
        for (let i = tiles.length % 4; i > 0 && i < 4; i++)
            row.add_child(new St.Widget({x_expand: true}));

        c.chooser = new St.BoxLayout({style_class: 'nook-segments', x_expand: true, visible: false});
        c.chooser.layout_manager.homogeneous = true;
        c.box.add_child(c.chooser);

        this._body.add_child(c.box);
        if (device.primary.kind !== 'climate') {
            c.extras = new St.BoxLayout({...VERTICAL, x_expand: true});
            this._body.add_child(c.extras);
        }
        this._addDeviceInfo(device);
        this._climate = c;
        this._syncClimateCard();
        this._fillClimateExtras();
    }

    _climateTile(title, glyph, choices) {
        const icon = new Glyph(glyph);
        const head = new St.BoxLayout({style_class: 'nook-ac-tile-head'});
        head.add_child(new St.Bin({style_class: 'nook-ac-bubble', child: icon}));
        head.add_child(new St.Widget({x_expand: true}));
        const pin = new St.Icon({
            style_class: 'nook-ac-mark',
            icon_name: 'view-pin-symbolic',
            icon_size: 12,
            visible: false,
            y_align: Clutter.ActorAlign.START,
        });
        head.add_child(pin);
        head.add_child(choices
            ? new St.Icon({style_class: 'nook-ac-mark', icon_name: 'pan-down-symbolic', icon_size: 12})
            : new St.Widget({style_class: 'nook-ac-led', y_align: Clutter.ActorAlign.START}));
        const name = new St.Label({style_class: 'nook-ac-tile-title', text: title});
        const value = new St.Label({style_class: 'nook-ac-tile-value'});
        for (const label of [name, value])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-ac-tile-box', x_expand: true});
        box.add_child(head);
        box.add_child(name);
        box.add_child(value);
        const button = new St.Button({
            style_class: 'nook-ac-tile',
            child: box,
            can_focus: true,
            x_expand: true,
            accessible_name: title,
        });
        return {button, icon, value, choices, pin};
    }

    _chooseClimate(key) {
        const c = this._climate;
        c.choosing = c.choosing === key ? null : key;
        this._syncChoices();
        if (c.choosing) {
            c.box.set_child_above_sibling(c.chooser, c.tiles.get(key).row);
            c.chooser.opacity = 0;
            c.chooser.translation_y = -6;
            c.chooser.ease({
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _syncChoices() {
        const c = this._climate;
        for (const [key, tile] of c.tiles) {
            if (key === c.choosing)
                tile.button.add_style_pseudo_class('open');
            else
                tile.button.remove_style_pseudo_class('open');
        }
        c.chooser.destroy_all_children();
        c.chooser.visible = c.choosing !== null;
        if (!c.choosing)
            return;
        const key = c.choosing;
        const tile = c.tiles.get(key);
        const {state} = climateView(c.device);
        const current = key === 'SwUpDn' ? airflowChoice(state[key]) : state[key];
        for (const [value, label, glyph] of tile.choices) {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-segment-box'});
            box.add_child(new Glyph(glyph));
            const text = new St.Label({text: label, x_align: Clutter.ActorAlign.CENTER});
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(text);
            const segment = new St.Button({
                style_class: 'nook-segment',
                child: box,
                can_focus: true,
                x_expand: true,
                accessible_name: `${tile.button.accessible_name}: ${label}`,
                checked: value === current,
            });
            // Hide only: the segments are rebuilt on the next sync, not inside their own
            // 'clicked' handler.
            segment.connect('clicked', () => {
                c.choosing = null;
                c.chooser.visible = false;
                tile.button.remove_style_pseudo_class('open');
                this._climateWrite(c.device, {[key]: value}).catch(logError);
            });
            c.chooser.add_child(segment);
        }
    }

    // Colour by mode, not a blue-orange blend by target: that went muddy grey mid-range.
    // A target not read yet shows as a dash.
    _showTarget(temperature) {
        const c = this._climate;
        const {state, caps} = climateView(c.device);
        const on = state.Pow === 1;
        const mode = MODES[state.Mod];
        const known = typeof temperature === 'number';
        const {color, air} = climateLook(mode, known ? temperature : 24);
        const shade = share => color.map(v => Math.round(v * 255 * share));
        const [top, bottom] = on ? [shade(0.5), shade(0.24)] : [[66, 66, 72], [48, 48, 54]];
        c.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${top}); background-gradient-end: rgb(${bottom});`;
        c.target.text = known ? numberFormat.format(temperature) : '–';
        c.scene.show({
            on,
            color,
            air,
            target: c.target.text,
            swing: state.SwUpDn ?? 0,
            side: state.SwingLfRig ?? 0,
            speed: climateSpeed(state, caps),
            light: state.Lig !== 0,
        });
        c.minus.reactive = !known || temperature > caps.range[0];
        c.plus.reactive = !known || temperature < caps.range[1];
    }

    _syncClimateCard() {
        const c = this._climate;
        const {state, caps} = climateView(c.device);
        const on = state.Pow === 1;
        c.room.text = typeof state.roomTemperature === 'number'
            ? _('Room %s°').replace('%s', numberFormat.format(state.roomTemperature))
            : _('Room temperature unknown');
        c.status.text = on ? (state.Mod === null ? _('On') : climateStatus(state.Mod)) : _('Off');
        if (on)
            c.dot.add_style_pseudo_class('checked');
        else
            c.dot.remove_style_pseudo_class('checked');
        c.power.checked = on;
        c.power.accessible_name = on ? _('Turn Off') : _('Turn On');
        // A nudge not sent yet keeps its value on screen.
        const target = c.pending ?? state.SetTem;
        const [min, max] = caps.range;
        c.slider.showTemperature(target ?? (min + max) / 2);
        this._showTarget(target);
        for (const [key, tile] of c.tiles) {
            const value = state[key];
            if (key === 'Mod') {
                tile.value.text = value === null ? '–' : modeText(value);
                tile.icon.setName(MODE_GLYPHS[MODES[value]] ?? 'aircon');
            } else if (key === 'WdSpd') {
                const fan = caps.fans.find(f => f.value === value);
                tile.value.text = fan ? fanText(fan, caps)[1] : '–';
                tile.icon.setName(fan?.level >= 1 && fan.level <= 5 ? `speed${fan.level}` : 'fan');
            } else if (key === 'SwUpDn' && tile.choices) {
                const choice = airflowChoice(value);
                if (choice >= 2)
                    tile.value.text = `${choice - 1} / 5`;
                else
                    tile.value.text = choice === 1 ? _('Swing') : _('Off');
                tile.icon.setName(choice === 1 ? 'flow-swing' : `flow${Math.max(0, choice - 1)}`);
            } else if (key === 'SwingLfRig' && tile.choices) {
                if (value >= 2 && value <= 6)
                    tile.value.text = `${value - 1} / 5`;
                else
                    tile.value.text = value === 1 ? _('Swing') : _('Off');
                tile.icon.setName(value === 1 ? 'side-swing' : `side${value >= 2 && value <= 6 ? value - 1 : 0}`);
            } else {
                tile.button.checked = Boolean(value);
                tile.value.text = value === null ? '–' : value ? _('On') : _('Off');
            }
        }
        this._syncChoices();
        c.scene.run(on && this._menu.isOpen);
    }

    _closeCard() {
        this._card = null;
        this._setCardMode(false);
        this._render();
        for (const tile of this._tiles)
            tile.sync();
    }

    async _cardWrite(device, task) {
        try {
            await task();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof XiaomiError) && !(e instanceof SonoffError) && !(e instanceof EwelinkError) &&
                !(e instanceof SpecError) && !(e instanceof GLib.Error))
                throw e;
            if (this._gone)
                return;
            Main.notifyError(device.name, device.source instanceof SonoffHome ? sonoffTrouble(e)
                : e instanceof SpecError ? specTrouble(e) : e.message);
        }
        if (this._card === device)
            await this._openCard(device);
    }

    // Tile: {title, glyph, text, on, value, choices, range: {prop, value, write}, fill,
    // extra, pick}. choices, range and fill open a drawer under the row; others switch.
    _addTileGrid(box, tiles) {
        if (tiles.length === 0)
            return;
        let perRow = tiles.length % 4 !== 0 && tiles.length % 3 === 0 ? 3 : 4;
        perRow = Math.min(perRow, tiles.length);
        const drawer = new St.BoxLayout({...VERTICAL, style_class: 'nook-drawer', x_expand: true, visible: false});
        let open = null;
        const fold = () => {
            open?.button.remove_style_pseudo_class('open');
            open = null;
            this._drawer = null;
            drawer.visible = false;
        };
        // Remembered so a slider's drawer survives the re-read after each write.
        const unfold = (tile, made, row, animate) => {
            open = made;
            this._drawer = tile.choices ? null : tile.title;
            made.button.add_style_pseudo_class('open');
            drawer.destroy_all_children();
            if (tile.fill) {
                tile.fill(drawer);
            } else if (tile.range) {
                const {prop, value, write} = tile.range;
                drawer.add_child(this._sliderRow(tile.title, prop, value, write, true));
            } else {
                const count = tile.choices.length;
                const longest = Math.max(...tile.choices.map(([, label]) => label.length));
                const lines = Math.ceil(count / (longest > 10 ? 3 : longest > 6 ? 4 : 5));
                let line = null;
                let room = 0;
                tile.choices.forEach(([value, label, glyph]) => {
                    if (room === 0) {
                        const index = drawer.get_n_children();
                        room = Math.floor(count / lines) + (index < count % lines ? 1 : 0);
                        line = new St.BoxLayout({style_class: 'nook-segments', x_expand: true});
                        line.layout_manager.homogeneous = true;
                        drawer.add_child(line);
                    }
                    room--;
                    const content = new St.BoxLayout({...VERTICAL, style_class: 'nook-segment-box'});
                    const picture = tile.icon?.(value);
                    if (picture)
                        content.add_child(new St.Icon({gicon: picture, icon_size: 32}));
                    else if (glyph)
                        content.add_child(new Glyph(glyph));
                    const text = new St.Label({text: label, x_align: Clutter.ActorAlign.CENTER});
                    text.clutter_text.line_wrap = true;
                    text.clutter_text.line_alignment = Pango.Alignment.CENTER;
                    content.add_child(text);
                    const segment = new St.Button({
                        style_class: 'nook-segment',
                        child: content,
                        can_focus: true,
                        x_expand: true,
                        accessible_name: `${tile.title}: ${label}`,
                        checked: value === tile.value,
                    });
                    segment.connect('clicked', () => {
                        fold();
                        tile.pick(value);
                    });
                    line.add_child(segment);
                });
            }
            box.set_child_above_sibling(drawer, row);
            drawer.visible = true;
            if (!animate)
                return;
            drawer.opacity = 0;
            drawer.translation_y = -6;
            drawer.ease({
                opacity: 255,
                translation_y: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        let row = null;
        let reopen = null;
        tiles.forEach((tile, i) => {
            if (i % perRow === 0) {
                row = new St.BoxLayout({style_class: 'nook-climate-tiles', x_expand: true});
                row.layout_manager.homogeneous = true;
                box.add_child(row);
            }
            const opens = Boolean(tile.choices || tile.range || tile.fill);
            const made = this._climateTile(tile.title, tile.glyph, opens);
            made.value.text = tile.text ?? '';
            made.button.checked = !opens && tile.on === true;
            if (tile.extra) {
                made.pin.visible = readSetting(this._settings, 'extra-tiles').includes(tile.extra);
                made.button.button_mask = PRIMARY_SECONDARY;
            }
            const own = row;
            made.button.connect('clicked', (_button, clicked) => {
                if (clicked === 3) {
                    this._toggleIn('extra-tiles', tile.extra);
                    made.pin.visible = !made.pin.visible;
                    return;
                }
                if (!opens) {
                    tile.pick(!tile.on);
                    return;
                }
                const again = open === made;
                fold();
                if (!again)
                    unfold(tile, made, own, true);
            });
            row.add_child(made.button);
            if (opens && !tile.choices && tile.title === this._drawer)
                reopen = () => unfold(tile, made, own, false);
        });
        for (let i = tiles.length % perRow; i > 0 && i < perRow; i++)
            row.add_child(new St.Widget({x_expand: true}));
        box.add_child(drawer);
        reopen?.();
    }

    _addFanControls(device, services, values, covered) {
        const home = device.source;
        const find = (names, test = () => true) => {
            for (const name of names) {
                for (const service of services) {
                    const prop = service.properties.find(p => p.name === name && p.access.includes('write') && test(p, service));
                    const key = prop ? `${service.siid}/${prop.piid}` : null;
                    if (prop && values.has(key))
                        return {service, prop, key, value: values.get(key)};
                }
            }
            return null;
        };
        const write = (found, value) => {
            this._cardWrite(device, () => home.setProperty(device, found.service.siid, found.prop.piid, value))
                .catch(logError);
        };
        const tiles = [];
        const toggle = (found, title, glyph) => {
            if (!found || found.prop.format !== 'bool')
                return;
            covered.add(found.key);
            tiles.push({
                title,
                glyph,
                on: found.value === true,
                text: found.value === true ? _('On') : _('Off'),
                pick: on => write(found, on),
            });
        };
        const choose = (found, title, glyph, shape) => {
            if (!found?.prop.choices?.length)
                return;
            covered.add(found.key);
            const choices = found.prop.choices.map(c => [c.value, ...shape(c)]);
            tiles.push({
                title,
                glyph: choices.find(([v]) => v === found.value)?.[2] ?? glyph,
                value: found.value,
                text: choices.find(([v]) => v === found.value)?.[1] ?? '–',
                choices,
                pick: value => write(found, value),
            });
        };

        const power = find(['on'], (p, s) => s.name === 'fan');
        if (power && this._hero?.power)
            covered.add(power.key);
        else
            toggle(power, _('Power'), 'power');
        choose(find(['fan-level', 'speed-level', 'fan-speed']), _('Speed'), 'fan',
            c => [/\d/.test(c.description) ? c.description.replace(/\D+/g, '') : choiceText(c.description), 'fan']);
        choose(find(['mode']), _('Wind'), 'wind', c => {
            const text = c.description;
            let glyph = 'wind';
            if (/natur|nature/i.test(text))
                glyph = 'leaf';
            else if (/sleep/i.test(text))
                glyph = 'moon';
            else if (/auto|smart/i.test(text))
                glyph = 'auto';
            const short = {'straight-wind': _('Straight'), 'natural-wind': _('Natural')}[specKey(text)];
            return [short ?? choiceText(text), glyph];
        });
        toggle(find(['horizontal-swing', 'swing']), _('Swing'), 'swing');
        choose(find(['horizontal-angle', 'swing-angle']), _('Angle'), 'angle',
            c => [`${c.description}°`, `angle${c.value}`]);

        const timer = find(['off-delay-time'], p => NUMBER_FORMATS.includes(p.format) && p.range);
        if (timer) {
            covered.add(timer.key);
            const hours = timer.prop.unit === 'hours';
            const max = timer.prop.range[1];
            const span = minutes => (minutes < 60
                ? _('%s min').replace('%s', minutes)
                : _('%s h').replace('%s', numberFormat.format(Math.round(minutes / 6) / 10)));
            const choices = [[0, _('Off'), 'clock']];
            for (const minutes of [30, 60, 120, 240, 480]) {
                const value = hours ? minutes / 60 : minutes;
                if (Number.isInteger(value) && value <= max)
                    choices.push([value, span(minutes), 'clock']);
            }
            const minutes = hours ? timer.value * 60 : timer.value;
            tiles.push({
                title: _('Timer'),
                glyph: 'clock',
                value: timer.value,
                text: timer.value > 0 ? span(minutes) : _('Off'),
                choices,
                pick: value => write(timer, value),
            });
        }
        toggle(find(['on'], (p, s) => s.name === 'indicator-light'), _('Light'), 'bulb');
        toggle(find(['alarm'], (p, s) => s.name === 'alarm'), _('Sound'), 'bell');
        toggle(find(['physical-controls-locked']), _('Child Lock'), 'lock');

        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-fan'});
        if (tiles.length > 0)
            this._addTileGrid(box, tiles);

        for (const service of services) {
            const motor = service.properties.find(p => p.name === 'motor-control' && p.access.includes('write'));
            const left = motor?.choices?.find(c => /left/i.test(c.description));
            const right = motor?.choices?.find(c => /right/i.test(c.description));
            if (!left || !right)
                continue;
            covered.add(`${service.siid}/${motor.piid}`);
            const row = new St.BoxLayout({style_class: 'nook-fan-turn'});
            row.add_child(new St.Label({
                style_class: 'nook-card-label',
                text: _('Turn the Head'),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            for (const [icon, label, choice] of [
                ['go-previous-symbolic', _('Left'), left],
                ['go-next-symbolic', _('Right'), right],
            ]) {
                const button = this._addRoundButton(row, icon, label, () => {
                    this._cardWrite(device, () => home.setProperty(device, service.siid, motor.piid, choice.value))
                        .catch(logError);
                });
                button.add_style_class_name('nook-step');
            }
            box.add_child(row);
        }

        for (const service of tiles.length > 0 ? services : []) {
            for (const action of service.actions ?? []) {
                if (['toggle', 'toggle-mode', 'loop-gear'].includes(action.name))
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
        }
        if (box.get_n_children() > 0)
            this._stageAdd(box);
        else
            box.destroy();
    }

    _addGatewayControls(device, services, values, covered) {
        const home = this._home;
        const found = (serviceName, name) => {
            const service = services.find(s => s.name === serviceName);
            const prop = service?.properties.find(p => p.name === name);
            const key = prop ? `${service.siid}/${prop.piid}` : null;
            return prop && values.has(key) ? {service, prop, key, value: values.get(key)} : null;
        };
        const tiles = [];
        for (const [serviceName, name, title, glyph] of [
            ['light', 'on', _('Light'), 'bulb'],
            ['gateway', 'guard-mode', _('Guard'), 'shield'],
        ]) {
            const f = found(serviceName, name);
            if (f?.prop.format !== 'bool' || !f.prop.access.includes('write'))
                continue;
            covered.add(f.key);
            tiles.push({
                title,
                glyph,
                on: f.value === true,
                text: f.value === true ? _('On') : _('Off'),
                pick: on => this._cardWrite(device, () => home.setProperty(device, f.service.siid, f.prop.piid, on))
                    .catch(logError),
            });
        }
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-fan'});
        if (tiles.length > 0)
            this._addTileGrid(box, tiles);
        // The siren stays a plain switch: a tile is too easy to hit.
        for (const [name, title] of [['alarm', _('Siren')], ['volume', _('Siren Volume')]]) {
            const f = found('alarm', name);
            if (!f)
                continue;
            covered.add(f.key);
            const row = this._propertyRow(home, device, f.service, f.prop, f.value, title);
            if (row)
                box.add_child(row);
        }
        const lux = found('motion-sensor', 'illumination');
        if (typeof lux?.value === 'number') {
            covered.add(lux.key);
            const stats = statFlow();
            fillStats(stats, [{title: _('Light Around It'), glyph: 'sun', text: formatValue(lux.prop, lux.value)}]);
            box.add_child(stats);
        }
        if (box.get_n_children() > 0)
            this._stageAdd(box);
        else
            box.destroy();
    }

    _addStepper(box, title, current, [min, max], format, stepOf, write) {
        const row = new St.BoxLayout({style_class: 'nook-stepper'});
        row.add_child(new St.Label({
            style_class: 'nook-card-label',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        let wanted = current;
        let written = current;
        let timer = 0;
        const flush = () => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
            if (wanted !== written) {
                written = wanted;
                write(wanted);
            }
        };
        const shown = new St.Label({style_class: 'nook-stepper-value', text: format(current), y_align: Clutter.ActorAlign.CENTER});
        const nudge = direction => {
            wanted = Math.min(max, Math.max(min, wanted + direction * stepOf(wanted, direction)));
            shown.text = format(wanted);
            if (timer)
                GLib.source_remove(timer);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                timer = 0;
                flush();
                return GLib.SOURCE_REMOVE;
            });
        };
        const minus = this._addRoundButton(row, 'list-remove-symbolic', _('Less'), () => nudge(-1));
        row.add_child(shown);
        const plus = this._addRoundButton(row, 'list-add-symbolic', _('More'), () => nudge(1));
        for (const button of [minus, plus])
            button.add_style_class_name('nook-step');
        row.connect('destroy', () => {
            if (timer)
                flush();
        });
        box.add_child(row);
    }

    _addFryerControls(device, services, values, covered) {
        const home = this._home;
        const fryer = services.find(s => s.actions?.some(a => a.name === 'start-cook'));
        if (!fryer)
            return;
        const prop = name => fryer.properties.find(p => p.name === name);
        const keyOf = p => `${fryer.siid}/${p.piid}`;
        const value = name => (prop(name) ? values.get(keyOf(prop(name))) : undefined);
        const action = name => fryer.actions.find(a => a.name === name && a.in.length === 0);
        const write = (p, v) => this._cardWrite(device, () => home.setProperty(device, fryer.siid, p.piid, v))
            .catch(logError);
        for (const name of ['status', 'left-time', 'turn-pot', 'cooking-weight', 'target-cooking-measure', 'texture',
            'current-keep-warm'])
            covered.add(prop(name) ? keyOf(prop(name)) : null);

        const status = choiceOf(prop('status'), value('status')) ?? '';
        const running = /^\s*(cooking|preheat|keep warm|crispy roast|degrease)\s*$/i.test(status);
        const paused = /paused/i.test(status);
        const waiting = /delay/i.test(status);
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-fryer'});

        const left = value('left-time');
        const total = value('target-time');
        if ((running || paused) && typeof left === 'number') {
            const row = new St.BoxLayout({style_class: 'nook-fryer-left'});
            row.add_child(new St.Label({style_class: 'nook-fryer-minutes', text: String(left)}));
            row.add_child(new St.Label({
                style_class: 'nook-fryer-unit',
                text: paused ? _('min left, paused') : _('min left'),
                y_align: Clutter.ActorAlign.END,
            }));
            box.add_child(row);
            if (typeof total === 'number' && total > 0) {
                const bar = new Scene('progress', 'nook-wear-bar');
                const temperature = value('target-temperature');
                bar.show({
                    share: Math.min(1, Math.max(0, 1 - left / total)),
                    color: Scenes.tint('fryer', {cooking: true, temperature}) ?? [0.98, 0.62, 0.24],
                });
                box.add_child(bar);
            }
        }
        // turn-pot stays 'need' after cooking ends; only meaningful while running.
        if ((running || paused) && /need/i.test(choiceOf(prop('turn-pot'), value('turn-pot')) ?? ''))
            box.add_child(new St.Label({style_class: 'nook-fryer-note', text: _('Time to turn the food over.')}));

        const buttons = new St.BoxLayout({style_class: 'nook-vacuum-actions', x_expand: true});
        buttons.layout_manager.homogeneous = true;
        const add = (found, icon, label) => {
            if (!found)
                return;
            const item = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-action'});
            const button = this._addRoundButton(item, icon, label, () => {
                this._cardWrite(device, () => home.runAction(device, fryer.siid, found.aiid)).catch(logError);
            });
            button.x_align = Clutter.ActorAlign.CENTER;
            item.add_child(wordLabel(label));
            buttons.add_child(item);
        };
        if (running)
            add(action('pause'), 'media-playback-pause-symbolic', _('Pause'));
        else if (paused)
            add(action('resume-cook'), 'media-playback-start-symbolic', _('Go On'));
        else if (!waiting)
            add(action('start-cook'), 'media-playback-start-symbolic', _('Start'));
        if (running || paused || waiting)
            add(action('cancel-cooking'), 'media-playback-stop-symbolic', _('Stop'));
        for (const name of ['pause', 'resume-cook', 'start-cook', 'cancel-cooking']) {
            if (action(name))
                covered.add(`${fryer.siid}/a${action(name).aiid}`);
        }
        if (buttons.get_n_children() > 0)
            box.add_child(buttons);

        const tiles = [];
        const mode = prop('mode');
        if (mode?.choices?.length && values.has(keyOf(mode))) {
            covered.add(keyOf(mode));
            const choices = mode.choices.map(c => [c.value, choiceText(c.description), null]);
            tiles.push({
                title: _('Program'),
                glyph: 'pot',
                value: value('mode'),
                text: choices.find(([v]) => v === value('mode'))?.[1] ?? '–',
                choices,
                pick: v => write(mode, v),
            });
        }

        const span = minutes => {
            if (minutes < 60)
                return _('%s min').replace('%s', minutes);
            const [hours, rest] = [Math.floor(minutes / 60), minutes % 60];
            return rest ? _('%s h %s min').replace('%s', hours).replace('%s', rest) : _('%s h').replace('%s', hours);
        };
        const stepped = (name, title, glyph, format, stepOf) => {
            const p = prop(name);
            const current = p ? values.get(keyOf(p)) : undefined;
            if (!p?.range || !p.access.includes('write') || typeof current !== 'number')
                return;
            covered.add(keyOf(p));
            tiles.push({
                title,
                glyph,
                text: format(current),
                fill: drawer => this._addStepper(drawer, title, current, p.range, format, stepOf, v => write(p, v)),
            });
        };
        stepped('target-temperature', pgettext('fryer', 'Heat'), 'thermometer', v => `${v} °C`,
            () => prop('target-temperature').range[2] || 5);
        stepped('target-time', _('Time'), 'timer', span, (v, direction) => {
            const at = direction > 0 ? v : v - 1;
            if (at < 10)
                return 1;
            return at < 60 ? 5 : 10;
        });
        stepped('reservation-left-time', _('Start In'), 'clock', v => (v > 0 ? span(v) : _('Now')), () => 30);

        for (const [name, title, glyph] of [
            ['preheat', _('Preheat'), 'sun'],
            ['auto-keep-warm', _('Keep Warm'), 'pot'],
            ['turn-pot-config', _('Turn Over'), 'swing'],
        ]) {
            const p = prop(name);
            const current = p ? values.get(keyOf(p)) : undefined;
            if (p?.format !== 'bool' || !p.access.includes('write') || typeof current !== 'boolean')
                continue;
            covered.add(keyOf(p));
            tiles.push({title, glyph, on: current, text: current ? _('On') : _('Off'), pick: on => write(p, on)});
        }
        this._addTileGrid(box, tiles);
        this._stageAdd(box);
    }

    // Shown items go into covered: properties as 'siid/piid', actions as 'siid/a<aiid>'.
    _addVacuumControls(device, services, values, covered) {
        const home = this._home;
        const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section nook-vacuum'});
        const keyOf = (service, prop) => `${service.siid}/${prop.piid}`;
        const findProperty = (names, test = () => true) => {
            for (const name of names) {
                for (const service of services) {
                    const prop = service.properties.find(p => p.name === name && test(p));
                    if (prop)
                        return {service, prop, key: keyOf(service, prop)};
                }
            }
            return null;
        };
        const status = findProperty(['status']);
        const mode = vacuumMode(choiceOf(status?.prop, values.get(status?.key)));

        const mapService = services.find(s => s.name === 'map' && s.properties.some(p => p.name === 'object-name'));
        if (mapService) {
            const frame = new St.Widget({
                style_class: 'nook-vacuum-map',
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
            });
            const scene = new Scene('map', 'nook-vacuum-map-scene');
            scene.y_expand = true;
            frame.add_child(scene);
            const waiting = skeletonBlock();
            frame.add_child(waiting);
            const note = new St.Label({
                style_class: 'nook-card-value',
                visible: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            frame.add_child(note);
            box.add_child(frame);
            const request = mapService.actions?.find(a => a.name === 'map-req' && a.in.length === 1);
            this._map = {
                device,
                scene,
                waiting,
                note,
                siid: mapService.siid,
                piid: mapService.properties.find(p => p.name === 'object-name').piid,
                request: request ? {aiid: request.aiid, piid: request.in[0]} : null,
                live: mapService.properties.find(p => p.name === 'map-view')?.piid ?? null,
                working: mode === 'cleaning' || mode === 'returning',
                timer: 0,
            };
            this._loadMap(this._map).catch(logError);
        }

        const runTime = findProperty(['cleaning-time', 'time-duration']);
        const runArea = findProperty(['cleaning-area', 'size']);
        const paused = /paus/i.test(choiceOf(status?.prop, values.get(status?.key)) ?? '');
        if ((mode === 'cleaning' || mode === 'returning' || paused) && (runTime || runArea)) {
            covered.add(runTime?.key);
            covered.add(runArea?.key);
            const flow = statFlow();
            flow.visible = false;
            box.add_child(flow);
            this._fillRun(device, flow, runTime, runArea, values).catch(logError);
        }

        const buttons = new St.BoxLayout({style_class: 'nook-vacuum-actions', x_expand: true});
        buttons.layout_manager.homogeneous = true;
        // Older Dreame robots lack pause-sweeping: for them stop-clean pauses and
        // stop-sweeping stops.
        const pauses = services.some(s => s.actions?.some(a => a.name === 'pause-sweeping'));
        for (const name of ['start-sweep', 'start-clean', 'pause-sweeping', 'stop-sweeping', 'stop-clean']) {
            for (const service of services) {
                const action = (service.actions ?? []).find(a => a.name === name && a.in.length === 0);
                if (action)
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
        }
        for (const [names, icon, label, active] of [
            mode === 'cleaning'
                ? [[pauses ? 'pause-sweeping' : 'stop-clean'], 'media-playback-pause-symbolic', _('Pause'), false]
                : [['start-sweep', 'start-clean'], 'media-playback-start-symbolic', _('Clean'), false],
            [['stop-sweeping', 'stop-clean'], 'media-playback-stop-symbolic', _('Stop'), false],
            [['start-charge'], 'go-home-symbolic', _('Dock'), mode === 'charging' || mode === 'returning'],
            [['identify'], 'find-location-symbolic', _('Find'), false],
        ]) {
            let first = null;
            for (const name of names) {
                for (const service of services) {
                    const action = (service.actions ?? []).find(a => a.name === name && a.in.length === 0);
                    if (!action)
                        continue;
                    first ??= {service, action};
                    covered.add(`${service.siid}/a${action.aiid}`);
                }
            }
            if (!first)
                continue;
            const item = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-action'});
            const button = this._addRoundButton(item, icon, label, () => {
                this._cardWrite(device, () => home.runAction(device, first.service.siid, first.action.aiid))
                    .catch(logError);
            });
            button.x_align = Clutter.ActorAlign.CENTER;
            button.checked = active;
            item.add_child(wordLabel(label));
            buttons.add_child(item);
        }
        if (buttons.get_n_children() > 0)
            box.add_child(buttons);

        const suction = findProperty(['suction-level', 'cleaning-mode', 'mode', 'fan-level'],
            p => p.access.includes('write') && (p.choices?.length ?? 0) > 1);
        if (suction) {
            covered.add(suction.key);
            box.add_child(new St.Label({style_class: 'nook-vacuum-title', text: _('Suction')}));
            const segments = new St.BoxLayout({style_class: 'nook-segments', x_expand: true});
            segments.layout_manager.homogeneous = true;
            const current = values.get(suction.key);
            for (const choice of suction.prop.choices) {
                const label = new St.Label({text: choiceText(choice.description), x_align: Clutter.ActorAlign.CENTER});
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                const segment = new St.Button({style_class: 'nook-segment', child: label, can_focus: true, x_expand: true});
                segment.checked = choice.value === current;
                segment.connect('clicked', () => {
                    this._cardWrite(device, () => home.setProperty(device, suction.service.siid, suction.prop.piid, choice.value))
                        .catch(logError);
                });
                segments.add_child(segment);
            }
            box.add_child(segments);
        }

        const wear = [];
        for (const service of services) {
            const level = service.properties.find(p => p.name.endsWith('life-level'));
            const value = level ? values.get(keyOf(service, level)) : undefined;
            if (typeof value !== 'number')
                continue;
            const left = service.properties.find(p => p.name.endsWith('left-time'));
            const hours = left ? values.get(keyOf(service, left)) : undefined;
            covered.add(keyOf(service, level));
            if (left)
                covered.add(keyOf(service, left));
            wear.push([humanize(service.description || service.name), value, hours]);
        }
        if (wear.length > 0) {
            box.add_child(new St.Label({style_class: 'nook-vacuum-title', text: _('Brushes and Filter')}));
            for (const [name, value, hours] of wear) {
                const row = new St.BoxLayout({style_class: 'nook-wear'});
                const text = new St.BoxLayout({...VERTICAL, x_expand: true});
                const head = new St.BoxLayout();
                head.add_child(new St.Label({text: name, x_expand: true}));
                const parts = [`${value} %`];
                if (typeof hours === 'number')
                    parts.push(_('%s h left').replace('%s', hours));
                head.add_child(new St.Label({style_class: 'nook-card-value', text: parts.join(' · ')}));
                text.add_child(head);
                const bar = new Scene('progress', 'nook-wear-bar');
                let color = [0.36, 0.82, 0.56];
                if (value < 10)
                    color = ALARM;
                else if (value < 30)
                    color = [0.98, 0.66, 0.22];
                bar.show({share: value / 100, color});
                text.add_child(bar);
                row.add_child(text);
                box.add_child(row);
            }
        }

        const total = name => {
            const found = findProperty([name]);
            if (found)
                covered.add(found.key);
            const value = found ? values.get(found.key) : undefined;
            return typeof value === 'number' ? value : null;
        };
        const stats = [
            [total('total-clean-times'), _('cleanings')],
            [total('total-clean-time'), _('hours'), minutes => numberFormat.format(Math.round(minutes / 6) / 10)],
            [total('total-clean-area'), _('m² cleaned')],
        ].filter(([value]) => value !== null);
        if (stats.length > 0) {
            const row = new St.BoxLayout({style_class: 'nook-vacuum-stats', x_expand: true});
            row.layout_manager.homogeneous = true;
            for (const [value, word, shape = v => numberFormat.format(v)] of stats) {
                const stat = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-stat', x_expand: true});
                const number = new St.Label({style_class: 'nook-vacuum-number', text: shape(value), x_align: Clutter.ActorAlign.CENTER});
                number.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
                stat.add_child(number);
                stat.add_child(wordLabel(word));
                row.add_child(stat);
            }
            box.add_child(row);
        }

        const settings = [];
        const quiet = services.find(s => s.name === 'annoy');
        const enable = quiet?.properties.find(p => p.name === 'enable' && p.format === 'bool');
        const quietKey = enable ? keyOf(quiet, enable) : null;
        covered.add(quietKey);
        if (typeof values.get(quietKey) === 'boolean') {
            const row = this._propertyRow(home, device, quiet, enable, values.get(quietKey), _('Do Not Disturb'));
            const hours = ['start-time', 'stop-time'].map(name => {
                const prop = quiet.properties.find(p => p.name === name);
                if (prop)
                    covered.add(keyOf(quiet, prop));
                const value = prop ? values.get(keyOf(quiet, prop)) : undefined;
                return typeof value === 'string' ? value.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1') : '';
            });
            if (hours.every(h => /^\d{1,2}:\d{2}$/.test(h))) {
                row.insert_child_at_index(new St.Label({
                    style_class: 'nook-card-value',
                    text: hours.join(' – '),
                    y_align: Clutter.ActorAlign.CENTER,
                }), 1);
            }
            settings.push(row);
        }
        const audio = services.find(s => s.name === 'audio');
        const volume = audio?.properties.find(p => p.name === 'volume' && p.access.includes('read'));
        const volumeKey = volume ? keyOf(audio, volume) : null;
        covered.add(volumeKey);
        if (typeof values.get(volumeKey) === 'number') {
            const row = this._propertyRow(home, device, audio, volume, values.get(volumeKey), _('Volume'));
            const test = audio.actions?.find(a => a.name === 'play-sound' && a.in.length === 0);
            if (test && row && device.online) {
                const chip = new St.Button({style_class: 'nook-chip', label: _('Play a Sound'), can_focus: true, x_align: Clutter.ActorAlign.START});
                chip.connect('clicked', () => {
                    this._cardWrite(device, () => home.runAction(device, audio.siid, test.aiid)).catch(logError);
                });
                row.add_child(chip);
            }
            if (row)
                settings.push(row);
        }
        if (settings.length > 0) {
            box.add_child(new St.Label({style_class: 'nook-vacuum-title', text: _('Settings')}));
            for (const row of settings)
                box.add_child(row);
        }

        // In the hero already, or internal firmware values meaningless to show.
        for (const name of ['status', 'battery-level', 'charging-state', 'work-mode', 'clean-log-start-time',
            'button-led', 'task-done', 'delete-timer'])
            covered.add(findProperty([name])?.key);
        // Hide the 'remote' service (a joystick, no room for it) and all audio actions:
        // voice packs are set in the app, Find is above, the test sound sits by Volume.
        for (const service of services) {
            const all = service.name === 'remote';
            for (const action of service.actions ?? []) {
                if (all || service === audio)
                    covered.add(`${service.siid}/a${action.aiid}`);
            }
            if (all) {
                for (const prop of service.properties)
                    covered.add(keyOf(service, prop));
            }
        }
        if (box.get_n_children() > 0)
            this._stageAdd(box);
    }

    // Cached map first, refetched when stale. While cleaning, follow map-view history if
    // the robot has it (_followRobot()), else request a whole new map periodically.
    async _loadMap(view) {
        const did = view.device.did;
        const cached = this._maps.get(did);
        if (cached)
            this._showMap(view, cached);
        const fresh = view.working && !view.live ? MAP_FRESH_WORKING * 1000 : MAP_FRESH;
        if (!cached || Date.now() - cached.at > fresh) {
            let file = null, map = null;
            try {
                if (view.working && view.request && !view.live) {
                    await this._home.requestMap(view.device, view.siid, view.request.aiid, view.request.piid);
                    await Timers.sleep(3000);
                }
                file = await this._home.mapFile(view.device, view.siid, view.piid);
                map = file ? decodeMap(file.text) : null;
            } catch (e) {
                if (!(e instanceof XiaomiError) && !(e instanceof MapError) && !(e instanceof GLib.Error))
                    throw e;
                console.debug(`nook: map: ${e.message}`);
            }
            if (this._map !== view)
                return;
            if (map) {
                const same = cached?.since === file.time;
                const entry = {
                    map,
                    at: Date.now(),
                    since: file.time,
                    seen: same ? cached.seen : file.time,
                    trail: same ? cached.trail : [],
                    robot: same ? cached.robot : null,
                };
                this._maps.set(did, entry);
                this._showMap(view, entry);
            } else if (!cached) {
                view.waiting.visible = false;
                view.note.text = _('No map yet: one is drawn as the robot cleans.');
                view.note.visible = true;
            }
        }
        if (view.working && !view.timer) {
            const every = view.live ? MAP_LIVE : MAP_FRESH_WORKING;
            view.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, every, () => {
                if (this._menu.isOpen)
                    (view.live ? this._followRobot(view) : this._loadMap(view)).catch(logError);
                return GLib.SOURCE_CONTINUE;
            });
            if (view.live)
                this._followRobot(view).catch(logError);
        }
    }

    async _followRobot(view) {
        const entry = this._maps.get(view.device.did);
        if (!entry || entry.following)
            return;
        entry.following = true;
        try {
            if (!entry.robot) {
                const last = await this._home.lastTold(view.device, view.siid, view.live);
                let frame = null;
                try {
                    frame = last ? decodeMap(String(last.value)) : null;
                } catch (e) {
                    if (!(e instanceof MapError))
                        throw e;
                }
                if (frame && frame.robot.x !== 32767) {
                    entry.robot = frame.robot;
                    if (this._map?.device === view.device)
                        this._showMap(this._map, entry);
                }
            }
            const frames = await this._home.propHistory(view.device, view.siid, view.live, entry.seen + 1);
            for (const [i, {time, value}] of frames.entries()) {
                // Yield to the main loop every 100 frames so the shell doesn't stall.
                if (i % 100 === 99) {
                    await Timers.sleep(0, GLib.PRIORITY_DEFAULT_IDLE);
                }
                let frame;
                try {
                    frame = decodeMap(String(value));
                } catch (e) {
                    if (!(e instanceof MapError))
                        throw e;
                    continue;
                }
                entry.seen = Math.max(entry.seen, time);
                if (frame.rooms)
                    entry.map = frame;
                if (frame.robot.x !== 32767)
                    entry.robot = frame.robot;
                entry.trail.push(...parsePath(frame.trace, entry.trail.at(-1)));
            }
            if (entry.trail.length > MAP_TRAIL)
                entry.trail.splice(0, entry.trail.length - MAP_TRAIL);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: live map: ${e.message}`);
        } finally {
            entry.following = false;
        }
        if (this._map?.device === view.device)
            this._showMap(this._map, entry);
    }

    _showMap(view, {map, trail = [], robot = null}) {
        view.waiting.visible = false;
        view.note.visible = false;
        view.scene.show({
            map: {...map, robot: robot ?? map.robot, path: trail.length > 1 ? [...map.path, ...trail] : map.path},
            working: view.working,
        });
        view.scene.run(view.working && this._menu.isOpen);
    }

    // Robots that report these only on change: fall back to the cloud's last stored
    // value, if reported since this clean began.
    async _fillRun(device, flow, time, area, values) {
        let gone = false;
        flow.connect('destroy', () => {
            gone = true;
        });
        const since = this._maps.get(device.did)?.since ?? 0;
        const told = async found => {
            if (!found)
                return null;
            if (values.has(found.key))
                return values.get(found.key);
            const last = await this._home.lastTold(device, found.service.siid, found.prop.piid);
            return last && last.time >= since - 120 ? last.value : null;
        };
        let minutes = null, size = null;
        try {
            [minutes, size] = await Promise.all([told(time), told(area)]);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            console.debug(`nook: this clean: ${e.message}`);
        }
        if (gone)
            return;
        const rows = [];
        if (minutes !== null && minutes !== '' && Number.isFinite(Number(minutes)))
            rows.push({key: 'run-time', title: _('Cleaning for'), glyph: 'clock', text: spanText(Number(minutes) * 60)});
        if (size !== null && size !== '' && Number.isFinite(Number(size)))
            rows.push({key: 'run-area', title: _('Cleaned'), glyph: 'vacuum', text: `${numberFormat.format(Number(size))} m²`});
        fillStats(flow, rows);
        flow.visible = rows.length > 0;
    }

    _forgetMap() {
        if (this._map?.timer)
            GLib.source_remove(this._map.timer);
        this._map?.scene.run(false);
        this._map = null;
    }

    _fillCard(device, services, values, eventKeys = []) {
        const home = device.source;
        this._clear();
        this._addHero(device, services, values);
        const h = this._hero;
        // Keys already shown by the kind's own controls or the hero power button.
        const covered = new Set();
        if (h.power) {
            const [prop] = device.primary.props;
            covered.add(`${prop.siid}/${prop.piid}`);
        }
        // Vacuum, fryer and gateway controls call Mi Home itself (maps, histories).
        const mi = home === this._home;
        if (mi && deviceType(device) === 'vacuum' && !device.unreadable)
            this._addVacuumControls(device, services, values, covered);
        else if (deviceType(device) === 'fan' && !device.unreadable)
            this._addFanControls(device, services, values, covered);
        else if (mi && deviceType(device) === 'air-fryer' && !device.unreadable)
            this._addFryerControls(device, services, values, covered);
        else if (mi && deviceType(device) === 'gateway' && !device.unreadable)
            this._addGatewayControls(device, services, values, covered);

        let live = [];
        if (device.live) {
            live = liveRows(device.live);
            for (const [field, names] of Object.entries(SAID_LIVE)) {
                if (device.live[field] === undefined)
                    continue;
                for (const service of services) {
                    for (const prop of service.properties.filter(p => names.includes(p.name)))
                        covered.add(`${service.siid}/${prop.piid}`);
                }
            }
        }
        else if (device.info)
            live = infoRows(device.info);
        live = live.filter(row => !h.said.includes(row.key));
        for (const service of services) {
            for (const prop of service.properties.filter(p => HERO_STATES.includes(p.name)))
                covered.add(`${service.siid}/${prop.piid}`);
        }
        if (isBluetooth(device)) {
            this._heardSection = statFlow();
            this._stageAdd(this._heardSection, true);
            this._syncHeard(device);
        }
        this._addSpecTiles(device, device.unreadable ? [] : services, values, covered, live);

        if (device.online === false)
            freeze(h.controls);
        this._layHero(!h.controlled);
        this._syncControls();
        if (!h.controls.visible && device.online === false && !isBluetooth(device) && !device.unreadable &&
            services.length > 0) {
            const label = new St.Label({style_class: 'nook-message', text: _('Its settings show once it is back online.')});
            label.clutter_text.line_wrap = true;
            this._body.add_child(label);
        }
        const later = {};
        if (historyKeys(device).length > 0) {
            this._body.add_child(new St.Label({style_class: 'nook-room', text: _('Last 24 Hours')}));
            later.charts = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
            later.charts.add_child(skeletonBlock('nook-chart'));
            this._body.add_child(later.charts);
        }
        if (eventKeys.length > 0) {
            this._body.add_child(new St.Label({style_class: 'nook-room', text: _('History')}));
            later.log = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
            later.log.add_child(skeletonLines());
            this._body.add_child(later.log);
        }
        later.token = this._cardToken = {};
        if (later.charts || later.log)
            this._fillHistory(home, device, eventKeys, later).catch(logError);

        const kind = device.did.startsWith('lumi.') ? sensorKind(device.model) : null;
        if (kind)
            this._addAlertsRow(device, kind);

        this._addDeviceInfo(device, new Set([...live.map(row => row.key), ...h.said]));

        if (this._body.get_n_children() === 0)
            this._message(device.online ? _('Online, with nothing more to show.') : _('Offline.'));
    }

    _addDeviceInfo(device, shown = new Set()) {
        const names = readSetting(this._settings, 'names');
        const nameOf = did => names[did] || this._home?.devices.find(d => d.did === did)?.name || did;
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const arrow = new St.Icon({style_class: 'nook-fold-arrow', icon_size: 12, y_align: Clutter.ActorAlign.CENTER});
        const line = new St.BoxLayout({style_class: 'nook-fold-line'});
        line.add_child(new St.Label({text: _('Device Info'), y_align: Clutter.ActorAlign.CENTER}));
        line.add_child(arrow);
        const heading = new St.Button({
            style_class: 'nook-room nook-fold',
            accessible_name: _('Device Info'),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            child: line,
        });
        const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
        const flow = statFlow();
        section.add_child(flow);
        this._body.add_child(heading);
        this._body.add_child(section);
        let rows = [];
        const show = () => {
            const open = this._infoOpen.has(device.did);
            arrow.icon_name = open ? 'pan-down-symbolic' : `pan-${rtl ? 'start' : 'end'}-symbolic`;
            heading.visible = rows.length > 0;
            section.visible = open && rows.length > 0;
        };
        heading.connect('clicked', () => {
            if (this._infoOpen.delete(device.did)) {
                show();
                return;
            }
            this._infoOpen.add(device.did);
            show();
            this._scrollToEnd();
        });
        const fill = () => {
            rows = aboutRows(device, nameOf).filter(row => !shown.has(row.key));
            fillStats(flow, rows);
            show();
        };
        fill();
        return fill;
    }

    _addSpecTiles(device, services, values, covered, lead = []) {
        const home = device.source;
        const type = deviceType(device);
        // BLE devices take commands only from a phone or gateway in range, not the cloud.
        const bluetooth = isBluetooth(device);
        const said = this._hero?.said ?? [];
        const [own] = device.primary.kind === 'switch' ? device.primary.props : [];
        let main = null;
        const tiles = [];
        const stats = [...lead];
        const actions = [];
        for (const service of services.filter(s => !PLUMBING.includes(s.name))) {
            for (const prop of service.properties) {
                const key = `${service.siid}/${prop.piid}`;
                const value = values.get(key);
                if (covered.has(key) || !worthShowing(prop, value, values.has(key)))
                    continue;
                const title = specTitle(service, prop, type);
                const glyph = PROP_GLYPHS[prop.name] ?? SERVICE_GLYPHS[service.name] ?? 'dot';
                const writable = prop.access.includes('write') && !bluetooth;
                const write = v => this._cardWrite(device, () => home.setProperty(device, service.siid, prop.piid, v))
                    .catch(logError);
                const [min, max] = prop.range ?? [];
                if (writable && prop.format === 'bool') {
                    const mine = own?.siid === service.siid && own?.piid === prop.piid;
                    tiles.push({
                        rank: 1,
                        title,
                        glyph,
                        on: value === true,
                        text: value === true ? _('On') : _('Off'),
                        // Extra tiles come only from Mi Home.
                        extra: mine || home !== this._home ? null : `${device.did}/${service.siid}/${prop.piid}/${prop.name}`,
                        pick: write,
                    });
                } else if (writable && prop.choices?.length > 0) {
                    const glyphs = prop.choices.map(c => choiceGlyph(c.description, null));
                    const pictured = glyphs.every(Boolean);
                    const choices = prop.choices.map((c, i) => [c.value, choiceText(c.description), pictured ? glyphs[i] : null]);
                    const current = choices.find(([v]) => v === value);
                    tiles.push({
                        rank: 0,
                        title,
                        glyph: current?.[2] ?? glyph,
                        value,
                        text: current?.[1] ?? '–',
                        choices,
                        pick: write,
                    });
                } else if (writable && NUMBER_FORMATS.includes(prop.format) && max > min) {
                    if (!main && service.name === type && MAIN_RANGES.includes(prop.name))
                        main = {title, prop, value, write};
                    else
                        tiles.push({rank: 2, title, glyph, text: formatValue(prop, value), range: {prop, value, write}});
                } else if (prop.access.includes('read') && !said.includes(prop.name)) {
                    stats.push({title, glyph, text: formatValue(prop, value) || '–'});
                }
            }
            const switched = service.properties.some(p => p.name === 'on' && p.access.includes('write'));
            for (const action of bluetooth ? [] : service.actions ?? []) {
                if (action.in.length === 0 && !RISKY_ACTION.test(action.name) &&
                    !covered.has(`${service.siid}/a${action.aiid}`) && !(action.name === 'toggle' && switched))
                    actions.push({service, action});
            }
        }

        if (main)
            this._stageAdd(this._sliderRow(main.title, main.prop, main.value, main.write, true));
        if (tiles.length > 0) {
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-tiles'});
            this._addTileGrid(box, tiles.sort((a, b) => a.rank - b.rank));
            this._stageAdd(box);
        }
        const perRow = Math.ceil(actions.length / Math.ceil(actions.length / 4));
        let row = null;
        actions.forEach(({service, action}, i) => {
            if (i % perRow === 0) {
                row = new St.BoxLayout({style_class: 'nook-vacuum-actions', x_expand: true});
                row.layout_manager.homogeneous = true;
                this._stageAdd(row);
            }
            const label = humanize(action.name);
            const item = new St.BoxLayout({...VERTICAL, style_class: 'nook-vacuum-action'});
            const button = this._addRoundButton(item, actionIcon(action.name), label, () => {
                this._cardWrite(device, () => home.runAction(device, service.siid, action.aiid)).catch(logError);
            });
            button.x_align = Clutter.ActorAlign.CENTER;
            item.add_child(wordLabel(label));
            row.add_child(item);
        });
        for (let i = actions.length % perRow; i > 0 && i < perRow; i++)
            row.add_child(new St.Widget({x_expand: true}));
        if (stats.length > 0) {
            const box = statFlow();
            fillStats(box, stats);
            this._stageAdd(box, true);
        }
    }

    _addHero(device, services, values) {
        const h = {services, values, said: []};
        h.box = new St.BoxLayout({...VERTICAL, style_class: 'nook-climate nook-stage'});

        const top = new St.BoxLayout({style_class: 'nook-climate-top'});
        h.dot = new St.Widget({style_class: 'nook-climate-dot', y_align: Clutter.ActorAlign.CENTER});
        h.dot.connect('notify::mapped', () => breathe(h.dot, h.listening));
        top.add_child(h.dot);
        h.status = new St.Label({style_class: 'nook-climate-status', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        h.status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        top.add_child(h.status);
        const toggle = () => {
            const on = device.values?.[0] === true;
            this._cardWrite(device, () => device.source.setSwitch(device, !on)).catch(logError);
        };
        if (ownSwitch(device)) {
            h.power = this._addRoundButton(top, 'system-shutdown-symbolic', _('Power'), toggle);
            h.power.add_style_class_name('nook-power');
        }
        h.box.add_child(top);

        h.middle = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-middle'});
        h.scene = new Scene('glyph', 'nook-stage-scene');
        if (h.power) {
            h.middle.add_child(this._powerScene(h.scene, h.power));
        } else if (device.primary.kind === 'switch') {
            // A light that isn't the device's power, as on a gateway: no power button, but
            // the picture draws it, so pressing the picture toggles it.
            h.tap = new SceneButton({child: h.scene, can_focus: false});
            h.tap.connect('clicked', toggle);
            h.middle.add_child(h.tap);
        } else {
            h.middle.add_child(h.scene);
        }
        h.words = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-words'});
        h.wait = skeletonLines(['mid', 'name']);
        h.wait.x_align = Clutter.ActorAlign.CENTER;
        h.words.add_child(h.wait);
        h.big = new St.Label({style_class: 'nook-stage-big', x_align: Clutter.ActorAlign.CENTER});
        h.small = new St.Label({style_class: 'nook-hero-small', x_align: Clutter.ActorAlign.CENTER});
        for (const label of [h.big, h.small]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            h.words.add_child(label);
        }
        h.middle.add_child(h.words);
        h.box.add_child(h.middle);

        h.controls = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-controls'});
        h.box.add_child(h.controls);
        h.facts = new St.BoxLayout({...VERTICAL, style_class: 'nook-stage-facts'});
        this._body.add_child(h.box);
        this._hero = h;
        this._syncHero(device);
    }

    _stageAdd(actor, reading = false) {
        const h = this._hero;
        if (!h) {
            (this._stageTarget ?? this._body).add_child(actor);
        } else if (reading) {
            h.facts.add_child(actor);
        } else {
            h.controlled = true;
            h.controls.add_child(actor);
        }
    }

    _layHero(beside) {
        const h = this._hero;
        if (!h)
            return;
        if (!beside || !(h.big.visible || h.small.visible || h.wait.visible)) {
            h.controls.add_child(h.facts);
            return;
        }
        if (SHELL_MAJOR >= 48)
            h.middle.orientation = Clutter.Orientation.HORIZONTAL;
        else
            h.middle.vertical = false;
        h.box.add_style_class_name('nook-stage-beside');
        h.scene.y_align = Clutter.ActorAlign.CENTER;
        h.words.x_expand = true;
        h.words.y_align = Clutter.ActorAlign.CENTER;
        for (const label of [h.big, h.small, h.wait])
            label.x_align = Clutter.ActorAlign.START;
        h.words.add_child(h.facts);
    }

    _syncHero(device) {
        const h = this._hero;
        if (!h || !device || this._card?.did !== device.did)
            return;
        const hero = heroOf(this._card, h.services, h.values);
        h.said = IN_HERO[hero.scene] ?? [];
        const offline = this._card.online === false && !isBluetooth(this._card);
        h.big.text = hero.big ?? '';
        h.big.visible = Boolean(hero.big);
        h.big.style_class = /^[-−\d]/.test(h.big.text) ? 'nook-stage-big' : 'nook-stage-word';
        h.small.text = hero.small ?? '';
        h.small.visible = Boolean(hero.small);

        let status;
        let listening = false;
        h.wait.visible = false;
        if (isBluetooth(this._card)) {
            const time = beaconOf(this._card)?.time;
            if (time)
                status = _('Heard %s').replace('%s', whenText(time));
            else
                status = this._beacons?.off ? _('Bluetooth is off, so it cannot be heard.') : _('Listening for it nearby…');
            listening = this._awaits(this._card);
        } else {
            status = offline ? _('Offline') : _('Online');
        }
        h.status.text = status;
        if (h.big.text === status)
            h.big.visible = false;
        // Nothing heard yet: the big word is only "Bluetooth", so show bars instead.
        if (listening && h.big.text === stateText(this._card) && !h.small.visible) {
            h.big.visible = false;
            h.wait.visible = true;
        }
        h.dot.remove_style_class_name('nook-listening');
        if (listening)
            h.dot.add_style_class_name('nook-listening');
        if (h.listening !== listening) {
            h.listening = listening;
            breathe(h.dot, listening);
        }
        if (offline || listening || (isBluetooth(this._card) && !beaconOf(this._card)?.time))
            h.dot.remove_style_pseudo_class('checked');
        else
            h.dot.add_style_pseudo_class('checked');
        if (h.power) {
            const on = this._card.values?.[0] === true;
            h.power.checked = on;
            h.power.accessible_name = on ? _('Turn Off') : _('Turn On');
            h.power.reactive = !offline;
        }
        if (h.tap)
            h.tap.reactive = !offline;

        let color = hero.alarm ? ALARM : Scenes.tint(hero.scene, hero.state) ?? hero.color;
        if (offline)
            color = [0.42, 0.42, 0.46];
        const shade = share => color.map(v => Math.round(v * 255 * share));
        h.box.style = 'background-gradient-direction: vertical; ' +
            `background-gradient-start: rgb(${shade(0.5)}); background-gradient-end: rgb(${shade(0.24)});`;

        h.scene.setScene(hero.scene, hero.state);
        h.scene.run(Scenes.moves(hero.scene, hero.state) && this._menu.isOpen);
    }

    _syncControls() {
        const h = this._hero;
        if (!h)
            return;
        h.facts.visible = h.facts.get_children().some(child => child.visible);
        h.controls.visible = h.controls.get_children().some(child => child.visible);
    }

    _syncHeard(device) {
        this._syncHero(device);
        const box = this._heardSection;
        if (!box || !device || this._card?.did !== device.did)
            return;
        const said = this._hero?.said ?? [];
        const stats = beaconRows(beaconOf(device)).filter(row => row.key !== 'heard' && !said.includes(row.key));
        const text = JSON.stringify(stats);
        if (text === this._heardShown)
            return;
        this._heardShown = text;
        fillStats(box, stats);
        box.visible = stats.length > 0;
        this._syncControls();
    }

    _readHistory(home, device, eventKeys) {
        const keys = historyKeys(device).map(([key]) => key);
        return Promise.all([
            keys.length > 0 ? home.readHistory(device, keys, HISTORY_SPAN) : [],
            home.readEventLog(device, eventKeys.map(([key]) => key)),
        ]);
    }

    async _fillHistory(home, device, eventKeys, {charts, log, token}) {
        const keys = historyKeys(device);
        let series, entries;
        try {
            [series, entries] = await this._readHistory(home, device, eventKeys);
        } catch (e) {
            if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
                throw e;
            if (this._card !== device || this._cardToken !== token)
                return;
            for (const section of [charts, log].filter(Boolean)) {
                section.destroy_all_children();
                section.add_child(new St.Label({style_class: 'nook-card-value', text: e.message}));
            }
            return;
        }
        if (this._card !== device || this._cardToken !== token)
            return;

        if (charts) {
            charts.destroy_all_children();
            keys.forEach(([, , name, unit, divisor, color], i) => {
                const points = series[i].map(p => ({time: p.time, value: p.value / divisor}));
                const head = new St.BoxLayout({style_class: 'nook-card-row'});
                head.add_child(new St.Label({style_class: 'nook-card-label', text: name, x_expand: true}));
                const values = points.map(p => p.value);
                const range = values.length > 0
                    ? `${numberFormat.format(Math.min(...values))} – ${numberFormat.format(Math.max(...values))} ${unit}`
                    : _('Nothing kept');
                const value = new St.Label({style_class: 'nook-card-value', text: range});
                head.add_child(value);
                charts.add_child(head);
                if (points.length > 0) {
                    charts.add_child(new Chart(points, color, point => {
                        value.text = point
                            ? `${numberFormat.format(point.value)} ${unit} · ${whenText(point.time)}`
                            : range;
                    }));
                }
            });
        }

        if (log) {
            if (device.lastEvent === undefined && device.primary.props.length === 0) {
                home.noteEvent(device, entries[0] ?? null);
                this._syncHero(device);
            }
            log.destroy_all_children();
            const labels = new Map(eventKeys);
            for (const {key, time} of entries) {
                const row = new St.BoxLayout({style_class: 'nook-card-row'});
                row.add_child(new St.Label({style_class: 'nook-card-label', text: labels.get(key) ?? key, x_expand: true}));
                row.add_child(new St.Label({style_class: 'nook-card-value', text: whenText(time)}));
                log.add_child(row);
            }
            if (entries.length === 0)
                log.add_child(new St.Label({style_class: 'nook-card-value', text: _('Nothing in the last 30 days.')}));
        }
    }

    _addAlertsRow(device, kind) {
        this._body.add_child(new St.Label({style_class: 'nook-room', text: _('Notifications')}));
        const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
        const switchRow = (text, on, flip) => {
            const row = new St.BoxLayout({style_class: 'nook-card-row'});
            const label = new St.Label({
                style_class: 'nook-card-label',
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.line_wrap = true;
            const toggle = new PopupMenu.Switch(on);
            toggle.reactive = false;
            const button = new St.Button({child: toggle, can_focus: true, accessible_name: text});
            button.connect('clicked', () => {
                toggle.state = !toggle.state;
                flip(toggle.state);
            });
            row.add_child(label);
            row.add_child(button);
            section.add_child(row);
        };
        if (ALERT_SCOPE()[kind]) {
            switchRow(ALERT_SCOPE()[kind], alertsOn(this._settings, device.did, kind), on => {
                const alerts = {...readSetting(this._settings, 'alerts'), [device.did]: on};
                this._settings.set_value('alerts', new GLib.Variant('a{sb}', alerts));
            });
        }

        const rule = sensorRules(this._settings)[device.did] ?? {};
        const setRule = (name, value) => {
            const rules = sensorRules(this._settings);
            const changed = {...rules[device.did]};
            if (value === null)
                delete changed[name];
            else
                changed[name] = value;
            if (Object.keys(changed).length > 0)
                rules[device.did] = changed;
            else
                delete rules[device.did];
            this._settings.set_string('sensor-rules', JSON.stringify(rules));
        };
        const limit = (name, title, list, usual, text) => {
            const at = Math.max(0, list.indexOf(rule[name] ?? null));
            this._addStepper(section, title, at, [0, list.length - 1],
                i => (list[i] === null ? _('Off') : text(list[i])),
                (i, direction) => (i === 0 && direction > 0 ? list.indexOf(usual) : 1),
                i => setRule(name, list[i]));
        };
        const span = (from, to, step = 1) => Array.from({length: (to - from) / step + 1}, (_v, i) => from + i * step);
        if (kind === 'door') {
            limit('openFor', _('Left open longer than'), [null, 1, 2, 5, 10, 15, 30, 60], 10,
                m => _('%s min').replace('%s', m));
        }
        if (kind === 'climate') {
            limit('warm', _('Warmer than'), [null, ...span(20, 35)], 28, t => `${t} °C`);
            limit('cold', _('Colder than'), [null, ...span(5, 25)], 16, t => `${t} °C`);
            limit('wet', _('More humid than'), [null, ...span(40, 90, 5)], 70, h => `${h} %`);
            limit('dry', _('Drier than'), [null, ...span(10, 50, 5)], 30, h => `${h} %`);
        }
        switchRow(_('A battery running low'), rule.battery !== false, on => setRule('battery', on ? null : false));
        if (!this._alerts.heard) {
            const note = new St.Label({
                style_class: 'nook-card-value',
                text: _('They come from the gateway once its LAN protocol is on, in the gateway’s settings in Mi Home.'),
            });
            note.clutter_text.line_wrap = true;
            section.add_child(note);
        }
        this._body.add_child(section);
    }

    _propertyRow(home, device, service, prop, value, name = humanize(prop.name)) {
        const writable = prop.access.includes('write') && device.online && !isBluetooth(device);
        const label = new St.Label({
            style_class: 'nook-card-label',
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const write = v => this._cardWrite(device, () => home.setProperty(device, service.siid, prop.piid, v))
            .catch(logError);

        if (writable && prop.format === 'bool') {
            const row = new St.BoxLayout({style_class: 'nook-card-row'});
            // PopupMenu.Switch handles its own clicks and drags, which never reach the
            // button around it; made non-reactive so the button does the toggling.
            const toggle = new PopupMenu.Switch(value === true);
            toggle.reactive = false;
            const button = new St.Button({child: toggle, can_focus: true, accessible_name: label.text});
            button.connect('clicked', () => write(!toggle.state));
            row.add_child(label);

            const primary = device.primary.kind === 'switch' &&
                device.primary.props[0].siid === service.siid && device.primary.props[0].piid === prop.piid;
            if (!primary) {
                const entry = `${device.did}/${service.siid}/${prop.piid}/${prop.name}`;
                const tiled = readSetting(this._settings, 'extra-tiles').includes(entry);
                const pin = new St.Button({
                    style_class: 'nook-more',
                    accessible_name: tiled ? _('Remove Its Tile') : _('Give It a Tile'),
                    can_focus: true,
                    checked: tiled,
                    y_align: Clutter.ActorAlign.CENTER,
                    child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 16}),
                });
                pin.connect('clicked', () => {
                    this._toggleIn('extra-tiles', entry);
                    pin.checked = !pin.checked;
                });
                row.add_child(pin);
            }
            row.add_child(button);
            return row;
        }

        if (writable && prop.choices?.length > 0) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
            const row = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-row'});
            const chips = new St.Widget({layout_manager: new WrapLayout(CHIP_SPACING * scale), x_expand: true});
            for (const choice of prop.choices) {
                const chip = new St.Button({
                    style_class: 'nook-chip',
                    label: choiceText(choice.description),
                    can_focus: true,
                    checked: choice.value === value,
                });
                chip.connect('clicked', () => write(choice.value));
                chips.add_child(chip);
            }
            row.add_child(label);
            row.add_child(chips);
            return row;
        }

        const [min, max] = prop.range ?? [];
        if (writable && NUMBER_FORMATS.includes(prop.format) && max > min)
            return this._sliderRow(name, prop, value, write);

        if (!prop.access.includes('read'))
            return null;
        const row = new St.BoxLayout({style_class: 'nook-card-row'});
        row.add_child(label);
        row.add_child(new St.Label({
            style_class: 'nook-card-value',
            text: value === undefined ? '–' : formatValue(prop, value) || '–',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return row;
    }

    _sliderRow(title, prop, value, write, steps = false, lead = null) {
        const [min, max, step] = prop.range;
        const row = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-row'});
        const top = new St.BoxLayout();
        top.add_child(new St.Label({
            style_class: 'nook-card-label',
            text: title,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const shown = new St.Label({style_class: 'nook-card-value', text: formatValue(prop, value)});
        top.add_child(shown);
        row.add_child(top);
        const slider = new CardSlider(typeof value === 'number' ? (value - min) / (max - min) : 0);
        slider.x_expand = true;
        const pick = () => {
            const raw = min + slider.value * (max - min);
            return Math.min(max, Math.max(min, min + Math.round((raw - min) / (step || 1)) * (step || 1)));
        };
        let timer = 0;
        let dragging = false;
        const settle = () => {
            if (timer)
                GLib.source_remove(timer);
            timer = 0;
        };
        slider.connect('drag-begin', () => {
            dragging = true;
            settle();
        });
        slider.connect('drag-end', () => {
            dragging = false;
            settle();
            write(pick());
        });
        slider.connect('notify::value', () => {
            shown.text = formatValue(prop, pick());
            if (dragging)
                return;
            settle();
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_SETTLE, () => {
                timer = 0;
                write(pick());
                return GLib.SOURCE_REMOVE;
            });
        });
        slider.connect('destroy', () => {
            if (timer) {
                settle();
                write(pick());
            }
        });
        if (!steps && !lead) {
            row.add_child(slider);
            return row;
        }
        if (!steps) {
            const line = new St.BoxLayout({style_class: 'nook-climate-range'});
            line.add_child(lead);
            line.add_child(slider);
            row.add_child(line);
            return row;
        }
        const unit = step || 1;
        const nudge = Math.max(unit, Math.round((max - min) / 20 / unit) * unit);
        const line = new St.BoxLayout({style_class: 'nook-climate-range'});
        const less = this._addRoundButton(line, 'list-remove-symbolic', _('Less'), () => {
            slider.value = Math.max(0, (pick() - nudge - min) / (max - min));
        });
        line.add_child(slider);
        const more = this._addRoundButton(line, 'list-add-symbolic', _('More'), () => {
            slider.value = Math.min(1, (pick() + nudge - min) / (max - min));
        });
        for (const button of [less, more])
            button.add_style_class_name('nook-step');
        row.add_child(line);
        return row;
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

    _render() {
        if (!this._sources().some(Boolean))
            return;
        // Pin/hide from an open card writes settings; only its header needs updating.
        if (this._card) {
            this._syncCardHeader();
            return;
        }
        this._clear();

        const view = readSetting(this._settings, 'view');
        this._quietHeader(view === 'control');
        this._title.text = this._home?.homeName ?? _('Nook');

        const choices = this._choices();
        const devices = arrange(this._devices(), choices);
        const pinned = devices.filter(d => choices.pinned.includes(d.did));
        if (devices.length === 0) {
            const miOnly = this._home && !this._sources().some(source => source && source !== this._home);
            this._message(miOnly ? _('No devices in this Mi Home account.')
                : _('No devices to show. Add them, or show hidden ones, in Settings.'));
            if (this._loginNote)
                this._addLoginNote();
            return;
        }
        this._drawnOffline = this._offlineKey();

        const rooms = groupRooms(view === 'rooms' ? devices.filter(d => !pinned.includes(d)) : devices);
        if (view === 'rooms' && pinned.length > 0)
            rooms.unshift({key: PINNED, name: _('Pinned'), devices: pinned});

        if (view === 'control') {
            this._addModules(devices);
        } else if (view === 'grid') {
            this._addSections(devices, pinned, 3, 'square');
        } else if (view === 'rooms') {
            for (const room of rooms) {
                this._body.add_child(new St.Label({
                    style_class: 'nook-room',
                    text: room.name ?? _('Other'),
                }));
                this._addTiles(room.devices, 2, 'compact');
            }
        } else {
            if (pinned.length > 0)
                rooms.unshift({key: PINNED, name: _('Pinned'), devices: pinned});
            const hiddenRooms = readSetting(this._settings, 'hidden-rooms');
            const shown = rooms.filter(r => !hiddenRooms.includes(r.key));
            let current = readSetting(this._settings, 'room');
            if (!shown.some(r => r.key === current))
                current = '';
            if (rooms.length > 1 && shown.length > 0) {
                this._chips.visible = true;
                const tabs = [['', _('All')], ...shown.map(r => [r.key, r.name ?? _('Other')])];
                for (const [key, label] of tabs)
                    this._addChip(key, label, current);
            }
            if (current)
                this._addTiles(rooms.find(r => r.key === current).devices, 2, 'wide');
            else
                this._addSections(devices, pinned, 2, 'wide');
        }
        if (this._loginNote)
            this._addLoginNote();
    }

    _addSections(devices, pinned, columns, shape) {
        const sections = [
            [_('Pinned'), []],
            [_('Controls'), []],
            [_('Speakers'), []],
            [_('TVs'), []],
            [_('Cameras'), []],
            [_('Sensors'), []],
            [_('Offline'), []],
        ];
        for (const device of devices) {
            let index;
            if (pinned.includes(device))
                index = 0;
            else if (device.online === false && !isBluetooth(device))
                index = 6;
            else if (['switch', 'climate'].includes(device.primary.kind))
                index = 1;
            else if (device.primary.kind === 'media')
                index = 2;
            else if (device.primary.kind === 'tv')
                index = 3;
            else if (device.primary.kind === 'camera')
                index = 4;
            else
                index = 5;
            sections[index][1].push(device);
        }
        for (const [title, members] of sections) {
            if (members.length === 0)
                continue;
            this._body.add_child(new St.Label({style_class: 'nook-room', text: title}));
            this._addTiles(members, columns, shape);
        }
    }

    _addChip(key, label, current) {
        const text = new St.Label({text: label});
        text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        const chip = new St.Button({
            style_class: 'nook-chip',
            child: text,
            can_focus: true,
            checked: key === current,
        });
        chip.connect('clicked', () => this._settings.set_string('room', key));
        this._chips.add_child(chip);
    }

    _addTiles(devices, columns, shape) {
        const extras = this._home?.extras ?? [];
        const items = devices.flatMap(device => [
            [device, null],
            ...extras.filter(e => e.did === device.did).map(e => [device, e]),
        ]);

        let row = null;
        items.forEach(([device, extra], i) => {
            if (i % columns === 0) {
                row = new St.BoxLayout({style_class: 'nook-row', x_expand: true});
                row.layout_manager.homogeneous = true;
                this._body.add_child(row);
            }
            row.add_child(this._newTile(device, shape, extra));
        });
        // Pad the last row, or its tiles stretch across it.
        for (let i = items.length % columns; i > 0 && i < columns; i++)
            row.add_child(new St.Widget({x_expand: true}));
    }

    _newTile(device, shape, extra = null, {drop = null, label = null, synced = null} = {}) {
        const tile = new Tile(this._home, device, {
            shape,
            typeColors: readSetting(this._settings, 'type-colors'),
            name: this._nameOf(device),
            label,
            icon: readSetting(this._settings, 'icons')[device.did] ?? '',
            extra,
            openCard: d => this._openCard(d).catch(logError),
            awaits: d => this._awaits(d),
            drop,
            synced,
        });
        this._tiles.push(tile);
        return tile;
    }

    // Control Center style: the user's groups, then a module per section, two tiles a line.
    _addModules(devices) {
        const extras = this._home?.extras ?? [];
        const named = readSetting(this._settings, 'groups');
        const icons = readSetting(this._settings, 'icons');
        const names = readSetting(this._settings, 'names');
        const groups = new Map();
        const sections = new Map(SECTIONS.map(([id]) => [id, []]));
        for (const device of devices) {
            const items = [[device, null], ...extras.filter(e => e.did === device.did).map(e => [device, e])];
            const name = named[device.did];
            if (name !== undefined) {
                if (!groups.has(name))
                    groups.set(name, []);
                groups.get(name).push(...items);
                continue;
            }
            for (const item of items)
                sections.get(tileSection(...item, icons)).push(item);
        }

        const speakers = [];
        const gone = ([device]) => device.online === false && !isBluetooth(device);
        const module = (items, synced = null) => {
            const labels = roomLabels(items, names);
            const grid = new St.Widget({layout_manager: new ColumnsLayout(2, 2), x_expand: true});
            // Offline last; the sort is stable.
            const tiles = [...items].sort((a, b) => gone(a) - gone(b)).map(([device, extra]) => {
                const tile = this._newTile(device, 'row', extra, {
                    drop: this._drop,
                    label: extra ? null : labels.get(device.did) ?? null,
                    synced,
                });
                if (device.primary.kind === 'media' && !extra)
                    speakers.push(tile);
                grid.add_child(tile);
                return tile;
            });
            const box = new St.BoxLayout({...VERTICAL, style_class: 'nook-cc-module', x_expand: true});
            box.add_child(grid);
            return [box, tiles];
        };

        for (const [name, items] of groups) {
            const [box] = module(items);
            box.insert_child_at_index(this._groupTitle(name, box), 0);
            const members = items.filter(([, extra]) => !extra).map(([device]) => device.did);
            box._delegate = this._drop.group(name, members, box);
            this._body.add_child(box);
        }
        const boxes = new Map();
        for (const [id] of SECTIONS) {
            if (sections.get(id).length === 0)
                continue;
            const summary = new St.Label({style_class: 'nook-cc-summary', y_align: Clutter.ActorAlign.CENTER});
            const tiles = [];
            const sum = () => {
                summary.text = sectionSummary(id, tiles);
            };
            const [box, made] = module(sections.get(id), sum);
            tiles.push(...made);
            sum();
            const head = new St.BoxLayout({style_class: 'nook-cc-head', x_expand: true});
            head.add_child(new St.Label({
                style_class: 'nook-cc-section',
                text: sectionTitle(id),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            head.add_child(summary);
            box.insert_child_at_index(head, 0);
            boxes.set(id, box);
        }
        let playing = null;
        if (speakers.length > 0) {
            playing = new NowPlaying(speakers.map(tile => tile.device), speakers, {
                nameOf: device => this._nameOf(device),
                openCard: device => this._openCard(device).catch(logError),
                act: (device, action) => this._castDo(device, () => action(device.source)),
            });
            this._tiles.push(playing);
        }
        for (const [id] of SECTIONS) {
            // The player keeps the media section's place, with or without it.
            if (id === 'media' && playing)
                this._body.add_child(playing);
            if (boxes.has(id))
                this._body.add_child(boxes.get(id));
        }
    }

    _groupTitle(name, box) {
        const title = new St.Button({
            style_class: 'nook-cc-group-title',
            label: name,
            accessible_name: _('Rename Group'),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        title.connect('clicked', () => {
            const entry = new St.Entry({style_class: 'nook-cc-group-entry', text: name, can_focus: true, x_expand: true});
            let done = false;
            const commit = () => {
                if (done)
                    return;
                done = true;
                const text = entry.text.trim();
                // Not destroyed with the key focus: the input method would keep it.
                const focused = entry.clutter_text.has_key_focus();
                if (text && text !== name) {
                    if (focused)
                        this._menu.actor.grab_key_focus();
                    this._drop.rename(name, text);
                } else if (entry.get_parent() === box) {
                    box.replace_child(entry, title);
                    if (focused)
                        title.grab_key_focus();
                    entry.destroy();
                }
            };
            entry.connect('destroy', () => {
                done = true;
            });
            entry.clutter_text.connect('activate', commit);
            entry.clutter_text.connect('key-focus-out', commit);
            box.replace_child(title, entry);
            entry.grab_key_focus();
            entry.clutter_text.set_selection(0, -1);
        });
        return title;
    }

    _nameOf(device) {
        return readSetting(this._settings, 'names')[device.did] || shortName(device.name);
    }

    _syncExtras() {
        if (this._home)
            this._home.extras = readSetting(this._settings, 'extra-tiles').map(parseExtra).filter(Boolean);
    }

    // Per-source sync: an offline camera's connect timeout must not delay the rest.
    async _read() {
        if (this._tiles.length === 0)
            return;
        for (const source of [this._aircon, this._tapo, this._cast, this._tv, this._sonoff, this._ewelink, this._hue, this._hass,
            this._homekit, this._smartlife, ...this._clouds].filter(Boolean))
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

    // Home Assistant pushes every change; a power sensor can report each second.
    _hassChanged(hass) {
        if (this._hassSync || this._hass !== hass)
            return;
        this._hassSync = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._hassSync = 0;
            this._syncTiles(hass);
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncTiles(source) {
        if (this._card || !this._sources().includes(source))
            return;
        for (const tile of this._tiles)
            tile.sync();
        this._syncReadings();
    }

    // Scan only while the menu is open: scanning keeps the radio busy.
    _startBeacons() {
        if (this._beacons || !this._home?.devices.some(isBluetooth))
            return;
        const byAddress = address => this._home?.devices.find(d => isBluetooth(d) && d.mac?.toUpperCase() === address);
        const scan = this._beacons = new BeaconScan((address, beacon) => {
            const device = byAddress(address);
            if (!device)
                return;
            const before = stateText(device);
            const waited = this._awaits(device);
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
                    scan.keys.set(address, key);
            }).catch(e => console.debug(`nook: beacon key: ${e.message}`));
        };
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
        if (!isBluetooth(device) || device.online === true || !this._beacons || this._beacons.off)
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
        const keysOf = device => (device.primary.props.length === 0
            ? (EVENT_KEYS()[deviceType(device)] ?? []).map(([key]) => key) : []);
        try {
            if (!await home.readLastEvents(home.devices, keysOf))
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
});

const NookToggle = GObject.registerClass(
class NookToggle extends QuickSettings.QuickMenuToggle {
    _init(path) {
        super._init({
            title: _('Nook'),
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${path}/icons/nook-symbolic.svg`)),
            toggleMode: false,
        });
        this.connect('clicked', () => this.menu.open());
    }
});

const NookIndicator = GObject.registerClass(
class NookIndicator extends QuickSettings.SystemIndicator {
    _init(button, path) {
        super._init();
        this.add_child(button.takeMark());
        this.visible = true;
        const toggle = new NookToggle(path);
        const quickSettings = Main.panel.statusArea.quickSettings;
        button.hostIn(toggle.menu, quickSettings.menu);
        this.quickSettingsItems.push(toggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }
});

export default class NookExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._alerts = new Alerts(this._settings, this.path);
        this._alerts.start();

        // prefs.js writes this on login/logout; the keyring has no usable change signal.
        this._settings.connectObject(
            'changed::xiaomi-user-id', () => this._button?.reload().catch(logError),
            'changed::ewelink-region', () => this._button?.reload().catch(logError),
            'changed::hass-server', () => this._button?.reload().catch(logError),
            'changed::smartlife-user', () => this._button?.reload().catch(logError),
            this);
        this._placing = 0;
        const placeInPanel = () => {
            if (readSetting(this._settings, 'location') === 'panel')
                this._placeSoon();
        };
        this._settings.connectObject(
            'changed::location', () => this._placeSoon(),
            'changed::panel-box', placeInPanel,
            'changed::panel-index', placeInPanel,
            this);
        Main.sessionMode.connectObject('updated', () => this._syncButton(), this);
        this._syncButton();
    }

    // A move means rebuilding the button (addToStatusArea() takes a role once), which
    // re-reads every device; debounced so stepping the position rebuilds once.
    _placeSoon() {
        if (this._placing)
            GLib.source_remove(this._placing);
        this._placing = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._placing = 0;
            this._dropButton();
            this._syncButton();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncButton() {
        if (Main.sessionMode.isLocked) {
            this._dropButton();
            return;
        }
        if (this._button)
            return;
        // Rejects while the prefs window is already open; not worth surfacing.
        const openPreferences = (target = '') => {
            this._settings.set_string('prefs-target', target);
            Main.extensionManager.openExtensionPrefs(this.uuid, '', {})
                ?.catch?.(e => console.debug(`nook: preferences: ${e.message}`));
        };
        this._button = new NookButton(this._settings, openPreferences, this.path, this._alerts);
        if (readSetting(this._settings, 'location') === 'quick-settings') {
            this._indicator = new NookIndicator(this._button, this.path);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        } else {
            Main.panel.addToStatusArea(this.uuid, this._button,
                readSetting(this._settings, 'panel-index'),
                readSetting(this._settings, 'panel-box'));
        }
        this._button.reload().catch(logError);
    }

    _dropButton() {
        this._button?.stop();
        this._button?.destroy();
        this._button = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // Stays enabled in unlock-dialog only for gateway leak/smoke alerts while locked;
    // the menu, and with it every cloud call, is dropped on lock and rebuilt on unlock.
    disable() {
        if (this._placing)
            GLib.source_remove(this._placing);
        this._placing = 0;
        Main.sessionMode.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._dropButton();
        this._alerts?.stop();
        this._alerts = null;
        this._settings = null;
        beacons.clear();
        units = null;
        choiceWords = null;
        fanWords = null;
        nameWords = null;
        clearPacing();
        Tapo.clearRefusals();
        Timers.removeAll();
    }
}
