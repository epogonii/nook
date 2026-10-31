// SPDX-License-Identifier: GPL-2.0-or-later

// Online state is left out: known only after a read, it would make tiles jump.
const KIND_ORDER = {climate: 0, switch: 0, camera: 1, reading: 1, none: 2};

export function arrange(devices, {pinned, order, hidden}, withHidden = false) {
    const rank = did => {
        const i = order.indexOf(did);
        return i < 0 ? Infinity : i;
    };
    return devices
        .filter(d => withHidden || !hidden.includes(d.did))
        .sort((a, b) => {
            const pin = pinned.includes(b.did) - pinned.includes(a.did);
            if (pin !== 0)
                return pin;
            const [ra, rb] = [rank(a.did), rank(b.did)];
            if (ra !== rb)
                return ra - rb;
            return (KIND_ORDER[a.primary.kind] ?? 2) - (KIND_ORDER[b.primary.kind] ?? 2) ||
                a.name.localeCompare(b.name);
        });
}

export function move(arranged, moved, target, after) {
    if (moved === target)
        return arranged;
    const order = arranged.filter(did => did !== moved);
    const at = order.indexOf(target);
    order.splice(after ? at + 1 : at, 0, moved);
    return order;
}
