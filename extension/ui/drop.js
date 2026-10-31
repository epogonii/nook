// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

import {arrange, move} from '../lib/arrange.js';
import {readSetting} from './text.js';
import {Tile, tileSection} from './tiles.js';

const DROP_ZONES = ['drop-before', 'drop-after', 'drop-into'];
// Share of a tile at each end that reorders; the middle groups.
const DROP_EDGE = 0.3;
// Logical px: band at the list's top and bottom that scrolls it during a drag, and the
// speed per second at the very edge.
const SCROLL_EDGE = 48;
const SCROLL_SPEED = 800;
const SCROLL_TICK = 16;

// Module view drag and drop. Order moves only show within a module, so a tile dropped on a
// loose one of another section groups with it.
export class TileDrop {
    constructor(settings, devices, scroll) {
        this._settings = settings;
        this._devices = devices;
        this._scroll = scroll;
        this._marked = null;
        this._later = 0;
        this._scrolling = 0;
        this._pointer = null;
        this._source = null;
        this._monitor = {
            dragMotion: event => {
                this._pointer = [event.x, event.y];
                this._source = event.source;
                this._mark(null);
                this._autoscroll();
                return DND.DragMotionResult.CONTINUE;
            },
        };
    }

    begin() {
        DND.addDragMonitor(this._monitor);
    }

    end() {
        DND.removeDragMonitor(this._monitor);
        this._mark(null);
        if (this._scrolling)
            GLib.source_remove(this._scrolling);
        this._scrolling = 0;
        this._pointer = null;
        this._source = null;
    }

    _speed() {
        if (!this._pointer)
            return 0;
        const [x, y] = this._pointer;
        const [left, top] = this._scroll.get_transformed_position();
        const [width, height] = this._scroll.get_transformed_size();
        if (x < left || x > left + width || y < top || y > top + height)
            return 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const edge = SCROLL_EDGE * scale;
        if (y < top + edge)
            return -SCROLL_SPEED * scale * (1 - (y - top) / edge);
        if (y > top + height - edge)
            return SCROLL_SPEED * scale * (1 - (top + height - y) / edge);
        return 0;
    }

    _autoscroll() {
        if (this._scrolling || this._speed() === 0)
            return;
        let last = GLib.get_monotonic_time();
        this._scrolling = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_TICK, () => {
            const now = GLib.get_monotonic_time();
            const speed = this._speed();
            const adjustment = this._scroll.vadjustment;
            const value = Math.min(Math.max(adjustment.value + speed * (now - last) / 1e6, adjustment.lower),
                adjustment.upper - adjustment.page_size);
            last = now;
            if (speed === 0 || value === adjustment.value) {
                this._scrolling = 0;
                return GLib.SOURCE_REMOVE;
            }
            adjustment.value = value;
            this._hover();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // The list moved under a still pointer: find the drop target again, as a motion would.
    _hover() {
        const [x, y] = this._pointer;
        this._mark(null);
        for (let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y); actor; actor = actor.get_parent()) {
            if (!actor._delegate?.handleDragOver)
                continue;
            const [, targetX, targetY] = actor.transform_stage_point(x, y);
            if (actor._delegate.handleDragOver(this._source, null, targetX, targetY, 0) !== DND.DragMotionResult.CONTINUE)
                break;
        }
    }

    stop() {
        this.end();
        if (this._later)
            GLib.source_remove(this._later);
        this._later = 0;
    }

    _groups() {
        return readSetting(this._settings, 'groups');
    }

    _section(tile) {
        return tileSection(tile.device, tile.extra, readSetting(this._settings, 'icons'));
    }

    // Before or after only where the dragged tile then shows: in the target's group, or in its
    // own section when that is the target's.
    _zone(target, source, x) {
        if (target.device === source.device)
            return null;
        if (!(target.device.did in this._groups()) && this._section(target) !== this._section(source))
            return 'into';
        const [width] = target.get_size();
        const at = x / width;
        if (at < DROP_EDGE)
            return 'before';
        return at > 1 - DROP_EDGE ? 'after' : 'into';
    }

    _mark(actor, zone = null) {
        if (this._marked) {
            this._marked.disconnectObject(this);
            for (const name of DROP_ZONES)
                this._marked.remove_style_pseudo_class(name);
        }
        this._marked = actor;
        if (!actor)
            return;
        actor.add_style_pseudo_class(`drop-${zone}`);
        actor.connectObject('destroy', () => {
            this._marked = null;
        }, this);
    }

    over(target, source, x) {
        const zone = this._zone(target, source, x);
        if (!zone)
            return DND.DragMotionResult.NO_DROP;
        this._mark(target, zone);
        return DND.DragMotionResult.MOVE_DROP;
    }

    // Settings are written after the drop: the redraw destroys the dragged tile.
    _soon(write) {
        if (this._later)
            GLib.source_remove(this._later);
        this._later = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._later = 0;
            write();
            return GLib.SOURCE_REMOVE;
        });
    }

    accept(target, source, x) {
        const zone = this._zone(target, source, x);
        // dnd.js offers a refused drop to the parents, and the panel would take the tile out.
        if (!zone)
            return true;
        const [did, onto] = [source.device.did, target.device.did];
        const [one, other] = [source.device, target.device];
        this._soon(() => {
            const groups = {...this._groups()};
            if (zone === 'into')
                groups[onto] ??= this._newName(groups, one, other);
            if (onto in groups)
                groups[did] = groups[onto];
            else
                delete groups[did];
            this._samePin(did, onto);
            this._write(groups, did, onto, zone !== 'before');
        });
        return true;
    }

    // Drop target for a group's module outside its tiles.
    group(name, members, box) {
        return {
            handleDragOver: source => {
                if (!(source instanceof Tile))
                    return DND.DragMotionResult.CONTINUE;
                if (this._groups()[source.device.did] === name)
                    return DND.DragMotionResult.NO_DROP;
                this._mark(box, 'into');
                return DND.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: source => {
                if (!(source instanceof Tile))
                    return false;
                // Swallowed: the panel behind would take it out.
                if (this._groups()[source.device.did] === name)
                    return true;
                const did = source.device.did;
                this._soon(() => {
                    const last = members.at(-1);
                    this._samePin(did, last);
                    this._write({...this._groups(), [did]: name}, did, last, true);
                });
                return true;
            },
        };
    }

    // Drop target for the panel around the modules and for the sections: takes a tile out of
    // its group, back to its section.
    outside() {
        const takes = source => source instanceof Tile && source.device.did in this._groups();
        return {
            handleDragOver: source => takes(source) ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP,
            acceptDrop: source => {
                if (!takes(source))
                    return false;
                const did = source.device.did;
                this._soon(() => {
                    const groups = {...this._groups()};
                    delete groups[did];
                    this._write(groups);
                });
                return true;
            },
        };
    }

    rename(name, to) {
        const groups = this._groups();
        for (const did of Object.keys(groups)) {
            if (groups[did] === name)
                groups[did] = to;
        }
        this._write(groups);
    }

    _newName(groups, one, other) {
        const taken = new Set(Object.values(groups));
        if (one.room && one.room === other.room && !taken.has(one.room))
            return one.room;
        for (let n = 1; ; n++) {
            const name = _('Group %s').replace('%s', String(n));
            if (!taken.has(name))
                return name;
        }
    }

    // Pinned devices sort first; a move across that line would not show.
    _samePin(did, onto) {
        const pinned = readSetting(this._settings, 'pinned');
        if (pinned.includes(did) === pinned.includes(onto))
            return;
        this._settings.set_strv('pinned', pinned.includes(onto) ? [...pinned, did] : pinned.filter(p => p !== did));
    }

    _write(groups, moved = null, onto = null, after = false) {
        const sizes = {};
        for (const name of Object.values(groups))
            sizes[name] = (sizes[name] ?? 0) + 1;
        for (const [did, name] of Object.entries(groups)) {
            if (sizes[name] < 2)
                delete groups[did];
        }
        this._settings.set_value('groups', new GLib.Variant('a{ss}', groups));
        if (!moved)
            return;
        // Devices not loaded right now keep their place.
        const order = readSetting(this._settings, 'order');
        const ids = arrange(this._devices(), {
            pinned: readSetting(this._settings, 'pinned'),
            order,
            hidden: [],
        }, true).map(d => d.did);
        this._settings.set_strv('order', [...move(ids, moved, onto, after), ...order.filter(did => !ids.includes(did))]);
    }
}
