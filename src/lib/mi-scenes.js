// SPDX-License-Identifier: GPL-2.0-or-later

// Mi Home manual scenes, the ones its app runs with a tap, in the homes MiHome found.
// The cloud gives no time of a scene's last run: only runs from Nook show one.

import {cacheFile, readJson, writeJson} from './mihome.js';
import {SpecError, SpecHome, layout} from './spec-home.js';
import {XiaomiError} from './xiaomi.js';

const LAYOUT = layout([[2, 'scene', [], [[1, 'run-scene', () => null]]]]);
// Scenes change rarely: read as seldom as MiHome lists devices.
const GAP = 5 * 60 * 1000;

const asSpec = e => (e instanceof XiaomiError ? new SpecError(e.message, 'cloud') : e);

export class MiScenes extends SpecHome {
    // home: the MiHome whose homes the scenes are read from, and whose turns the calls take.
    // unnamed: the translated name of a scene without one.
    constructor(cloud, home, unnamed) {
        super('Mi Home', {gap: GAP, fresh: GAP});
        this._cloud = cloud;
        this._home = home;
        this._unnamed = unnamed;
        this._scenes = new Map();
        this._aborted = false;
        this.onDevices = null;
        this.onChange = null;
    }

    get _cacheFile() {
        return cacheFile(`xiaomi-scenes-${this._cloud.credentials.userId}.json`);
    }

    abort() {
        this._aborted = true;
    }

    _empty() {
        return this._home.homes.length === 0;
    }

    _layout() {
        return LAYOUT;
    }

    async load() {
        const cached = await readJson(this._cacheFile);
        if (!this._aborted && Array.isArray(cached?.scenes) && this._take(cached.scenes))
            this.onDevices?.();
    }

    // answered: the homes read just now, null for the cached list. True when scenes came,
    // went or were renamed.
    _take(scenes, answered = null) {
        const fresh = new Map(scenes.map(scene => [`miscene:${scene.id}`, scene]));
        const listed = () => this.devices.map(d => `${d.did} ${d.name}`).join('\n');
        const before = listed();
        this.devices = this.devices.filter(d => fresh.has(d.did));
        for (const [did, scene] of fresh) {
            const name = scene.name || this._unnamed;
            const device = this.devices.find(d => d.did === did) ??
                this._add({did, name, model: 'mi-scene', urn: 'urn:nook:device:scene:0', about: {model: null}});
            device.name = name;
            device.scene ??= {running: false, ranAt: null};
            this._keep(device, {}, answered?.has(scene.homeId) ?? true);
        }
        this._scenes = fresh;
        return listed() !== before;
    }

    async _refresh() {
        const homes = this._home.homes;
        if (homes.length === 0)
            return;
        const results = await Promise.allSettled(homes.map(({server, homeId, ownerId}) => this._home.guarded(async () =>
            (await this._cloud.scenes(server, {homeId, ownerId})).map(scene => ({
                id: String(scene.scene_id),
                name: scene.name ?? '',
                server,
                homeId,
                ownerId,
            })), {extra: true, background: true})));
        if (this._aborted)
            return;
        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0 && failed.length === results.length)
            throw asSpec(failed[0].reason);
        // A home that did not answer keeps the scenes it had, offline.
        const answered = new Set(homes.filter((_home, i) => results[i].status === 'fulfilled').map(h => h.homeId));
        const scenes = results.flatMap((r, i) => (r.status === 'fulfilled' ? r.value
            : [...this._scenes.values()].filter(scene => scene.homeId === homes[i].homeId)));
        if (this._take(scenes, answered)) {
            writeJson(this._cacheFile, {version: 1, scenes}).catch(logError);
            this.onDevices?.();
        }
    }

    async _send(device) {
        const scene = this._scenes.get(device.did);
        // Deleted in Mi Home while its card was open.
        if (!scene)
            throw new SpecError(`${device.name} is no longer in Mi Home`, 'gone');
        try {
            await this._home.guarded(() => this._cloud.runScene(scene.server, scene, scene.id), {extra: true});
        } catch (e) {
            throw asSpec(e);
        }
        device.scene = {running: false, ranAt: Math.floor(Date.now() / 1000)};
    }
}
