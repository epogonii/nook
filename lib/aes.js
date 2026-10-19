// SPDX-License-Identifier: GPL-2.0-or-later

// Pure-JS AES-128 (FIPS-197, NIST SP 800-38D): GJS has no cipher API to call.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

// S-box: GF(2^8) inverse plus affine map, generated instead of a 256-entry table.
{
    let p = 1, q = 1;
    do {
        p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
        q ^= q << 1;
        q ^= q << 2;
        q ^= q << 4;
        q &= 0xff;
        if (q & 0x80)
            q ^= 0x09;
        const x = q ^ (q << 1 | q >> 7) ^ (q << 2 | q >> 6) ^ (q << 3 | q >> 5) ^ (q << 4 | q >> 4);
        SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++)
        INV_SBOX[SBOX[i]] = i;
}

const xtime = b => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

function mul(a, b) {
    let r = 0;
    while (b) {
        if (b & 1)
            r ^= a;
        a = xtime(a);
        b >>= 1;
    }
    return r;
}

function expandKey(key) {
    const w = new Uint8Array(176);
    w.set(key);
    let rcon = 1;
    for (let i = 16; i < 176; i += 4) {
        let t = w.slice(i - 4, i);
        if (i % 16 === 0) {
            t = Uint8Array.of(SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]);
            rcon = xtime(rcon);
        }
        for (let j = 0; j < 4; j++)
            w[i + j] = w[i - 16 + j] ^ t[j];
    }
    return w;
}

function addRoundKey(s, w, round) {
    for (let i = 0; i < 16; i++)
        s[i] ^= w[round * 16 + i];
}

function shiftRows(s, inverse) {
    const t = s.slice();
    for (let r = 1; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const from = inverse ? (c - r + 4) % 4 : (c + r) % 4;
            s[c * 4 + r] = t[from * 4 + r];
        }
    }
}

function mixColumns(s, inverse) {
    const m = inverse ? [14, 11, 13, 9] : [2, 3, 1, 1];
    for (let c = 0; c < 4; c++) {
        const col = s.slice(c * 4, c * 4 + 4);
        for (let r = 0; r < 4; r++) {
            s[c * 4 + r] = mul(col[0], m[(4 - r) % 4]) ^ mul(col[1], m[(5 - r) % 4]) ^
                mul(col[2], m[(6 - r) % 4]) ^ mul(col[3], m[(7 - r) % 4]);
        }
    }
}

function encryptBlock(w, block) {
    const s = Uint8Array.from(block);
    addRoundKey(s, w, 0);
    for (let round = 1; round <= 10; round++) {
        for (let i = 0; i < 16; i++)
            s[i] = SBOX[s[i]];
        shiftRows(s, false);
        if (round < 10)
            mixColumns(s, false);
        addRoundKey(s, w, round);
    }
    return s;
}

function decryptBlock(w, block) {
    const s = Uint8Array.from(block);
    addRoundKey(s, w, 10);
    for (let round = 9; round >= 0; round--) {
        shiftRows(s, true);
        for (let i = 0; i < 16; i++)
            s[i] = INV_SBOX[s[i]];
        addRoundKey(s, w, round);
        if (round > 0)
            mixColumns(s, true);
    }
    return s;
}

export function ecbEncrypt(key, data) {
    const w = expandKey(key);
    const pad = 16 - data.length % 16;
    const padded = new Uint8Array(data.length + pad).fill(pad);
    padded.set(data);
    const out = new Uint8Array(padded.length);
    for (let i = 0; i < padded.length; i += 16)
        out.set(encryptBlock(w, padded.subarray(i, i + 16)), i);
    return out;
}

/** Loose unpadding: some Gree units pad with zeros; a wrong key fails at JSON.parse. */
export function ecbDecrypt(key, data) {
    const w = expandKey(key);
    const out = new Uint8Array(data.length);
    for (let i = 0; i + 16 <= data.length; i += 16)
        out.set(decryptBlock(w, data.subarray(i, i + 16)), i);
    const pad = out[out.length - 1];
    return pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
}

function gfMul(x, y) {
    const z = new Uint8Array(16);
    const v = Uint8Array.from(y);
    for (let i = 0; i < 128; i++) {
        if (x[i >> 3] & (0x80 >> (i & 7))) {
            for (let j = 0; j < 16; j++)
                z[j] ^= v[j];
        }
        const lsb = v[15] & 1;
        for (let j = 15; j > 0; j--)
            v[j] = (v[j] >> 1) | ((v[j - 1] & 1) << 7);
        v[0] >>= 1;
        if (lsb)
            v[0] ^= 0xe1;
    }
    return z;
}

function ghash(h, aad, ciphertext) {
    let y = new Uint8Array(16);
    const absorb = data => {
        for (let i = 0; i < data.length; i += 16) {
            const block = new Uint8Array(16);
            block.set(data.subarray(i, i + 16));
            for (let j = 0; j < 16; j++)
                y[j] ^= block[j];
            y = gfMul(y, h);
        }
    };
    absorb(aad);
    absorb(ciphertext);
    const lengths = new Uint8Array(16);
    const view = new DataView(lengths.buffer);
    view.setUint32(4, aad.length * 8);
    view.setUint32(12, ciphertext.length * 8);
    for (let j = 0; j < 16; j++)
        y[j] ^= lengths[j];
    return gfMul(y, h);
}

function gctr(w, j0, data) {
    const out = new Uint8Array(data.length);
    const counter = Uint8Array.from(j0);
    const view = new DataView(counter.buffer);
    for (let i = 0; i < data.length; i += 16) {
        view.setUint32(12, view.getUint32(12) + 1);
        const stream = encryptBlock(w, counter);
        for (let j = 0; j < 16 && i + j < data.length; j++)
            out[i + j] = data[i + j] ^ stream[j];
    }
    return out;
}

function gcmSetup(key, nonce) {
    if (nonce.length !== 12)
        throw new Error('GCM nonce must be 12 bytes');
    const w = expandKey(key);
    const h = encryptBlock(w, new Uint8Array(16));
    const j0 = new Uint8Array(16);
    j0.set(nonce);
    j0[15] = 1;
    return [w, h, j0];
}

function tagFor(w, h, j0, aad, ciphertext) {
    const s = ghash(h, aad, ciphertext);
    const mask = encryptBlock(w, j0);
    return s.map((b, i) => b ^ mask[i]);
}

export function gcmEncrypt(key, nonce, aad, data) {
    const [w, h, j0] = gcmSetup(key, nonce);
    const ciphertext = gctr(w, j0, data);
    return [ciphertext, tagFor(w, h, j0, aad, ciphertext)];
}

export function gcmDecrypt(key, nonce, aad, ciphertext, tag) {
    const [w, h, j0] = gcmSetup(key, nonce);
    const expected = tagFor(w, h, j0, aad, ciphertext);
    let diff = 0;
    for (let i = 0; i < 16; i++)
        diff |= expected[i] ^ tag[i];
    if (diff !== 0)
        throw new Error('GCM tag mismatch');
    return gctr(w, j0, ciphertext);
}

export function ccmDecrypt(key, nonce, aad, ciphertext, tag) {
    const w = expandKey(key);
    const counterBlock = i => {
        const block = new Uint8Array(16);
        block[0] = 2;
        block.set(nonce, 1);
        block[13] = i >> 16 & 0xff;
        block[14] = i >> 8 & 0xff;
        block[15] = i & 0xff;
        return block;
    };

    const plaintext = new Uint8Array(ciphertext.length);
    for (let i = 0; i < ciphertext.length; i += 16) {
        const stream = encryptBlock(w, counterBlock(i / 16 + 1));
        for (let j = 0; j < 16 && i + j < ciphertext.length; j++)
            plaintext[i + j] = ciphertext[i + j] ^ stream[j];
    }

    const b0 = new Uint8Array(16);
    b0[0] = (aad.length > 0 ? 0x40 : 0) | ((tag.length - 2) / 2) << 3 | 2;
    b0.set(nonce, 1);
    b0[13] = plaintext.length >> 16 & 0xff;
    b0[14] = plaintext.length >> 8 & 0xff;
    b0[15] = plaintext.length & 0xff;
    const header = aad.length > 0 ? Uint8Array.of(aad.length >> 8, aad.length & 0xff, ...aad) : new Uint8Array(0);
    const blocks = [b0, header, plaintext].flatMap(part => {
        const out = [];
        for (let i = 0; i < part.length; i += 16) {
            const block = new Uint8Array(16);
            block.set(part.subarray(i, i + 16));
            out.push(block);
        }
        return out;
    });
    let mac = new Uint8Array(16);
    for (const block of blocks) {
        for (let j = 0; j < 16; j++)
            mac[j] ^= block[j];
        mac = encryptBlock(w, mac);
    }
    const stream = encryptBlock(w, counterBlock(0));
    let diff = 0;
    for (let j = 0; j < tag.length; j++)
        diff |= (mac[j] ^ stream[j]) ^ tag[j];
    if (diff !== 0)
        throw new Error('CCM tag mismatch');
    return plaintext;
}

export function cbcEncrypt(key, iv, data, padding = true) {
    const w = expandKey(key);
    if (!padding && data.length % 16 !== 0)
        throw new Error('CBC data is not whole blocks');
    const pad = padding ? 16 - data.length % 16 : 0;
    const padded = new Uint8Array(data.length + pad).fill(pad);
    padded.set(data);
    const out = new Uint8Array(padded.length);
    let last = iv;
    for (let i = 0; i < padded.length; i += 16) {
        const block = padded.slice(i, i + 16);
        for (let j = 0; j < 16; j++)
            block[j] ^= last[j];
        last = encryptBlock(w, block);
        out.set(last, i);
    }
    return out;
}

export function cbcDecrypt(key, iv, data, padding = true) {
    if (data.length === 0 || data.length % 16 !== 0)
        throw new Error('CBC data is not whole blocks');
    const w = expandKey(key);
    const out = new Uint8Array(data.length);
    let last = iv;
    for (let i = 0; i < data.length; i += 16) {
        const block = data.subarray(i, i + 16);
        const plain = decryptBlock(w, block);
        for (let j = 0; j < 16; j++)
            out[i + j] = plain[j] ^ last[j];
        last = block;
    }
    if (!padding)
        return out;
    const pad = out[out.length - 1];
    if (pad < 1 || pad > 16 || out.subarray(out.length - pad).some(b => b !== pad))
        throw new Error('CBC padding is wrong');
    return out.subarray(0, out.length - pad);
}
