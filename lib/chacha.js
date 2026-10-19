// SPDX-License-Identifier: GPL-2.0-or-later

// Pure-JS ChaCha20-Poly1305 (RFC 8439) for Apple TV sessions: GJS has no cipher API to call.

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
const P1305 = (1n << 130n) - 5n;
const MASK128 = (1n << 128n) - 1n;

const rotl = (v, n) => (v << n) | (v >>> (32 - n));

function words(bytes, count) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 4);
    return Uint32Array.from({length: count}, (_, i) => view.getUint32(i * 4, true));
}

function block(key, counter, nonce, out) {
    const state = new Uint32Array(16);
    state.set(SIGMA);
    state.set(key, 4);
    state[12] = counter;
    state.set(nonce, 13);
    const x = Uint32Array.from(state);
    const quarter = (a, b, c, d) => {
        x[a] += x[b];
        x[d] = rotl(x[d] ^ x[a], 16);
        x[c] += x[d];
        x[b] = rotl(x[b] ^ x[c], 12);
        x[a] += x[b];
        x[d] = rotl(x[d] ^ x[a], 8);
        x[c] += x[d];
        x[b] = rotl(x[b] ^ x[c], 7);
    };
    for (let i = 0; i < 10; i++) {
        quarter(0, 4, 8, 12);
        quarter(1, 5, 9, 13);
        quarter(2, 6, 10, 14);
        quarter(3, 7, 11, 15);
        quarter(0, 5, 10, 15);
        quarter(1, 6, 11, 12);
        quarter(2, 7, 8, 13);
        quarter(3, 4, 9, 14);
    }
    const view = new DataView(out.buffer, out.byteOffset, 64);
    for (let i = 0; i < 16; i++)
        view.setUint32(i * 4, x[i] + state[i], true);
}

function stream(key, nonce, counter, data) {
    const k = words(key, 8);
    const n = words(nonce, 3);
    const out = new Uint8Array(data.length);
    const pad = new Uint8Array(64);
    for (let at = 0; at < data.length; at += 64, counter++) {
        block(k, counter, n, pad);
        const end = Math.min(64, data.length - at);
        for (let i = 0; i < end; i++)
            out[at + i] = data[at + i] ^ pad[i];
    }
    return out;
}

function littleEndian(bytes) {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--)
        n = (n << 8n) | BigInt(bytes[i]);
    return n;
}

function poly1305(key, message) {
    const r = littleEndian(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
    const s = littleEndian(key.subarray(16, 32));
    let h = 0n;
    for (let at = 0; at < message.length; at += 16) {
        const chunk = message.subarray(at, at + 16);
        h = ((h + littleEndian(chunk) + (1n << BigInt(8 * chunk.length))) * r) % P1305;
    }
    let tag = (h + s) & MASK128;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++, tag >>= 8n)
        out[i] = Number(tag & 0xffn);
    return out;
}

function authenticate(otk, aad, ciphertext) {
    const padded = n => n + (16 - n % 16) % 16;
    const data = new Uint8Array(padded(aad.length) + padded(ciphertext.length) + 16);
    data.set(aad);
    data.set(ciphertext, padded(aad.length));
    const view = new DataView(data.buffer, data.length - 16);
    view.setBigUint64(0, BigInt(aad.length), true);
    view.setBigUint64(8, BigInt(ciphertext.length), true);
    return poly1305(otk, data);
}

const oneTimeKey = (key, nonce) => stream(key, nonce, 0, new Uint8Array(32));

/** Returns the ciphertext with the 16-byte tag appended. nonce: 12 bytes. */
export function seal(key, nonce, data, aad = new Uint8Array(0)) {
    const ciphertext = stream(key, nonce, 1, data);
    const out = new Uint8Array(ciphertext.length + 16);
    out.set(ciphertext);
    out.set(authenticate(oneTimeKey(key, nonce), aad, ciphertext), ciphertext.length);
    return out;
}

/** Throws if the tag does not match. */
export function open(key, nonce, sealed, aad = new Uint8Array(0)) {
    if (sealed.length < 16)
        throw new Error('Sealed data too short');
    const ciphertext = sealed.subarray(0, sealed.length - 16);
    const tag = authenticate(oneTimeKey(key, nonce), aad, ciphertext);
    let diff = 0;
    for (let i = 0; i < 16; i++)
        diff |= tag[i] ^ sealed[ciphertext.length + i];
    if (diff !== 0)
        throw new Error('Sealed data does not open');
    return stream(key, nonce, 1, ciphertext);
}
