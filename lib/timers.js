// SPDX-License-Identifier: GPL-2.0-or-later

// Timeouts no object owns: waits inside promises and the deadlines of one-off network
// operations. disable() removes the ones still pending; their waits never end, and a
// deadline's cleanup releases what its callback would have.

import GLib from 'gi://GLib';

const pending = new Map();

export function timeout(ms, callback, {priority = GLib.PRIORITY_DEFAULT, cleanup = null} = {}) {
    const id = GLib.timeout_add(priority, ms, () => {
        let again = GLib.SOURCE_REMOVE;
        try {
            again = callback();
        } finally {
            if (again !== GLib.SOURCE_CONTINUE)
                pending.delete(id);
        }
        return again;
    });
    pending.set(id, cleanup);
    return id;
}

export function remove(id) {
    if (pending.delete(id))
        GLib.source_remove(id);
}

export function sleep(ms, priority = GLib.PRIORITY_DEFAULT) {
    return new Promise(resolve => timeout(ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }, {priority}));
}

export function removeAll() {
    for (const [id, cleanup] of pending) {
        pending.delete(id);
        GLib.MainContext.default().find_source_by_id(id)?.destroy();
        try {
            cleanup?.();
        } catch (e) {
            logError(e);
        }
    }
}
