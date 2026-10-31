// SPDX-License-Identifier: GPL-2.0-or-later

// Dreame vacuum map: base64url(zlib(27-byte header, one byte per cell, JSON with tr)).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class MapError extends Error {}

const HEADER = 27;

// Real maps are a few hundred KB; this cap stops a runaway inflate.
const MAX_MAP = 64 << 20;

function inflate(bytes) {
    const input = Gio.ConverterInputStream.new(
        Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(bytes)),
        new Gio.ZlibDecompressor({format: Gio.ZlibCompressorFormat.ZLIB}));
    const chunks = [];
    let length = 0;
    for (;;) {
        const chunk = input.read_bytes(65536, null).toArray();
        if (chunk.length === 0)
            break;
        chunks.push(chunk);
        length += chunk.length;
        if (length > MAX_MAP)
            throw new MapError('the map is far too big');
    }
    const whole = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
        whole.set(chunk, at);
        at += chunk.length;
    }
    return whole;
}

/**
 * tr, e.g. "S96,378L50,0L-33,-60": S and M start a line at an absolute point, L steps
 * relative. Live-frame pieces continue from `from`; "l" is absolute but keeps the line.
 */
export function parsePath(text, from = {x: 0, y: 0}) {
    const points = [];
    let {x, y} = from;
    for (const [, operator, dx, dy] of text.matchAll(/([MLlSW])(-?\d+),(-?\d+)/g)) {
        if (operator === 'M' || operator === 'S' || operator === 'l') {
            x = Number(dx);
            y = Number(dy);
        } else {
            x += Number(dx);
            y += Number(dy);
        }
        points.push({x, y, jump: operator !== 'L' && operator !== 'l'});
    }
    return points;
}

function runsOf(pixels, width, height) {
    const runs = [];
    for (let row = 0; row < height; row++) {
        let start = 0;
        let kind = 0;
        for (let column = 0; column <= width; column++) {
            const next = column < width ? pixels[row * width + column] : -1;
            if (next === kind)
                continue;
            if (kind !== 0)
                runs.push([row, start, column, kind]);
            start = column;
            kind = next;
        }
    }
    return runs;
}

export function decodeMap(text, saved = false) {
    let bytes;
    try {
        bytes = inflate(GLib.base64_decode(text.trim().replace(/-/g, '+').replace(/_/g, '/')));
    } catch (e) {
        throw new MapError(`the map could not be unpacked: ${e.message}`);
    }
    if (bytes.length < HEADER)
        throw new MapError('the map is empty');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const number = offset => view.getInt16(offset, true);
    const map = {
        frame: String.fromCharCode(bytes[4]),
        robot: {x: number(5), y: number(7), angle: number(9)},
        charger: {x: number(11), y: number(13), angle: number(15)},
        grid: number(17),
        width: number(19),
        height: number(21),
        left: number(23),
        top: number(25),
    };
    const size = map.width * map.height;
    // A live (P) frame with nothing new has no grid, only position and path.
    const bare = map.frame === 'P' && size === 0;
    if ((!bare && (map.grid <= 0 || map.width <= 0 || map.height <= 0)) || size < 0 || bytes.length < HEADER + size)
        throw new MapError('the map is not whole');
    const pixels = bytes.subarray(HEADER, HEADER + size);
    let extra = null;
    try {
        extra = JSON.parse(new TextDecoder().decode(bytes.subarray(HEADER + size)));
    } catch {}
    map.kinds = [...new Set(pixels)].sort((a, b) => a - b);
    map.runs = runsOf(pixels, map.width, map.height);
    map.trace = typeof extra?.tr === 'string' ? extra.tr : '';
    map.path = parsePath(map.trace);
    // On a saved map (ris 2) the live grid starts empty around the robot and the saved
    // map rides along in rism (room ids, walls with bit 0x80). Show that one instead.
    if (!saved && extra?.ris === 2 && typeof extra.rism === 'string') {
        try {
            const home = decodeMap(extra.rism, true);
            return {...home, robot: map.robot, path: map.path, frame: map.frame, rooms: true};
        } catch (e) {
            if (!(e instanceof MapError))
                throw e;
        }
    }
    return map;
}
