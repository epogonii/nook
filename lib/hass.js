// SPDX-License-Identifier: GPL-2.0-or-later

// Home Assistant over its WebSocket API, with a long-lived access token from the user's
// profile. The device list is built in the preferences from the registries; the shell
// subscribes to the states of those entities only.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {SpecError} from './spec-home.js';

Gio._promisify(Soup.Session.prototype, 'websocket_connect_async', 'websocket_connect_finish');

const decoder = new TextDecoder();

export const SECRET = 'homeassistant';

const ANSWER_TIMEOUT = 20000;

// http://host:8123 from what was typed; null when it is no address.
export function serverUrl(text) {
    let url = String(text ?? '').trim();
    if (!url)
        return null;
    if (!/^https?:\/\//i.test(url))
        url = `http://${url}`;
    let uri;
    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch {
        return null;
    }
    if (!uri.get_host())
        return null;
    const path = uri.get_path().replace(/\/+$/, '').replace(/\/api(\/websocket)?$/, '');
    return GLib.Uri.join(GLib.UriFlags.NONE, uri.get_scheme().toLowerCase(), null, uri.get_host(), uri.get_port(), path, null, null);
}

export function parseDevices(json) {
    try {
        const devices = JSON.parse(json || '[]');
        return Array.isArray(devices)
            ? devices.filter(d => /^[a-z_]+\.\w+$/.test(d?.id ?? '') && Array.isArray(d.entities) && d.entities.length > 0)
            : [];
    } catch {
        return [];
    }
}

export class HassClient {
    constructor(url, token) {
        this._url = url;
        this._token = token;
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._connection = null;
        this._next = 1;
        this._pending = new Map();
        this._listeners = new Map();
        this._authorized = null;
        this.closed = false;
        this.onClose = null;
    }

    async connect() {
        const message = Soup.Message.new('GET', `${this._url.replace(/^http/i, 'ws')}/api/websocket`);
        if (!message)
            throw new SpecError('Not an address Home Assistant could have', 'address');
        let connection;
        try {
            connection = await this._session.websocket_connect_async(message, null, null, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (e.domain === Gio.tls_error_quark() || message.get_tls_peer_certificate_errors?.())
                throw new SpecError('The certificate of this Home Assistant is not trusted. Use its http:// address on this network, or give it a trusted certificate.', 'tls');
            if (message.get_status() === 404)
                throw new SpecError('Home Assistant was not found at this address', 'notfound');
            throw e;
        }
        this._connection = connection;
        connection.max_incoming_payload_size = 64 << 20;
        connection.keepalive_interval = 30;
        const authorized = new Promise((resolve, reject) => {
            this._authorized = {resolve, reject};
        });
        connection.connect('message', (_connection, type, bytes) => {
            if (type === Soup.WebsocketDataType.TEXT)
                this._receive(bytes);
        });
        connection.connect('closed', () => this._end(new SpecError('Home Assistant closed the connection', 'closed')));
        connection.connect('error', (_connection, error) => this._end(new SpecError(error.message, 'closed')));
        let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANSWER_TIMEOUT, () => {
            timer = 0;
            this._end(new SpecError('Home Assistant did not answer', 'timeout'));
            return GLib.SOURCE_REMOVE;
        });
        try {
            await authorized;
        } finally {
            if (timer)
                GLib.source_remove(timer);
        }
    }

    _receive(bytes) {
        let message;
        try {
            message = JSON.parse(decoder.decode(bytes.toArray()));
        } catch {
            return;
        }
        for (const each of Array.isArray(message) ? message : [message])
            this._handle(each);
    }

    _handle(message) {
        switch (message?.type) {
        case 'auth_required':
            this._connection.send_text(JSON.stringify({type: 'auth', access_token: this._token}));
            return;
        case 'auth_ok':
            this._authorized?.resolve();
            this._authorized = null;
            return;
        case 'auth_invalid':
            this._end(new SpecError('Home Assistant refused the access token', 'unauthorized'));
            return;
        case 'event':
            this._listeners.get(message.id)?.(message.event);
            return;
        case 'result':
        case 'pong': {
            const waiter = this._pending.get(message.id);
            if (!waiter)
                return;
            this._pending.delete(message.id);
            GLib.source_remove(waiter.timer);
            if (message.type === 'pong' || message.success)
                waiter.resolve(message.result ?? null);
            else
                waiter.reject(new SpecError(message.error?.message || 'Home Assistant refused it', message.error?.code ?? ''));
        }
        }
    }

    _end(error) {
        if (this.closed)
            return;
        this.closed = true;
        this._authorized?.reject(error);
        this._authorized = null;
        for (const waiter of this._pending.values()) {
            GLib.source_remove(waiter.timer);
            waiter.reject(error);
        }
        this._pending.clear();
        this._listeners.clear();
        if (this._connection?.get_state() === Soup.WebsocketState.OPEN)
            this._connection.close(Soup.WebsocketCloseCode.NORMAL, null);
        this.onClose?.(error);
    }

    close() {
        this._cancellable.cancel();
        this._end(new SpecError('Closed', 'closed'));
    }

    call(type, fields = {}) {
        if (this.closed || !this._connection)
            return Promise.reject(new SpecError('Not connected to Home Assistant', 'closed'));
        const id = this._next++;
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANSWER_TIMEOUT, () => {
                this._pending.delete(id);
                reject(new SpecError('Home Assistant did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {resolve, reject, timer});
            this._connection.send_text(JSON.stringify({...fields, id, type}));
        });
    }

    // Resolves with the first event, which carries the current states.
    subscribeEntities(ids, onEvent) {
        if (this.closed || !this._connection)
            return Promise.reject(new SpecError('Not connected to Home Assistant', 'closed'));
        const id = this._next;
        return new Promise((resolve, reject) => {
            let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANSWER_TIMEOUT, () => {
                timer = 0;
                this._listeners.delete(id);
                reject(new SpecError('Home Assistant did not answer', 'timeout'));
                return GLib.SOURCE_REMOVE;
            });
            this._listeners.set(id, event => {
                onEvent(event);
                if (timer) {
                    GLib.source_remove(timer);
                    timer = 0;
                    resolve();
                }
            });
            this.call('subscribe_entities', {entity_ids: ids}).catch(e => {
                if (timer)
                    GLib.source_remove(timer);
                timer = 0;
                this._listeners.delete(id);
                reject(e);
            });
        });
    }

    callService(domain, service, entityId, data = {}) {
        return this.call('call_service', {domain, service, service_data: data, target: {entity_id: entityId}});
    }
}

const CONTROLS = ['light', 'switch', 'input_boolean', 'fan', 'cover', 'climate', 'humidifier', 'lock', 'vacuum', 'media_player'];

// Readings a sensor's device class stands for, as MIoT property names.
export const SENSOR_CLASSES = {
    'temperature': 'temperature',
    'humidity': 'relative-humidity',
    'illuminance': 'illumination',
    'power': 'electric-power',
    'energy': 'power-consumption',
    'voltage': 'voltage',
    'current': 'electric-current',
    'battery': 'battery-level',
    'carbon_dioxide': 'co2-density',
    'pm25': 'pm2.5-density',
    'pm10': 'pm10-density',
    'atmospheric_pressure': 'atmospheric-pressure',
    'pressure': 'atmospheric-pressure',
    'moisture': 'soil-moisture',
};

export const BINARY_CLASSES = {
    motion: 'motion-state',
    occupancy: 'motion-state',
    presence: 'motion-state',
    door: 'contact-state',
    window: 'contact-state',
    opening: 'contact-state',
    garage_door: 'contact-state',
    moisture: 'submersion-state',
    smoke: 'smoke-status',
    gas: 'gas-status',
    carbon_monoxide: 'gas-status',
};

// Which reading names a group of sensors: the first found in this order.
const SENSOR_TYPES = [
    ['motion-state', 'motion-sensor'],
    ['contact-state', 'magnet-sensor'],
    ['submersion-state', 'submersion-sensor'],
    ['smoke-status', 'smoke-sensor'],
    ['gas-status', 'smoke-sensor'],
    ['temperature', 'temperature-humidity-sensor'],
    ['relative-humidity', 'temperature-humidity-sensor'],
];

// Attributes the card's layout is built from, kept so tiles have it before a read.
const KEPT = ['supported_color_modes', 'min_color_temp_kelvin', 'max_color_temp_kelvin', 'supported_features', 'hvac_modes',
    'fan_modes', 'preset_modes', 'min_temp', 'max_temp', 'target_temp_step', 'min_humidity', 'max_humidity',
    'available_modes', 'percentage_step', 'device_class', 'unit_of_measurement'];

export const readingOf = entity => (entity.domain === 'sensor' ? SENSOR_CLASSES : BINARY_CLASSES)[entity.attributes.device_class] ?? null;

function controlType(domain, attributes) {
    switch (domain) {
    case 'light':
        return 'light';
    case 'switch':
    case 'input_boolean':
        return attributes.device_class === 'outlet' ? 'outlet' : 'switch';
    case 'fan':
        return 'fan';
    case 'cover':
        return 'curtain';
    case 'climate':
        return attributes.hvac_modes?.includes('cool') ? 'air-conditioner' : 'thermostat';
    case 'humidifier':
        return attributes.device_class === 'dehumidifier' ? 'dehumidifier' : 'humidifier';
    case 'media_player':
        return attributes.device_class === 'tv' ? 'television' : 'speaker';
    default:
        return domain;
    }
}

const kept = attributes => Object.fromEntries(KEPT.filter(key => attributes[key] !== undefined && attributes[key] !== null)
    .map(key => [key, attributes[key]]));

// What hass-devices keeps: a device per controllable entity, the sensors of the same
// HA device attached to the first of them; a device of sensors alone otherwise.
export function savedDevices({states, entities = [], devices = [], areas = [], config = null}) {
    const registry = new Map(entities.map(e => [e.entity_id, e]));
    const owners = new Map(devices.map(d => [d.id, d]));
    const areaNames = new Map(areas.map(a => [a.area_id, a.name]));
    const fahrenheit = config?.unit_system?.temperature === '°F';
    const groups = new Map();
    for (const state of states) {
        const [domain] = state.entity_id.split('.');
        const entry = registry.get(state.entity_id);
        if (entry?.disabled_by || entry?.hidden_by || entry?.entity_category)
            continue;
        const entity = {id: state.entity_id, domain, attributes: state.attributes ?? {}};
        if (!CONTROLS.includes(domain) && !(['sensor', 'binary_sensor'].includes(domain) && readingOf(entity)))
            continue;
        const owner = entry?.device_id ? owners.get(entry.device_id) : null;
        const key = owner?.id ?? state.entity_id;
        if (!groups.has(key))
            groups.set(key, {owner, area: entry?.area_id ?? owner?.area_id ?? null, entities: []});
        const group = groups.get(key);
        group.area ??= entry?.area_id ?? null;
        group.entities.push(entity);
    }
    const saved = [];
    const keep = entity => ({id: entity.id, attributes: kept(entity.attributes)});
    for (const {owner, area, entities: members} of groups.values()) {
        const room = areaNames.get(area) ?? null;
        const model = owner ? [owner.manufacturer, owner.model].filter(Boolean).join(' ') || null : null;
        const controls = members.filter(e => CONTROLS.includes(e.domain));
        const sensors = members.filter(e => !CONTROLS.includes(e.domain));
        controls.forEach((control, i) => {
            saved.push({
                id: control.id,
                type: controlType(control.domain, control.attributes),
                name: control.attributes.friendly_name || owner?.name_by_user || owner?.name || control.id,
                room,
                model,
                fahrenheit,
                entities: [keep(control), ...(i === 0 ? sensors.map(keep) : [])],
            });
        });
        if (controls.length > 0 || sensors.length === 0)
            continue;
        const ranked = SENSOR_TYPES.flatMap(([reading, type]) =>
            sensors.filter(e => readingOf(e) === reading).map(e => [e, type]));
        const [lead, type] = ranked[0] ?? [sensors[0], 'sensor'];
        saved.push({
            id: lead.id,
            type,
            name: owner?.name_by_user || owner?.name || lead.attributes.friendly_name || lead.id,
            room,
            model,
            fahrenheit,
            entities: [lead, ...sensors.filter(e => e !== lead)].map(keep),
        });
    }
    return saved;
}

export async function readHome(client) {
    const quiet = promise => promise.catch(e => {
        console.debug(`nook: Home Assistant: ${e.message}`);
        return [];
    });
    const [states, entities, devices, areas, config] = await Promise.all([
        client.call('get_states'),
        quiet(client.call('config/entity_registry/list')),
        quiet(client.call('config/device_registry/list')),
        quiet(client.call('config/area_registry/list')),
        client.call('get_config').catch(() => null),
    ]);
    return {states: states ?? [], entities: entities ?? [], devices: devices ?? [], areas: areas ?? [], config};
}
