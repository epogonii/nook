// SPDX-License-Identifier: GPL-2.0-or-later

// OPACK, Apple's binary encoding in the Companion protocol, as pyatv reads and writes it.
// Integers become numbers, data Uint8Array, dictionaries plain objects.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sized(length, sizes) {
    for (const [code, bytes] of sizes) {
        if (length < 2 ** (8 * bytes))
            return [code, ...littleEndian(length, bytes)];
    }
    throw new Error('Too large to pack');
}

function littleEndian(value, bytes) {
    const out = [];
    for (let i = 0; i < bytes; i++, value = Math.floor(value / 256))
        out.push(value % 256);
    return out;
}

function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

function packValue(value) {
    if (value === null || value === undefined)
        return Uint8Array.of(0x04);
    if (value === true || value === false)
        return Uint8Array.of(value ? 0x01 : 0x02);
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
            const out = new Uint8Array(9);
            out[0] = 0x36;
            new DataView(out.buffer).setFloat64(1, value, true);
            return out;
        }
        if (value < 0)
            throw new Error('Negative integers are not packed');
        if (value < 0x28)
            return Uint8Array.of(value + 8);
        for (const [code, bytes] of [[0x30, 1], [0x31, 2], [0x32, 4], [0x33, 8]]) {
            if (value < 2 ** (8 * bytes))
                return Uint8Array.from([code, ...littleEndian(value, bytes)]);
        }
    }
    if (typeof value === 'string') {
        const bytes = encoder.encode(value);
        const head = bytes.length <= 0x20 ? [0x40 + bytes.length]
            : sized(bytes.length, [[0x61, 1], [0x62, 2], [0x63, 3], [0x64, 4]]);
        return concat([Uint8Array.from(head), bytes]);
    }
    if (value instanceof Uint8Array) {
        const head = value.length <= 0x20 ? [0x70 + value.length]
            : sized(value.length, [[0x91, 1], [0x92, 2], [0x93, 4]]);
        return concat([Uint8Array.from(head), value]);
    }
    if (Array.isArray(value)) {
        const parts = [Uint8Array.of(0xd0 + Math.min(value.length, 0xf)), ...value.map(packValue)];
        if (value.length >= 0xf)
            parts.push(Uint8Array.of(0x03));
        return concat(parts);
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        const parts = [Uint8Array.of(0xe0 + Math.min(entries.length, 0xf))];
        for (const [key, item] of entries)
            parts.push(packValue(key), packValue(item));
        if (entries.length >= 0xf)
            parts.push(Uint8Array.of(0x03));
        return concat(parts);
    }
    throw new Error(`Cannot pack ${typeof value}`);
}

/** No back-references written: they only make a message shorter. */
export const pack = value => packValue(value);

function readLittle(data, at, bytes) {
    let value = 0;
    for (let i = bytes - 1; i >= 0; i--)
        value = value * 256 + data[at + i];
    return value;
}

// Strings, data, sized integers and UUIDs read before can be referred back to by index.
export function unpack(data) {
    const seen = [];
    const remember = value => {
        if (!seen.some(old => same(old, value)))
            seen.push(value);
    };
    const read = at => {
        const tag = data[at];
        if (tag === undefined)
            throw new Error('Truncated OPACK');
        if (tag === 0x01 || tag === 0x02)
            return [tag === 0x01, at + 1];
        if (tag === 0x04)
            return [null, at + 1];
        if (tag === 0x05) {
            const uuid = data.slice(at + 1, at + 17);
            remember(uuid);
            return [uuid, at + 17];
        }
        if (tag === 0x06) {
            const value = readLittle(data, at + 1, 8);
            remember(value);
            return [value, at + 9];
        }
        if (tag >= 0x08 && tag <= 0x2f)
            return [tag - 8, at + 1];
        if (tag === 0x35 || tag === 0x36) {
            const view = new DataView(data.buffer, data.byteOffset + at + 1, tag === 0x35 ? 4 : 8);
            const value = tag === 0x35 ? view.getFloat32(0, true) : view.getFloat64(0, true);
            remember(value);
            return [value, at + (tag === 0x35 ? 5 : 9)];
        }
        if ((tag & 0xf0) === 0x30) {
            const bytes = 2 ** (tag & 0xf);
            const value = readLittle(data, at + 1, bytes);
            remember(value);
            return [value, at + 1 + bytes];
        }
        if (tag >= 0x40 && tag <= 0x64) {
            const [length, start] = tag <= 0x60 ? [tag - 0x40, at + 1]
                : [readLittle(data, at + 1, tag & 0xf), at + 1 + (tag & 0xf)];
            const value = decoder.decode(data.subarray(start, start + length));
            remember(value);
            return [value, start + length];
        }
        if (tag >= 0x70 && tag <= 0x94) {
            const width = tag <= 0x90 ? 0 : 1 << ((tag & 0xf) - 1);
            const [length, start] = tag <= 0x90 ? [tag - 0x70, at + 1] : [readLittle(data, at + 1, width), at + 1 + width];
            const value = data.slice(start, start + length);
            remember(value);
            return [value, start + length];
        }
        if (tag >= 0xa0 && tag <= 0xc0)
            return [seen[tag - 0xa0], at + 1];
        if (tag >= 0xc1 && tag <= 0xc4) {
            const width = tag - 0xc0;
            return [seen[readLittle(data, at + 1, width)], at + 1 + width];
        }
        if ((tag & 0xf0) === 0xd0 || (tag & 0xf0) === 0xe0) {
            const list = (tag & 0xf0) === 0xd0;
            const count = tag & 0xf;
            const out = list ? [] : {};
            let next = at + 1;
            for (let i = 0; count === 0xf ? data[next] !== 0x03 : i < count; i++) {
                let key, value;
                if (!list)
                    [key, next] = read(next);
                [value, next] = read(next);
                if (list)
                    out.push(value);
                else
                    out[key] = value;
            }
            return [out, count === 0xf ? next + 1 : next];
        }
        throw new Error(`Unknown OPACK tag 0x${tag.toString(16)}`);
    };
    return read(0)[0];
}

function same(a, b) {
    if (a instanceof Uint8Array && b instanceof Uint8Array)
        return a.length === b.length && a.every((byte, i) => byte === b[i]);
    return a === b;
}
