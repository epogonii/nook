// SPDX-License-Identifier: GPL-2.0-or-later

// HAP pairing as Apple TV speaks it (pair-setup with a PIN, then pair-verify each
// time), independent of the transport: Companion frames or AirPlay HTTP.
// Integer to bytes conversions follow srptools, which pyatv pairs with.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {open, seal} from './chacha.js';
import {ed25519Public, ed25519Sign, ed25519Verify, sha512, x25519, x25519Public} from './curve25519.js';

const encoder = new TextEncoder();

export const TLV = {
    method: 0x00,
    identifier: 0x01,
    salt: 0x02,
    publicKey: 0x03,
    proof: 0x04,
    encrypted: 0x05,
    state: 0x06,
    error: 0x07,
    signature: 0x0a,
    name: 0x11,
};

// RFC 5054 3072-bit group, generator 5.
const N = BigInt('0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A0879' +
    '8E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE' +
    '386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3' +
    'AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783' +
    'A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A3' +
    '3A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261' +
    'AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143' +
    'DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF');
const G = 5n;
const N_LENGTH = 384;

export class HapError extends Error {
    constructor(message, code = '') {
        super(message);
        this.name = 'HapError';
        this.code = code;
    }
}

export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

export function randomBytes(count) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        return stream.read_bytes(count, null).toArray();
    } finally {
        stream.close(null);
    }
}

export const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
export const fromHex = hex => Uint8Array.from(hex.match(/../g) ?? [], b => parseInt(b, 16));

const bigFrom = bytes => (bytes.length ? BigInt(`0x${toHex(bytes)}`) : 0n);

// Big-endian, no leading zeros; padded to N's length when length is given.
function bigBytes(n, length = 0) {
    let hex = n.toString(16);
    if (hex.length % 2)
        hex = `0${hex}`;
    const bytes = fromHex(hex);
    if (bytes.length >= length)
        return bytes;
    return concat(new Uint8Array(length - bytes.length), bytes);
}

function power(base, exponent, modulus) {
    let result = 1n;
    base %= modulus;
    while (exponent > 0n) {
        if (exponent & 1n)
            result = result * base % modulus;
        base = base * base % modulus;
        exponent >>= 1n;
    }
    return result;
}

const hash = (...parts) => sha512(concat(...parts));

function hmac(key, data) {
    const hex = GLib.compute_hmac_for_bytes(GLib.ChecksumType.SHA512, new GLib.Bytes(key), new GLib.Bytes(data));
    return fromHex(hex);
}

/** HKDF-SHA512 (RFC 5869) to 32 bytes. */
export function hkdf(secret, salt, info, length = 32) {
    const key = hmac(encoder.encode(salt), secret);
    let block = new Uint8Array(0);
    const out = [];
    for (let i = 1; out.length * 64 < length; i++) {
        block = hmac(key, concat(block, encoder.encode(info), Uint8Array.of(i)));
        out.push(block);
    }
    return concat(...out).subarray(0, length);
}

// HAP nonces are 4 zero bytes and an 8-byte ASCII label, like "PS-Msg05".
const labelNonce = label => concat(new Uint8Array(4), encoder.encode(label));

/** [[type, bytes], ...]: values over 255 bytes split into fragments of the same type. */
export function writeTlv(items) {
    const parts = [];
    for (const [type, value] of items) {
        if (value.length === 0)
            parts.push(Uint8Array.of(type, 0));
        for (let at = 0; at < value.length; at += 255) {
            const chunk = value.subarray(at, at + 255);
            parts.push(Uint8Array.of(type, chunk.length), chunk);
        }
    }
    return concat(...parts);
}

/** Map of type to bytes, fragments joined; throws HapError on an error item. */
export function readTlv(data) {
    const items = new Map();
    for (let at = 0; at + 2 <= data.length;) {
        const [type, length] = [data[at], data[at + 1]];
        const value = data.subarray(at + 2, at + 2 + length);
        items.set(type, items.has(type) ? concat(items.get(type), value) : value);
        at += 2 + length;
    }
    if (items.has(TLV.error)) {
        const code = items.get(TLV.error)[0];
        // 2: wrong PIN; 3: back off; 4: too many paired; 5: too many tries; 6: busy.
        throw new HapError(`The device answered pairing error ${code}`, code === 2 ? 'pin' : String(code));
    }
    return items;
}

const byte = n => Uint8Array.of(n);

function required(items, type) {
    const value = items.get(type);
    if (!value)
        throw new HapError(`The device left out TLV item ${type}`);
    return value;
}

/**
 * exchange(step, tlvBytes) sends one message and resolves with the answer's TLV bytes;
 * step is 1, 3 or 5, so the transport can tell the first message from the rest.
 */
export class PairSetup {
    // method 1 is pair-setup with the accessory's hardware authentication (HAP feature flag 1).
    constructor(exchange, method = 0) {
        this._exchange = exchange;
        this._method = method;
        this._seed = randomBytes(32);
        this.clientId = encoder.encode(GLib.uuid_string_random().toUpperCase());
    }

    // The device shows its PIN once it has the first message.
    async begin() {
        const answer = readTlv(await this._exchange(1, writeTlv([[TLV.method, byte(this._method)], [TLV.state, byte(1)]])));
        this._salt = required(answer, TLV.salt);
        this._serverPublic = bigFrom(required(answer, TLV.publicKey));
    }

    async finish(pin, name) {
        const a = bigFrom(randomBytes(32));
        const A = power(G, a, N);
        const B = this._serverPublic;
        if (B % N === 0n)
            throw new HapError('The device sent a bad SRP key');
        const u = bigFrom(hash(bigBytes(A, N_LENGTH), bigBytes(B, N_LENGTH)));
        const k = bigFrom(hash(bigBytes(N), bigBytes(G, N_LENGTH)));
        const x = bigFrom(hash(this._salt, hash(encoder.encode(`Pair-Setup:${pin}`))));
        let base = (B - k * power(G, x, N)) % N;
        if (base < 0n)
            base += N;
        const K = hash(bigBytes(power(base, a + u * x, N)));
        const hashG = hash(bigBytes(G));
        const group = hash(bigBytes(N)).map((value, i) => value ^ hashG[i]);
        const proof = hash(group, hash(encoder.encode('Pair-Setup')), this._salt, bigBytes(A), bigBytes(B), K);

        // A wrong PIN comes back as an error item. The device's own proof and, below, its
        // signature are only logged, as pyatv does: nobody has seen an Apple TV checked
        // against them, and a device without the PIN cannot seal the last message anyway.
        const verified = readTlv(await this._exchange(3, writeTlv([
            [TLV.state, byte(3)], [TLV.publicKey, bigBytes(A)], [TLV.proof, proof]])));
        const expected = hash(bigBytes(A), proof, K);
        const serverProof = verified.get(TLV.proof) ?? new Uint8Array(0);
        if (serverProof.length !== expected.length || serverProof.some((v, i) => v !== expected[i]))
            console.debug('nook: pairing: the device proof differs from SRP-6a');

        const key = hkdf(K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
        const deviceX = hkdf(K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info');
        const ltpk = ed25519Public(this._seed);
        const items = [
            [TLV.identifier, this.clientId],
            [TLV.publicKey, ltpk],
            [TLV.signature, ed25519Sign(this._seed, concat(deviceX, this.clientId, ltpk))],
        ];
        if (name)
            items.push([TLV.name, name]);
        const done = readTlv(await this._exchange(5, writeTlv([
            [TLV.state, byte(5)], [TLV.encrypted, seal(key, labelNonce('PS-Msg05'), writeTlv(items))]])));

        const inner = readTlv(open(key, labelNonce('PS-Msg06'), required(done, TLV.encrypted)));
        const deviceId = required(inner, TLV.identifier);
        const devicePublic = required(inner, TLV.publicKey);
        const accessoryX = hkdf(K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info');
        if (!ed25519Verify(devicePublic, concat(accessoryX, deviceId, devicePublic), inner.get(TLV.signature) ?? new Uint8Array(0)))
            console.debug('nook: pairing: the device key signature differs from HAP');
        return {
            ltsk: toHex(this._seed),
            ltpk: toHex(devicePublic),
            deviceId: toHex(deviceId),
            clientId: toHex(this.clientId),
        };
    }
}

/**
 * Proves both sides hold the keys from pair-setup and agrees on a fresh shared secret.
 * Resolves with keys(salt, info) to derive the session's keys from it.
 */
export async function pairVerify(exchange, credentials) {
    const secret = randomBytes(32);
    const ours = x25519Public(secret);
    const answer = readTlv(await exchange(1, writeTlv([[TLV.state, byte(1)], [TLV.publicKey, ours]])));
    const theirs = required(answer, TLV.publicKey);
    const shared = x25519(secret, theirs);
    if (shared.every(v => v === 0))
        throw new HapError('The device sent a bad key');
    const key = hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
    const inner = readTlv(open(key, labelNonce('PV-Msg02'), required(answer, TLV.encrypted)));
    const deviceId = required(inner, TLV.identifier);
    if (toHex(deviceId) !== credentials.deviceId)
        throw new HapError('Another device answered', 'unpaired');
    if (!ed25519Verify(fromHex(credentials.ltpk), concat(theirs, deviceId, ours), required(inner, TLV.signature)))
        throw new HapError('The device did not prove who it is', 'unpaired');
    const clientId = fromHex(credentials.clientId);
    const proof = writeTlv([
        [TLV.identifier, clientId],
        [TLV.signature, ed25519Sign(fromHex(credentials.ltsk), concat(ours, clientId, theirs))],
    ]);
    readTlv(await exchange(3, writeTlv([[TLV.state, byte(3)], [TLV.encrypted, seal(key, labelNonce('PV-Msg03'), proof)]])));
    return {keys: (salt, info) => hkdf(shared, salt, info)};
}
