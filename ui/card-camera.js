// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Secrets from '../lib/secrets.js';
import {OnvifError} from '../lib/onvif.js';
import {parseCameras} from '../lib/tapo.js';
import {CameraApi, TapoError, WRONG_PASSWORD} from '../lib/tapo-local.js';
import {CameraView, NO_GSTREAMER, NO_PLUGIN, Panner, REFUSED, panButtons} from './camera.js';
import {VERTICAL, readSetting} from './text.js';
import {optimistic, skeletonLines} from './widgets.js';

export class CameraCard {
    async _openCameraCard(device) {
        this._card = device;
        this._setCardMode(true);
        this._title.text = readSetting(this._settings, 'names')[device.did] || device.name;
        this._clear();

        let account = null;
        let controls;
        const toSettings = [_('Settings…'), () => {
            this._closeMenu();
            this._openPreferences(`accounts-tapo ${device.did}`);
        }];
        if (device.test) {
            controls = device.source.controls(device);
        } else if (!device.tapo && !device.xaddr) {
            this._message(_('Search for cameras again in Settings, under Cameras, so Nook learns how to reach this one.'), toSettings);
            return;
        } else {
            let saved = null;
            try {
                saved = await Secrets.lookup(device.source.secret(device));
            } catch (e) {
                console.debug(`nook: keyring: ${e.message}`);
            }
            if (this._card !== device)
                return;
            if (!saved) {
                this._message(device.tapo
                    ? _('Add the camera account from the Tapo app in Settings, under Cameras.')
                    : _('Add the login of this camera in Settings, under Cameras.'), toSettings);
                return;
            }
            let user, password;
            try {
                ({user, password} = JSON.parse(saved));
            } catch {
                this._message(_('The saved camera account could not be read. Save it again in Settings, under Cameras.'));
                return;
            }
            account = {user, password};
            controls = device.source.controls(device, user, password);
        }

        const view = new CameraView(() => device.source.refused(device));
        this._body.add_child(view);
        this._camera = view;
        // Refused recently: don't retry yet, every attempt keeps the camera locked out.
        if (!device.test && device.source.isRefused(device))
            view.showRefused();
        else if (device.test)
            view.start(this._path, null);
        else
            this._watchCamera(device, view, account, controls).catch(logError);

        const row = new St.BoxLayout({style_class: 'nook-card-row'});
        const about = [device.model.replace(/^tapo /, 'Tapo '), device.test ? '' : device.ip].filter(Boolean).join(' · ');
        const info = new St.Label({
            style_class: 'nook-card-value',
            text: about,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        info.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(info);
        const snapshot = this._addRoundButton(row, 'camera-photo-symbolic', _('Take a Snapshot'), () => {
            this._takeSnapshot(device, account, view, snapshot).catch(logError);
        });
        this._body.add_child(row);
        this._addPanButtons(device, view, controls, row, info).catch(logError);
        this._addCameraControls(device, view).catch(logError);
    }

    async _watchCamera(device, view, account, controls) {
        try {
            const {live, still} = await device.source.streams(device, controls, this._cancellable);
            Object.assign(account, {url: live, still});
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._camera !== view)
                return;
            if (!(e instanceof OnvifError) && !(e instanceof GLib.Error))
                throw e;
            if (e.refused) {
                device.source.refused(device);
                view.showRefused();
            } else {
                view.showProblem(e.message);
            }
            return;
        }
        if (this._camera === view)
            view.start(this._path, account);
    }

    async _takeSnapshot(device, account, view, button) {
        if (!device.test && device.source.isRefused(device)) {
            view.showRefused();
            return;
        }
        // The camera has not said where its stream is yet.
        if (account && !account.still)
            return;
        button.reactive = false;
        button.opacity = 110;
        const name = readSetting(this._settings, 'names')[device.did] || device.name;
        try {
            const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir();
            const folder = Gio.File.new_for_path(GLib.build_filenamev([pictures, 'Nook']));
            const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
            const file = folder.get_child(`${name.replaceAll('/', '-')} ${stamp}.jpg`);
            const argv = ['gjs', '-m', `${this._path}/feed.js`, '--still', file.get_path()];
            if (!account)
                argv.push('--test');
            const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            const input = account ? `${JSON.stringify({...account, url: account.still})}\n` : null;
            await new Promise((resolve, reject) => {
                process.communicate_utf8_async(input, null, (_process, result) => {
                    try {
                        resolve(process.communicate_utf8_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            const status = process.get_exit_status();
            if (this._gone)
                return;
            if (status === 0)
                this._alerts.snapshotSaved(name, file);
            else if (status === NO_GSTREAMER)
                Main.notifyError(name, _('GStreamer is needed to show the picture.'));
            else if (status === NO_PLUGIN)
                Main.notifyError(name, _('The picture needs a GStreamer plugin that is not installed.'));
            else if (status === REFUSED) {
                device.source.refused(device);
                if (this._camera === view)
                    view.showRefused();
            } else
                Main.notifyError(name, _('The camera sent no picture to save.'));
        } catch (e) {
            if (!(e instanceof GLib.Error))
                throw e;
            Main.notifyError(name, e.message);
        } finally {
            if (this._camera === view) {
                button.reactive = true;
                button.opacity = 255;
            }
        }
    }

    async _addCameraControls(device, view) {
        // Privacy, light, night vision and siren go through Tapo's own API.
        if (device.test || !device.tapo) {
            this._addDeviceInfo(device);
            return;
        }
        let saved = null;
        try {
            saved = await Secrets.lookup('tapo-admin');
        } catch (e) {
            console.debug(`nook: keyring: ${e.message}`);
        }
        if (this._camera !== view)
            return;
        this._body.add_child(new St.Label({style_class: 'nook-room', text: _('Camera')}));
        const section = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-section'});
        this._body.add_child(section);
        const fillInfo = this._addDeviceInfo(device);
        const say = text => {
            section.destroy_all_children();
            const label = new St.Label({style_class: 'nook-card-value', text});
            label.clutter_text.line_wrap = true;
            section.add_child(label);
        };
        let password = null;
        try {
            password = saved ? JSON.parse(saved).password : null;
        } catch {}
        if (!password) {
            say(_('Privacy mode, the light, night vision and the siren need your TP-Link password, in Settings under Cameras.'));
            const settings = new St.Button({style_class: 'nook-chip', label: _('Settings…'), can_focus: true, x_align: Clutter.ActorAlign.START});
            settings.connect('clicked', () => {
                this._closeMenu();
                this._openPreferences('accounts-tapo admin');
            });
            section.add_child(settings);
            return;
        }

        section.destroy_all_children();
        section.add_child(skeletonLines());
        const api = this._cameraApi = new CameraApi(device.ip, password);
        let state;
        try {
            state = await api.read();
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._camera !== view)
                return;
            if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
                throw e;
            say(e.code === WRONG_PASSWORD
                ? _('The TP-Link password in Settings is not the one this camera knows.')
                : e.message);
            return;
        }
        if (this._camera !== view)
            return;
        section.destroy_all_children();
        if (state.about) {
            device.about = {...device.about, ...state.about};
            fillInfo();
        }

        const fail = e => {
            if (!(e instanceof TapoError) && !(e instanceof GLib.Error))
                logError(e);
            else if (!this._gone && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                Main.notifyError(device.name, e.message);
        };
        const switches = [
            ['privacy', _('Privacy Mode'), on => api.setPrivacy(on)],
            ['light', _('Status Light'), on => api.setLight(on)],
            ['motion', _('Motion Detection'), on => api.setMotion(on)],
            ['alarm', _('Siren on Motion'), on => api.setAlarm(on)],
        ];
        for (const [key, label, set] of switches) {
            if (state[key] !== null)
                section.add_child(this._switchRow(label, state[key], on => set(on).catch(e => {
                    fail(e);
                    throw e;
                })));
        }

        if (state.night) {
            const row = new St.BoxLayout({...VERTICAL, style_class: 'nook-card-row'});
            row.add_child(new St.Label({style_class: 'nook-card-label', text: _('Night Vision')}));
            const chips = new St.BoxLayout({style_class: 'nook-card-row'});
            const modes = [['auto', _('Auto')], ['on', _('On')], ['off', _('Off')]];
            const pick = optimistic(chips, state.night, night => {
                buttons.forEach((b, i) => {
                    b.checked = modes[i][0] === night;
                });
            });
            const buttons = modes.map(([mode, label]) => {
                const chip = new St.Button({style_class: 'nook-chip', label, can_focus: true, checked: state.night === mode});
                chip.connect('clicked', () => pick(mode, m => api.setNight(m).catch(e => {
                    fail(e);
                    throw e;
                })));
                chips.add_child(chip);
                return chip;
            });
            row.add_child(chips);
            section.add_child(row);
        }

        const siren = new St.Button({style_class: 'nook-chip', label: _('Sound the Siren'), can_focus: true, x_align: Clutter.ActorAlign.START});
        let armed = false;
        let sounding = false;
        let pending = false;
        let gone = false;
        siren.connect('destroy', () => {
            gone = true;
        });
        siren.connect('clicked', () => {
            if (pending)
                return;
            if (!sounding && !armed) {
                armed = true;
                siren.label = _('Click Again to Sound It');
                this._sirenTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
                    this._sirenTimer = 0;
                    armed = false;
                    siren.label = _('Sound the Siren');
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            if (this._sirenTimer) {
                GLib.source_remove(this._sirenTimer);
                this._sirenTimer = 0;
            }
            const next = !sounding;
            armed = false;
            pending = true;
            api.siren(next).then(() => {
                sounding = next;
            }).catch(e => {
                if (!gone)
                    fail(e);
            }).finally(() => {
                pending = false;
                if (!gone)
                    siren.label = sounding ? _('Stop the Siren') : _('Sound the Siren');
            });
        });
        section.add_child(siren);
    }

    async _addPanButtons(device, view, controls, row, info) {
        let abilities;
        try {
            abilities = await device.source.abilities(device, controls, this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`nook: ${device.name}: ${e.message}`);
            return;
        }
        if (this._camera !== view || !abilities.pan)
            return;

        const panner = this._panner = new Panner(controls, e => {
            if (!(e instanceof OnvifError) && !(e instanceof GLib.Error)) {
                logError(e);
                return;
            }
            if (this._camera === view)
                info.text = _('Could not turn the camera: %s').format(e.message);
        });
        const pad = new St.BoxLayout({style_class: 'nook-card-row'});
        for (const [icon, label, x, y] of panButtons())
            this._addRoundButton(pad, icon, label, () => panner.nudge(x, y));
        if (abilities.home)
            this._addRoundButton(pad, 'go-home-symbolic', _('Turn to the Home Position'), () => panner.home());
        // After adding buttons: Clutter passes text direction to children only when set.
        pad.set_text_direction(Clutter.TextDirection.LTR);
        row.insert_child_above(pad, info);
    }

    // A camera found at a new address keeps it, without reloading the menu.
    _keepCameras(tapo, moved) {
        if (tapo !== this._tapo)
            return;
        const cameras = parseCameras(readSetting(this._settings, 'tapo-cameras'))
            .map(camera => ({...camera, ...moved.find(m => m.id === camera.id)}));
        this._keepingCameras = true;
        try {
            this._settings.set_string('tapo-cameras', JSON.stringify(cameras));
        } finally {
            this._keepingCameras = false;
        }
    }
}
