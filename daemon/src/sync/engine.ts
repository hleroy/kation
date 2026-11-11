// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Two-way sync between a local folder and "My files".
 *
 * For every item, the current local state and remote state are compared with
 * the state recorded after the last sync (the base, see SyncState). Whichever
 * side changed is copied to the other; when both changed, both versions are
 * kept. Deletions go to the Proton Drive trash or the desktop trash, never
 * straight to oblivion.
 *
 * Remote changes are discovered through Drive events: only folders an event
 * points at are listed again ("fresh"); other folders are assumed to match the
 * base. The whole tree is listed only for the first sync or when Drive asks
 * for a refresh, as Proton's guidelines require. Local changes come from a
 * file watcher plus periodic local scans, which cost nothing remotely.
 */
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type DriveEvent, DriveEventType, type Logger, type NodeEntity } from '@protontech/drive-sdk';

import type { DriveService } from '../service/driveService';
import { MAX_NAME_BYTES, sha1Of } from '../service/driveService';
import { isFolder, nodeName } from '../service/entry';
import { KationError, toKationError } from '../service/errors';
import type { DriveSdk } from '../service/sdk';
import type { DriveTree } from '../service/tree';
import { conflictName, isIgnoredName, isLinkOrSpecial, type LocalItem, MARKER_NAME, moveToTrash, scanFolder, statItem } from './local';
import { findUnmountedDisk } from './mounts';
import { type BaseEntry, childPath, nameOf, parentOf, type SyncState } from './state';

export type SyncPhase = 'disabled' | 'idle' | 'syncing' | 'paused' | 'error';

/**
 * Why sync is paused or cannot run, for the KDE side to word (and translate):
 * "user" (paused from the menu or settings), "deletions" (more than
 * deletionLimit items would be deleted at once), "folder" (the sync folder is
 * missing or was replaced), "notMounted" (the sync folder is on a disk that is
 * not mounted), "account" (signed in to another account than the one the folder
 * was synced with), "signedOut" (sync is on but nobody is signed in), "items"
 * (some items could not be synced, with no error message), "links" (items are
 * not synced because a symbolic link or special file in the sync folder has
 * their name), or "" (none of these: see message).
 */
export type SyncReason = '' | 'user' | 'deletions' | 'folder' | 'notMounted' | 'account' | 'signedOut' | 'items' | 'links';

/** Default for SyncEngineOptions.maxDeletionsPerPass. */
export const DEFAULT_MAX_DELETIONS_PER_PASS = 100;

export type SyncStatus = {
    state: SyncPhase;
    /** English detail for logs and the command line: the error, or why sync is paused. */
    message: string;
    reason: SyncReason;
    /** Deletions allowed in one pass before sync pauses for safety. */
    deletionLimit: number;
    /** Path being transferred, or "". */
    current: string;
    /** Folders waiting to be synced. */
    pending: number;
    /** End of the last complete sync, seconds since the epoch (0: never). */
    lastSync: number;
};

/** Something sync did, shown as recent activity. Paths are inside "My files". */
export type SyncActivity = {
    /** Seconds since the epoch. */
    time: number;
    kind: 'uploaded' | 'downloaded' | 'trashedRemote' | 'trashedLocal' | 'conflict' | 'error' | 'skipped';
    path: string;
    /** Conflict: the path of the copy kept. Error: the error message. Skipped: why, as a code ("nameTooLong"). */
    detail: string;
};

/** Sync state of one local item, for file manager overlay icons. "" when not synced at all. */
export type ItemState = 'synced' | 'syncing' | 'pending' | 'paused' | 'error' | 'excluded' | '';

export type SyncEngineOptions = {
    drive: DriveService;
    tree: DriveTree;
    sdk: Pick<DriveSdk, 'getNode'>;
    state: SyncState;
    logger: Logger;
    /** Absolute path of the local sync folder. */
    root: string;
    /** Paths inside "My files" that are not synced, e.g. "/Videos". */
    excluded?: string[];
    /** Watch the local folder for changes (off in unit tests). */
    watch?: boolean;
    onStatus?: (status: SyncStatus) => void;
    onActivity?: (activity: SyncActivity) => void;
    /** Paths inside "My files" whose ItemState may have changed; [] means any. */
    onItemsChanged?: (paths: string[]) => void;
    /** Moves a local item to the desktop trash. */
    trash?: (absolutePath: string) => Promise<unknown>;
    now?: () => number;
    /** Files modified more recently than this are left until they settle. */
    settleMs?: number;
    /** Delay between a change and the sync pass, to batch changes. */
    debounceMs?: number;
    /** Deletions in one pass above which sync pauses for confirmation. */
    maxDeletionsPerPass?: number;
    /** Interval of the full local scan that catches missed watcher events. */
    rescanIntervalMs?: number;
    /** Interval of the (local, cheap) check that the sync folder is still there. */
    rootCheckIntervalMs?: number;
    /** The mount point the folder needs but that is not mounted, or undefined. */
    unmountedDisk?: (folder: string) => Promise<string | undefined>;
};

type RemoteItem = {
    name: string;
    type: 'file' | 'folder';
    uid: string;
    revision: string | null;
    sha1: string | null;
    size: number | null;
    /** Present when listed from the server; fetched lazily otherwise. */
    node?: NodeEntity;
};

/** How a folder's remote children are known. */
type RemoteSource = 'list' | 'base' | 'empty';

type FolderContext = {
    path: string;
    /** The remote folder, fetched (or created, with missing parents) on first use. */
    ensureRemote: () => Promise<NodeEntity>;
};

/** Stops a pass and pauses sync until the user resumes it. */
class SafetyPause extends Error {
    constructor(
        readonly kind: 'deletions' | 'folder' | 'notMounted' | 'account',
        message: string,
    ) {
        super(message);
    }
}

/** The local file changed while its new version was downloading. */
class LocalChangedDuringDownload extends Error {}

/** A symbolic link or special file has the name of a remote item: Kation neither follows nor replaces it. */
class LinkInTheWay extends Error {}

type Callbacks = 'onStatus' | 'onActivity' | 'onItemsChanged';

/** State key: the kind of safety pause ('folder' or 'account') sync is stuck in, until a pass succeeds. */
export const SAFETY_PAUSE_META = 'safetyPause';

const PASS_ABORTING_CODES = new Set(['RateLimited', 'Connection', 'NotLoggedIn', 'Cancelled']);
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;

export class SyncEngine {
    private readonly options: Required<Omit<SyncEngineOptions, Callbacks>> & Pick<SyncEngineOptions, Callbacks>;
    private status: SyncStatus = { state: 'idle', message: '', reason: '', deletionLimit: 0, current: '', pending: 0, lastSync: 0 };
    private fullPass: 'local' | 'fresh' | null = null;
    /** Folder path -> whether its remote listing must be fetched again. */
    private dirty = new Map<string, boolean>();
    private running?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private rescanTimer?: ReturnType<typeof setInterval>;
    private rootCheckTimer?: ReturnType<typeof setInterval>;
    private watcher?: FSWatcher;
    private abort = new AbortController();
    private stopped = false;
    private paused = false;
    private retryDelayMs = 0;
    private deletionsThisPass = 0;
    /** Folders with remote changes in the current pass: always listed from the server. */
    private freshFolders = new Set<string>();
    /** Items that could not be synced, until they are. */
    private failedItems = new Set<string>();
    /** Remote items not synced because their name or path is too long here; reported once each. */
    private skippedItems = new Set<string>();
    /** Items that failed with "not found" once; a second failure is reported as an error. */
    private notFoundRetried = new Set<string>();
    /** An item was skipped in this pass for a link with its name (reason "links"). */
    private linkInTheWay = false;
    /** The sync folder's real path, resolved once per pass (see checkNoLinkAbove). */
    private realRoot?: Promise<string>;
    /** Set when the user resumes after a deletion safety pause: the next pass may delete. */
    private allowMassDeletion = false;
    private pausedFor?: SafetyPause['kind'];
    /** The last error creating the sync folder, logged once. */
    private createError = '';
    private idleWaiters: (() => void)[] = [];

    constructor(options: SyncEngineOptions) {
        this.options = {
            excluded: [],
            watch: true,
            trash: (absolutePath) => moveToTrash(absolutePath),
            now: Date.now,
            settleMs: 2000,
            debounceMs: 1000,
            maxDeletionsPerPass: DEFAULT_MAX_DELETIONS_PER_PASS,
            rescanIntervalMs: 30 * 60 * 1000,
            rootCheckIntervalMs: 10 * 1000,
            unmountedDisk: findUnmountedDisk,
            ...options,
        };
        this.status.lastSync = Number(options.state.getMeta('lastSync') ?? 0);
        this.status.deletionLimit = this.options.maxDeletionsPerPass;
    }

    getStatus(): SyncStatus {
        return { ...this.status, pending: this.dirty.size + (this.fullPass ? 1 : 0) };
    }

    /** Starts syncing: a full pass now, then on changes. */
    async start(paused = false): Promise<void> {
        this.paused = paused;
        const disk = await this.prepareRoot();
        // First sync (or an interrupted one): list everything. Otherwise trust the base
        // for remote folders and let Drive events (replayed by the SDK) say what changed.
        this.fullPass = this.options.state.getMeta('initialSyncDone') ? 'local' : 'fresh';
        for (const pending of this.options.state.pending()) {
            this.dirty.set(pending, true);
        }
        // Not stat'ed on a disk that is not mounted: an automount point would block.
        if (this.options.watch && !disk && (await this.rootLooksValid())) {
            this.startWatcher();
        }
        this.rescanTimer = setInterval(() => this.requestFullPass('local'), this.options.rescanIntervalMs);
        this.rootCheckTimer = setInterval(() => void this.checkRootPresence(), this.options.rootCheckIntervalMs);
        this.setStatus(paused ? { state: 'paused', message: 'Paused', reason: 'user' } : { state: 'idle', message: '', reason: '' });
        this.schedule(0);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        clearTimeout(this.timer);
        clearInterval(this.rescanTimer);
        clearInterval(this.rootCheckTimer);
        this.watcher?.close();
        this.abort.abort();
        await this.running?.catch(() => {});
        this.setStatus({ state: 'disabled', message: '', reason: '', current: '' });
        this.resolveIdle();
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        // Drive change notifications keep being received while paused; they are applied on resume.
        this.logger.info(paused ? 'Sync paused' : 'Sync resumed');
        if (paused) {
            // The user's pause wins over resuming by itself when the folder or disk is back.
            this.pausedFor = undefined;
            this.abort.abort();
            clearTimeout(this.timer);
            this.timer = undefined;
            this.setStatus({ state: 'paused', message: 'Paused', reason: 'user', current: '' });
            if (!this.running) {
                this.resolveIdle();
            }
        } else {
            // Resuming after the deletion guard confirms those deletions.
            this.allowMassDeletion = this.pausedFor === 'deletions';
            this.pausedFor = undefined;
            this.retryDelayMs = 0;
            this.setStatus({ state: 'idle', message: '', reason: '' });
            this.requestFullPass('local');
        }
    }

    /** Scans the local folder now (remote changes arrive through events). */
    syncNow(): void {
        this.requestFullPass('local');
    }

    /** Resolves when no work is pending or running. For tests and shutdown. */
    whenIdle(): Promise<void> {
        const nothingToDo = this.dirty.size === 0 && !this.fullPass;
        if (!this.running && (!this.timer || this.paused || this.stopped) && (nothingToDo || this.paused || this.stopped)) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    /** Called for every Drive event, after the path cache has seen it. */
    onRemoteEvent(event: DriveEvent): void {
        switch (event.type) {
            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated:
            case DriveEventType.NodeDeleted: {
                const folders = new Set<string>();
                const parent = this.folderPathOfUid(event.parentNodeUid);
                if (parent !== undefined) {
                    folders.add(parent);
                }
                // The node's previous location, for moves, renames and deletions.
                const known = this.options.state.byRemoteUid(event.nodeUid);
                if (known) {
                    folders.add(parentOf(known.path));
                }
                for (const folder of folders) {
                    this.markDirty(folder, true);
                }
                break;
            }
            case DriveEventType.TreeRefresh:
                this.requestFullPass('fresh');
                break;
            default:
                break;
        }
    }

    /** Called for local changes; `relativePath` is inside the sync folder. */
    onLocalChange(relativePath: string): void {
        if (relativePath.split('/').some((part) => part && isIgnoredName(part))) {
            return;
        }
        this.markDirty(parentOf(relativePath), false);
    }

    private markDirty(folder: string, fresh: boolean): void {
        if (fresh) {
            this.options.state.addPending(folder);
        }
        this.dirty.set(folder, fresh || (this.dirty.get(folder) ?? false));
        this.schedule();
    }

    private requestFullPass(kind: 'local' | 'fresh'): void {
        this.fullPass = this.fullPass === 'fresh' || kind === 'fresh' ? 'fresh' : 'local';
        this.schedule();
    }

    private schedule(delay = this.options.debounceMs): void {
        if (this.stopped || this.paused) {
            return;
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.run();
        }, delay);
    }

    private async run(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = (async () => {
            while (!this.stopped && !this.paused && (this.fullPass || this.dirty.size > 0)) {
                await this.pass();
                if (this.timer) {
                    break; // a retry was scheduled
                }
            }
        })();
        try {
            await this.running;
        } finally {
            this.running = undefined;
            if (!this.timer) {
                this.resolveIdle();
            }
        }
    }

    private async pass(): Promise<void> {
        const full = this.fullPass;
        const dirty = this.dirty;
        this.fullPass = null;
        this.dirty = new Map();
        this.freshFolders = new Set([...dirty].filter(([, fresh]) => fresh).map(([folder]) => folder));
        this.deletionsThisPass = 0;
        this.linkInTheWay = false;
        this.realRoot = undefined;
        this.abort = new AbortController();
        const abort = this.abort;
        this.logger.info(
            `Sync pass: ${full ? `full (${full})` : 'changes'}, folders ${[...dirty.keys()].join(', ') || '-'}` +
                (this.paused ? ' [paused!]' : ''),
        );
        this.setStatus({ state: 'syncing', message: '', reason: '' });

        let failedFolders: string[] = [];
        try {
            await this.checkRoot();
            // Not running after a start on a missing disk or folder, or after one went missing.
            if (this.options.watch && this.watcher === undefined) {
                this.startWatcher();
            }
            if (full) {
                // The traversal lists folders with remote changes from the server (freshFolders),
                // so it covers every dirty folder.
                failedFolders = await this.syncFolderAt('/', full === 'fresh' || this.freshFolders.has('/'), true);
                for (const folder of dirty.keys()) {
                    if (!failedFolders.includes(folder)) {
                        this.options.state.removePending(folder);
                    }
                }
            } else {
                const ordered = [...dirty.entries()].sort(([a], [b]) => depth(a) - depth(b) || a.localeCompare(b));
                for (const [folder, fresh] of ordered) {
                    failedFolders.push(...(await this.syncFolderAt(folder, fresh, false)));
                }
            }
        } catch (error: unknown) {
            this.handlePassError(error, full, dirty, abort.signal.aborted);
            return;
        }
        if (abort.signal.aborted) {
            // Paused during the pass (see checkRootPresence, setPaused): put the work back, keep the status.
            this.handlePassError(new KationError('Cancelled', 'Paused'), full, dirty, true);
            return;
        }

        if (failedFolders.length > 0) {
            for (const folder of failedFolders) {
                this.dirty.set(folder, true);
            }
            this.retryDelayMs = Math.min(Math.max(this.retryDelayMs * 2, 5000), MAX_RETRY_DELAY_MS);
            const message = this.status.message;
            const reason: SyncReason = message ? '' : this.linkInTheWay ? 'links' : 'items';
            this.setStatus({
                state: 'error',
                current: '',
                message:
                    message ||
                    (reason === 'links'
                        ? 'A symbolic link in the sync folder has the name of an item in Proton Drive; rename or remove it to sync that item'
                        : 'Some items could not be synced'),
                reason,
            });
            this.schedule(this.retryDelayMs);
            return;
        }

        this.retryDelayMs = 0;
        this.allowMassDeletion = false;
        if (this.dirty.size === 0) {
            this.notFoundRetried.clear();
        }
        if (this.failedItems.size > 0) {
            this.failedItems.clear();
            this.options.onItemsChanged?.([]);
        }
        if (full === 'fresh') {
            this.options.state.setMeta('initialSyncDone', '1');
        }
        this.options.state.setMeta(SAFETY_PAUSE_META, undefined);
        const lastSync = Math.floor(this.options.now() / 1000);
        this.options.state.setMeta('lastSync', String(lastSync));
        this.setStatus({ state: 'idle', message: '', reason: '', current: '', lastSync });
    }

    private handlePassError(error: unknown, full: 'local' | 'fresh' | null, dirty: Map<string, boolean>, abortedOnPurpose: boolean): void {
        // Put the work back so nothing is lost.
        if (full) {
            this.requestFullPass(full);
        }
        for (const [folder, fresh] of dirty) {
            this.dirty.set(folder, fresh || (this.dirty.get(folder) ?? false));
        }
        // Paused for safety during the pass (see checkRootPresence): whatever the aborted
        // pass ran into next, often the missing folder, must not replace that pause.
        if (this.pausedFor) {
            return;
        }
        if (error instanceof SafetyPause) {
            this.pauseFor(error);
            return;
        }
        const kationError = toKationError(error);
        // Stopped by a pause (possibly already resumed): the work was put back above.
        if (kationError.code === 'Cancelled' && (this.paused || this.stopped || abortedOnPurpose)) {
            return;
        }
        this.logger.error('Sync pass failed', error);
        this.retryDelayMs = Math.min(
            Math.max(this.retryDelayMs * 2, kationError.code === 'RateLimited' ? 120_000 : 15_000),
            MAX_RETRY_DELAY_MS,
        );
        this.setStatus({ state: 'error', message: kationError.message, reason: '', current: '' });
        if (kationError.code !== 'NotLoggedIn') {
            this.schedule(this.retryDelayMs);
        }
    }

    private pauseFor(pause: SafetyPause): void {
        this.logger.warn(`Sync paused: ${pause.message}`);
        this.paused = true;
        this.pausedFor = pause.kind;
        if (pause.kind === 'folder' || pause.kind === 'account') {
            // Remembered so that turning sync off and on again starts over (see SyncController).
            this.options.state.setMeta(SAFETY_PAUSE_META, pause.kind);
        } else if (pause.kind === 'notMounted') {
            // Starting over would merge the disk's files back as new once it is mounted.
            this.options.state.setMeta(SAFETY_PAUSE_META, undefined);
        }
        if (pause.kind === 'folder' || pause.kind === 'notMounted') {
            // It watches a folder that is gone; the next pass watches the one that is back.
            this.watcher?.close();
            this.watcher = undefined;
        }
        clearTimeout(this.timer);
        this.timer = undefined;
        this.setStatus({ state: 'paused', message: pause.message, reason: pause.kind, current: '' });
    }

    /**
     * On a first sync, creates the sync folder, but not its parents: a missing parent is
     * more likely a disk that is not there than folders to create. Never on a disk that is
     * not mounted. Returns that disk's mount point, if any.
     */
    private async prepareRoot(): Promise<string | undefined> {
        const disk = await this.options.unmountedDisk(this.options.root);
        if (disk || !this.options.state.isEmpty() || this.stopped) {
            return disk;
        }
        await mkdir(this.options.root).catch((error: NodeJS.ErrnoException) => {
            // Logged once: the folder check repeats every rootCheckIntervalMs.
            if (error.code !== 'EEXIST' && error.message !== this.createError) {
                this.createError = error.message;
                this.logger.warn(`Cannot create the sync folder ${this.options.root}: ${error.message}`);
            }
        });
        await writeFile(path.join(this.options.root, MARKER_NAME), 'Synced by Kation. Do not delete.\n', { flag: 'wx' }).catch(
            (error: NodeJS.ErrnoException) => {
                if (error.code !== 'EEXIST' && error.code !== 'ENOENT') {
                    this.logger.warn(`Cannot write ${MARKER_NAME} in the sync folder: ${error.message}`);
                }
            },
        );
        return undefined;
    }

    /** Why sync cannot run in the sync folder now, or undefined. */
    private async rootProblem(): Promise<SafetyPause | undefined> {
        const notMounted = (disk: string) =>
            new SafetyPause(
                'notMounted',
                `The sync folder ${this.options.root} is on a disk that is not mounted (${disk}). Mount it and sync starts by itself.`,
            );
        const disk = await this.prepareRoot();
        if (disk) {
            return notMounted(disk);
        }
        if (!(await this.rootLooksValid())) {
            // The disk may have gone since the first check.
            const gone = await this.options.unmountedDisk(this.options.root);
            if (gone) {
                return notMounted(gone);
            }
            // Removed or replaced: syncing would look like a mass deletion.
            return new SafetyPause(
                'folder',
                `The sync folder ${this.options.root} is missing or was replaced. Restore it and sync resumes by itself, or turn sync off and on again to start over.`,
            );
        }
        return undefined;
    }

    private async checkRoot(): Promise<void> {
        const problem = await this.rootProblem();
        if (problem) {
            throw problem;
        }
    }

    /**
     * Before writing in the sync folder during a pass: its disk may have been unmounted
     * since the pass began. Files written in the empty mount point and recorded as
     * synced would be missing once the disk is back, and then trashed on Proton.
     */
    private async checkRootBeforeWrite(): Promise<void> {
        if (!(await this.rootLooksValid())) {
            await this.checkRoot();
        }
    }

    /** Syncs one folder (by its sync path). Returns the folders that had errors. */
    private async syncFolderAt(folder: string, fresh: boolean, recursive: boolean): Promise<string[]> {
        if (this.isExcluded(folder)) {
            this.options.state.removePending(folder);
            return [];
        }
        let context: FolderContext;
        if (folder === '/') {
            const root = await this.options.tree.root();
            this.checkAccount(root.uid);
            context = this.nodeContext(folder, root);
        } else {
            const base = this.options.state.get(folder);
            if (base?.type !== 'folder') {
                // Not synced yet: its parent decides what to do with it.
                this.options.state.removePending(folder);
                return this.syncFolderAt(parentOf(folder), fresh, false);
            }
            if (await this.throughLink(folder)) {
                // Replaced here by a symbolic link, or inside one: never synced through, its parent reports it.
                this.options.state.removePending(folder);
                return this.syncFolderAt(parentOf(folder), fresh, false);
            }
            if (fresh) {
                const remote = await this.getNodeOrUndefined(base.remoteUid);
                if (!remote || remote.trashTime) {
                    // Gone remotely: the parent's listing will show it.
                    this.options.state.removePending(folder);
                    return this.syncFolderAt(parentOf(folder), true, false);
                }
                context = this.nodeContext(folder, remote);
            } else {
                context = this.nodeContext(folder, base.remoteUid);
            }
        }
        const errors: string[] = [];
        await this.reconcileFolder(context, fresh ? 'list' : 'base', fresh, recursive, errors);
        if (!errors.includes(folder)) {
            this.options.state.removePending(folder);
        }
        return errors;
    }

    private checkAccount(rootUid: string): void {
        const known = this.options.state.getMeta('rootUid');
        if (known && known !== rootUid) {
            throw new SafetyPause(
                'account',
                'You are signed in to a different Proton account than the one this folder was synced with. Turn sync off and on again to sync this folder with the current account instead.',
            );
        }
        if (!known) {
            this.options.state.setMeta('rootUid', rootUid);
        }
    }

    private async reconcileFolder(
        context: FolderContext,
        source: RemoteSource,
        fresh: boolean,
        recursive: boolean,
        errors: string[],
    ): Promise<void> {
        const folder = context.path;
        const base = this.options.state.children(folder);
        let local: Map<string, LocalItem>;
        let remote: Map<string, RemoteItem>;
        try {
            local = await scanFolder(this.absolute(folder));
            remote = await this.remoteChildren(context, source, base);
        } catch (error: unknown) {
            const kationError = toKationError(error);
            if (PASS_ABORTING_CODES.has(kationError.code)) {
                throw kationError;
            }
            this.logger.error(`Failed to list ${folder}`, error);
            this.status.message = `${folder}: ${kationError.message}`;
            if (!errors.includes(folder)) {
                errors.push(folder);
            }
            return;
        }
        if (local.size === 0 && base.size > 0) {
            // Everything gone at once: the disk may have just been unmounted.
            const problem = await this.rootProblem();
            if (problem) {
                throw problem;
            }
        }
        this.abort.signal.throwIfAborted();

        await this.checkDeletionCount(folder, base, local, remote);
        const names = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort();
        const skipped = new Set<string>();
        // Only on this side: someone else's item must not keep sync in error (an editor of a shared folder).
        const remoteOnly = (name: string) => remote.has(name) && !local.has(name) && !base.has(name);
        for (const name of names) {
            this.abort.signal.throwIfAborted();
            const itemPath = childPath(folder, name);
            if (isIgnoredName(name) || this.isExcluded(itemPath)) {
                continue;
            }
            if (remoteOnly(name) && Buffer.byteLength(name) > MAX_NAME_BYTES) {
                this.skipTooLong(itemPath);
                skipped.add(itemPath);
                continue;
            }
            try {
                await this.reconcileItem(context, itemPath, local.get(name), remote.get(name), base.get(name), fresh, recursive, errors);
            } catch (error: unknown) {
                if (error instanceof SafetyPause) {
                    throw error;
                }
                const kationError = toKationError(error);
                if (PASS_ABORTING_CODES.has(kationError.code)) {
                    throw kationError;
                }
                // A file system with a lower limit (eCryptfs), or a path too long as a whole.
                if (remoteOnly(name) && isNameTooLong(error)) {
                    this.skipTooLong(itemPath);
                    skipped.add(itemPath);
                    continue;
                }
                if (kationError.code === 'NotFound' && !this.notFoundRetried.has(itemPath)) {
                    // Usually a race: the item or its folder changed on Proton during this pass
                    // (for example trashed), and the event has not been applied yet. List the
                    // folder again from the server once before calling it an error.
                    this.notFoundRetried.add(itemPath);
                    this.logger.warn(`${itemPath} changed on Proton during sync (${kationError.message}); checking again`);
                    this.markDirty(folder, true);
                    continue;
                }
                const linked = error instanceof LinkInTheWay;
                if (linked) {
                    this.logger.warn(`Not syncing ${itemPath}: ${kationError.message}`);
                    this.linkInTheWay = true;
                } else {
                    this.logger.error(`Failed to sync ${itemPath}`, error);
                    this.status.message = `${itemPath}: ${kationError.message}`;
                }
                if (!this.failedItems.has(itemPath)) {
                    this.failedItems.add(itemPath);
                    // The KDE side words link problems from the "links" reason, not from an English detail.
                    this.activity('error', itemPath, linked ? '' : kationError.message);
                    this.options.onItemsChanged?.([itemPath]);
                }
                if (!errors.includes(folder)) {
                    errors.push(folder);
                }
            }
        }
        if (source === 'list') {
            // Listed from the server: skipped items not seen again were renamed, moved or deleted.
            for (const itemPath of this.skippedItems) {
                if (parentOf(itemPath) === folder && !skipped.has(itemPath)) {
                    this.skippedItems.delete(itemPath);
                }
            }
        }
    }

    private skipTooLong(itemPath: string): void {
        if (this.skippedItems.has(itemPath)) {
            return;
        }
        this.skippedItems.add(itemPath);
        this.logger.warn(`Not syncing ${itemPath}: its name or path is too long for the local file system`);
        this.activity('skipped', itemPath, 'nameTooLong');
    }

    private async remoteChildren(
        context: FolderContext,
        source: RemoteSource,
        base: Map<string, BaseEntry>,
    ): Promise<Map<string, RemoteItem>> {
        const items = new Map<string, RemoteItem>();
        if (source === 'empty') {
            return items;
        }
        if (source === 'base') {
            for (const [name, entry] of base) {
                items.set(name, {
                    name,
                    type: entry.type,
                    uid: entry.remoteUid,
                    revision: entry.remoteRevision,
                    sha1: entry.remoteSha1,
                    size: entry.localSize,
                });
            }
            return items;
        }
        const remoteFolder = await context.ensureRemote();
        this.options.tree.invalidate(remoteFolder.uid);
        for (const node of await this.options.tree.list(remoteFolder)) {
            if (node.trashTime || isProtonDocument(node)) {
                continue;
            }
            if (!node.name.ok) {
                const tooLong = tooLongName(node.name.error);
                if (tooLong !== undefined && !this.options.state.byRemoteUid(node.uid)) {
                    // Never synced: kept under its name, which reconcileFolder skips as too long.
                    items.set(tooLong, { ...remoteItemFromNode(node), name: tooLong });
                    continue;
                }
                // An item we cannot name would look like a deletion of the local copy.
                // Skip the whole folder until it lists cleanly.
                throw new Error(`An item in ${context.path} could not be decrypted; this folder is skipped for now`);
            }
            const name = nodeName(node);
            items.set(name, {
                name,
                type: isFolder(node) ? 'folder' : 'file',
                uid: node.uid,
                revision: node.activeRevision?.uid ?? null,
                sha1: node.activeRevision?.claimedDigests?.sha1 ?? null,
                size: node.activeRevision?.claimedSize ?? null,
                node,
            });
        }
        return items;
    }

    private async reconcileItem(
        parent: FolderContext,
        itemPath: string,
        local: LocalItem | undefined,
        remote: RemoteItem | undefined,
        base: BaseEntry | undefined,
        fresh: boolean,
        recursive: boolean,
        errors: string[],
    ): Promise<void> {
        if (!local && !remote) {
            if (base) {
                this.options.state.removeTree(itemPath);
            }
            return;
        }
        if (!local && remote && (await isLinkOrSpecial(this.absolute(itemPath)))) {
            // Not a local deletion either. Without its base, removing the link later brings the item back instead of trashing it.
            if (base) {
                this.options.state.removeTree(itemPath);
            }
            throw new LinkInTheWay('A symbolic link or special file has this name in the sync folder');
        }

        const localChanged = hasLocalChange(local, base);
        const remoteChanged = hasRemoteChange(remote, base);

        // One side changed type (file <-> folder).
        if (local && remote && local.type !== remote.type) {
            if (base && base.type === local.type && !localChanged) {
                await this.trashLocal(itemPath);
                this.options.state.removeTree(itemPath);
                return this.reconcileItem(parent, itemPath, undefined, remote, undefined, fresh, recursive, errors);
            }
            if (base && base.type === remote.type && !remoteChanged) {
                await this.trashRemote(itemPath, remote);
                this.options.state.removeTree(itemPath);
                return this.reconcileItem(parent, itemPath, local, undefined, undefined, fresh, recursive, errors);
            }
            const renamed = await this.keepLocalCopy(itemPath);
            this.options.state.removeTree(itemPath);
            await this.reconcileItem(parent, renamed.path, renamed.item, undefined, undefined, fresh, recursive, errors);
            return this.reconcileItem(parent, itemPath, undefined, remote, undefined, fresh, recursive, errors);
        }

        if (local?.type === 'folder' || remote?.type === 'folder') {
            return this.reconcileFolderItem(parent, itemPath, local, remote, base, fresh, recursive, errors);
        }
        return this.reconcileFile(parent, itemPath, local, remote, base, localChanged, remoteChanged);
    }

    private async reconcileFolderItem(
        parent: FolderContext,
        itemPath: string,
        local: LocalItem | undefined,
        remote: RemoteItem | undefined,
        base: BaseEntry | undefined,
        fresh: boolean,
        recursive: boolean,
        errors: string[],
    ): Promise<void> {
        const name = nameOf(itemPath);

        if (local && remote) {
            const known = base?.type === 'folder' && base.remoteUid === remote.uid;
            if (!known) {
                this.recordFolder(itemPath, remote.uid);
            }
            if (recursive || !known) {
                const childFresh = fresh || !known || this.freshFolders.has(itemPath);
                const context = this.nodeContext(itemPath, remote.node ?? remote.uid);
                await this.reconcileFolder(context, childFresh ? 'list' : 'base', childFresh, true, errors);
            }
            return;
        }

        if (local) {
            if (base?.type === 'folder') {
                // Deleted remotely. Keep only what changed locally since the last sync.
                if (await this.localTreeMatchesBase(itemPath)) {
                    await this.trashLocal(itemPath);
                    this.options.state.removeTree(itemPath);
                    return;
                }
                let recreated: NodeEntity | undefined;
                const context: FolderContext = {
                    path: itemPath,
                    ensureRemote: async () => {
                        recreated ??= await this.options.drive.createFolderIn(await parent.ensureRemote(), name);
                        return recreated;
                    },
                };
                // Children still have their base: unchanged ones follow the deletion, changed ones are uploaded.
                await this.reconcileFolder(context, 'empty', true, true, errors);
                if (recreated) {
                    this.recordFolder(itemPath, recreated.uid);
                } else {
                    this.options.state.removeTree(itemPath);
                    await rmdir(this.absolute(itemPath)).catch(() => {});
                }
                return;
            }
            // New local folder.
            const created = await this.options.drive.createFolderIn(await parent.ensureRemote(), name);
            this.recordFolder(itemPath, created.uid);
            await this.reconcileFolder(this.nodeContext(itemPath, created), 'empty', true, true, errors);
            return;
        }

        if (remote) {
            if (base?.type === 'folder' && base.remoteUid === remote.uid) {
                const context = this.nodeContext(itemPath, remote.node ?? remote.uid);
                if (await this.remoteTreeMatchesBase(context)) {
                    // Deleted locally: the whole folder goes to the Proton trash, where it can be restored.
                    await this.trashRemote(itemPath, remote);
                    this.options.state.removeTree(itemPath);
                    return;
                }
                // Deleted locally but changed on Proton since the last sync. Children still have their
                // base: unchanged ones follow the deletion, changed ones are downloaded.
                await this.reconcileFolder(context, 'list', true, true, errors);
                await this.checkRootBeforeWrite();
                await this.checkNoLinkAbove(itemPath);
                await mkdir(this.absolute(itemPath), { recursive: true });
                return;
            }
            // New remote folder.
            await this.checkRootBeforeWrite();
            await this.checkNoLinkAbove(itemPath);
            await mkdir(this.absolute(itemPath), { recursive: true });
            this.recordFolder(itemPath, remote.uid);
            await this.reconcileFolder(this.nodeContext(itemPath, remote.node ?? remote.uid), 'list', true, true, errors);
        }
    }

    private async reconcileFile(
        parent: FolderContext,
        itemPath: string,
        local: LocalItem | undefined,
        remote: RemoteItem | undefined,
        base: BaseEntry | undefined,
        localChanged: boolean,
        remoteChanged: boolean,
    ): Promise<void> {
        if (local && localChanged && !this.isSettled(local)) {
            // Still being written: try again shortly.
            this.dirty.set(parentOf(itemPath), this.dirty.get(parentOf(itemPath)) ?? false);
            this.schedule(this.options.settleMs);
            return;
        }

        if (local && remote) {
            if (!base || (localChanged && remoteChanged)) {
                if (await this.sameContent(itemPath, local, remote)) {
                    this.recordFile(itemPath, local, remote);
                } else {
                    await this.resolveConflict(parent, itemPath, remote);
                }
            } else if (localChanged) {
                const existing = remote.node ?? (await this.options.sdk.getNode(remote.uid));
                if (!remote.node) {
                    // The remote side was assumed unchanged. Check before replacing it: a change
                    // whose event was not processed yet must become a conflict, not be overwritten.
                    const current = remoteItemFromNode(existing);
                    if (existing.trashTime) {
                        this.markDirty(parentOf(itemPath), true);
                        await this.upload(parent, itemPath, local, undefined);
                        return;
                    }
                    if (hasRemoteChange(current, base)) {
                        if (await this.sameContent(itemPath, local, current)) {
                            this.recordFile(itemPath, local, current);
                        } else {
                            await this.resolveConflict(parent, itemPath, current);
                        }
                        return;
                    }
                }
                await this.upload(parent, itemPath, local, existing);
            } else if (remoteChanged) {
                await this.download(itemPath, remote, local);
            }
            return;
        }

        if (local) {
            if (base && !localChanged) {
                // Deleted remotely and unchanged here.
                await this.trashLocal(itemPath);
                this.options.state.removeTree(itemPath);
            } else {
                // New here, or changed here while deleted remotely: keep it.
                await this.upload(parent, itemPath, local, undefined);
            }
            return;
        }

        if (remote) {
            if (base && !remoteChanged) {
                // Deleted here and unchanged remotely.
                await this.trashRemote(itemPath, remote);
                this.options.state.removeTree(itemPath);
            } else {
                // New remotely, or changed remotely while deleted here: keep it.
                await this.download(itemPath, remote, undefined);
            }
        }
    }

    /** Both sides changed differently: the remote version keeps the name, the local one is renamed and uploaded. */
    private async resolveConflict(parent: FolderContext, itemPath: string, remote: RemoteItem): Promise<void> {
        const renamed = await this.keepLocalCopy(itemPath);
        this.logger.warn(`Conflict on ${itemPath}: keeping the local version as ${renamed.path}`);
        this.activity('conflict', itemPath, renamed.path);
        if (renamed.item.type === 'file') {
            await this.upload(parent, renamed.path, renamed.item, undefined);
        }
        await this.download(itemPath, remote, undefined);
    }

    /** Renames the local item to a free conflict name and returns it. */
    private async keepLocalCopy(itemPath: string): Promise<{ path: string; item: LocalItem }> {
        const folder = parentOf(itemPath);
        const name = nameOf(itemPath);
        const date = new Date(this.options.now());
        for (let attempt = 0; attempt < 100; attempt++) {
            const candidate = childPath(folder, conflictName(name, date, attempt));
            if (await statItem(this.absolute(candidate))) {
                continue;
            }
            await this.checkNoLinkAbove(itemPath);
            await rename(this.absolute(itemPath), this.absolute(candidate));
            const item = await statItem(this.absolute(candidate));
            if (!item) {
                throw new Error(`Lost ${candidate} while renaming it`);
            }
            return { path: candidate, item };
        }
        throw new Error(`No free conflict name for ${itemPath}`);
    }

    private async upload(parent: FolderContext, itemPath: string, local: LocalItem, existing: NodeEntity | undefined): Promise<void> {
        this.logger.info(`Uploading ${itemPath}${existing ? ' (new version)' : ''}`);
        this.setStatus({ current: itemPath });
        const remoteParent = await parent.ensureRemote();
        let node: NodeEntity;
        try {
            node = await this.options.drive.uploadFile(remoteParent, nameOf(itemPath), this.absolute(itemPath), existing, {
                signal: this.abort.signal,
            });
        } catch (error: unknown) {
            if (!existing && toKationError(error).code === 'AlreadyExists') {
                // Appeared remotely meanwhile: list again and decide next pass.
                this.markDirty(parentOf(itemPath), true);
                return;
            }
            throw error;
        }
        // Record the state read before the upload: a change during the upload is uploaded next time.
        this.recordFile(itemPath, local, {
            name: nameOf(itemPath),
            type: 'file',
            uid: node.uid,
            revision: node.activeRevision?.uid ?? null,
            sha1: node.activeRevision?.claimedDigests?.sha1 ?? null,
            size: node.activeRevision?.claimedSize ?? null,
        });
        this.setStatus({ current: '' });
        this.itemDone(itemPath, 'uploaded');
    }

    /** Downloads over `expected`, the local item the decision was based on (undefined: none). */
    private async download(itemPath: string, remote: RemoteItem, expected: LocalItem | undefined): Promise<void> {
        this.logger.info(`Downloading ${itemPath}`);
        this.setStatus({ current: itemPath });
        const node = remote.node ?? (await this.options.sdk.getNode(remote.uid));
        await this.checkRootBeforeWrite();
        await this.checkNoLinkAbove(itemPath);
        await mkdir(this.absolute(parentOf(itemPath)), { recursive: true });
        // A local edit saved while the download ran must not be overwritten: the next pass sees both changes.
        const beforeReplace = async () => {
            if (!sameLocalState(await statItem(this.absolute(itemPath)), expected)) {
                throw new LocalChangedDuringDownload();
            }
            await this.checkNoLinkAbove(itemPath);
        };
        try {
            await this.options.drive.downloadNode(node, this.absolute(itemPath), {
                signal: this.abort.signal,
                resumable: true,
                beforeReplace,
            });
        } catch (error: unknown) {
            if (error instanceof LocalChangedDuringDownload) {
                this.logger.info(`${itemPath} changed here during its download; checking again`);
                this.setStatus({ current: '' });
                this.markDirty(parentOf(itemPath), true);
                return;
            }
            throw error;
        }
        await this.checkRootBeforeWrite();
        const local = await statItem(this.absolute(itemPath));
        if (!local) {
            throw new Error(`Downloaded file disappeared: ${itemPath}`);
        }
        this.recordFile(itemPath, local, {
            ...remote,
            revision: node.activeRevision?.uid ?? remote.revision,
            sha1: node.activeRevision?.claimedDigests?.sha1 ?? remote.sha1,
        });
        this.setStatus({ current: '' });
        this.itemDone(itemPath, 'downloaded');
    }

    private async trashLocal(itemPath: string): Promise<void> {
        this.countDeletion();
        this.logger.info(`Moving ${itemPath} to the desktop trash (deleted in Proton Drive)`);
        await this.checkNoLinkAbove(itemPath);
        await this.options.trash(this.absolute(itemPath));
        this.itemDone(itemPath, 'trashedLocal');
    }

    private async trashRemote(itemPath: string, remote: RemoteItem): Promise<void> {
        this.countDeletion();
        this.logger.info(`Moving ${itemPath} to the Proton Drive trash (deleted locally)`);
        const node = remote.node ?? (await this.getNodeOrUndefined(remote.uid));
        if (node && !node.trashTime) {
            await this.options.drive.trashNode(node);
        }
        this.itemDone(itemPath, 'trashedRemote');
    }

    /**
     * Pauses before deleting anything in a folder when its deletions would go over the
     * limit. Counts every synced item now missing on one side; some of them may turn out
     * to be kept (changed on the other side), so this errs towards pausing.
     */
    private async checkDeletionCount(
        folder: string,
        base: Map<string, BaseEntry>,
        local: Map<string, LocalItem>,
        remote: Map<string, RemoteItem>,
    ): Promise<void> {
        if (this.allowMassDeletion) {
            return;
        }
        let candidates = 0;
        for (const name of base.keys()) {
            const itemPath = childPath(folder, name);
            if (local.has(name) === remote.has(name) || isIgnoredName(name) || this.isExcluded(itemPath)) {
                continue;
            }
            // A link with the item's name is reported, not deleted (see reconcileItem).
            if (!local.has(name) && (await isLinkOrSpecial(this.absolute(itemPath)).catch(() => false))) {
                continue;
            }
            candidates++;
        }
        if (this.deletionsThisPass + candidates > this.options.maxDeletionsPerPass) {
            throw this.massDeletionPause();
        }
    }

    private massDeletionPause(): SafetyPause {
        return new SafetyPause(
            'deletions',
            `More than ${this.options.maxDeletionsPerPass} items would be deleted at once. Check the sync folder, then resume sync to continue.`,
        );
    }

    private countDeletion(): void {
        this.deletionsThisPass++;
        if (this.deletionsThisPass > this.options.maxDeletionsPerPass && !this.allowMassDeletion) {
            throw this.massDeletionPause();
        }
    }

    private async sameContent(itemPath: string, local: LocalItem, remote: RemoteItem): Promise<boolean> {
        if (remote.size !== null && remote.size !== local.size) {
            return false;
        }
        if (!remote.sha1) {
            return false;
        }
        return (await sha1Of(this.absolute(itemPath), this.abort.signal)) === remote.sha1;
    }

    /** Whether nothing under a local folder is new or modified since the last sync. */
    private async localTreeMatchesBase(folder: string): Promise<boolean> {
        const base = this.options.state.children(folder);
        for (const [name, item] of await scanFolder(this.absolute(folder))) {
            const entry = base.get(name);
            if (!entry || hasLocalChange(item, entry)) {
                return false;
            }
            if (item.type === 'folder' && !(await this.localTreeMatchesBase(childPath(folder, name)))) {
                return false;
            }
        }
        return true;
    }

    /**
     * Whether nothing under a remote folder is new or modified since the last sync
     * (lists the folder and its subfolders from the server). Items in excluded folders
     * were never synced, so they count as changes: they must not be trashed with it.
     */
    private async remoteTreeMatchesBase(context: FolderContext): Promise<boolean> {
        const base = this.options.state.children(context.path);
        for (const [name, item] of await this.remoteChildren(context, 'list', base)) {
            const itemPath = childPath(context.path, name);
            if (isIgnoredName(name)) {
                continue;
            }
            const entry = base.get(name);
            if (this.isExcluded(itemPath) || !entry || hasRemoteChange(item, entry)) {
                return false;
            }
            if (item.type === 'folder' && !(await this.remoteTreeMatchesBase(this.nodeContext(itemPath, item.node ?? item.uid)))) {
                return false;
            }
        }
        return true;
    }

    /** Context for a folder that exists remotely; a UID is resolved only if an operation needs the node. */
    private nodeContext(itemPath: string, nodeOrUid: NodeEntity | string): FolderContext {
        let node: Promise<NodeEntity> | undefined = typeof nodeOrUid === 'string' ? undefined : Promise.resolve(nodeOrUid);
        return {
            path: itemPath,
            ensureRemote: () => (node ??= this.options.sdk.getNode(nodeOrUid as string)),
        };
    }

    private recordFolder(itemPath: string, remoteUid: string): void {
        this.options.state.put({
            path: itemPath,
            type: 'folder',
            localSize: null,
            localMtime: null,
            remoteUid,
            remoteRevision: null,
            remoteSha1: null,
        });
    }

    private recordFile(itemPath: string, local: LocalItem, remote: RemoteItem): void {
        this.options.state.put({
            path: itemPath,
            type: 'file',
            localSize: local.size,
            localMtime: local.mtime,
            remoteUid: remote.uid,
            remoteRevision: remote.revision,
            remoteSha1: remote.sha1,
        });
    }

    private isSettled(local: LocalItem): boolean {
        const age = this.options.now() - local.mtime;
        // A time far in the future (clock skew, copied files) is not a file being written.
        return age >= this.options.settleMs || -age > this.options.settleMs;
    }

    private isExcluded(itemPath: string): boolean {
        return this.options.excluded.some((excluded) => itemPath === excluded || itemPath.startsWith(`${excluded}/`));
    }

    private folderPathOfUid(uid: string | undefined): string | undefined {
        if (!uid) {
            return undefined;
        }
        if (uid === this.options.state.getMeta('rootUid')) {
            return '/';
        }
        const entry = this.options.state.byRemoteUid(uid);
        return entry?.type === 'folder' ? entry.path : undefined;
    }

    private async getNodeOrUndefined(uid: string): Promise<NodeEntity | undefined> {
        try {
            return await this.options.sdk.getNode(uid);
        } catch (error: unknown) {
            const code = toKationError(error).code;
            if (code === 'InvalidArgument' || code === 'NotFound') {
                return undefined;
            }
            throw error;
        }
    }

    private absolute(itemPath: string): string {
        if (itemPath === '/') {
            return this.options.root;
        }
        const absolutePath = path.join(this.options.root, itemPath);
        const relative = path.relative(this.options.root, absolutePath);
        if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
            throw new KationError('InvalidArgument', `Refusing a path outside the sync folder: ${itemPath}`);
        }
        return absolutePath;
    }

    /** Whether a folder's local path goes through a symbolic link (or special file) inside the sync folder. */
    private async throughLink(folder: string): Promise<boolean> {
        let current = '/';
        for (const name of folder.split('/').filter(Boolean)) {
            current = childPath(current, name);
            // An unreadable path is not a link: scanning the folder reports it, for that folder only.
            if (await isLinkOrSpecial(this.absolute(current)).catch(() => false)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Just before a local write: whether a folder above `itemPath` became a link since
     * the pass checked it. Compares the whole path at once; a swap between this check
     * and the write is still possible (no openat-style calls in Bun).
     */
    private async checkNoLinkAbove(itemPath: string): Promise<void> {
        // The sync folder itself may be a link (see rootLooksValid).
        this.realRoot ??= realpath(this.options.root);
        const realRoot = await this.realRoot;
        // A folder that does not exist yet is created by the write: check the deepest existing one.
        let folder = parentOf(itemPath);
        while (true) {
            try {
                const real = await realpath(this.absolute(folder));
                if (real !== (folder === '/' ? realRoot : path.join(realRoot, folder))) {
                    throw new LinkInTheWay(`A symbolic link in the sync folder leads ${folder} elsewhere`);
                }
                return;
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || folder === '/') {
                    throw error;
                }
                folder = parentOf(folder);
            }
        }
    }

    /**
     * Notices quickly when the sync folder is renamed, deleted or unmounted
     * (sync then pauses), and resumes by itself when it is back.
     */
    private async checkRootPresence(): Promise<void> {
        if (this.stopped) {
            return;
        }
        const problem = await this.rootProblem();
        if (this.stopped) {
            return;
        }
        const waiting = this.pausedFor === 'folder' || this.pausedFor === 'notMounted';
        if (problem && !waiting && !this.paused) {
            // Stop a running pass now: it would see the folder's items as deleted.
            this.pauseFor(problem);
            this.abort.abort();
        } else if (problem && (waiting || this.pausedFor === 'deletions') && problem.kind !== this.pausedFor) {
            // A deletion pause may come from the missing folder: wait for it instead; the
            // deletions are checked (and must be confirmed) again once it is back.
            this.pauseFor(problem);
        } else if (!problem && waiting) {
            this.logger.info('The sync folder is back; resuming sync');
            this.setPaused(false);
        }
    }

    private async rootLooksValid(): Promise<boolean> {
        // stat, not lstat: the sync folder may be a symbolic link to a folder elsewhere.
        const root = await stat(this.options.root).catch(() => undefined);
        if (!root?.isDirectory()) {
            return false;
        }
        const marker = await statItem(path.join(this.options.root, MARKER_NAME)).catch(() => undefined);
        return !!marker || this.options.state.isEmpty();
    }

    private startWatcher(): void {
        try {
            this.watcher = watch(this.options.root, { recursive: true }, (_event, filename) => {
                if (filename) {
                    this.onLocalChange(`/${filename.toString()}`);
                } else {
                    // The sync folder itself changed (renamed, deleted): check it now.
                    void this.checkRootPresence();
                }
            });
            this.watcher.on('error', (error) => {
                this.logger.error('Sync folder watcher failed; relying on periodic scans', error);
            });
        } catch (error: unknown) {
            this.logger.error('Cannot watch the sync folder; relying on periodic scans', error);
        }
    }

    private setStatus(update: Partial<SyncStatus>): void {
        const previous = this.status;
        const before = JSON.stringify(this.getStatus());
        this.status = { ...this.status, ...update };
        const after = this.getStatus();
        if (JSON.stringify(after) !== before) {
            this.options.onStatus?.(after);
        }
        if (previous.state !== this.status.state) {
            this.options.onItemsChanged?.([]);
        } else if (previous.current !== this.status.current) {
            this.options.onItemsChanged?.([previous.current, this.status.current].filter(Boolean));
        }
    }

    private activity(kind: SyncActivity['kind'], itemPath: string, detail = ''): void {
        this.options.onActivity?.({ time: Math.floor(this.options.now() / 1000), kind, path: itemPath, detail });
    }

    private itemDone(itemPath: string, kind: SyncActivity['kind']): void {
        this.activity(kind, itemPath);
        this.skippedItems.delete(itemPath);
        if (this.failedItems.delete(itemPath)) {
            this.options.onItemsChanged?.([itemPath]);
        }
    }

    /**
     * The sync state of a path inside "My files", from what is known locally
     * (no network): synced, being synced, waiting, failed or excluded.
     */
    async itemState(itemPath: string): Promise<ItemState> {
        const parts = itemPath.split('/').filter(Boolean);
        if (parts.some((part) => isIgnoredName(part) || part === MARKER_NAME)) {
            return '';
        }
        if (this.isExcluded(itemPath)) {
            return 'excluded';
        }
        const inside = (other: string) => other === itemPath || itemPath === '/' || other.startsWith(`${itemPath}/`);
        if ([...this.failedItems].some(inside)) {
            return 'error';
        }
        if (this.status.current && inside(this.status.current)) {
            return 'syncing';
        }
        const waiting: ItemState = this.paused || this.status.state === 'paused' ? 'paused' : 'pending';
        if (itemPath === '/') {
            return this.status.state === 'syncing' ? 'syncing' : this.status.state === 'idle' ? 'synced' : waiting;
        }
        const local = await statItem(this.absolute(itemPath));
        if (!local) {
            return '';
        }
        const base = this.options.state.get(itemPath);
        if (!base || base.type !== local.type) {
            return waiting;
        }
        if (local.type === 'file' && (base.localSize !== local.size || base.localMtime !== local.mtime)) {
            return waiting;
        }
        return 'synced';
    }

    private resolveIdle(): void {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    private get logger(): Logger {
        return this.options.logger;
    }
}

function remoteItemFromNode(node: NodeEntity): RemoteItem {
    return {
        name: nodeName(node),
        type: isFolder(node) ? 'folder' : 'file',
        uid: node.uid,
        revision: node.activeRevision?.uid ?? null,
        sha1: node.activeRevision?.claimedDigests?.sha1 ?? null,
        size: node.activeRevision?.claimedSize ?? null,
        node,
    };
}

function sameLocalState(current: LocalItem | undefined, expected: LocalItem | undefined): boolean {
    if (!current || !expected) {
        return !current && !expected;
    }
    return current.type === expected.type && current.size === expected.size && current.mtime === expected.mtime;
}

function hasLocalChange(local: LocalItem | undefined, base: BaseEntry | undefined): boolean {
    if (!local || !base) {
        return !!local !== !!base;
    }
    if (local.type !== base.type) {
        return true;
    }
    return local.type === 'file' && (local.size !== base.localSize || local.mtime !== base.localMtime);
}

function hasRemoteChange(remote: RemoteItem | undefined, base: BaseEntry | undefined): boolean {
    if (!remote || !base) {
        return !!remote !== !!base;
    }
    if (remote.type !== base.type || remote.uid !== base.remoteUid) {
        return true;
    }
    return remote.type === 'file' && remote.revision !== base.remoteRevision;
}

/** Proton Docs and Sheets only exist online; they cannot be downloaded as files. */
function isProtonDocument(node: NodeEntity): boolean {
    return node.mediaType?.startsWith('application/vnd.proton.') ?? false;
}

/** The name the SDK refused as too long (InvalidNameError), or undefined for any other name error. */
function tooLongName(error: unknown): string | undefined {
    const name = (error as { name?: unknown } | undefined)?.name;
    return !(error instanceof Error) && typeof name === 'string' && Buffer.byteLength(name) > MAX_NAME_BYTES ? name : undefined;
}

function isNameTooLong(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
    return code === 'ENAMETOOLONG';
}

function depth(folder: string): number {
    return folder === '/' ? 0 : folder.split('/').length - 1;
}

// Re-exported for tests.
export { KationError };
