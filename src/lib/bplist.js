// SPDX-License-Identifier: GPL-2.0-or-later

// Binary property lists (bplist00), as AirPlay's SETUP and data stream carry them.
// Integers become numbers, data Uint8Array, dictionaries plain objects.

const encoder = new TextEncoder();
const MAGIC = encoder.encode('bplist00');

function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

function bigEndian(value, bytes) {
    const out = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--, value = Math.floor(value / 256))
        out[i] = value % 256;
    return out;
}

const widthOf = value => (value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x100000000 ? 4 : 8);

export function encode(root) {
    const objects = [];
    const add = value => {
        const index = objects.length;
        objects.push(null);
        if (Array.isArray(value)) {
            objects[index] = {list: value.map(add)};
        } else if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
            const entries = Object.entries(value).filter(([, item]) => item !== undefined);
            const keys = entries.map(([key]) => add(key));
            objects[index] = {keys, values: entries.map(([, item]) => add(item))};
        } else {
            objects[index] = {value};
        }
        return index;
    };
    add(root);
    const refSize = widthOf(objects.length);
    const head = (type, count) => (count < 15 ? [Uint8Array.of(type | count)]
        : [Uint8Array.of(type | 0xf), ...serialize({value: count})]);
    const serialize = ({value, list, keys, values}) => {
        if (list)
            return [...head(0xa0, list.length), ...list.map(i => bigEndian(i, refSize))];
        if (keys)
            return [...head(0xd0, keys.length), ...[...keys, ...values].map(i => bigEndian(i, refSize))];
        if (value === null)
            return [Uint8Array.of(0x00)];
        if (value === true || value === false)
            return [Uint8Array.of(value ? 0x09 : 0x08)];
        if (typeof value === 'number' && Number.isInteger(value)) {
            if (value < 0) {
                const out = new Uint8Array(9);
                out[0] = 0x13;
                new DataView(out.buffer).setBigInt64(1, BigInt(value));
                return [out];
            }
            const width = widthOf(value);
            return [Uint8Array.of(0x10 | Math.log2(width)), bigEndian(value, width)];
        }
        if (typeof value === 'number') {
            const out = new Uint8Array(9);
            out[0] = 0x23;
            new DataView(out.buffer).setFloat64(1, value);
            return [out];
        }
        if (value instanceof Uint8Array)
            return [...head(0x40, value.length), value];
        if (typeof value === 'string') {
            if ([...value].every(c => c.charCodeAt(0) < 0x80))
                return [...head(0x50, value.length), encoder.encode(value)];
            const units = new Uint8Array(value.length * 2);
            for (let i = 0; i < value.length; i++) {
                units[2 * i] = value.charCodeAt(i) >> 8;
                units[2 * i + 1] = value.charCodeAt(i) & 0xff;
            }
            return [...head(0x60, value.length), units];
        }
        throw new Error(`Cannot encode ${typeof value} in a plist`);
    };
    const body = objects.map(object => concat(serialize(object)));
    const offsets = [];
    let at = MAGIC.length;
    for (const part of body) {
        offsets.push(at);
        at += part.length;
    }
    const offsetSize = widthOf(at);
    const trailer = new Uint8Array(32);
    trailer[6] = offsetSize;
    trailer[7] = refSize;
    const view = new DataView(trailer.buffer);
    view.setBigUint64(8, BigInt(objects.length));
    view.setBigUint64(16, 0n);
    view.setBigUint64(24, BigInt(at));
    return concat([MAGIC, ...body, ...offsets.map(o => bigEndian(o, offsetSize)), trailer]);
}

function readBig(data, at, width) {
    let value = 0;
    for (let i = 0; i < width; i++)
        value = value * 256 + data[at + i];
    return value;
}

export function decode(data) {
    if (data.length < 40 || MAGIC.some((b, i) => data[i] !== b))
        throw new Error('Not a binary plist');
    const trailer = new DataView(data.buffer, data.byteOffset + data.length - 32, 32);
    const offsetSize = trailer.getUint8(6);
    const refSize = trailer.getUint8(7);
    const count = Number(trailer.getBigUint64(8));
    const top = Number(trailer.getBigUint64(16));
    const table = Number(trailer.getBigUint64(24));
    const offset = i => readBig(data, table + i * offsetSize, offsetSize);
    const depth = new Set();
    const read = index => {
        if (index >= count || depth.has(index))
            throw new Error('Broken plist');
        const at = offset(index);
        const marker = data[at];
        const type = marker >> 4, info = marker & 0xf;
        const length = () => {
            if (info !== 0xf)
                return [info, at + 1];
            const width = 1 << (data[at + 1] & 0xf);
            return [readBig(data, at + 2, width), at + 2 + width];
        };
        switch (type) {
        case 0x0:
            return info === 0x9 ? true : info === 0x8 ? false : null;
        case 0x1: {
            const width = 1 << info;
            if (width === 8)
                return Number(new DataView(data.buffer, data.byteOffset + at + 1, 8).getBigInt64(0));
            return readBig(data, at + 1, width);
        }
        case 0x2: {
            const view = new DataView(data.buffer, data.byteOffset + at + 1, 1 << info);
            return info === 2 ? view.getFloat32(0) : view.getFloat64(0);
        }
        case 0x3:
            return new Date((new DataView(data.buffer, data.byteOffset + at + 1, 8).getFloat64(0) + 978307200) * 1000);
        case 0x4: {
            const [n, start] = length();
            return data.slice(start, start + n);
        }
        case 0x5: {
            const [n, start] = length();
            return String.fromCharCode(...data.subarray(start, start + n));
        }
        case 0x6: {
            const [n, start] = length();
            let text = '';
            for (let i = 0; i < n; i++)
                text += String.fromCharCode((data[start + 2 * i] << 8) | data[start + 2 * i + 1]);
            return text;
        }
        case 0x8:
            return {UID: readBig(data, at + 1, info + 1)};
        case 0xa: case 0xd: {
            const [n, start] = length();
            const refs = Array.from({length: type === 0xd ? 2 * n : n}, (_, i) => readBig(data, start + i * refSize, refSize));
            depth.add(index);
            try {
                if (type === 0xa)
                    return refs.map(read);
                const out = {};
                for (let i = 0; i < n; i++)
                    out[read(refs[i])] = read(refs[n + i]);
                return out;
            } finally {
                depth.delete(index);
            }
        }
        default:
            throw new Error(`Unknown plist object 0x${marker.toString(16)}`);
        }
    };
    return read(top);
}
