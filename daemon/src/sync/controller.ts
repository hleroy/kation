// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Owns the sync engine: starts it when signed in with sync enabled, stops it
 * otherwise, and applies settings changes coming from D-Bus.
 */
import path from 'node:path';

import type { DriveEvent, Logger } from '@protontech/drive-sdk';

import type { Config } from '../config';
import type { DriveService } from '../service/driveService';
import { KationError } from '../service/errors';
import type { DriveSdk } from '../service/sdk';
import type { DriveTree } from '../service/tree';
import {
    DEFAULT_MAX_DELETIONS_PER_PASS,
    type ItemState,
    SAFETY_PAUSE_META,
    type SyncActivity,
    SyncEngine,
    type SyncStatus,
} from './engine';
import { normalizeExcluded, SettingsStore, type SyncSettings, validateFolder, validateLimit } from './settings';
import { parentOf, SyncState } from './state';

export type SyncControllerStatus = SyncStatus & {
    enabled: boolean;
    paused: boolean;
    folder: string;
    excluded: string[];
    uploadLimit: number;
    downloadLimit: number;
};

/** Recent activity, with the local path of the item. */
export type SyncActivityEntry = SyncActivity & { localPath: string };

const MAX_ACTIVITY = 50;

export type SyncControllerOptions = {
    config: Config;
    drive: DriveService;
    tree: DriveTree;
    sdk: Pick<DriveSdk, 'getNode'>;
    logger: Logger;
    isLoggedIn: () => boolean;
    onStatus?: (status: SyncControllerStatus) => void;
    onActivity?: (activity: SyncActivityEntry) => void;
    /** Local paths whose sync state may have changed; [] means any. */
    onItemsChanged?: (localPaths: string[]) => void;
    /** Starts kationd with the session while sync is on (not in tests). */
    autostart?: (enabled: boolean) => Promise<void>;
    /** Overrides for tests. */
    engineOptions?: Partial<ConstructorParameters<typeof SyncEngine>[0]>;
};

export class SyncController {
    private readonly settingsStore: SettingsStore;
    private settings: SyncSettings;
    private readonly state: SyncState;
    private engine?: SyncEngine;
    private applying: Promise<void> = Promise.resolve();
    private readonly recent: SyncActivityEntry[] = [];

    constructor(private readonly options: SyncControllerOptions) {
        this.settingsStore = new SettingsStore(options.config.configDir, options.config.homeDir);
        this.settings = this.settingsStore.load();
        this.state = new SyncState(path.join(options.config.appDir, 'sync.sqlite'));
        this.applyLimits();
    }

    /** Most recent first. */
    recentActivity(): SyncActivityEntry[] {
        return [...this.recent];
    }

    /**
     * Sync states of local paths (absolute). Paths outside the sync folder,
     * or any path while sync is off, get "".
     */
    async itemStates(localPaths: string[]): Promise<Map<string, ItemState>> {
        const states = new Map<string, ItemState>();
        for (const localPath of localPaths) {
            const drivePath = this.drivePathOf(localPath);
            states.set(localPath, drivePath && this.engine ? await this.engine.itemState(drivePath) : '');
        }
        return states;
    }

    /** The path inside "My files" of a local path in the sync folder, or undefined. */
    drivePathOf(localPath: string): string | undefined {
        if (!path.isAbsolute(localPath)) {
            return undefined;
        }
        const normalized = path.resolve(localPath);
        const root = this.settings.folder;
        if (normalized === root) {
            return '/';
        }
        return normalized.startsWith(`${root}/`) ? normalized.slice(root.length) : undefined;
    }

    /** Speed limits in KiB/s, 0 for unlimited. They apply to all transfers. */
    setLimits(upload: number, download: number): void {
        this.update({ uploadLimit: validateLimit(upload), downloadLimit: validateLimit(download) });
        this.applyLimits();
    }

    status(): SyncControllerStatus {
        const signedOut = this.settings.enabled && !this.options.isLoggedIn();
        const engineStatus: SyncStatus = this.engine?.getStatus() ?? {
            state: 'disabled',
            message: signedOut ? 'Sign in to sync' : '',
            reason: signedOut ? 'signedOut' : '',
            deletionLimit: DEFAULT_MAX_DELETIONS_PER_PASS,
            current: '',
            pending: 0,
            lastSync: Number(this.state.getMeta('lastSync') ?? 0),
        };
        return {
            ...engineStatus,
            enabled: this.settings.enabled,
            paused: this.settings.paused,
            folder: this.settings.folder,
            excluded: [...this.settings.excluded],
            uploadLimit: this.settings.uploadLimit,
            downloadLimit: this.settings.downloadLimit,
        };
    }

    /** Starts or stops the engine to match the settings and sign-in state. */
    apply(): Promise<void> {
        this.applying = this.applying
            .then(() => this.doApply())
            .catch((error: unknown) => {
                this.options.logger.error('Failed to apply sync settings', error);
            });
        return this.applying;
    }

    async setEnabled(enabled: boolean): Promise<void> {
        if (enabled && !this.options.isLoggedIn()) {
            throw new KationError('NotLoggedIn', 'Sign in before turning on sync');
        }
        const safetyPause = this.state.getMeta(SAFETY_PAUSE_META);
        if (enabled && !this.settings.enabled && (safetyPause === 'folder' || safetyPause === 'account')) {
            // What the safety pause message tells the user to do to start over. Without a base,
            // nothing is deleted: both sides are merged as on a first sync.
            this.options.logger.info(`Sync turned on after a safety pause (${safetyPause}): starting over`);
            this.state.clear();
        }
        this.update({ enabled, paused: enabled ? false : this.settings.paused });
        await this.applyAutostart();
        await this.apply();
    }

    /** Makes start at login match the sync setting. Failures are logged, not thrown. */
    async applyAutostart(): Promise<void> {
        try {
            await this.options.autostart?.(this.settings.enabled);
        } catch (error: unknown) {
            this.options.logger.warn(`Could not update start at login: ${error}`);
        }
    }

    async setPaused(paused: boolean): Promise<void> {
        this.update({ paused });
        if (!this.engine) {
            this.options.logger.warn(`Sync ${paused ? 'pause' : 'resume'} requested, but sync is not running`);
        }
        if (this.engine) {
            this.engine.setPaused(paused);
            this.notify();
        }
    }

    async setFolder(folder: string): Promise<void> {
        if (this.settings.enabled) {
            throw new KationError('InvalidArgument', 'Turn off sync before changing the sync folder');
        }
        const { config } = this.options;
        const normalized = validateFolder(folder, config.homeDir, [config.appDir, config.cacheDir, config.logDir, config.configDir]);
        if (normalized !== this.settings.folder) {
            // A different folder starts from scratch.
            this.state.clear();
            this.update({ folder: normalized });
        }
    }

    async setExcluded(paths: string[]): Promise<void> {
        const excluded = normalizeExcluded(paths);
        const added = excluded.filter((item) => !this.settings.excluded.includes(item));
        await this.stopEngine();
        // Forget what was synced in newly excluded folders. Otherwise, deleting the local
        // copy to free space and including the folder again later would look like a local
        // deletion and send the folder to the Proton trash. Including it again now merges
        // or downloads it like a new folder.
        for (const item of added) {
            this.state.removeTree(item);
        }
        // Folders included again: list their parent from the server on the next pass.
        for (const item of this.settings.excluded.filter((previous) => !excluded.includes(previous))) {
            this.state.addPending(parentOf(item));
        }
        this.update({ excluded });
        await this.apply();
    }

    syncNow(): void {
        if (!this.engine) {
            throw new KationError('InvalidArgument', 'Sync is off');
        }
        this.engine.syncNow();
    }

    onRemoteEvent(event: DriveEvent): void {
        this.engine?.onRemoteEvent(event);
    }

    /** The session ended unexpectedly: stop, but keep the state to resume after signing in again. */
    async onSessionLost(): Promise<void> {
        await this.stopEngine();
        this.notify();
    }

    /**
     * After sign-out: stop and forget the sync state (files stay on disk). Which
     * account the folder belongs to is kept, so signing in to another account
     * pauses sync instead of uploading this folder into it.
     */
    async onLogout(): Promise<void> {
        await this.stopEngine();
        const rootUid = this.state.getMeta('rootUid');
        this.state.clear();
        this.state.setMeta('rootUid', rootUid);
        this.notify();
    }

    async dispose(): Promise<void> {
        await this.stopEngine();
        this.state.close();
    }

    private async doApply(): Promise<void> {
        const shouldRun = this.settings.enabled && this.options.isLoggedIn();
        if (shouldRun && !this.engine) {
            this.engine = new SyncEngine({
                drive: this.options.drive,
                tree: this.options.tree,
                sdk: this.options.sdk,
                state: this.state,
                logger: this.options.logger,
                root: this.settings.folder,
                excluded: this.settings.excluded,
                onStatus: () => this.notify(),
                onActivity: (activity) => this.addActivity(activity),
                onItemsChanged: (paths) => this.options.onItemsChanged?.(paths.map((item) => this.localPathOf(item))),
                ...this.options.engineOptions,
            });
            this.options.logger.info(`Starting sync of ${this.settings.folder}`);
            await this.engine.start(this.settings.paused);
        } else if (!shouldRun && this.engine) {
            await this.stopEngine();
        }
        this.notify();
    }

    private async stopEngine(): Promise<void> {
        const engine = this.engine;
        this.engine = undefined;
        if (engine) {
            this.options.logger.info('Stopping sync');
            await engine.stop();
        }
    }

    private addActivity(activity: SyncActivity): void {
        const entry = { ...activity, localPath: this.localPathOf(activity.path) };
        this.recent.unshift(entry);
        this.recent.length = Math.min(this.recent.length, MAX_ACTIVITY);
        this.options.onActivity?.(entry);
    }

    private localPathOf(drivePath: string): string {
        return drivePath === '/' ? this.settings.folder : path.join(this.settings.folder, drivePath);
    }

    private applyLimits(): void {
        this.options.drive.uploadLimiter.setLimit(this.settings.uploadLimit * 1024);
        this.options.drive.downloadLimiter.setLimit(this.settings.downloadLimit * 1024);
    }

    private update(changes: Partial<SyncSettings>): void {
        this.settings = { ...this.settings, ...changes };
        this.settingsStore.save(this.settings);
        this.notify();
    }

    private notify(): void {
        this.options.onStatus?.(this.status());
    }
}
