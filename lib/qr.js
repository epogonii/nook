// SPDX-License-Identifier: GPL-2.0-or-later

// QR codes (ISO/IEC 18004) for short texts: byte mode, error correction level M,
// versions 1 to 10. Enough for a login link; the result is a square of booleans.

const encoder = new TextEncoder();

// Per version at level M: error correction codewords per block, then [blocks, data codewords] groups.
const BLOCKS = [
    null,
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
];

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100)
        x ^= 0x11d;
}
for (let i = 255; i < 512; i++)
    EXP[i] = EXP[i - 255];

const times = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
        const next = new Array(poly.length + 1).fill(0);
        poly.forEach((c, j) => {
            next[j] ^= c;
            next[j + 1] ^= times(c, EXP[i]);
        });
        poly = next;
    }
    return poly;
}

function remainder(data, degree) {
    const gen = generator(degree);
    const out = [...data, ...new Array(degree).fill(0)];
    for (let i = 0; i < data.length; i++) {
        const factor = out[i];
        if (factor === 0)
            continue;
        for (let j = 0; j < gen.length; j++)
            out[i + j] ^= times(gen[j], factor);
    }
    return out.slice(data.length);
}

const dataCodewords = version => BLOCKS[version][1].reduce((n, [blocks, size]) => n + blocks * size, 0);

function codewords(bytes, version) {
    const bits = [];
    const push = (value, length) => {
        for (let i = length - 1; i >= 0; i--)
            bits.push((value >> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes)
        push(byte, 8);
    const capacity = dataCodewords(version) * 8;
    push(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8)
        bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8)
        data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
    for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11)
        data.push(pad);

    const [ecLength, groups] = BLOCKS[version];
    const blocks = [];
    let at = 0;
    for (const [count, size] of groups) {
        for (let i = 0; i < count; i++) {
            const block = data.slice(at, at + size);
            at += size;
            blocks.push({data: block, ec: remainder(block, ecLength)});
        }
    }
    const out = [];
    const longest = Math.max(...blocks.map(b => b.data.length));
    for (let i = 0; i < longest; i++) {
        for (const block of blocks) {
            if (i < block.data.length)
                out.push(block.data[i]);
        }
    }
    for (let i = 0; i < ecLength; i++) {
        for (const block of blocks)
            out.push(block.ec[i]);
    }
    return out;
}

// BCH codes of the format (15, 5) and version (18, 6) information.
function bch(value, poly, length) {
    const top = Math.floor(Math.log2(poly));
    let rest = value << top;
    while (rest >= 1 << top)
        rest ^= poly << (Math.floor(Math.log2(rest)) - top);
    return ((value << top) | rest) & ((1 << length) - 1);
}

const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    r => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(modules) {
    const size = modules.length;
    let score = 0;
    const line = get => {
        let run = 1;
        for (let i = 1; i <= size; i++) {
            if (i < size && get(i) === get(i - 1)) {
                run++;
                continue;
            }
            if (run >= 5)
                score += run - 2;
            run = 1;
        }
        const pattern = [true, false, true, true, true, false, true];
        for (let i = 0; i + 7 <= size; i++) {
            if (!pattern.every((dark, k) => get(i + k) === dark))
                continue;
            const light = (from, to) => {
                for (let k = from; k < to; k++) {
                    if (k >= 0 && k < size && get(k))
                        return false;
                }
                return true;
            };
            if (light(i - 4, i) || light(i + 7, i + 11))
                score += 40;
        }
    };
    for (let r = 0; r < size; r++)
        line(c => modules[r][c]);
    for (let c = 0; c < size; c++)
        line(r => modules[r][c]);
    for (let r = 0; r + 1 < size; r++) {
        for (let c = 0; c + 1 < size; c++) {
            const v = modules[r][c];
            if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v)
                score += 3;
        }
    }
    const dark = modules.flat().filter(Boolean).length;
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
}

// Rows of booleans, true for dark, without the quiet zone; null if the text is too long.
export function encode(text) {
    const bytes = encoder.encode(text);
    let version = 1;
    while (version <= 10 && dataCodewords(version) < bytes.length + (version < 10 ? 2 : 3))
        version++;
    if (version > 10)
        return null;
    const size = 17 + 4 * version;
    const modules = Array.from({length: size}, () => new Array(size).fill(false));
    const reserved = Array.from({length: size}, () => new Array(size).fill(false));
    const set = (r, c, dark) => {
        modules[r][c] = dark;
        reserved[r][c] = true;
    };

    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const [y, x] = [top + r, left + c];
                if (y < 0 || x < 0 || y >= size || x >= size)
                    continue;
                const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
                set(y, x, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
            }
        }
    }
    for (let i = 8; i < size - 8; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }
    const centers = ALIGNMENT[version];
    const last = centers.length - 1;
    centers.forEach((r, i) => centers.forEach((c, j) => {
        // The three corners hold finder patterns.
        if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0))
            return;
        for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++)
                set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
    }));
    set(size - 8, 8, true);
    for (let i = 0; i < 9; i++) {
        reserved[8][i] = reserved[i][8] = true;
        if (i < 8)
            reserved[8][size - 1 - i] = reserved[size - 1 - i][8] = true;
    }
    if (version >= 7) {
        const info = bch(version, 0x1f25, 18);
        for (let i = 0; i < 18; i++) {
            const dark = ((info >> i) & 1) === 1;
            const [a, b] = [Math.floor(i / 3), size - 11 + (i % 3)];
            set(a, b, dark);
            set(b, a, dark);
        }
    }

    const bits = codewords(bytes, version).flatMap(byte => [7, 6, 5, 4, 3, 2, 1, 0].map(i => ((byte >> i) & 1) === 1));
    let at = 0;
    for (let right = size - 1, upward = true; right > 0; right -= 2, upward = !upward) {
        if (right === 6)
            right = 5;
        for (let step = 0; step < size; step++) {
            const r = upward ? size - 1 - step : step;
            for (const c of [right, right - 1]) {
                if (reserved[r][c])
                    continue;
                modules[r][c] = at < bits.length ? bits[at] : false;
                at++;
            }
        }
    }

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const candidate = modules.map((row, r) => row.map((dark, c) => (reserved[r][c] ? dark : dark !== MASKS[mask](r, c))));
        // Level M is 00; the 15 bits are XORed with 101010000010010.
        const format = bch(mask, 0x537, 15) ^ 0x5412;
        for (let i = 0; i < 15; i++) {
            const dark = ((format >> i) & 1) === 1;
            if (i < 6)
                candidate[i][8] = dark;
            else if (i < 8)
                candidate[i + 1][8] = dark;
            else
                candidate[size - 15 + i][8] = dark;
            if (i < 8)
                candidate[8][size - 1 - i] = dark;
            else if (i < 9)
                candidate[8][7] = dark;
            else
                candidate[8][14 - i] = dark;
        }
        candidate[size - 8][8] = true;
        const score = penalty(candidate);
        if (!best || score < best.score)
            best = {score, candidate};
    }
    return best.candidate;
}
