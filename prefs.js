// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _, pgettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseSpeakers} from './lib/cast-home.js';
import * as EwelinkHome from './lib/ewelink-home.js';
import {parseAircons, parseUnits} from './lib/aircon-home.js';
import * as Hass from './lib/hass.js';
import * as SmartLifeHome from './lib/smartlife-home.js';
import * as Sonoff from './lib/sonoff.js';
import * as Tapo from './lib/tapo.js';
import {parseTvs} from './lib/tv-home.js';
import {AirconGroup} from './prefs/aircons.js';
import {CamerasGroup} from './prefs/cameras.js';
import {CloudAirconGroup} from './prefs/cloud-aircons.js';
import {CLOUD_AIRCONS, cachedDevices, findScrolled, hueDevices} from './prefs/common.js';
import {DevicesPage} from './prefs/devices-page.js';
import {EwelinkGroup} from './prefs/ewelink.js';
import {FindGroup} from './prefs/find.js';
import {HassGroup} from './prefs/hass.js';
import {HomeKitGroup} from './prefs/homekit.js';
import {HueGroup} from './prefs/hue.js';
import {SmartLifeGroup} from './prefs/smartlife.js';
import {ShellyGroup} from './prefs/shelly.js';
import {SonoffGroup} from './prefs/sonoff.js';
import {SpeakersGroup} from './prefs/speakers.js';
import {TvsGroup} from './prefs/tvs.js';
import {XiaomiGroup} from './prefs/xiaomi.js';

const PROJECT_URL = 'https://github.com/epogonii/nook';

const ISSUES_URL = 'https://github.com/epogonii/nook/issues';

const FEATURE_URL = 'https://github.com/epogonii/nook/issues/new?labels=enhancement';

const SPONSORS_URL = 'https://github.com/sponsors/epogonii';

const PAYPAL_URL = 'https://www.paypal.com/paypalme/pogonii';

const WALLETS = [
    ['Bitcoin', 'bc1qe6fjj3uv23e2yx2ry3wwhyrl7s2pqshau7mga3'],
    ['Ethereum', '0xDC9e1EfA0F8FAE71377F4018d4ff7D123369438e'],
    ['Solana', '3sYQyR27CVz1VcwCfoDLUioaAHk8jspQaSDHXEvBALxg'],
];

const QR_DIR = 'icons/qr';

const WALLET_QR_SIZE = 168;

const LOGO_FILE = 'icons/nook-logo.svg';

const LOGO_FILE_DARK = 'icons/nook-logo-dark.svg';

const LOGO_ANIMATION = 'icons/nook-logo-anim.svg';

const LOGO_ANIMATION_DARK = 'icons/nook-logo-anim-dark.svg';

const LOGO_SIZE = 96;

export default class NookPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const icons = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (!icons.get_search_path().includes(`${this.path}/icons`))
            icons.add_search_path(`${this.path}/icons`);

        const look = new Adw.PreferencesPage({
            name: 'appearance',
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        look.add(this._placementGroup(settings));
        look.add(this._appearanceGroup(settings));
        look.add(this._roomTabsGroup(settings));
        window.add(look);

        const gree = new AirconGroup(settings, window);
        const cameras = new CamerasGroup(settings, window);
        const speakers = new SpeakersGroup(settings, window);
        const tvs = new TvsGroup(settings, window);
        const sonoff = new SonoffGroup(settings, window);
        const shelly = new ShellyGroup(settings, window);
        const ewelink = new EwelinkGroup(settings, window);
        const hue = new HueGroup(settings, window);
        const hass = new HassGroup(settings, window);
        const homekit = new HomeKitGroup(settings, window);
        const smartlife = new SmartLifeGroup(settings, window);
        const clouds = CLOUD_AIRCONS().map(spec => new CloudAirconGroup(settings, window, spec));
        const devices = new DevicesPage(settings, new FindGroup(settings, window, [
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
        ]));
        window.add(devices);
        window.connect('close-request', () => {
            devices.forget();
            return false;
        });

        // Adw refocuses the last focused widget on page switch and scrolls to it.
        // Clear the focus and restore the Devices page's scroll position instead.
        let left = 0;
        // The visible_page property makes GJS warn about its getter type.
        let shown = window.get_visible_page();
        window.connect('notify::visible-page', () => {
            if (shown === devices)
                left = findScrolled(devices)?.vadjustment.value ?? 0;
            shown = window.get_visible_page();
            if (shown !== devices)
                return;
            window.set_focus(null);
            const restore = () => {
                const adjustment = findScrolled(devices)?.vadjustment;
                if (adjustment)
                    adjustment.value = left;
                return GLib.SOURCE_REMOVE;
            };
            // Restore at idle and again after 120 ms: layout scrolls the page once more.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, restore);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, restore);
        });

        const accounts = new Adw.PreferencesPage({
            name: 'accounts',
            title: _('Accounts'),
            icon_name: 'system-users-symbolic',
        });
        const xiaomi = new XiaomiGroup(settings, window);
        accounts.add(xiaomi);
        accounts.add(gree);
        accounts.add(cameras);
        accounts.add(speakers);
        accounts.add(tvs);
        accounts.add(sonoff);
        accounts.add(shelly);
        accounts.add(ewelink);
        accounts.add(hue);
        accounts.add(hass);
        accounts.add(homekit);
        accounts.add(smartlife);
        for (const cloud of clouds)
            accounts.add(cloud);
        window.connect('close-request', () => {
            gree.forget();
            cameras.forget();
            speakers.forget();
            tvs.forget();
            sonoff.forget();
            shelly.forget();
            ewelink.forget();
            hue.forget();
            hass.forget();
            homekit.forget();
            smartlife.forget();
            for (const cloud of clouds)
                cloud.forget();
            return false;
        });
        window.add(accounts);
        this._goTo(window, settings, accounts, new Map([
            ['accounts-mihome', xiaomi], ['accounts-gree', gree], ['accounts-tapo', cameras], ['accounts-cast', speakers],
            ['accounts-tv', tvs], ['accounts-sonoff', sonoff], ['accounts-shelly', shelly], ['accounts-ewelink', ewelink], ['accounts-hue', hue],
            ['accounts-hass', hass], ['accounts-homekit', homekit], ['accounts-smartlife', smartlife],
            ...clouds.map((cloud, i) => [`accounts-${CLOUD_AIRCONS()[i].id}`, cloud]),
        ]));

        this._window = window;
        this._closed = false;
        window.connect('close-request', () => {
            this._closed = true;
            return false;
        });
        window.add(this._aboutPage());
    }

    // The shell names a group, and maybe a device in it, in prefs-target before it opens this window.
    _goTo(window, settings, page, groups) {
        const go = () => {
            const [id, did] = settings.get_string('prefs-target').split(' ');
            if (!id)
                return;
            settings.set_string('prefs-target', '');
            const group = groups.get(id);
            if (!group)
                return;
            window.set_visible_page(page);
            const target = group.reveal(did);
            // Again after 120 ms: the first layout and the focus Adw restores both scroll the page.
            const scroll = () => {
                const scrolled = findScrolled(page);
                const [ok, bounds] = target.compute_bounds(scrolled?.child ?? page);
                if (scrolled && ok)
                    scrolled.vadjustment.value += bounds.origin.y - 12;
                return GLib.SOURCE_REMOVE;
            };
            window.set_focus(null);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, scroll);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, scroll);
        };
        const handler = settings.connect('changed::prefs-target', go);
        window.connect('close-request', () => {
            settings.disconnect(handler);
            return false;
        });
        go();
    }

    _logo() {
        const logo = new Gtk.Image({pixel_size: LOGO_SIZE});
        const style = Adw.StyleManager.get_default();
        // Gtk.Svg (GTK 4.22, GNOME 50) plays SMIL; older GTK gets the still logo.
        if (typeof Gtk.Svg !== 'function' || !Gtk.Settings.get_default().gtk_enable_animations) {
            const show = () => (logo.file = `${this.path}/${style.dark ? LOGO_FILE_DARK : LOGO_FILE}`);
            const handler = style.connect('notify::dark', show);
            logo.connect('destroy', () => style.disconnect(handler));
            show();
            return logo;
        }
        const load = name => Gio.File.new_for_path(`${this.path}/${name}`).load_contents(null)[1];
        const light = load(LOGO_ANIMATION);
        const dark = load(LOGO_ANIMATION_DARK);
        // A finished Gtk.Svg does not replay, so each visit to the page draws a fresh one.
        const play = () => {
            const svg = Gtk.Svg.new_from_bytes(new GLib.Bytes(style.dark ? dark : light));
            svg.set_frame_clock(logo.get_frame_clock());
            logo.paintable = svg;
            svg.play();
        };
        logo.connect('map', play);
        const handler = style.connect('notify::dark', () => {
            if (logo.get_mapped())
                play();
        });
        logo.connect('destroy', () => style.disconnect(handler));
        return logo;
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({
            name: 'about',
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        const header = new Adw.PreferencesGroup();
        page.add(header);
        header.add(this._logo());
        header.add(new Gtk.Label({
            label: this.metadata.name,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_top: 12,
            css_classes: ['title-1'],
        }));
        header.add(new Gtk.Label({
            label: _('Your smart home, from the top bar'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_top: 6,
            css_classes: ['dim-label'],
        }));

        const about = new Adw.PreferencesGroup();
        page.add(about);
        about.add(this._linkRow(_('Project page'), PROJECT_URL, PROJECT_URL));

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            homogeneous: true,
            halign: Gtk.Align.CENTER,
            spacing: 12,
            margin_top: 18,
        });
        buttons.append(this._pill(_('Report a problem'), ISSUES_URL));
        buttons.append(this._pill(_('Request a feature'), FEATURE_URL));
        about.add(buttons);
        about.add(new Gtk.Label({
            label: _('A device it gets wrong, or one it cannot reach yet - either one belongs in an issue.'),
            justify: Gtk.Justification.CENTER,
            wrap: true,
            max_width_chars: 44,
            margin_top: 12,
            css_classes: ['dim-label', 'caption'],
        }));

        const support = new Adw.PreferencesGroup({title: _('Support')});
        page.add(support);
        const free = new Adw.ActionRow({
            title: _('Nook is free and stays free. If it earned a coffee ☕'),
            title_lines: 0,
        });
        free.add_prefix(new Gtk.Image({icon_name: 'emblem-favorite-symbolic'}));
        support.add(free);
        support.add(this._linkRow(_('GitHub Sponsors'), _('Monthly or one time'), SPONSORS_URL));
        support.add(this._linkRow(_('PayPal'), PAYPAL_URL, PAYPAL_URL));
        this._wallets(support);

        support.add(new Gtk.Label({
            label: `· ${_('Nook %s').format(this.metadata['version-name'] ?? '')} ·`,
            justify: Gtk.Justification.CENTER,
            margin_top: 18,
            css_classes: ['dim-label', 'caption'],
        }));
        return page;
    }

    _wallets(group) {
        const networks = new Gtk.StringList();
        for (const [name] of WALLETS)
            networks.append(name);
        const network = new Adw.ComboRow({title: _('Cryptocurrency'), model: networks});
        group.add(network);

        const address = new Adw.ActionRow({
            title: _('Address'),
            subtitle_selectable: true,
            subtitle_lines: 0,
        });
        const copy = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy the address'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        address.add_suffix(copy);
        group.add(address);

        const code = new Gtk.Picture({
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            width_request: WALLET_QR_SIZE,
            height_request: WALLET_QR_SIZE,
        });
        group.add(code);

        const chosen = () => WALLETS[network.selected] ?? WALLETS[0];
        const show = () => {
            const [name, wallet] = chosen();
            address.subtitle = wallet;
            code.file = Gio.File.new_for_path(`${this.path}/${QR_DIR}/${name.toLowerCase().replaceAll(' ', '-')}.svg`);
            code.alternative_text = _('The %s address as a QR code').format(name);
        };
        network.connect('notify::selected', show);
        show();

        copy.connect('clicked', () => {
            const [name, wallet] = chosen();
            const value = new GObject.Value();
            value.init(GObject.TYPE_STRING);
            value.set_string(wallet);
            Gdk.Display.get_default()?.get_clipboard().set_value(value);
            if (!this._closed)
                this._window.add_toast(new Adw.Toast({title: _('%s address copied').format(name), timeout: 6}));
        });
    }

    _pill(label, url) {
        const button = new Gtk.Button({label, css_classes: ['pill']});
        button.connect('clicked', () => Gio.AppInfo.launch_default_for_uri(url, null));
        return button;
    }

    _linkRow(title, subtitle, url) {
        const row = new Adw.ActionRow({title, subtitle, activatable: true});
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () => Gio.AppInfo.launch_default_for_uri(url, null));
        return row;
    }

    _choiceRow(settings, key, choices, props) {
        const row = new Adw.ComboRow({
            ...props,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const sync = () => {
            const i = choices.findIndex(([value]) => value === settings.get_string(key));
            row.selected = Math.max(i, 0);
        };
        sync();
        row.connect('notify::selected', () => {
            const value = choices[row.selected]?.[0];
            if (value && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        const handler = settings.connect(`changed::${key}`, sync);
        row.connect('destroy', () => settings.disconnect(handler));
        return row;
    }

    _placementGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Placement')});

        group.add(this._choiceRow(settings, 'location', [
            ['panel', _('Top bar button')],
            ['quick-settings', _('Quick Settings')],
        ], {
            title: _('Location'),
            subtitle: _('A button of its own, or a tile next to Wi-Fi and Bluetooth.'),
        }));

        const box = this._choiceRow(settings, 'panel-box', [
            ['left', pgettext('top bar area', 'Left')],
            ['center', pgettext('top bar area', 'Centre')],
            ['right', pgettext('top bar area', 'Right')],
        ], {
            title: _('Top Bar Area'),
            subtitle: _('Which part of the top bar the button is in.'),
        });
        group.add(box);

        const index = new Adw.SpinRow({
            title: _('Position'),
            subtitle: _('Counted from the left of that area. Zero is first.'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1, page_increment: 1}),
        });
        settings.bind('panel-index', index, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(index);

        const middle = this._choiceRow(settings, 'middle-click', [
            ['none', _('Nothing')],
            ['refresh', _('Find devices again')],
            ['settings', _('Open these settings')],
        ], {
            title: _('Middle Click'),
            subtitle: _('On the button in the top bar.'),
        });
        group.add(middle);

        const hover = new Adw.SwitchRow({
            title: _('Switch Menus on Hover'),
            subtitle: _('Pointing at another top bar button closes Nook and opens that menu. Off: Nook stays open until a click outside it.'),
        });
        settings.bind('hover-switch', hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hover);

        const follow = () => {
            const own = settings.get_string('location') === 'panel';
            box.sensitive = own;
            index.sensitive = own;
            middle.sensitive = own;
            hover.sensitive = own;
        };
        follow();
        const handler = settings.connect('changed::location', follow);
        group.connect('destroy', () => settings.disconnect(handler));

        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Menu')});

        const views = [
            ['tabs', _('Rooms as tabs')],
            ['grid', _('Small tiles')],
            ['rooms', _('Tiles by room')],
            ['control', _('Modules')],
        ];
        const viewRow = new Adw.ComboRow({
            title: _('View'),
            subtitle: _('How the menu lays out the devices.'),
            model: Gtk.StringList.new(views.map(([, label]) => label)),
        });
        const syncView = () => {
            const i = views.findIndex(([value]) => value === settings.get_string('view'));
            viewRow.selected = Math.max(i, 0);
        };
        syncView();
        viewRow.connect('notify::selected', () => {
            const value = views[viewRow.selected]?.[0];
            if (value && value !== settings.get_string('view'))
                settings.set_string('view', value);
        });
        const viewHandler = settings.connect('changed::view', syncView);
        viewRow.connect('destroy', () => settings.disconnect(viewHandler));
        group.add(viewRow);

        const colorRow = new Adw.SwitchRow({
            title: _('Colour by Device Type'),
            subtitle: _('Fans, lights and sensors each get a colour of their own instead of the accent colour.'),
        });
        settings.bind('type-colors', colorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(colorRow);

        const scenesRow = new Adw.SwitchRow({
            title: _('Compact Scenes'),
            subtitle: _('Scenes as one row of buttons under the header, instead of a section of their own.'),
        });
        settings.bind('scenes-compact', scenesRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(scenesRow);

        group.add(this._choiceRow(settings, 'switcher-style', [
            ['bar', _('Static')],
            ['floating', _('Floating')],
            ['none', _('None')],
        ], {
            title: _('Tabs at the Bottom'),
            subtitle: _('Home and the sections chosen below, while they have devices.'),
        }));

        const sections = [
            ['scenes', _('Scenes')],
            ['lights', _('Lights')],
            ['climate', _('Climate')],
            ['media', _('Media')],
            ['cameras', _('Cameras')],
            ['security', _('Security')],
            ['appliances', _('Appliances')],
        ];
        const tabRows = new Adw.ExpanderRow({title: _('Tabs')});
        const autoRow = new Adw.SwitchRow({
            title: _('Automatic'),
            subtitle: _('Up to six sections with the most devices.'),
        });
        settings.bind('switcher-auto', autoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        tabRows.add_row(autoRow);
        const tabs = sections.map(([id, title]) => {
            const row = new Adw.SwitchRow({title});
            row.connect('notify::active', () => {
                const chosen = settings.get_strv('switcher-tabs');
                if (chosen.includes(id) !== row.active)
                    settings.set_strv('switcher-tabs', row.active ? [...chosen, id] : chosen.filter(t => t !== id));
            });
            tabRows.add_row(row);
            return [id, row];
        });
        group.add(tabRows);

        const follow = () => {
            const auto = settings.get_boolean('switcher-auto');
            const chosen = settings.get_strv('switcher-tabs');
            // The bar holds six tabs next to Home.
            const full = chosen.filter(id => sections.some(([section]) => section === id)).length >= 6;
            for (const [id, row] of tabs) {
                row.active = chosen.includes(id);
                row.visible = !auto;
                row.sensitive = row.active || !full;
            }
            const titles = sections.filter(([id]) => chosen.includes(id)).map(([, title]) => title);
            tabRows.subtitle = GLib.markup_escape_text(auto ? _('Automatic')
                : titles.length > 0 ? titles.join(', ') : _('None'), -1);
            const shown = settings.get_string('switcher-style') !== 'none';
            tabRows.sensitive = shown;
            // The Scenes tab takes the scenes out of Home; an automatic one may or may not be there.
            scenesRow.sensitive = !shown || auto || !chosen.includes('scenes');
        };
        follow();
        const handlers = ['changed::switcher-style', 'changed::switcher-auto', 'changed::switcher-tabs'].map(signal => settings.connect(signal, follow));
        group.connect('destroy', () => handlers.forEach(handler => settings.disconnect(handler)));

        return group;
    }

    // Rooms are keyed by lower-cased name, as extension.js merges same-named rooms.
    _roomTabsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Room Tabs'),
            description: _('The tabs shown over the tiles. A room left out keeps its devices under All.'),
        });
        const names = new Map();
        for (const device of [
            ...cachedDevices(settings.get_string('xiaomi-user-id')),
            ...parseUnits(settings.get_string('gree-units')),
            ...parseAircons(settings.get_string('aircons')),
            ...Tapo.parseCameras(settings.get_string('tapo-cameras')),
            ...parseSpeakers(settings.get_string('cast-speakers')),
            ...parseTvs(settings.get_string('tvs')),
            ...Sonoff.parseSwitches(settings.get_string('sonoff-switches')),
            ...EwelinkHome.parseDevices(settings.get_string('ewelink-devices')),
            ...hueDevices(settings),
            ...Hass.parseDevices(settings.get_string('hass-devices')),
            ...SmartLifeHome.parseDevices(settings.get_string('smartlife-devices')),
        ]) {
            if (typeof device.room === 'string' && device.room)
                names.set(device.room.toLocaleLowerCase(), device.room);
        }
        const rooms = [...names].sort((a, b) => a[1].localeCompare(b[1]));
        rooms.unshift(['@pinned', _('Pinned')]);
        rooms.push(['@other', _('Other')]);
        const rows = [];
        for (const [key, name] of rooms) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(name, -1),
                active: !settings.get_strv('hidden-rooms').includes(key),
            });
            row.connect('notify::active', () => {
                const was = settings.get_strv('hidden-rooms');
                if (was.includes(key) !== row.active)
                    return;
                const hidden = was.filter(k => k !== key);
                if (!row.active)
                    hidden.push(key);
                settings.set_strv('hidden-rooms', hidden);
            });
            group.add(row);
            rows.push([key, row]);
        }

        const all = new Gtk.Button({valign: Gtk.Align.CENTER, css_classes: ['flat']});
        all.connect('clicked', () => {
            const hidden = settings.get_strv('hidden-rooms');
            const listed = rows.map(([key]) => key);
            const others = hidden.filter(key => !listed.includes(key));
            settings.set_strv('hidden-rooms',
                listed.some(key => hidden.includes(key)) ? others : [...others, ...listed]);
        });
        group.header_suffix = all;

        const sync = () => {
            const hidden = settings.get_strv('hidden-rooms');
            for (const [key, row] of rows)
                row.active = !hidden.includes(key);
            all.label = rows.some(([key]) => hidden.includes(key)) ? _('Show All') : _('Hide All');
        };
        sync();
        const handler = settings.connect('changed::hidden-rooms', sync);
        group.connect('destroy', () => settings.disconnect(handler));
        return group;
    }
}
