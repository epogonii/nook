// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';
import {gettext as _} from 'gettext';

import {AccountsPage, addDevicesDialog} from './accounts.js';
import {DevicePage} from './device.js';
import {HomePage} from './home.js';
import {AirconGroup} from './pages/aircons.js';
import {CamerasGroup} from './pages/cameras.js';
import {CloudAirconGroup} from './pages/cloud-aircons.js';
import {CLOUD_AIRCONS} from './pages/common.js';
import {EwelinkGroup} from './pages/ewelink.js';
import {FindGroup} from './pages/find.js';
import {setFolding} from './pages/fold.js';
import {HassGroup} from './pages/hass.js';
import {HomeKitGroup} from './pages/homekit.js';
import {HueGroup} from './pages/hue.js';
import {ShellyGroup} from './pages/shelly.js';
import {SmartLifeGroup} from './pages/smartlife.js';
import {SonoffGroup} from './pages/sonoff.js';
import {SpeakersGroup} from './pages/speakers.js';
import {TvsGroup} from './pages/tvs.js';
import {XiaomiGroup} from './pages/xiaomi.js';
import {TopBarPage} from './topbar.js';
import {CameraPin} from './widgets.js';

// A row of the sidebar: one place in the window.
const PlaceRow = GObject.registerClass(
class PlaceRow extends Gtk.ListBoxRow {
    _init(place, title, icon) {
        super._init();
        this.place = place;
        const box = new Gtk.Box({spacing: 12});
        box.append(new Gtk.Image({icon_name: icon}));
        this.label = new Gtk.Label({label: title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END});
        box.append(this.label);
        this.child = box;
    }
});

export const Window = GObject.registerClass(
class Window extends Adw.ApplicationWindow {
    _init(application, settings, service) {
        super._init({
            application,
            title: _('Nook'),
            default_width: 1080,
            default_height: 720,
            width_request: 360,
            height_request: 360,
        });
        this._settings = settings;
        this._menu = service.menu;
        this._place = 'home';

        // Inside the groups, rows fold no more: each service has a page of its own.
        setFolding(false);
        const xiaomi = new XiaomiGroup(settings, this);
        const gree = new AirconGroup(settings, this);
        const cameras = new CamerasGroup(settings, this);
        const speakers = new SpeakersGroup(settings, this);
        const tvs = new TvsGroup(settings, this);
        const sonoff = new SonoffGroup(settings, this);
        const shelly = new ShellyGroup(settings, this);
        const ewelink = new EwelinkGroup(settings, this);
        const hue = new HueGroup(settings, this);
        const hass = new HassGroup(settings, this);
        const homekit = new HomeKitGroup(settings, this);
        const smartlife = new SmartLifeGroup(settings, this);
        const clouds = CLOUD_AIRCONS().map(spec => [spec.id, new CloudAirconGroup(settings, this, spec)]);
        this._groups = {
            mihome: xiaomi, gree, tapo: cameras, cast: speakers, tv: tvs, sonoff, shelly, ewelink, hue, hass,
            homekit, smartlife, ...Object.fromEntries(clouds),
        };
        this._find = new FindGroup(settings, this, [
            {name: _('Air Conditioners'), about: _('Gree, Midea and Daikin units, by a broadcast on this network.'),
                find: () => gree._find('255.255.255.255', true)},
            {name: _('Cameras'), about: _('Tapo cameras, by ONVIF. A camera answers only once its camera account exists.'),
                find: () => cameras._find(true)},
            {name: _('Speakers'), about: _('Google Cast speakers and displays, by mDNS.'),
                find: () => speakers._find(true)},
            {name: _('TVs'), about: _('By mDNS and UPnP.'),
                find: looking => tvs._find(true, looking), survey: true},
            {name: _('Sonoff Switches'), about: _('Switches in DIY mode, by mDNS.'),
                find: () => sonoff._find(true)},
            {name: _('Shelly'), about: _('Shelly relays, plugs, lights and covers of every generation, by mDNS.'),
                find: () => shelly._find(true)},
            {name: _('eWeLink Devices'), about: _('By mDNS, once the eWeLink account is logged in. Their device IDs are sent to that account.'),
                find: looking => ewelink._find(true, looking), survey: true},
            {name: _('Philips Hue'), about: _('Hue bridges, by mDNS.'),
                find: looking => hue._find(true, looking)},
            {name: _('HomeKit'), about: _('HomeKit accessories, by mDNS.'),
                find: looking => homekit._find(true, looking)},
        ]);
        this._findDialog = addDevicesDialog(this._find);

        this._nav = new Adw.NavigationView();
        this._home = new HomePage(service, settings);
        this._accounts = new AccountsPage(settings, this._groups, this._nav);
        this._topBar = new TopBarPage(this._menu, settings, this._home, this._nav);
        this._home.connect('add-devices', () => this.addDevices());
        this._home.connect('show-accounts', () => this.showPlace('accounts'));
        this._accounts.connect('add-devices', () => this.addDevices());
        this._home.connect('open-device', (_home, device) => this._openDevice(device));
        this._nav.connect('popped', (_nav, page) => page.forget?.());
        this._nav.connect('replaced', () => this._home.devicePage?.forget());

        this._list = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
        this._list.connect('row-activated', (_list, row) => this.showPlace(row.place));
        this._list.set_header_func(row => {
            row.set_header(row.place === 'accounts' ? new Gtk.Label({
                label: _('Setup'),
                xalign: 0,
                css_classes: ['heading', 'dim-label'],
                margin_start: 12,
                margin_top: 12,
                margin_bottom: 6,
            }) : null);
        });
        const menuButton = new Gtk.MenuButton({
            icon_name: 'open-menu-symbolic',
            primary: true,
            tooltip_text: _('Main Menu'),
            menu_model: this._mainMenu(),
        });
        const brand = new Gtk.Box({spacing: 6, css_classes: ['nook-brand']});
        brand.append(new Gtk.Image({icon_name: 'io.github.epogonii.nook-symbolic'}));
        brand.append(new Gtk.Label({label: _('Nook'), css_classes: ['title']}));
        const sidebarHeader = new Adw.HeaderBar({title_widget: brand});
        sidebarHeader.pack_end(menuButton);
        const sidebarView = new Adw.ToolbarView({
            content: new Gtk.ScrolledWindow({hscrollbar_policy: Gtk.PolicyType.NEVER, child: this._list}),
        });
        sidebarView.add_top_bar(sidebarHeader);
        const pin = new CameraPin();
        pin.connect('open', () => {
            if (this._nav.visible_page === this._home.devicePage && this._home.devicePage.device === pin.device)
                return;
            this.showPlace('home');
            this._openDevice(pin.device);
        });
        this._home.connect('pin-changed', () => {
            const device = this._home.pinned;
            pin.set(device, device && this._home.nameOf(device), device && this._home.stillOf(device));
        });
        sidebarView.add_bottom_bar(pin);

        this._split = new Adw.OverlaySplitView({
            sidebar: sidebarView,
            content: this._nav,
            min_sidebar_width: 200,
            max_sidebar_width: 260,
            css_classes: ['nook-dark-side'],
        });
        const sidebar = Gio.SimpleAction.new_stateful('show-sidebar', null, GLib.Variant.new_boolean(true));
        sidebar.connect('change-state', (action, value) => {
            action.set_state(value);
            this._split.show_sidebar = value.get_boolean();
        });
        // Collapsing hides it, and a click beside the overlay closes it.
        this._split.connect('notify::show-sidebar', () => {
            if (sidebar.state.get_boolean() !== this._split.show_sidebar)
                sidebar.set_state(GLib.Variant.new_boolean(this._split.show_sidebar));
        });
        this.add_action(sidebar);
        application.set_accels_for_action('win.show-sidebar', ['F9']);
        this._toasts = new Adw.ToastOverlay({child: this._split});
        this.content = this._toasts;

        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 640sp')});
        narrow.add_setter(this._split, 'collapsed', true);
        this.add_breakpoint(narrow);

        this._nav.add(this._home);
        this._fillSidebar();
        // Asked for before the extension's settings arrived: shown once they do.
        this._topBarAsked = false;
        this._presentHandler = this._menu.connect('notify::present', () => {
            this._fillSidebar();
            if (this._menu.present && this._topBarAsked) {
                this._topBarAsked = false;
                this.showPlace('top-bar');
            }
        });
        service.wantUi();

        this.connect('close-request', () => {
            for (const group of [...Object.values(this._groups), this._find])
                group.forget?.();
            this._home.devicePage?.forget();
            this._home.forget();
            this._accounts.forget();
            this._topBar.forget();
            this._menu.disconnect(this._presentHandler);
            return false;
        });
        this._home.start();
    }

    _mainMenu() {
        const menu = new Gio.Menu();
        const first = new Gio.Menu();
        first.append(_('Add Devices…'), 'win.add-devices');
        menu.append_section(null, first);
        const second = new Gio.Menu();
        second.append(_('Support Nook'), 'app.support');
        second.append(_('About Nook'), 'app.about');
        menu.append_section(null, second);
        const action = new Gio.SimpleAction({name: 'add-devices'});
        action.connect('activate', () => this.addDevices());
        this.add_action(action);
        return menu;
    }

    _fillSidebar() {
        const places = [['home', _('Home'), 'go-home-symbolic'], ['accounts', _('Accounts'), 'goa-panel-symbolic']];
        if (this._menu.present)
            places.push(['top-bar', _('Top Bar'), 'focus-top-bar-symbolic']);
        for (let row = this._list.get_first_child(); row; row = this._list.get_first_child())
            this._list.remove(row);
        for (const [place, title, icon] of places)
            this._list.append(new PlaceRow(place, title, icon));
        if (!places.some(([place]) => place === this._place))
            this._place = 'home';
        this._select();
    }

    _select() {
        for (let row = this._list.get_first_child(); row; row = row.get_next_sibling()) {
            if (row.place === this._place)
                this._list.select_row(row);
        }
    }

    // place: "home", "accounts", "top-bar". Home keeps the room its tabs show.
    showPlace(place) {
        this._place = place;
        this._select();
        let page;
        if (place === 'home') {
            page = this._home;
        } else if (place === 'accounts') {
            page = this._accounts;
        } else {
            page = this._topBar;
            page.refresh();
        }
        if (this._nav.navigation_stack.get_n_items() !== 1 || this._nav.visible_page !== page)
            this._nav.replace([page]);
        if (this._split.collapsed)
            this._split.show_sidebar = false;
    }

    _openDevice(device) {
        const page = new DevicePage(device, this._home, this._settings, this._menu);
        this._home.devicePage = page;
        this._nav.push(page);
    }

    addDevices() {
        this._findDialog.present(this);
    }

    // The account groups report through toasts, as they did in the preferences window.
    add_toast(toast) {
        this._toasts.add_toast(toast);
    }

    // target: "home", "accounts", "accounts-hue", "accounts-tapo <did>", "find", "top-bar".
    showPage(target) {
        const [id, did] = target.split(' ');
        if (id === 'find') {
            this.addDevices();
        } else if (id === 'top-bar') {
            this._topBarAsked = !this._menu.present;
            this.showPlace(this._menu.present ? 'top-bar' : 'home');
        } else if (id.startsWith('accounts-')) {
            this.showPlace('accounts');
            this._accounts.reveal(id.slice('accounts-'.length), did);
        } else if (id === 'accounts') {
            this.showPlace('accounts');
        } else {
            this.showPlace('home');
        }
    }
});
