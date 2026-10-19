// SPDX-License-Identifier: GPL-2.0-or-later

// The protobuf subset TV remotes need: varints and length-delimited fields.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function varint(value) {
    const out = [];
    do {
        let byte = value % 128;
        value = Math.floor(value / 128);
        if (value > 0)
            byte |= 0x80;
        out.push(byte);
    } while (value > 0);
    return out;
}

export function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * [[field, value], ...]: numbers and booleans become varints; strings, bytes and nested
 * lists length-delimited fields. Repeat an entry for a repeated field; null skips it.
 */
export function encode(fields) {
    const parts = [];
    for (const [field, value] of fields) {
        if (value === null || value === undefined)
            continue;
        if (typeof value === 'number' || typeof value === 'boolean') {
            parts.push(Uint8Array.from([...varint(field * 8), ...varint(Number(value))]));
            continue;
        }
        let body = value;
        if (typeof value === 'string')
            body = encoder.encode(value);
        else if (!(value instanceof Uint8Array))
            body = encode(value);
        parts.push(Uint8Array.from([...varint(field * 8 + 2), ...varint(body.length)]), body);
    }
    return concat(parts);
}

/** [value, next offset], or null if the bytes end inside the varint. */
export function readVarint(bytes, at) {
    let value = 0, scale = 1;
    while (at < bytes.length) {
        const byte = bytes[at++];
        value += (byte & 0x7f) * scale;
        scale *= 128;
        if (!(byte & 0x80))
            return [value, at];
    }
    return null;
}

/** Field number to its values in order: numbers, or the bytes of length-delimited fields. */
export function decode(bytes) {
    const fields = new Map();
    let at = 0;
    const next = () => {
        const read = readVarint(bytes, at);
        if (!read)
            throw new Error('Truncated message');
        [, at] = read;
        return read[0];
    };
    while (at < bytes.length) {
        const key = next();
        const wire = key & 7;
        let value;
        if (wire === 0) {
            value = next();
        } else if (wire === 2) {
            const length = next();
            if (at + length > bytes.length)
                throw new Error('Truncated message');
            value = bytes.subarray(at, at + length);
            at += length;
        } else if (wire === 1 || wire === 5) {
            value = bytes.subarray(at, at + (wire === 1 ? 8 : 4));
            at += wire === 1 ? 8 : 4;
        } else {
            throw new Error(`Unknown wire type ${wire}`);
        }
        const field = Math.floor(key / 8);
        if (!fields.has(field))
            fields.set(field, []);
        fields.get(field).push(value);
    }
    return fields;
}

// Proto3 leaves out zeros, empty strings and empty messages: read them as such.
export const number = (fields, field) => fields.get(field)?.at(-1) ?? 0;
export const text = (fields, field) => {
    const value = fields.get(field)?.at(-1);
    return value instanceof Uint8Array ? decoder.decode(value) : '';
};
export const message = (fields, field) => decode(fields.get(field)?.at(-1) ?? new Uint8Array(0));
