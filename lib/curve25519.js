// SPDX-License-Identifier: GPL-2.0-or-later

// Pure-JS X25519 (RFC 7748) and Ed25519 (RFC 8032) on BigInt, for Apple TV pairing.
// Not constant time: fine for a LAN client, where nobody can time it.

import GLib from 'gi://GLib';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

const mod = a => {
    const r = a % P;
    return r < 0n ? r + P : r;
};

function power(base, exponent) {
    let result = 1n;
    base = mod(base);
    while (exponent > 0n) {
        if (exponent & 1n)
            result = result * base % P;
        base = base * base % P;
        exponent >>= 1n;
    }
    return result;
}

const invert = a => power(a, P - 2n);

function littleEndian(bytes) {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--)
        n = (n << 8n) | BigInt(bytes[i]);
    return n;
}

function toBytes(n, length = 32) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++, n >>= 8n)
        out[i] = Number(n & 0xffn);
    return out;
}

function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

export function sha512(data) {
    const hex = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA512, new GLib.Bytes(data));
    return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}

function clamp(bytes) {
    const k = Uint8Array.from(bytes.subarray(0, 32));
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    return littleEndian(k);
}

/** Shared secret of a 32-byte private key and a peer's 32-byte public key. */
export function x25519(secret, peer) {
    const k = clamp(secret);
    const u = Uint8Array.from(peer);
    u[31] &= 127;
    const x1 = littleEndian(u) % P;
    let [x2, z2, x3, z3] = [1n, 0n, x1, 1n];
    let swap = 0n;
    for (let t = 254n; t >= 0n; t--) {
        const bit = (k >> t) & 1n;
        if (swap ^ bit)
            [x2, x3, z2, z3] = [x3, x2, z3, z2];
        swap = bit;
        const a = mod(x2 + z2), aa = a * a % P, b = mod(x2 - z2), bb = b * b % P, e = mod(aa - bb);
        const c = mod(x3 + z3), d = mod(x3 - z3), da = d * a % P, cb = c * b % P;
        x3 = mod((da + cb) ** 2n);
        z3 = x1 * mod((da - cb) ** 2n) % P;
        x2 = aa * bb % P;
        z2 = e * mod(aa + 121665n * e) % P;
    }
    if (swap)
        [x2, z2] = [x3, z3];
    return toBytes(x2 * invert(z2) % P);
}

export const x25519Public = secret => x25519(secret, toBytes(9n));

const D = mod(-121665n * invert(121666n));
const SQRT_M1 = power(2n, (P - 1n) / 4n);

function recoverX(y, odd) {
    const xx = mod((y * y - 1n) * invert(D * y * y + 1n));
    if (xx === 0n) {
        if (odd)
            throw new Error('Not a curve point');
        return 0n;
    }
    let x = power(xx, (P + 3n) / 8n);
    if (mod(x * x - xx) !== 0n)
        x = x * SQRT_M1 % P;
    if (mod(x * x - xx) !== 0n)
        throw new Error('Not a curve point');
    return (x & 1n) === BigInt(odd) ? x : P - x;
}

// Extended coordinates (X, Y, Z, T), x = X/Z, y = Y/Z, xy = T/Z.
function add([x1, y1, z1, t1], [x2, y2, z2, t2]) {
    const a = mod((y1 - x1) * (y2 - x2));
    const b = mod((y1 + x1) * (y2 + x2));
    const c = 2n * t1 * t2 % P * D % P;
    const d = 2n * z1 * z2 % P;
    const e = b - a, f = d - c, g = d + c, h = b + a;
    return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function multiply(scalar, point) {
    let result = [0n, 1n, 1n, 0n];
    while (scalar > 0n) {
        if (scalar & 1n)
            result = add(result, point);
        point = add(point, point);
        scalar >>= 1n;
    }
    return result;
}

const BASE_Y = 4n * invert(5n) % P;
const BASE_X = recoverX(BASE_Y, 0);
const BASE = [BASE_X, BASE_Y, 1n, BASE_X * BASE_Y % P];

function encode([x, y, z]) {
    const zi = invert(z);
    const out = toBytes(y * zi % P);
    out[31] |= Number(x * zi % P & 1n) << 7;
    return out;
}

function decode(bytes) {
    if (bytes.length !== 32)
        throw new Error('Not a curve point');
    const odd = bytes[31] >> 7;
    const y = littleEndian(bytes) & ((1n << 255n) - 1n);
    if (y >= P)
        throw new Error('Not a curve point');
    const x = recoverX(y, odd);
    return [x, y, 1n, x * y % P];
}

/** The 32-byte public key of a 32-byte seed. */
export const ed25519Public = seed => encode(multiply(clamp(sha512(seed)), BASE));

export function ed25519Sign(seed, message) {
    const hash = sha512(seed);
    const a = clamp(hash);
    const publicKey = encode(multiply(a, BASE));
    const r = littleEndian(sha512(concat(hash.subarray(32), message))) % L;
    const big = encode(multiply(r, BASE));
    const k = littleEndian(sha512(concat(big, publicKey, message))) % L;
    return concat(big, toBytes((r + k * a) % L));
}

export function ed25519Verify(publicKey, message, signature) {
    if (signature.length !== 64)
        return false;
    try {
        const s = littleEndian(signature.subarray(32));
        if (s >= L)
            return false;
        const big = signature.subarray(0, 32);
        const k = littleEndian(sha512(concat(big, publicKey, message))) % L;
        const left = encode(multiply(s, BASE));
        const right = encode(add(decode(big), multiply(k, decode(publicKey))));
        return left.every((byte, i) => byte === right[i]);
    } catch {
        return false;
    }
}
