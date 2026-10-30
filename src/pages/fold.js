// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'gettext';

import {groupTitle} from './common.js';

let folding = true;

// Off where each group has a page of its own.
export function setFolding(on) {
    folding = on;
}

// Rows of a folded group are taken out rather than hidden: groups show and hide rows of
// their own, and unfolding would undo that.
export const FoldGroup = GObject.registerClass(
class FoldGroup extends Adw.PreferencesGroup {
    _init(params) {
        super._init(params);
        this._children = [];
        this._folded = false;
    }

    add(child) {
        this._children.push(child);
        if (this._folded)
            this._describe();
        else
            super.add(child);
    }

    remove(child) {
        this._children = this._children.filter(c => c !== child);
        if (!this._folded)
            super.remove(child);
    }

    // Kept in folded-groups under id; summary() is the description while folded.
    foldable(settings, id, summary = () => null) {
        if (!folding)
            return null;
        this._open = this.description;
        this._summary = summary;
        this._fold = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat', 'circular']});
        const toggle = () => {
            const folded = !this._folded;
            const others = settings.get_strv('folded-groups').filter(g => g !== id);
            settings.set_strv('folded-groups', folded ? [...others, id] : others);
            this._setFolded(folded);
        };
        this._fold.connect('clicked', toggle);
        this._unfold = () => {
            if (this._folded)
                toggle();
        };
        const title = groupTitle(this);
        if (title) {
            const click = new Gtk.GestureClick();
            click.connect('released', toggle);
            title.add_controller(click);
            title.set_cursor_from_name('pointer');
        }
        const suffix = this.header_suffix;
        if (suffix) {
            this.header_suffix = null;
            const box = new Gtk.Box({spacing: 6});
            box.append(suffix);
            box.append(this._fold);
            this.header_suffix = box;
        } else {
            this.header_suffix = this._fold;
        }
        this._setFolded(settings.get_strv('folded-groups').includes(id));
        return this._fold;
    }

    // The widget to scroll to for a device in this group; the group itself by default.
    reveal(_did) {
        this._unfold?.();
        return this;
    }

    _setFolded(folded) {
        this._fold.icon_name = folded ? 'pan-end-symbolic' : 'pan-down-symbolic';
        this._fold.tooltip_text = folded ? _('Expand') : _('Collapse');
        if (folded !== this._folded) {
            this._folded = folded;
            for (const child of this._children) {
                if (folded)
                    super.remove(child);
                else
                    super.add(child);
            }
        }
        this._describe();
    }

    _describe() {
        this.description = this._folded ? this._summary() : this._open;
    }
});
