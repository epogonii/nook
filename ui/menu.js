// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {arrange} from '../lib/arrange.js';
import {XiaomiError} from '../lib/xiaomi.js';
import {CameraCard} from './card-camera.js';
import {ClimateCard} from './card-climate.js';
import {ControlsCard} from './card-controls.js';
import {HistoryCard} from './card-history.js';
import {MediaCard} from './card-media.js';
import {SpecCard} from './card-spec.js';
import {TvCard} from './card-tv.js';
import {VacuumCard} from './card-vacuum.js';
import {Card} from './card.js';
import {TileDrop} from './drop.js';
import {WrapLayout} from './layouts.js';
import {MenuRead} from './menu-read.js';
import {MenuLights} from './menu-lights.js';
import {MenuView} from './menu-view.js';
import {isBluetooth} from './rows.js';
import {CHIP_SPACING, CLOUD_AIRCONS, VERTICAL, readSetting} from './text.js';
import {skeletonTile} from './tiles.js';
import {Glyph, SceneButton, skeletonLines} from './widgets.js';

// µs; a middle press and its click gesture land within this and count as one click.
const MIDDLE_TWICE = 250 * 1000;

const MENU_SHARE = 0.7;

const QUICK_SETTINGS_MARGIN = 12;

// Open card: checked every CARD_TICK s, re-read when the last read is older than
// CARD_LOCAL/CARD_CLOUD ms and it has been untouched for CARD_TOUCHED ms.
const CARD_TICK = 1;

export const NookButton = GObject.registerClass(
class NookButton extends PanelMenu.Button {
    _init(settings, openPreferences, path, alerts) {
        super._init(0.5, _('Nook'));
        this._settings = settings;
        this._path = path;
        this._alerts = alerts;
        this._beacons = null;
        this._hearing = 0;
        this._unheard = new Set();
        alerts.onReport = (sid, data) => this._heardFromGateway(sid, data);
        this._openPreferences = openPreferences;
        this._cancellable = null;
        this._home = null;
        this._aircon = null;
        this._tapo = null;
        this._cast = null;
        this._tv = null;
        this._sonoff = null;
        this._shelly = null;
        this._ewelink = null;
        this._hue = null;
        this._hass = null;
        this._pushSync = 0;
        this._homekit = null;
        this._smartlife = null;
        this._miScenes = null;
        this._clouds = [];
        this._keepingSpeaker = false;
        this._keepingCameras = false;
        this._loginNote = null;
        this._tiles = [];
        // Offline devices when the tiles were last drawn; null while something else shows.
        this._drawnOffline = null;

        const box = new St.BoxLayout({style_class: 'nook-panel-box'});
        this._mark = new Glyph('nook');
        this._mark.add_style_class_name('nook-mark');
        this._mark.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(this._mark);
        // Hidden while empty, or the box spacing pushes the mark off centre.
        this._readings = new St.BoxLayout({
            style_class: 'nook-readings',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._readings);
        this.add_child(box);
        this._markBox = box;
        this._timer = 0;
        this._listenForMiddleClick();
        this._activitiesHeld = false;
        this.menu.actor.connect('captured-event', (actor, event) => this._holdOpen(actor, event));
        this.menu.connect('open-state-changed', (_menu, open) => this._pauseMenuManager(open));

        this._panel = new St.BoxLayout({...VERTICAL, style_class: 'nook-panel'});
        this.menu.box.add_child(this._panel);

        const header = this._header = new St.BoxLayout({style_class: 'nook-header'});
        this._backButton = this._addRoundButton(header, 'go-previous-symbolic', _('Back'),
            () => this._closeCard());
        this._title = new St.Label({
            style_class: 'nook-title',
            text: _('Nook'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._title);
        this._panelButton = this._addRoundButton(header, null, _('Show in the Top Bar'),
            () => this._toggleIn('panel-sensors', this._card.did));
        this._panelButton.child.gicon = Gio.FileIcon.new(Gio.File.new_for_path(`${this._path}/icons/nook-top-bar-symbolic.svg`));
        this._pinButton = this._addRoundButton(header, 'non-starred-symbolic', _('Pin'),
            () => this._togglePin(this._card.did));
        this._hideButton = this._addRoundButton(header, 'view-reveal-symbolic', _('Hide from the Menu'),
            () => this._toggleHidden(this._card.did));
        this._refreshButton = this._addRoundButton(header, 'view-refresh-symbolic', _('Find Devices Again'),
            () => this._discover().catch(logError));
        this._addRoundButton(header, 'emblem-system-symbolic', _('Settings'), () => {
            this._closeMenu();
            this._openPreferences();
        });
        this._panel.add_child(header);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        this._chips = new St.Widget({
            style_class: 'nook-chips',
            layout_manager: new WrapLayout(CHIP_SPACING * scale),
            x_expand: true,
            visible: false,
        });
        this._panel.add_child(this._chips);

        this._body = new St.BoxLayout({...VERTICAL, style_class: 'nook-body'});
        this._scroll = new St.ScrollView({
            child: this._body,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._drop = new TileDrop(settings, () => this._devices(), this._scroll);
        this._panel._delegate = this._drop.outside();
        // No card refresh while a control is held, or within CARD_TOUCHED ms of input.
        this._scroll.connect('captured-event', (_actor, event) => {
            switch (event.type()) {
            case Clutter.EventType.BUTTON_PRESS:
            case Clutter.EventType.TOUCH_BEGIN:
                this._pressed = true;
                this._touchedAt = Date.now();
                break;
            case Clutter.EventType.BUTTON_RELEASE:
            case Clutter.EventType.TOUCH_END:
            case Clutter.EventType.TOUCH_CANCEL:
                this._pressed = false;
                this._touchedAt = Date.now();
                break;
            case Clutter.EventType.SCROLL:
            case Clutter.EventType.KEY_PRESS:
                this._touchedAt = Date.now();
                break;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._scroll.connect('notify::vscrollbar-visible', () => {
            if (this._scroll.vscrollbar_visible)
                this._body.add_style_class_name('nook-body-scrolls');
            else
                this._body.remove_style_class_name('nook-body-scrolls');
        });
        this._panel.add_child(this._scroll);
        this._card = null;
        this._heardSection = null;
        this._heardShown = null;
        this._settle = 0;
        this._scrollRestore = 0;
        this._infoOpen = new Set();
        this._tvBusy = new Set();
        this._cardTimer = 0;
        this._cardReadAt = 0;
        this._cardReading = false;
        this._touchedAt = 0;
        this._pressed = false;
        this._climate = null;
        this._hero = null;
        this._media = null;
        this._map = null;
        this._maps = new Map();
        this._setCardMode(false);

        this._menu = this.menu;
        this._outerMenu = null;
        this._closeHost = null;
        this._menuOpened = open => {
            if (!open) {
                this._stopRetry();
                this._stopBeacons();
                this._syncReadings();
                if (this._card)
                    this._closeCard();
                this._cast?.rest();
                this._tv?.rest();
                this._infoOpen.clear();
                this._stopCardTimer();
                return;
            }
            // Offline tiles sort apart: catch up with what the last open learned, never under the pointer.
            if (this._drawnOffline !== null && this._offlineKey() !== this._drawnOffline)
                this._render();
            // Under Quick Settings, hostIn()'s 'show' handler fits the height.
            if (!this._outerMenu)
                this._fitHeight();
            this._startBeacons();
            this._read().catch(logError);
            this._stopCardTimer();
            this._cardTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CARD_TICK, () => {
                this._refreshCard();
                return GLib.SOURCE_CONTINUE;
            });
        };
        this._watchMenu();
        settings.connectObject(
            'changed::view', () => this._render(),
            'changed::type-colors', () => this._render(),
            'changed::scenes-compact', () => this._render(),
            'changed::scenes-folded', () => this._render(),
            'changed::room', () => this._render(),
            'changed::panel-sensors', () => {
                this._restartReadingsSoon();
                if (this._card)
                    this._syncCardHeader();
            },
            'changed::panel-interval', () => this._restartReadingsSoon(),
            'changed::pinned', () => this._render(),
            'changed::order', () => {
                this._render();
                this._syncReadings();
            },
            'changed::hidden', () => this._render(),
            'changed::hidden-rooms', () => this._render(),
            'changed::groups', () => this._render(),
            'changed::names', () => this._render(),
            'changed::icons', () => this._render(),
            'changed::gree-units', () => this.reload().catch(logError),
            'changed::aircons', () => this.reload().catch(logError),
            'changed::tapo-cameras', () => {
                if (!this._keepingCameras)
                    this.reload().catch(logError);
            },
            'changed::cast-speakers', () => {
                if (!this._keepingSpeaker)
                    this.reload().catch(logError);
            },
            'changed::tvs', () => this.reload().catch(logError),
            'changed::sonoff-switches', () => this.reload().catch(logError),
            'changed::shelly-devices', () => this.reload().catch(logError),
            'changed::ewelink-devices', () => this.reload().catch(logError),
            'changed::hue-bridges', () => this.reload().catch(logError),
            'changed::hue-devices', () => this.reload().catch(logError),
            'changed::hass-devices', () => this.reload().catch(logError),
            'changed::homekit-accessories', () => this.reload().catch(logError),
            'changed::smartlife-devices', () => this.reload().catch(logError),
            ...CLOUD_AIRCONS.flatMap(brand => [`changed::${brand.id}-devices`, () => this.reload().catch(logError)]),
            'changed::extra-tiles', () => {
                this._syncExtras();
                this._render();
            },
            this);
        this._gone = false;
        this.connect('destroy', () => {
            this._gone = true;
            this.stop();
        });
    }

    _watchMenu() {
        this._menu.connectObject('open-state-changed', (_menu, open) => this._menuOpened(open), this);
    }

    _closeMenu() {
        if (this._closeHost)
            this._closeHost();
        else
            this._menu.close();
    }

    hostIn(menu, outer) {
        this._menu.disconnectObject(this);
        this._menu.box.remove_child(this._panel);
        menu.box.add_child(this._panel);
        this._menu = menu;
        this._outerMenu = outer;
        this._closeHost = () => outer.close();
        this._watchMenu();
        // The tile menu shows before measuring its height, so fit on 'show'. Hide it
        // while shut, as closing would, so the first open emits 'show' too.
        if (!menu.isOpen)
            menu.actor.hide();
        menu.actor.connectObject('show', () => this._fitHeight(), this);
    }

    takeMark() {
        this.remove_child(this._markBox);
        return this._markBox;
    }

    // GNOME 49+ opens the menu from a click gesture that accepts any button unless
    // told otherwise; middle clicks run the configured action instead.
    _listenForMiddleClick() {
        this._middleAt = 0;
        this.connect('button-press-event', (_actor, event) =>
            this._clicked(event.get_button()) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        if (this._clickGesture?.set_required_button)
            this._clickGesture.set_required_button(Clutter.BUTTON_PRIMARY);
        else
            this._clickGesture?.connect('recognize', gesture =>
                this._clicked(gesture.get_button?.() ?? Clutter.BUTTON_PRIMARY));
    }

    // Connected before the panel's menu manager, which opens whichever top bar button
    // the pointer crosses while a menu is up. A click on one still opens its menu.
    _holdOpen(actor, event) {
        const type = event.type();
        const target = global.stage.get_event_actor(event);
        if (type === Clutter.EventType.TOUCH_END ||
            (type === Clutter.EventType.BUTTON_RELEASE && event.get_button() === Clutter.BUTTON_PRIMARY))
            return this._releaseActivities(target);
        const press = type === Clutter.EventType.TOUCH_BEGIN ||
            (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY);
        if (type !== Clutter.EventType.ENTER && !press)
            return Clutter.EVENT_PROPAGATE;
        if (press)
            this._activitiesHeld = false;
        if (!target || actor.contains(target) || this.contains(target) ||
            readSetting(this._settings, 'hover-switch'))
            return Clutter.EVENT_PROPAGATE;
        if (!press) {
            // EVENT_STOP on a crossing event trips a Clutter runtime check.
            if (!(event.get_flags() & Clutter.EventFlags.FLAG_GRAB_NOTIFY))
                GObject.signal_stop_emission_by_name(actor, 'captured-event::pointer-focus');
            return Clutter.EVENT_PROPAGATE;
        }
        const other = this._topBarButtonAt(target);
        // Activities has no menu and toggles the overview on release.
        if (other === Main.panel.statusArea.activities) {
            this._activitiesHeld = true;
            return Clutter.EVENT_STOP;
        }
        other?.menu.toggle();
        return other?.menu.isOpen ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    _topBarButtonAt(target) {
        const {statusArea} = Main.panel;
        if (statusArea.activities?.contains(target))
            return statusArea.activities;
        return Object.values(statusArea).find(button =>
            button.menu instanceof PopupMenu.PopupMenu && button.menu.sourceActor.contains(target));
    }

    // GNOME 51's menu manager adds capture-phase actions on open that run before
    // captured-event: a hover controller, paused meanwhile, and a click gesture that
    // would close the menu on a press _holdOpen handles itself.
    _pauseMenuManager(open) {
        if (this._hoverSwitch)
            this._hoverSwitch.enabled = true;
        this._hoverSwitch = null;
        if (!open || readSetting(this._settings, 'hover-switch'))
            return;
        // Added after this handler runs.
        Promise.resolve().then(() => {
            if (!this.menu?.isOpen)
                return;
            this._hoverSwitch = this.menu.actor.get_action('popup-manager-motion-controller');
            if (this._hoverSwitch)
                this._hoverSwitch.enabled = false;
            const click = this.menu.actor.get_action('popup-manager-click-gesture');
            if (click && click !== this._managerClick) {
                this._managerClick = click;
                click.connectObject('may-recognize', () => !this._holdsPress(click), this);
            }
        });
    }

    _holdsPress(click) {
        if (click.get_actor() !== this.menu.actor || readSetting(this._settings, 'hover-switch'))
            return false;
        const event = click.get_point_event(0);
        const target = global.stage.get_event_actor(event);
        const primary = event.type() === Clutter.EventType.TOUCH_BEGIN ||
            event.get_button() === Clutter.BUTTON_PRIMARY;
        return primary && Boolean(target) && !this.contains(target) && Boolean(this._topBarButtonAt(target));
    }

    _releaseActivities(target) {
        const held = this._activitiesHeld;
        this._activitiesHeld = false;
        if (!held || !target || !Main.panel.statusArea.activities?.contains(target))
            return Clutter.EVENT_PROPAGATE;
        this.menu.close();
        if (Main.overview.shouldToggleByCornerOrButton())
            Main.overview.toggle();
        return Clutter.EVENT_STOP;
    }

    _clicked(button) {
        if (button !== Clutter.BUTTON_MIDDLE)
            return false;
        const action = readSetting(this._settings, 'middle-click');
        if (action === 'none')
            return false;
        this.menu.close();
        // Press event and gesture may both report one click; ignore the second.
        const now = GLib.get_monotonic_time();
        if (now - this._middleAt < MIDDLE_TWICE)
            return true;
        this._middleAt = now;
        if (action === 'refresh')
            this._discover().catch(logError);
        else if (action === 'settings')
            this._openPreferences();
        return true;
    }

    _roundButton(iconName, label, onClick) {
        const button = new St.Button({
            style_class: 'nook-round-button',
            accessible_name: label,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
        });
        button.connect('clicked', onClick);
        return button;
    }

    _addRoundButton(box, iconName, label, onClick) {
        const button = this._roundButton(iconName, label, onClick);
        box.add_child(button);
        return button;
    }

    // The picture presses its power button too. Not focusable: the button already is.
    _powerScene(scene, power) {
        const button = new SceneButton({child: scene, can_focus: false});
        power.bind_property('reactive', button, 'reactive', GObject.BindingFlags.SYNC_CREATE);
        button.connect('clicked', () => power.emit('clicked', 1));
        return button;
    }

    // Work area is in device pixels, style lengths aren't: divide by the scale factor.
    _fitHeight() {
        const anchor = this._outerMenu?.box ?? this;
        const monitor = Main.layoutManager.findMonitorForActor(anchor) ?? Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        if (!this._outerMenu) {
            this._scroll.style = `max-height: ${Math.round(workArea.height * MENU_SHARE / scale)}px;`;
            return;
        }
        // Panel max-height: room below Quick Settings with the tile shut. The tile menu
        // opens in between, pushing later tiles down; only the list scrolls.
        const [, top] = this._outerMenu.box.get_transformed_position();
        const [, height] = this._outerMenu.box.get_transformed_size();
        const [, panel] = this._panel.get_preferred_height(-1);
        const [, box] = this._menu.box.get_preferred_height(-1);
        const edges = node => node.get_vertical_padding() +
            node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        // Tile menu chrome and the panel's padding and border, which max-height excludes.
        const frame = box - panel + edges(this._menu.actor.get_theme_node()) +
            this._menu.actor.margin_top + this._menu.actor.margin_bottom +
            edges(this._panel.get_theme_node());
        const room = workArea.y + workArea.height - (top + height) - frame -
            QUICK_SETTINGS_MARGIN * scale;
        this._panel.style = `max-height: ${Math.max(0, Math.round(room / scale))}px;`;
    }

    // Idempotent: disable() calls it, then the destroy handler again.
    stop() {
        this._drop.stop();
        this._stopRetry();
        this._stopLightUp();
        this._stopBeacons();
        this._stopCardTimer();
        this._cameraApi?.abort();
        this._cameraApi = null;
        if (this._sirenTimer)
            GLib.source_remove(this._sirenTimer);
        this._sirenTimer = 0;
        this._alerts.onReport = null;
        this._camera?.stop();
        this._camera = null;
        this._panner?.finish();
        this._panner = null;
        if (this._climate?.nudging)
            GLib.source_remove(this._climate.nudging);
        this._climate?.scene.run(false);
        this._hero?.scene?.run(false);
        this._forgetMedia();
        this._forgetMap();
        this._card = null;
        this._forgetScroll();
        this._stopReadings();
        this._menu.disconnectObject(this);
        if (this._outerMenu)
            this._menu.actor.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._cancellable?.cancel();
        this._cancellable = null;
        this._dropSources();
        if (this._pushSync)
            GLib.source_remove(this._pushSync);
        this._pushSync = 0;
    }

    _clear() {
        this._camera?.stop();
        this._camera = null;
        this._cameraApi?.abort();
        this._cameraApi = null;
        if (this._sirenTimer)
            GLib.source_remove(this._sirenTimer);
        this._sirenTimer = 0;
        this._panner?.finish();
        this._panner = null;
        this._climate?.flush?.();
        this._climate?.scene.run(false);
        this._climate = null;
        this._tvCard?.scene.run(false);
        this._tvCard = null;
        this._hero?.scene?.run(false);
        this._hero = null;
        this._forgetMedia();
        this._forgetMap();
        this._forgetScroll();
        this._heardSection = null;
        this._heardShown = null;
        this._body.destroy_all_children();
        this._chips.destroy_all_children();
        this._chips.visible = false;
        this._tiles = [];
        this._drawnOffline = null;
    }

    _message(text, action = null) {
        this._clear();
        const label = new St.Label({style_class: 'nook-message', text});
        label.clutter_text.line_wrap = true;
        this._body.add_child(label);
        if (action) {
            const [actionLabel, onClick] = action;
            const button = new St.Button({
                style_class: 'nook-action',
                label: actionLabel,
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
            });
            button.connect('clicked', onClick);
            this._body.add_child(button);
        }
    }

    _showLoading(card = false) {
        this._clear();
        if (card) {
            const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
            section.add_child(skeletonLines());
            this._body.add_child(section);
            return;
        }
        const [columns, shape] = {grid: [3, 'square'], rooms: [2, 'compact']}[readSetting(this._settings, 'view')] ??
            [2, 'wide'];
        for (let i = 0; i < 3; i++) {
            const row = new St.BoxLayout({style_class: 'nook-row', x_expand: true});
            row.layout_manager.homogeneous = true;
            for (let j = 0; j < columns; j++)
                row.add_child(skeletonTile(shape));
            this._body.add_child(row);
        }
    }

    // Mi Home is one source of many: only a login that was there and is lost gets a note.
    // Its scenes come with the login, so they don't count.
    _showLogin(text = null) {
        if (this._sources().some(source => source && source !== this._home && source !== this._miScenes)) {
            if (text)
                this._loginNote = {text, target: 'accounts-mihome'};
            this._render();
            return;
        }
        const open = () => {
            this._closeMenu();
            this._openPreferences('accounts-mihome');
        };
        if (text)
            this._message(text, [_('Log In…'), open]);
        else
            this._message(_('Add an account or a device in Settings, and your home shows up here.'), [_('Open Settings…'), open]);
    }

    _addLoginNote() {
        const {text, target} = this._loginNote;
        const label = new St.Label({style_class: 'nook-message', text});
        label.clutter_text.line_wrap = true;
        this._body.add_child(label);
        const button = new St.Button({
            style_class: 'nook-action',
            label: _('Log In…'),
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
        });
        button.connect('clicked', () => {
            this._closeMenu();
            this._openPreferences(target);
        });
        this._body.add_child(button);
    }

    _devices() {
        return [
            ...this._home?.devices ?? [],
            ...this._aircon?.devices ?? [],
            ...this._tapo?.devices ?? [],
            ...this._cast?.devices ?? [],
            ...this._tv?.devices ?? [],
            ...this._sonoff?.devices ?? [],
            ...this._shelly?.devices ?? [],
            ...this._ewelink?.devices ?? [],
            ...this._hue?.devices ?? [],
            ...this._hass?.devices ?? [],
            ...this._homekit?.devices ?? [],
            ...this._smartlife?.devices ?? [],
            ...this._miScenes?.devices ?? [],
            ...this._clouds.flatMap(cloud => cloud.devices),
        ];
    }

    _offlineKey() {
        return this._devices().filter(d => d.online === false && !isBluetooth(d)).map(d => d.did).join(' ');
    }

    _sources() {
        return [this._home, this._aircon, this._tapo, this._cast, this._tv, this._sonoff, this._shelly, this._ewelink, this._hue, this._hass,
            this._homekit, this._smartlife, this._miScenes, ...this._clouds];
    }

    _showFailure(home, e) {
        if (!(e instanceof XiaomiError) && !(e instanceof GLib.Error))
            logError(e);
        if (!home.loggedIn)
            this._showLogin(_('The Mi Home login has expired.'));
        else
            this._message(e.message, [_('Try Again'), () => this.reload().catch(logError)]);
    }

    // Tile order, hidden devices included: hiding a tile keeps its top bar reading.
    _panelDevices() {
        const dids = readSetting(this._settings, 'panel-sensors');
        return arrange(this._devices(), this._choices(), true).filter(d => dids.includes(d.did));
    }

    _choices() {
        return {
            pinned: readSetting(this._settings, 'pinned'),
            order: readSetting(this._settings, 'order'),
            hidden: readSetting(this._settings, 'hidden'),
        };
    }

    _togglePin(did) {
        this._toggleIn('pinned', did);
    }

    _toggleHidden(did) {
        this._toggleIn('hidden', did);
    }

    _toggleIn(key, did) {
        const list = readSetting(this._settings, key);
        this._settings.set_strv(key, list.includes(did) ? list.filter(d => d !== did) : [...list, did]);
    }
});

// The cards and data reads are in ui/card-*.js and ui/menu-*.js as plain classes that
// are never constructed; their methods go on NookButton here.
for (const part of [MenuRead, MenuView, MenuLights, Card, SpecCard, HistoryCard, CameraCard, MediaCard, TvCard, ClimateCard, ControlsCard, VacuumCard]) {
    for (const name of Object.getOwnPropertyNames(part.prototype)) {
        if (name !== 'constructor')
            Object.defineProperty(NookButton.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
    }
}
