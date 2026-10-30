// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import {gettext as _, ngettext} from 'gettext';

import {sourceName} from './device.js';
import {listDevices} from './devices.js';
import * as Glyphs from './lib/glyphs.js';
import {findScrolled} from './pages/common.js';
import {GlyphWell, sidebarButton, subpage} from './widgets.js';

// Services by the kind of device they bring, so a brand doesn't need a row of its own.
function categories() {
    return [
        {id: 'hubs', glyph: 'hub', title: _('Apps and Hubs'),
            about: _('Mi Home, Home Assistant, HomeKit and Smart Life'),
            groups: ['mihome', 'hass', 'homekit', 'smartlife']},
        {id: 'climate', glyph: 'aircon', title: _('Air Conditioners'),
            about: _('Gree, Midea and Daikin on this network; LG, Samsung, Mitsubishi Electric and Electrolux through their apps'),
            groups: ['gree', 'lg', 'smartthings', 'melcloud', 'electrolux']},
        {id: 'lights', glyph: 'bulb', title: _('Lights and Switches'),
            about: _('Philips Hue, Shelly, Sonoff and eWeLink'),
            groups: ['hue', 'shelly', 'sonoff', 'ewelink']},
        {id: 'media', glyph: 'tv', title: _('TVs and Speakers'),
            about: _('TVs on this network and Google Cast speakers'),
            groups: ['tv', 'cast']},
        {id: 'cameras', glyph: 'camera', title: _('Cameras'),
            about: _('Tapo and other ONVIF cameras'),
            groups: ['tapo']},
    ];
}

// Which group lists a device, by its did.
const BELONGS = {
    mihome: did => !did.includes(':'),
    gree: did => /^(gree|midea|daikin):/.test(did),
    tapo: did => did.startsWith('tapo:'),
    cast: did => did.startsWith('cast:'),
    tv: did => did.startsWith('tv:'),
};

const belongs = (id, did) => BELONGS[id]?.(did) ?? did.startsWith(`${id}:`);

function deviceCount(count) {
    return ngettext('%d device', '%d devices', count).replace('%d', String(count));
}

// A tinted glyph for a row, like the wells on the tiles.
export function rowIcon(glyph) {
    const well = new GlyphWell({size: 16});
    well.add_css_class('small');
    well.set([glyph, Glyphs.colorOf(glyph, [0.6, 0.6, 0.6]), null], false, false);
    return well;
}

// The kinds of service as a short list; each opens a page with its sign-ins and searches.
export const AccountsPage = GObject.registerClass({
    Signals: {'add-devices': {}},
}, class AccountsPage extends Adw.NavigationPage {
    _init(settings, groups, nav) {
        super._init({title: _('Accounts'), tag: 'accounts'});
        this._settings = settings;
        this._groups = groups;
        this._nav = nav;
        this._pages = new Map();
        this._rows = new Map();
        this._recount = 0;

        const page = new Adw.PreferencesPage();
        const list = new Adw.PreferencesGroup({
            description: _('Sign in to the apps your devices are in, or add devices this computer finds on the network.'),
        });
        for (const category of categories()) {
            const row = new Adw.ActionRow({title: category.title, subtitle: category.about, activatable: true});
            row.add_prefix(rowIcon(category.glyph));
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', () => this.open(category.id));
            list.add(row);
            this._rows.set(category.id, [row, category]);
        }
        page.add(list);

        const header = new Adw.HeaderBar();
        header.pack_start(sidebarButton());
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: _('Add Devices')});
        add.connect('clicked', () => this.emit('add-devices'));
        header.pack_end(add);
        const view = new Adw.ToolbarView({content: page});
        view.add_top_bar(header);
        this.child = view;

        this._changed = settings.connect('changed', () => this._countSoon());
        this._count().catch(logError);
    }

    forget() {
        this._settings.disconnect(this._changed);
        if (this._recount)
            GLib.source_remove(this._recount);
        this._recount = 0;
    }

    _countSoon() {
        if (this._recount)
            return;
        this._recount = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._recount = 0;
            this._count().catch(logError);
            return GLib.SOURCE_REMOVE;
        });
    }

    // From settings and caches, as the extension's list was: no device is asked.
    async _count() {
        const devices = (await listDevices(this._settings)).filter(d => d.primary?.kind !== 'scene');
        for (const [row, category] of this._rows.values()) {
            const own = devices.filter(d => category.groups.some(id => belongs(id, d.did)));
            const services = [...new Set(own.map(d => sourceName(d.did)))];
            row.subtitle = GLib.markup_escape_text(own.length > 0
                ? `${services.join(', ')} · ${deviceCount(own.length)}` : category.about, -1);
        }
    }

    // id: a category; a group id opens the category that holds it.
    open(id, animate = true) {
        const category = categories().find(c => c.id === id || c.groups.includes(id));
        if (!category)
            return null;
        let page = this._pages.get(category.id);
        if (!page) {
            const content = new Adw.PreferencesPage();
            for (const group of category.groups)
                content.add(this._groups[group]);
            page = subpage(category.title, content, `accounts:${category.id}`);
            page.content = content;
            this._pages.set(category.id, page);
        }
        if (this._nav.visible_page !== page) {
            this._nav.animate_transitions = animate;
            this._nav.push(page);
            this._nav.animate_transitions = true;
        }
        return page;
    }

    // target: "accounts-hue", "accounts-tapo <did>".
    reveal(id, did) {
        const group = this._groups[id];
        const page = this.open(id, false);
        if (!group || !page)
            return;
        const widget = group.reveal?.(did) ?? group;
        // Again after 120 ms: the first layout and the focus Adw restores both scroll the page.
        const scroll = () => {
            const scrolled = findScrolled(page.content);
            const [ok, bounds] = widget.compute_bounds(scrolled?.child ?? page.content);
            if (scrolled && ok)
                scrolled.vadjustment.value += bounds.origin.y - 12;
            return GLib.SOURCE_REMOVE;
        };
        this.get_root()?.set_focus(null);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, scroll);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, scroll);
    }
});

// Find Devices as a dialog: looking for devices is an action, not a place.
export function addDevicesDialog(find) {
    const page = new Adw.PreferencesPage();
    page.add(find);
    const view = new Adw.ToolbarView({content: page});
    view.add_top_bar(new Adw.HeaderBar());
    return new Adw.Dialog({
        title: _('Add Devices'),
        content_width: 600,
        content_height: 680,
        child: view,
    });
}
