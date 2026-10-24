// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const TIMEOUT = 5;

const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
const WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const TOKEN_PROFILE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
const MESSAGE_SECURITY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0';
const DEVICE = 'http://www.onvif.org/ver10/device/wsdl';
const MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const PTZ = 'http://www.onvif.org/ver20/ptz/wsdl';
const SCHEMA = 'http://www.onvif.org/ver10/schema';

// ISO 8601 duration; the camera stops by itself if stop() never arrives.
const MOVE_TIMEOUT = 'PT1S';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class OnvifError extends Error {
    constructor(message, refused = false) {
        super(message);
        this.refused = refused;
    }
}

const field = (xml, tag) => new RegExp(`<(?:\\w+:)?${tag}>([^<]*)<`).exec(xml)?.[1]?.trim() ?? '';
const unescape = text => text.replace(/&amp;/g, '&');

const escape = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

// WS-Security PasswordDigest = SHA-1(nonce + created + password). Sent over plain
// HTTP: replayable and brute-forceable if sniffed. Nothing better on these cameras.
function security(user, password, skew) {
    const nonce = new Uint8Array(16);
    for (let i = 0; i < nonce.length; i++)
        nonce[i] = GLib.random_int_range(0, 256);
    const created = new Date(Date.now() + skew).toISOString();
    const tail = encoder.encode(created + password);
    const data = new Uint8Array(nonce.length + tail.length);
    data.set(nonce);
    data.set(tail, nonce.length);
    const digest = hexToBytes(GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, new GLib.Bytes(data)));
    return `<s:Header><Security s:mustUnderstand="1" xmlns="${WSSE}"><UsernameToken>` +
        `<Username>${escape(user)}</Username>` +
        `<Password Type="${TOKEN_PROFILE}#PasswordDigest">${GLib.base64_encode(digest)}</Password>` +
        `<Nonce EncodingType="${MESSAGE_SECURITY}#Base64Binary">${GLib.base64_encode(nonce)}</Nonce>` +
        `<Created xmlns="${WSU}">${created}</Created>` +
        '</UsernameToken></Security></s:Header>';
}

// Tapo answers every service at one url. Other cameras name theirs in GetCapabilities:
// pass the device service url and lookup = true.
export class Camera {
    constructor(url, user, password, lookup = false) {
        this._url = url;
        this._user = user;
        this._password = password;
        this._session = new Soup.Session({timeout: TIMEOUT});
        this._profile = null;
        // Tapo keeps its clock right; ask only the others.
        this._services = lookup ? null : Promise.resolve({media: url, ptz: url});
        this._skew = lookup ? null : Promise.resolve(0);
    }

    async _post(url, header, body, cancellable) {
        const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${SOAP}">` +
            `${header}<s:Body>${body}</s:Body></s:Envelope>`;
        const msg = Soup.Message.new('POST', url);
        msg.set_request_body_from_bytes('application/soap+xml; charset=utf-8', new GLib.Bytes(encoder.encode(envelope)));
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable);
        const xml = decoder.decode(bytes.toArray());
        if (msg.status_code !== Soup.Status.OK) {
            const reason = /<[^>]*:Text[^>]*>([^<]+)</.exec(xml)?.[1];
            // Fault codes only: namespace declarations alone mention wssecurity.
            const codes = [...xml.matchAll(/<(?:\w+:)?Value>([^<]+)</g)].map(m => m[1]).join(' ');
            const refused = msg.status_code === Soup.Status.UNAUTHORIZED ||
                /NotAuthorized|FailedAuthentication|InvalidSecurity/i.test(codes) || /Security|authori[sz]/i.test(reason ?? '');
            throw new OnvifError(reason?.trim() || msg.get_reason_phrase() || `HTTP ${msg.status_code}`, refused);
        }
        return xml;
    }

    // WS-Security digests carry a timestamp the camera checks against its own clock,
    // and cheap cameras keep theirs hours off. GetSystemDateAndTime needs no login.
    // Promises, not values, are kept: the stream and PTZ lookups run side by side, and
    // each extra login try counts towards a lockout.
    _clock(cancellable) {
        this._skew ??= this._askClock(cancellable).catch(e => {
            this._skew = null;
            throw e;
        });
        return this._skew;
    }

    async _askClock(cancellable) {
        try {
            const xml = await this._post(this._url, '', `<GetSystemDateAndTime xmlns="${DEVICE}"/>`, cancellable);
            const utc = /UTCDateTime>([\s\S]*?)<\/(?:\w+:)?UTCDateTime/.exec(xml)?.[1] ?? '';
            const parts = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map(tag => field(utc, tag));
            if (parts.some(part => part === '') || Number(parts[0]) < 2000)
                return 0;
            const [year, month, day, hour, minute, second] = parts.map(Number);
            const camera = Date.UTC(year, month - 1, day, hour, minute, second);
            return Number.isFinite(camera) ? camera - Date.now() : 0;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            return 0;
        }
    }

    // Only queries are cancellable: a move must never be left without its stop.
    async _call(service, body, cancellable = null) {
        const skew = await this._clock(cancellable);
        const url = service === 'device' ? this._url : (await this._lookup(cancellable))[service];
        if (!url)
            throw new OnvifError(`The camera has no ${service} service.`);
        return this._post(url, security(this._user, this._password, skew), body, cancellable);
    }

    _lookup(cancellable) {
        this._services ??= this._askServices(cancellable).catch(e => {
            this._services = null;
            throw e;
        });
        return this._services;
    }

    async _askServices(cancellable) {
        const xml = await this._call('device', `<GetCapabilities xmlns="${DEVICE}"><Category>All</Category></GetCapabilities>`, cancellable);
        const address = tag => new RegExp(`<(?:\\w+:)?${tag}>\\s*<(?:\\w+:)?XAddr>([^<]+)<`).exec(xml)?.[1]?.trim() ?? null;
        return {media: address('Media'), ptz: address('PTZ')};
    }

    async _token() {
        if (!this._profile) {
            const xml = await this._call('media', `<GetProfiles xmlns="${MEDIA}"/>`);
            this._profile = /Profiles[^>]*\btoken="([^"]+)"/.exec(xml)?.[1] ?? null;
            if (!this._profile)
                throw new OnvifError('The camera has no media profile.');
        }
        return this._profile;
    }

    // RTSP urls of the smallest profile, for the menu, and the largest, for snapshots.
    async streams(cancellable = null) {
        const xml = await this._call('media', `<GetProfiles xmlns="${MEDIA}"/>`, cancellable);
        const profiles = xml.split(/<(?:\w+:)?Profiles\b/).slice(1).map(part => {
            const video = part.slice(Math.max(part.indexOf('VideoEncoderConfiguration'), 0));
            return {
                token: /^[^>]*\btoken="([^"]+)"/.exec(part)?.[1],
                pixels: (Number(field(video, 'Width')) * Number(field(video, 'Height'))) || 0,
            };
        }).filter(p => p.token).sort((a, b) => a.pixels - b.pixels);
        if (profiles.length === 0)
            throw new OnvifError('The camera has no media profile.');
        this._profile ??= profiles[0].token;
        const uri = async ({token}) => {
            const reply = await this._call('media', `<GetStreamUri xmlns="${MEDIA}"><StreamSetup>` +
                `<Stream xmlns="${SCHEMA}">RTP-Unicast</Stream><Transport xmlns="${SCHEMA}"><Protocol>RTSP</Protocol></Transport>` +
                `</StreamSetup><ProfileToken>${escape(token)}</ProfileToken></GetStreamUri>`, cancellable);
            const found = unescape(field(reply, 'Uri'));
            if (!found.startsWith('rtsp'))
                throw new OnvifError('The camera gave no stream address.');
            return found;
        };
        const live = await uri(profiles[0]);
        const still = profiles.length > 1 ? await uri(profiles[profiles.length - 1]) : live;
        return {live, still};
    }

    async abilities(cancellable = null) {
        if (!(await this._lookup(cancellable)).ptz)
            return {pan: false, home: false};
        const xml = await this._call('ptz', `<GetNodes xmlns="${PTZ}"/>`, cancellable);
        return {
            pan: xml.includes('ContinuousPanTiltVelocitySpace'),
            home: /HomeSupported>\s*true/.test(xml),
        };
    }

    async move(x, y) {
        const token = await this._token();
        await this._call('ptz', `<ContinuousMove xmlns="${PTZ}"><ProfileToken>${escape(token)}</ProfileToken>` +
            `<Velocity><PanTilt xmlns="${SCHEMA}" x="${x}" y="${y}"/></Velocity>` +
            `<Timeout>${MOVE_TIMEOUT}</Timeout></ContinuousMove>`);
    }

    async stop() {
        const token = await this._token();
        await this._call('ptz', `<Stop xmlns="${PTZ}"><ProfileToken>${escape(token)}</ProfileToken>` +
            '<PanTilt>true</PanTilt><Zoom>false</Zoom></Stop>');
    }

    async home() {
        const token = await this._token();
        await this._call('ptz', `<GotoHomePosition xmlns="${PTZ}"><ProfileToken>${escape(token)}</ProfileToken></GotoHomePosition>`);
    }
}
