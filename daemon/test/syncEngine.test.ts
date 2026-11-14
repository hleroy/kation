// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DriveEventType, NodeType } from '@protontech/drive-sdk';

import { DriveService } from '../src/service/driveService';
import { FakeDrive } from '../src/service/fakeDrive';
import { DriveTree } from '../src/service/tree';
import { foldersForLog, SAFETY_PAUSE_META, SyncEngine, type SyncEngineOptions } from '../src/sync/engine';
import { moveToTrash } from '../src/sync/local';
import { SyncState } from '../src/sync/state';
import { countingSdk, silentLogger, tempDir } from './helpers';

const engines: SyncEngine[] = [];
afterEach(async () => {
    await Promise.all(engines.splice(0).map((engine) => engine.stop()));
});

async function setup(options: Partial<SyncEngineOptions> & { fake?: FakeDrive; stateFile?: string; root?: string } = {}) {
    const fake =
        options.fake ??
        new FakeDrive({
            onEvent: (event) => {
                for (const listener of events) listener(event);
            },
        });
    const counting = countingSdk(fake.sdk);
    const tree = new DriveTree(counting.sdk, silentLogger);
    const drive = new DriveService(counting.sdk, tree, silentLogger);
    const root = options.root ?? path.join(await tempDir(), 'Proton Drive');
    const trashHome = await tempDir();
    const state = new SyncState(options.stateFile ?? path.join(await tempDir(), 'sync.sqlite'));
    const engine = new SyncEngine({
        drive,
        tree,
        sdk: counting.sdk,
        state,
        logger: silentLogger,
        root,
        watch: false,
        settleMs: 0,
        debounceMs: 0,
        trash: (absolutePath) => moveToTrash(absolutePath, trashHome),
        unmountedDisk: async () => undefined,
        ...options,
    });
    engines.push(engine);
    const listener = (event: Parameters<SyncEngine['onRemoteEvent']>[0]) => {
        tree.applyEvent(event);
        engine.onRemoteEvent(event);
    };
    events.add(listener);
    const settle = async () => {
        for (let i = 0; i < 3; i++) {
            await Bun.sleep(5);
            await engine.whenIdle();
        }
    };
    const local = (relative: string) => path.join(root, relative);
    const trashed = async () => (await readdir(path.join(trashHome, 'Trash', 'files')).catch(() => [])).sort();
    return {
        fake,
        sdk: counting.sdk,
        drive,
        engine,
        state,
        root,
        local,
        settle,
        trashed,
        listings: counting.listings,
        stop: () => events.delete(listener),
    };
}

const events = new Set<(event: Parameters<SyncEngine['onRemoteEvent']>[0]) => void>();
afterEach(() => events.clear());

/** Edits a file and dates it in the past, so it differs from the synced state and counts as settled. */
let editCount = 0;
async function edit(file: string, content: string) {
    await writeFile(file, content);
    const past = new Date(Date.now() - 60_000 - ++editCount * 1000);
    await utimes(file, past, past);
}

/** A failed pass is retried later, so wait for the error rather than for idleness. */
async function untilError(engine: SyncEngine) {
    for (let i = 0; i < 100 && engine.getStatus().state !== 'error'; i++) {
        await Bun.sleep(10);
    }
}

function child(fake: FakeDrive, parentUid: string, name: string) {
    return fake.childrenOf(parentUid).get(name);
}

describe('SyncEngine', () => {
    it('merges both sides on the first sync', async () => {
        const ctx = await setup();
        const docs = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Docs', type: NodeType.Folder });
        ctx.fake.add({ parentUid: docs.uid, name: 'remote.txt', type: NodeType.File, content: 'from proton' });
        await mkdir(ctx.local('Local'), { recursive: true });
        await writeFile(ctx.local('Local/mine.txt'), 'from disk');

        await ctx.engine.start();
        await ctx.settle();

        expect(await readFile(ctx.local('Docs/remote.txt'), 'utf8')).toBe('from proton');
        const uploaded = child(ctx.fake, child(ctx.fake, ctx.fake.rootUid, 'Local')!.uid, 'mine.txt');
        expect(ctx.fake.contentOf(uploaded!.uid)).toBe('from disk');
        expect(await readdir(ctx.root)).toContain('.kation-sync');
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
        expect(ctx.engine.getStatus().lastSync).toBeGreaterThan(0);
    });

    it('treats identical files on both sides as already synced', async () => {
        const ctx = await setup();
        const remote = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'same.txt', type: NodeType.File, content: 'same' });
        await mkdir(ctx.root, { recursive: true });
        await writeFile(ctx.local('same.txt'), 'same');
        await ctx.engine.start();
        await ctx.settle();
        expect(ctx.fake.childrenOf(ctx.fake.rootUid).size).toBe(1);
        expect(ctx.fake.childrenOf(ctx.fake.rootUid).get('same.txt')?.revision).toBe(remote.revision);
    });

    it('uploads local edits and downloads remote edits', async () => {
        const ctx = await setup();
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'v1' });
        await ctx.engine.start();
        await ctx.settle();

        await edit(ctx.local('a.txt'), 'v2 local');
        ctx.engine.onLocalChange('/a.txt');
        await ctx.settle();
        expect(ctx.fake.contentOf(file.uid)).toBe('v2 local');

        ctx.fake.updateContent(file.uid, 'v3 remote');
        await ctx.settle();
        expect(await readFile(ctx.local('a.txt'), 'utf8')).toBe('v3 remote');
    });

    it('sends deletions to the trash on the other side', async () => {
        const ctx = await setup();
        const keep = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'local-delete.txt', type: NodeType.File, content: 'x' });
        const gone = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'remote-delete.txt', type: NodeType.File, content: 'y' });
        await ctx.engine.start();
        await ctx.settle();

        await rm(ctx.local('local-delete.txt'));
        ctx.engine.onLocalChange('/local-delete.txt');
        for await (const result of ctx.fake.sdk.trashNodes([gone.uid])) {
            expect(result.ok).toBe(true);
        }
        await ctx.settle();

        expect(child(ctx.fake, ctx.fake.rootUid, 'local-delete.txt')).toBeUndefined();
        expect(ctx.fake.childrenOf(ctx.fake.rootUid).size).toBe(0);
        expect(keep.trashed).toBeDefined();
        expect(await readdir(ctx.root)).not.toContain('remote-delete.txt');
        expect(await ctx.trashed()).toEqual(['remote-delete.txt']);
    });

    it('keeps both versions when a file changed on both sides', async () => {
        const ctx = await setup({ now: () => new Date(2026, 10, 1, 10, 42).getTime() });
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'notes.txt', type: NodeType.File, content: 'base' });
        await ctx.engine.start();
        await ctx.settle();

        await edit(ctx.local('notes.txt'), 'local edit');
        ctx.fake.updateContent(file.uid, 'remote edit');
        await ctx.settle();

        expect(await readFile(ctx.local('notes.txt'), 'utf8')).toBe('remote edit');
        const conflictCopy = 'notes (conflict 2026-11-01 1042).txt';
        expect(await readFile(ctx.local(conflictCopy), 'utf8')).toBe('local edit');
        expect(ctx.fake.contentOf(child(ctx.fake, ctx.fake.rootUid, conflictCopy)!.uid)).toBe('local edit');
    });

    it('keeps both versions when a file is edited on both sides while paused', async () => {
        const ctx = await setup({ now: () => new Date(2026, 10, 1, 10, 42).getTime() });
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'notes.txt', type: NodeType.File, content: 'base' });
        await ctx.engine.start();
        await ctx.settle();

        ctx.engine.setPaused(true);
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'user' });
        await edit(ctx.local('notes.txt'), 'local edit');
        ctx.engine.onLocalChange('/notes.txt');
        ctx.fake.updateContent(file.uid, 'remote edit');
        await ctx.settle();
        expect(ctx.fake.contentOf(file.uid)).toBe('remote edit');
        expect(await readFile(ctx.local('notes.txt'), 'utf8')).toBe('local edit');

        ctx.engine.setPaused(false);
        await ctx.settle();
        expect(await readFile(ctx.local('notes.txt'), 'utf8')).toBe('remote edit');
        expect(ctx.fake.contentOf(file.uid)).toBe('remote edit');
        const conflictCopy = 'notes (conflict 2026-11-01 1042).txt';
        expect(await readFile(ctx.local(conflictCopy), 'utf8')).toBe('local edit');
        expect(ctx.fake.contentOf(child(ctx.fake, ctx.fake.rootUid, conflictCopy)!.uid)).toBe('local edit');
    });

    it('checks the remote version before overwriting it, even without an event', async () => {
        const ctx = await setup({ now: () => new Date(2026, 10, 1, 10, 42).getTime() });
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'notes.txt', type: NodeType.File, content: 'base' });
        await ctx.engine.start();
        await ctx.settle();

        ctx.fake.updateContent(file.uid, 'remote edit', { silent: true });
        await edit(ctx.local('notes.txt'), 'local edit');
        ctx.engine.onLocalChange('/notes.txt');
        await ctx.settle();

        expect(ctx.fake.contentOf(file.uid)).toBe('remote edit');
        expect(await readFile(ctx.local('notes (conflict 2026-11-01 1042).txt'), 'utf8')).toBe('local edit');
    });

    it('keeps locally changed files when their folder is deleted remotely', async () => {
        const ctx = await setup();
        const folder = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Project', type: NodeType.Folder });
        ctx.fake.add({ parentUid: folder.uid, name: 'old.txt', type: NodeType.File, content: 'old' });
        ctx.fake.add({ parentUid: folder.uid, name: 'draft.txt', type: NodeType.File, content: 'draft' });
        await ctx.engine.start();
        await ctx.settle();

        await edit(ctx.local('Project/draft.txt'), 'draft v2');
        for await (const result of ctx.fake.sdk.trashNodes([folder.uid])) {
            expect(result.ok).toBe(true);
        }
        await ctx.settle();

        const recreated = child(ctx.fake, ctx.fake.rootUid, 'Project');
        expect(recreated?.uid).not.toBe(folder.uid);
        expect([...ctx.fake.childrenOf(recreated!.uid).keys()]).toEqual(['draft.txt']);
        expect(await readdir(ctx.local('Project'))).toEqual(['draft.txt']);
        expect(await ctx.trashed()).toEqual(['old.txt']);
    });

    it('retries quietly when a folder is trashed on Proton while a file in it is uploaded', async () => {
        const errors: string[] = [];
        const ctx = await setup({ logger: { ...silentLogger, error: (message: string) => errors.push(message) } });
        const folder = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Project', type: NodeType.Folder });
        ctx.fake.add({ parentUid: folder.uid, name: 'draft.txt', type: NodeType.File, content: 'draft' });
        await ctx.engine.start();
        await ctx.settle();

        // The trash happens on Proton but its event has not arrived when the upload starts.
        ctx.fake.trashSilently(folder.uid);
        await edit(ctx.local('Project/draft.txt'), 'draft v2');
        ctx.engine.onLocalChange('/Project/draft.txt');
        await ctx.settle();

        expect(errors).toEqual([]);
        const recreated = child(ctx.fake, ctx.fake.rootUid, 'Project');
        expect(recreated?.uid).not.toBe(folder.uid);
        expect(ctx.fake.contentOf(child(ctx.fake, recreated!.uid, 'draft.txt')!.uid)).toBe('draft v2');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('reports conflicts and errors as activity, and failed items as errors', async () => {
        const activity: string[] = [];
        const ctx = await setup({
            now: () => new Date(2026, 10, 1, 10, 42).getTime(),
            onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`.trim()),
        });
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'notes.txt', type: NodeType.File, content: 'base' });
        await ctx.engine.start();
        await ctx.settle();
        ctx.fake.updateContent(file.uid, 'remote edit', { silent: true });
        await edit(ctx.local('notes.txt'), 'local edit');
        ctx.engine.onLocalChange('/notes.txt');
        await ctx.settle();
        expect(activity).toEqual([
            'downloaded /notes.txt',
            'conflict /notes.txt /notes (conflict 2026-11-01 1042).txt',
            'uploaded /notes (conflict 2026-11-01 1042).txt',
            'downloaded /notes.txt',
        ]);
        expect(await ctx.engine.itemState('/notes.txt')).toBe('synced');
    });

    it('treats a quick pause and resume during a transfer as a pause, not an error', async () => {
        const states: string[] = [];
        const fake = new FakeDrive({
            chunkDelayMs: 20,
            onEvent: (event) => {
                for (const listener of events) listener(event);
            },
        });
        const ctx = await setup({ fake, onStatus: (status) => states.push(status.state) });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'big.bin', type: NodeType.File, content: 'x'.repeat(3 * 1024 * 1024) });
        await ctx.engine.start();
        for (let i = 0; i < 200 && ctx.engine.getStatus().current !== '/big.bin'; i++) {
            await Bun.sleep(5);
        }
        expect(ctx.engine.getStatus().current).toBe('/big.bin');
        ctx.engine.setPaused(true);
        ctx.engine.setPaused(false);
        await ctx.settle();
        expect(states).not.toContain('error');
        expect(ctx.engine.getStatus().state).toBe('idle');
        expect((await stat(ctx.local('big.bin'))).size).toBe(3 * 1024 * 1024);
    });

    it('trashes a whole folder deleted locally in one operation', async () => {
        const ctx = await setup();
        const folder = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Old', type: NodeType.Folder });
        for (const name of ['a', 'b', 'c']) {
            ctx.fake.add({ parentUid: folder.uid, name, type: NodeType.File, content: name });
        }
        await ctx.engine.start();
        await ctx.settle();

        await rm(ctx.local('Old'), { recursive: true });
        ctx.engine.onLocalChange('/Old');
        await ctx.settle();
        expect(child(ctx.fake, ctx.fake.rootUid, 'Old')).toBeUndefined();
        expect(folder.trashed).toBeDefined();
    });

    it('trashes a folder deleted locally as a whole when only a folder inside it is marked changed', async () => {
        const activities: string[] = [];
        const ctx = await setup({ onActivity: (activity) => activities.push(`${activity.kind} ${activity.path}`) });
        const folder = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Old', type: NodeType.Folder });
        const sub = ctx.fake.add({ parentUid: folder.uid, name: 'sub', type: NodeType.Folder });
        for (const name of ['a', 'b', 'c']) {
            ctx.fake.add({ parentUid: sub.uid, name, type: NodeType.File, content: name });
        }
        await ctx.engine.start();
        await ctx.settle();
        activities.length = 0;

        await rm(ctx.local('Old'), { recursive: true });
        ctx.engine.onLocalChange('/Old/sub/a');
        await ctx.settle();

        expect(activities).toEqual(['trashedRemote /Old']);
        expect(folder.trashed).toBeDefined();
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('stops working in a new folder deleted locally while it is uploaded', async () => {
        const log: string[] = [];
        const record = (level: string) => (message: string) => log.push(`${level} ${message}`);
        const logger = {
            ...silentLogger,
            info: (message: string) => {
                log.push(`info ${message}`);
                if (message === 'Uploading /Test/a.txt') {
                    rmSync(ctx.local('Test'), { recursive: true });
                }
            },
            warn: record('warn'),
            error: record('error'),
        };
        const ctx = await setup({ logger });
        await mkdir(ctx.local('Test/sub1/deep'), { recursive: true });
        await mkdir(ctx.local('Test/sub2'));
        await edit(ctx.local('Test/a.txt'), 'a');
        await edit(ctx.local('Test/z.txt'), 'z');
        await ctx.engine.start();
        await ctx.settle();

        expect(log.filter((line) => !line.startsWith('info Sync pass'))).toEqual([
            'info Uploading /Test/a.txt',
            'info /Test was removed here during sync; checking again',
            'info Moving /Test to the Proton Drive trash (deleted locally)',
        ]);
        expect(child(ctx.fake, ctx.fake.rootUid, 'Test')).toBeUndefined();
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('does not create on Proton a new folder that vanished after its parent was scanned', async () => {
        const log: string[] = [];
        const logger = {
            ...silentLogger,
            info: (message: string) => {
                log.push(message);
                if (message === 'Uploading /Test/a.txt') {
                    rmSync(ctx.local('Test/sub1'), { recursive: true });
                }
            },
        };
        const ctx = await setup({ logger });
        await mkdir(ctx.local('Test/sub1'), { recursive: true });
        await edit(ctx.local('Test/a.txt'), 'a');
        await ctx.engine.start();
        await ctx.settle();

        expect(log.filter((line) => !line.startsWith('Sync pass'))).toEqual([
            'Uploading /Test/a.txt',
            '/Test/sub1 was removed here during sync; checking again',
        ]);
        expect([...ctx.fake.childrenOf(child(ctx.fake, ctx.fake.rootUid, 'Test')!.uid).keys()]).toEqual(['a.txt']);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('keeps a version changed on Proton when the local file vanishes during the pass', async () => {
        const logger = {
            ...silentLogger,
            info: (message: string) => {
                if (message === 'Downloading /a.txt') {
                    rmSync(ctx.local('notes.txt'));
                }
            },
        };
        const ctx = await setup({ logger });
        const first = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'a' });
        const notes = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'notes.txt', type: NodeType.File, content: 'notes' });
        await ctx.engine.start();
        await ctx.settle();

        await edit(ctx.local('notes.txt'), 'notes, edited here');
        ctx.fake.updateContent(first.uid, 'a v2');
        ctx.fake.updateContent(notes.uid, 'notes, edited on Proton');
        await ctx.settle();

        expect(notes.trashed).toBeUndefined();
        expect(await readFile(ctx.local('notes.txt'), 'utf8')).toBe('notes, edited on Proton');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('hands a changed folder to its parent when a folder above it was replaced by a file', async () => {
        const ctx = await setup();
        const a = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'A', type: NodeType.Folder });
        const b = ctx.fake.add({ parentUid: a.uid, name: 'B', type: NodeType.Folder });
        ctx.fake.add({ parentUid: b.uid, name: 'f.txt', type: NodeType.File, content: 'f' });
        await ctx.engine.start();
        await ctx.settle();

        await rm(ctx.local('A'), { recursive: true });
        await edit(ctx.local('A'), 'now a file');
        ctx.engine.onLocalChange('/A/B/f.txt');
        await ctx.settle();

        expect(a.trashed).toBeDefined();
        expect(ctx.fake.contentOf(child(ctx.fake, ctx.fake.rootUid, 'A')!.uid)).toBe('now a file');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('still syncs other folders when a changed folder is inside an unreadable one', async () => {
        const ctx = await setup();
        const a = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'A', type: NodeType.Folder });
        const b = ctx.fake.add({ parentUid: a.uid, name: 'B', type: NodeType.Folder });
        const z = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Z', type: NodeType.Folder });
        const y = ctx.fake.add({ parentUid: z.uid, name: 'Y', type: NodeType.Folder });
        await ctx.engine.start();
        await ctx.settle();

        await chmod(ctx.local('A'), 0o000);
        try {
            const f = ctx.fake.add({ parentUid: b.uid, name: 'f.txt', type: NodeType.File, content: 'f' });
            const g = ctx.fake.add({ parentUid: y.uid, name: 'g.txt', type: NodeType.File, content: 'g' });
            // Not awaited in between: both folders are in the same pass.
            ctx.fake.remoteChange({ type: DriveEventType.NodeCreated, uid: f.uid });
            ctx.fake.remoteChange({ type: DriveEventType.NodeCreated, uid: g.uid });
            await untilError(ctx.engine);
            expect(await readFile(ctx.local('Z/Y/g.txt'), 'utf8')).toBe('g');
            expect(b.trashed).toBeUndefined();
        } finally {
            await chmod(ctx.local('A'), 0o755);
        }
    });

    it('says that a file was removed here when it vanishes before its upload', async () => {
        const log: string[] = [];
        const logger = {
            ...silentLogger,
            info: (message: string) => {
                log.push(`info ${message}`);
                if (message === 'Uploading /a.txt') {
                    rmSync(ctx.local('a.txt'));
                }
            },
            warn: (message: string) => log.push(`warn ${message}`),
            error: (message: string) => log.push(`error ${message}`),
        };
        const ctx = await setup({ logger });
        await ctx.engine.start();
        await ctx.settle();
        await edit(ctx.local('a.txt'), 'a');
        await edit(ctx.local('b.txt'), 'b');
        ctx.engine.onLocalChange('/a.txt');
        await ctx.settle();

        expect(log.filter((line) => !line.startsWith('info Sync pass'))).toEqual([
            'info Uploading /a.txt',
            'info /a.txt was removed here during sync; checking again',
            'info Uploading /b.txt',
        ]);
        expect(child(ctx.fake, ctx.fake.rootUid, 'a.txt')).toBeUndefined();
        expect(ctx.fake.contentOf(child(ctx.fake, ctx.fake.rootUid, 'b.txt')!.uid)).toBe('b');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('does not announce the upload of a file that vanished since its folder was scanned', async () => {
        const log: string[] = [];
        const logger = {
            ...silentLogger,
            info: (message: string) => {
                log.push(message);
                if (message === 'Uploading /a.txt') {
                    rmSync(ctx.local('b.txt'));
                }
            },
        };
        const ctx = await setup({ logger });
        await ctx.engine.start();
        await ctx.settle();
        await edit(ctx.local('a.txt'), 'a');
        await edit(ctx.local('b.txt'), 'b');
        ctx.engine.onLocalChange('/a.txt');
        await ctx.settle();

        expect(log.filter((line) => !line.startsWith('Sync pass'))).toEqual([
            'Uploading /a.txt',
            '/b.txt was removed here during sync; checking again',
        ]);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('checks the parent of several vanished folders once per pass', async () => {
        const ctx = await setup();
        for (const name of ['x', 'y', 'z']) {
            await mkdir(ctx.local(`A/${name}`), { recursive: true });
        }
        await ctx.engine.start();
        await ctx.settle();

        const synced: string[] = [];
        const internals = ctx.engine as unknown as { syncFolderAt: (folder: string, ...rest: unknown[]) => Promise<string[]> };
        const original = internals.syncFolderAt.bind(ctx.engine);
        internals.syncFolderAt = (folder, ...rest) => {
            synced.push(folder);
            return original(folder, ...rest);
        };
        // Without Drive events: the trash request's own event would start a second pass.
        ctx.stop();
        await rm(ctx.local('A'), { recursive: true });
        for (const name of ['x', 'y', 'z']) {
            ctx.engine.onLocalChange(`/A/${name}/file.txt`);
        }
        await ctx.settle();

        expect(synced.filter((folder) => folder === '/')).toEqual(['/']);
        expect(child(ctx.fake, ctx.fake.rootUid, 'A')).toBeUndefined();
    });

    it('syncs new folder trees in both directions', async () => {
        const ctx = await setup();
        await ctx.engine.start();
        await ctx.settle();

        await mkdir(ctx.local('Up/deep'), { recursive: true });
        await writeFile(ctx.local('Up/deep/file.txt'), 'up');
        ctx.engine.onLocalChange('/Up');
        const down = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Down', type: NodeType.Folder });
        const deep = ctx.fake.add({ parentUid: down.uid, name: 'deep', type: NodeType.Folder });
        ctx.fake.add({ parentUid: deep.uid, name: 'file.txt', type: NodeType.File, content: 'down' });
        ctx.fake.remoteChange({ type: (await import('@protontech/drive-sdk')).DriveEventType.NodeCreated, uid: down.uid });
        await ctx.settle();

        const up = child(ctx.fake, ctx.fake.rootUid, 'Up')!;
        expect(ctx.fake.contentOf(child(ctx.fake, child(ctx.fake, up.uid, 'deep')!.uid, 'file.txt')!.uid)).toBe('up');
        expect(await readFile(ctx.local('Down/deep/file.txt'), 'utf8')).toBe('down');
    });

    it('resumes from its state without listing the whole drive again', async () => {
        const fake = new FakeDrive({
            onEvent: (event) => {
                for (const listener of events) listener(event);
            },
        });
        const a = fake.add({ parentUid: fake.rootUid, name: 'A', type: NodeType.Folder });
        const b = fake.add({ parentUid: fake.rootUid, name: 'B', type: NodeType.Folder });
        fake.add({ parentUid: a.uid, name: 'a.txt', type: NodeType.File, content: 'a' });
        fake.add({ parentUid: b.uid, name: 'b.txt', type: NodeType.File, content: 'b' });
        const stateFile = path.join(await tempDir(), 'sync.sqlite');
        const first = await setup({ fake, stateFile });
        await first.engine.start();
        await first.settle();
        expect(first.listings()).toBe(3);
        await first.engine.stop();
        first.stop();

        const second = await setup({ fake, stateFile, root: first.root });
        await second.engine.start();
        await second.settle();
        expect(second.listings()).toBe(0);

        fake.updateContent(child(fake, b.uid, 'b.txt')!.uid, 'b2');
        await second.settle();
        expect(second.listings()).toBe(1); // only B
        expect(await readFile(second.local('B/b.txt'), 'utf8')).toBe('b2');
    });

    it('remembers folders with remote changes across restarts', async () => {
        const ctx = await setup();
        await ctx.engine.start();
        await ctx.settle();
        ctx.state.addPending('/');
        expect(ctx.state.pending()).toEqual(['/']);
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'late.txt', type: NodeType.File, content: 'late' });
        await ctx.engine.stop();

        const again = await setup({ fake: ctx.fake, root: ctx.root, stateFile: undefined, state: ctx.state } as never);
        await again.engine.start();
        await again.settle();
        expect(await readFile(again.local('late.txt'), 'utf8')).toBe('late');
        expect(ctx.state.pending()).toEqual([]);
    });

    it('never syncs temporary files or online-only Proton documents', async () => {
        const ctx = await setup();
        ctx.fake.add({
            parentUid: ctx.fake.rootUid,
            name: 'Plan',
            type: NodeType.File,
            content: '',
            mediaType: 'application/vnd.proton.doc',
        });
        await mkdir(ctx.root, { recursive: true });
        await writeFile(ctx.local('.~lock.report.odt#'), 'lock');
        await writeFile(ctx.local('video.mp4.part'), 'partial');
        await ctx.engine.start();
        await ctx.settle();
        expect([...ctx.fake.childrenOf(ctx.fake.rootUid).keys()]).toEqual(['Plan']);
        expect((await readdir(ctx.root)).sort()).toEqual(['.kation-sync', '.~lock.report.odt#', 'video.mp4.part']);
    });

    it('skips excluded folders on both sides', async () => {
        const ctx = await setup({ excluded: ['/Videos'] });
        const videos = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Videos', type: NodeType.Folder });
        ctx.fake.add({ parentUid: videos.uid, name: 'big.mkv', type: NodeType.File, content: 'big' });
        await ctx.engine.start();
        await ctx.settle();
        expect(await readdir(ctx.root)).toEqual(['.kation-sync']);
    });

    it('waits for files that are still being written', async () => {
        const ctx = await setup({ settleMs: 60_000 });
        await ctx.engine.start();
        await ctx.settle();
        await writeFile(ctx.local('writing.iso'), 'partial');
        ctx.engine.onLocalChange('/writing.iso');
        await Bun.sleep(20);
        expect(ctx.fake.childrenOf(ctx.fake.rootUid).size).toBe(0);
    });

    it('pauses instead of deleting everything when the folder disappears', async () => {
        const ctx = await setup();
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'precious.txt', type: NodeType.File, content: 'x' });
        await ctx.engine.start();
        await ctx.settle();

        await rm(ctx.root, { recursive: true });
        await mkdir(ctx.root);
        ctx.engine.syncNow();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'folder' });
        expect(ctx.engine.getStatus().message).toContain('missing or was replaced');
        expect(child(ctx.fake, ctx.fake.rootUid, 'precious.txt')).toBeDefined();
    });

    it('pauses quickly when the folder is renamed, and resumes when it is back', async () => {
        const ctx = await setup({ watch: true, rootCheckIntervalMs: 200 });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'precious.txt', type: NodeType.File, content: 'x' });
        await ctx.engine.start();
        await ctx.settle();

        const renamed = `${ctx.root}-renamed`;
        await rename(ctx.root, renamed);
        for (let i = 0; i < 50 && ctx.engine.getStatus().state !== 'paused'; i++) {
            await Bun.sleep(20);
        }
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'folder' });
        expect(ctx.engine.getStatus().message).toContain('missing or was replaced');
        expect(child(ctx.fake, ctx.fake.rootUid, 'precious.txt')?.trashed).toBeUndefined();

        await rename(renamed, ctx.root);
        for (let i = 0; i < 50 && ctx.engine.getStatus().state !== 'idle'; i++) {
            await Bun.sleep(20);
        }
        await ctx.settle();
        expect(ctx.engine.getStatus().state).toBe('idle');

        // The watcher works again after the folder came back.
        await writeFile(ctx.local('after.txt'), 'after');
        const past = new Date(Date.now() - 60_000);
        await utimes(ctx.local('after.txt'), past, past);
        for (let i = 0; i < 100 && !child(ctx.fake, ctx.fake.rootUid, 'after.txt'); i++) {
            await Bun.sleep(20);
        }
        expect(child(ctx.fake, ctx.fake.rootUid, 'after.txt')).toBeDefined();
    });

    it('continues an interrupted download after a pause instead of starting over', async () => {
        const fake = new FakeDrive({
            chunkDelayMs: 15,
            onEvent: (event) => {
                for (const listener of events) listener(event);
            },
        });
        const content = 'abcdefghij'.repeat(100_000);
        fake.add({ parentUid: fake.rootUid, name: 'movie.mkv', type: NodeType.File, content });
        const ctx = await setup({ fake });
        await ctx.engine.start();
        await Bun.sleep(120);
        ctx.engine.setPaused(true);
        await ctx.settle();
        const part = (await readdir(ctx.root)).find((name) => name.endsWith('.kation-part'));
        expect(part).toStartWith('.movie.mkv.');

        fake.bytesServed = 0;
        ctx.engine.setPaused(false);
        await ctx.settle();
        expect(await readFile(ctx.local('movie.mkv'), 'utf8')).toBe(content);
        expect(fake.bytesServed).toBeLessThan(content.length);
        expect((await readdir(ctx.root)).sort()).toEqual(['.kation-sync', 'movie.mkv']);
        expect([...fake.childrenOf(fake.rootUid).keys()]).toEqual(['movie.mkv']);
    });

    it('pauses on mass deletion until resumed', async () => {
        const ctx = await setup({ maxDeletionsPerPass: 2 });
        for (const name of ['1', '2', '3']) {
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name, type: NodeType.File, content: name });
        }
        await ctx.engine.start();
        await ctx.settle();

        for (const name of ['1', '2', '3']) {
            await rm(ctx.local(name));
        }
        ctx.engine.syncNow();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'deletions', deletionLimit: 2 });
        // Nothing is deleted before the pause.
        expect(ctx.fake.childrenOf(ctx.fake.rootUid).size).toBe(3);

        ctx.engine.setPaused(false);
        await ctx.settle();
        expect(ctx.fake.childrenOf(ctx.fake.rootUid).size).toBe(0);
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'idle', reason: '' });
    });

    it('refuses to mix accounts', async () => {
        const ctx = await setup();
        await ctx.engine.start();
        await ctx.settle();
        ctx.state.setMeta('rootUid', 'someone-else');
        ctx.engine.syncNow();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'account' });
        expect(ctx.engine.getStatus().message).toContain('different Proton account');
    });

    it('never deletes local files because of an unreadable remote listing', async () => {
        const ctx = await setup();
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'safe.txt', type: NodeType.File, content: 'x' });
        await ctx.engine.start();
        await ctx.settle();

        // The same file comes back with a name that failed to decrypt.
        const sdk = ctx.sdk;
        const original = sdk.iterateNodes;
        sdk.iterateNodes = async function* (uids) {
            for await (const node of original(uids)) {
                yield 'uid' in node && node.uid === file.uid ? { ...node, name: { ok: false, error: new Error('bad key') } } : node;
            }
        } as typeof sdk.iterateNodes;
        ctx.fake.updateContent(file.uid, 'y');
        // The folder fails and is retried later; wait for the error instead of idleness.
        for (let i = 0; i < 100 && ctx.engine.getStatus().state !== 'error'; i++) {
            await Bun.sleep(10);
        }

        expect(await readFile(ctx.local('safe.txt'), 'utf8')).toBe('x');
        expect(await ctx.trashed()).toEqual([]);
        expect(ctx.engine.getStatus().state).toBe('error');
        sdk.iterateNodes = original;
    });

    it('waits for the disk instead of syncing into its empty mount point', async () => {
        let disk: string | undefined = '/mnt/data';
        const ctx = await setup({ unmountedDisk: async () => disk, rootCheckIntervalMs: 20 });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'precious.txt', type: NodeType.File, content: 'x' });
        await ctx.engine.start();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });
        expect(ctx.engine.getStatus().message).toContain('not mounted (/mnt/data)');
        expect(await stat(ctx.root).catch(() => undefined)).toBeUndefined();
        expect(ctx.state.getMeta(SAFETY_PAUSE_META)).toBeUndefined();

        disk = undefined;
        for (let i = 0; i < 50 && ctx.engine.getStatus().state !== 'idle'; i++) {
            await Bun.sleep(20);
        }
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'idle', reason: '' });
        expect(await readFile(ctx.local('precious.txt'), 'utf8')).toBe('x');
    });

    it('pauses when the disk is unmounted after a sync, and resumes when it is back', async () => {
        let disk: string | undefined;
        const ctx = await setup({ unmountedDisk: async () => disk, rootCheckIntervalMs: 20 });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'precious.txt', type: NodeType.File, content: 'x' });
        await ctx.engine.start();
        await ctx.settle();

        disk = '/mnt/data';
        for (let i = 0; i < 50 && ctx.engine.getStatus().state !== 'paused'; i++) {
            await Bun.sleep(20);
        }
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });
        disk = undefined;
        for (let i = 0; i < 50 && ctx.engine.getStatus().state !== 'idle'; i++) {
            await Bun.sleep(20);
        }
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'idle', reason: '' });
        expect(child(ctx.fake, ctx.fake.rootUid, 'precious.txt')).toBeDefined();
    });

    it('stops a running pass when the disk is unmounted', async () => {
        let disk: string | undefined;
        const fake = new FakeDrive({ chunkDelayMs: 40 });
        for (let i = 0; i < 20; i++) {
            fake.add({ parentUid: fake.rootUid, name: `file${i}.txt`, type: NodeType.File, content: `content ${i}` });
        }
        const ctx = await setup({ fake, unmountedDisk: async () => disk, rootCheckIntervalMs: 20 });
        await ctx.engine.start();
        for (let i = 0; i < 100 && ctx.engine.getStatus().current === ''; i++) {
            await Bun.sleep(5);
        }
        disk = '/mnt/data';
        for (let i = 0; i < 50 && ctx.engine.getStatus().state !== 'paused'; i++) {
            await Bun.sleep(10);
        }
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });
        expect((await readdir(ctx.root)).filter((name) => name.endsWith('.txt')).length).toBeLessThan(20);

        disk = undefined;
        for (let i = 0; i < 100 && ctx.engine.getStatus().state !== 'idle'; i++) {
            await Bun.sleep(20);
        }
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'idle', reason: '' });
        expect((await readdir(ctx.root)).filter((name) => name.endsWith('.txt')).length).toBe(20);
    });

    it("keeps the user's pause when the disk comes back", async () => {
        let disk: string | undefined = '/mnt/data';
        const ctx = await setup({ unmountedDisk: async () => disk, rootCheckIntervalMs: 20 });
        await ctx.engine.start();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });

        ctx.engine.setPaused(true);
        disk = undefined;
        await Bun.sleep(100);
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'user' });
    });

    it('waits for the disk instead of a deletion pause caused by its absence', async () => {
        let disk: string | undefined;
        const ctx = await setup({ unmountedDisk: async () => disk, rootCheckIntervalMs: 20, maxDeletionsPerPass: 2 });
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name, type: NodeType.File, content: name });
        }
        await ctx.engine.start();
        await ctx.settle();
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
            await rm(ctx.local(name));
        }
        ctx.engine.syncNow();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'deletions' });

        disk = '/mnt/data';
        for (let i = 0; i < 50 && ctx.engine.getStatus().reason !== 'notMounted'; i++) {
            await Bun.sleep(20);
        }
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });
        disk = undefined;
        for (let i = 0; i < 50 && ctx.engine.getStatus().reason !== 'deletions'; i++) {
            await Bun.sleep(20);
        }
        // Back, the deletions must be confirmed again.
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'deletions' });
        expect(child(ctx.fake, ctx.fake.rootUid, 'a.txt')).toBeDefined();
    });

    it('checks the disk before acting on a folder whose items all vanished', async () => {
        let disk: string | undefined;
        let unmountDuringPass = false;
        const ctx = await setup({
            unmountedDisk: async () => {
                if (unmountDuringPass) {
                    // The pass has checked the disk; it goes away before the folders are scanned.
                    unmountDuringPass = false;
                    for (const name of ['a.txt', 'b.txt']) {
                        await rm(ctx.local(name));
                    }
                    disk = '/mnt/data';
                    return undefined;
                }
                return disk;
            },
        });
        for (const name of ['a.txt', 'b.txt']) {
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name, type: NodeType.File, content: name });
        }
        await ctx.engine.start();
        await ctx.settle();

        unmountDuringPass = true;
        ctx.engine.syncNow();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });
        expect(child(ctx.fake, ctx.fake.rootUid, 'a.txt')).toBeDefined();
    });

    it('does not download into the mount point once the disk is unmounted mid-pass', async () => {
        let disk: string | undefined;
        const fake = new FakeDrive({ chunkDelayMs: 40 });
        for (let i = 0; i < 20; i++) {
            fake.add({ parentUid: fake.rootUid, name: `file${i}.txt`, type: NodeType.File, content: `content ${i}` });
        }
        // The disk is mounted at Data; the folder check does not run during the test.
        const root = path.join(await tempDir(), 'Data', 'Proton Drive');
        await mkdir(path.dirname(root));
        const ctx = await setup({ fake, root, unmountedDisk: async () => disk, rootCheckIntervalMs: 60_000 });
        await ctx.engine.start();
        for (let i = 0; i < 100 && ctx.engine.getStatus().current === ''; i++) {
            await Bun.sleep(5);
        }
        const away = `${root}-on-disk`;
        await rename(root, away);
        disk = path.dirname(root);
        for (let i = 0; i < 100 && ctx.engine.getStatus().state !== 'paused'; i++) {
            await Bun.sleep(20);
        }
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'notMounted' });
        expect(await stat(root).catch(() => undefined)).toBeUndefined();
    });

    it('watches the folder after resuming a pause that began while the disk was missing', async () => {
        const fake = new FakeDrive();
        fake.add({ parentUid: fake.rootUid, name: 'precious.txt', type: NodeType.File, content: 'x' });
        const stateFile = path.join(await tempDir(), 'sync.sqlite');
        const first = await setup({ fake, stateFile });
        await first.engine.start();
        await first.settle();
        await first.engine.stop();
        first.stop();

        // Paused at login, before the disk is mounted; the user resumes once it is.
        let disk: string | undefined = '/mnt/data';
        const ctx = await setup({ fake, stateFile, root: first.root, watch: true, unmountedDisk: async () => disk });
        await ctx.engine.start(true);
        disk = undefined;
        ctx.engine.setPaused(false);
        await ctx.settle();
        expect(ctx.engine.getStatus().state).toBe('idle');

        await edit(ctx.local('after.txt'), 'after');
        for (let i = 0; i < 100 && !child(ctx.fake, ctx.fake.rootUid, 'after.txt'); i++) {
            await Bun.sleep(20);
        }
        expect(child(ctx.fake, ctx.fake.rootUid, 'after.txt')).toBeDefined();
    });

    it('creates the sync folder but not missing parent folders', async () => {
        const root = path.join(await tempDir(), 'Absent', 'Proton Drive');
        const ctx = await setup({ root });
        await ctx.engine.start();
        await ctx.settle();
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'folder' });
        expect(await stat(path.dirname(root)).catch(() => undefined)).toBeUndefined();
    });

    it('does not recreate a sync folder that disappeared while kationd was stopped', async () => {
        const fake = new FakeDrive();
        fake.add({ parentUid: fake.rootUid, name: 'precious.txt', type: NodeType.File, content: 'x' });
        const stateFile = path.join(await tempDir(), 'sync.sqlite');
        const first = await setup({ fake, stateFile });
        await first.engine.start();
        await first.settle();
        await first.engine.stop();
        first.stop();

        await rm(first.root, { recursive: true });
        const second = await setup({ fake, stateFile, root: first.root });
        await second.engine.start();
        await second.settle();
        expect(second.engine.getStatus()).toMatchObject({ state: 'paused', reason: 'folder' });
        expect(await stat(first.root).catch(() => undefined)).toBeUndefined();
        expect(child(fake, fake.rootUid, 'precious.txt')).toBeDefined();
    });

    it('never writes outside the sync folder, whatever the remote names', async () => {
        const ctx = await setup();
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: '../escaped.txt', type: NodeType.File, content: 'x' });
        const parent = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: '..', type: NodeType.Folder });
        ctx.fake.add({ parentUid: parent.uid, name: 'escaped.txt', type: NodeType.File, content: 'x' });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'a/b.txt', type: NodeType.File, content: 'x' });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'fine.txt', type: NodeType.File, content: 'ok' });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: '..notes', type: NodeType.File, content: 'ok' });
        await ctx.engine.start();
        await ctx.settle();

        expect(await readdir(path.dirname(ctx.root))).toEqual(['Proton Drive']);
        expect((await readdir(ctx.root)).sort()).toEqual(['..notes', '.kation-sync', 'fine.txt']);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('does not overwrite a local edit saved while the new version downloads', async () => {
        const fake = new FakeDrive({
            chunkDelayMs: 15,
            onEvent: (event) => {
                for (const listener of events) listener(event);
            },
        });
        const file = fake.add({ parentUid: fake.rootUid, name: 'doc.txt', type: NodeType.File, content: 'v1' });
        const ctx = await setup({ fake });
        await ctx.engine.start();
        await ctx.settle();

        const remote = 'remote '.repeat(300_000);
        fake.updateContent(file.uid, remote);
        for (let i = 0; i < 200 && ctx.engine.getStatus().current !== '/doc.txt'; i++) {
            await Bun.sleep(5);
        }
        expect(ctx.engine.getStatus().current).toBe('/doc.txt');
        await edit(ctx.local('doc.txt'), 'local edit');
        await ctx.settle();

        const names = (await readdir(ctx.root)).filter((name) => name !== '.kation-sync').sort();
        expect(names).toHaveLength(2);
        expect(await readFile(ctx.local('doc.txt'), 'utf8')).toBe(remote);
        const copy = names.find((name) => name.includes('(conflict'));
        expect(await readFile(ctx.local(copy!), 'utf8')).toBe('local edit');
    });

    it('keeps files changed on Proton when their folder is deleted locally', async () => {
        const ctx = await setup();
        const folder = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Project', type: NodeType.Folder });
        ctx.fake.add({ parentUid: folder.uid, name: 'old.txt', type: NodeType.File, content: 'old' });
        const draft = ctx.fake.add({ parentUid: folder.uid, name: 'draft.txt', type: NodeType.File, content: 'draft' });
        await ctx.engine.start();
        await ctx.settle();

        // Edited on Proton, its event not processed yet, while the folder is deleted here.
        ctx.fake.updateContent(draft.uid, 'draft v2', { silent: true });
        await rm(ctx.local('Project'), { recursive: true });
        ctx.engine.onLocalChange('/Project');
        await ctx.settle();

        expect(folder.trashed).toBeUndefined();
        expect([...ctx.fake.childrenOf(folder.uid).keys()]).toEqual(['draft.txt']);
        expect(await readdir(ctx.local('Project'))).toEqual(['draft.txt']);
        expect(await readFile(ctx.local('Project/draft.txt'), 'utf8')).toBe('draft v2');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('syncs into a sync folder that is a symbolic link', async () => {
        const target = path.join(await tempDir(), 'real');
        await mkdir(target);
        const link = path.join(await tempDir(), 'Proton Drive');
        await symlink(target, link);
        const ctx = await setup({ root: link });
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'a' });
        await ctx.engine.start();
        await ctx.settle();
        ctx.engine.syncNow();
        await ctx.settle();

        expect(ctx.engine.getStatus().state).toBe('idle');
        expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('a');
    });

    it('never syncs through a symbolic link that has the name of a remote folder', async () => {
        const activity: string[] = [];
        const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`.trim()) });
        const outside = await tempDir();
        await writeFile(path.join(outside, 'private.txt'), 'not for Proton');
        await mkdir(ctx.root, { recursive: true });
        await symlink(outside, ctx.local('Notes'));
        // No remote item has this name: skipped silently.
        await symlink(outside, ctx.local('Other'));
        const notes = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Notes', type: NodeType.Folder });
        ctx.fake.add({ parentUid: notes.uid, name: 'remote.txt', type: NodeType.File, content: 'remote' });

        await ctx.engine.start();
        await untilError(ctx.engine);

        expect([...ctx.fake.childrenOf(notes.uid).keys()]).toEqual(['remote.txt']);
        expect(await readdir(outside)).toEqual(['private.txt']);
        expect((await lstat(ctx.local('Notes'))).isSymbolicLink()).toBe(true);
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', reason: 'links' });
        expect(activity).toEqual(['error /Notes']);
        expect(await ctx.engine.itemState('/Notes')).toBe('error');

        await rm(ctx.local('Notes'));
        ctx.engine.syncNow();
        await ctx.settle();
        expect(await readFile(ctx.local('Notes/remote.txt'), 'utf8')).toBe('remote');
        expect(ctx.engine.getStatus().state).toBe('idle');
        expect(child(ctx.fake, ctx.fake.rootUid, 'Other')).toBeUndefined();
    });

    it('never replaces a symbolic link that has the name of a remote file', async () => {
        const ctx = await setup();
        const target = path.join(await tempDir(), 'target.txt');
        await writeFile(target, 'mine');
        await mkdir(ctx.root, { recursive: true });
        await symlink(target, ctx.local('a.txt'));
        const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'remote' });

        await ctx.engine.start();
        await untilError(ctx.engine);

        expect((await lstat(ctx.local('a.txt'))).isSymbolicLink()).toBe(true);
        expect(await readFile(target, 'utf8')).toBe('mine');
        expect(ctx.fake.contentOf(file.uid)).toBe('remote');
        expect(ctx.engine.getStatus().reason).toBe('links');
    });

    it('keeps the remote copy of a synced folder replaced by a symbolic link', async () => {
        const ctx = await setup();
        const docs = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Docs', type: NodeType.Folder });
        ctx.fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'v1' });
        await ctx.engine.start();
        await ctx.settle();

        // Moved to another disk and linked back.
        const moved = path.join(await tempDir(), 'Docs');
        await rename(ctx.local('Docs'), moved);
        await symlink(moved, ctx.local('Docs'));
        ctx.engine.syncNow();
        await untilError(ctx.engine);

        expect(docs.trashed).toBeUndefined();
        expect(await readdir(moved)).toEqual(['a.txt']);
        expect(ctx.engine.getStatus().reason).toBe('links');

        // Removing the link, as the message says, brings the folder back instead of trashing it.
        await rm(ctx.local('Docs'));
        ctx.engine.syncNow();
        await ctx.settle();
        expect(docs.trashed).toBeUndefined();
        expect(await readFile(ctx.local('Docs/a.txt'), 'utf8')).toBe('v1');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('does not follow a symbolic link to sync a remote change in a synced folder', async () => {
        const ctx = await setup();
        const docs = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Docs', type: NodeType.Folder });
        const file = ctx.fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'v1' });
        await ctx.engine.start();
        await ctx.settle();

        const moved = path.join(await tempDir(), 'Docs');
        await rename(ctx.local('Docs'), moved);
        await symlink(moved, ctx.local('Docs'));
        // The event marks /Docs for syncing by its path, which now goes through the link.
        ctx.fake.updateContent(file.uid, 'v2');
        await untilError(ctx.engine);

        expect(await readFile(path.join(moved, 'a.txt'), 'utf8')).toBe('v1');
        expect(docs.trashed).toBeUndefined();
        expect(ctx.engine.getStatus().reason).toBe('links');

        // Moved back: the remote change is not lost.
        await rm(ctx.local('Docs'));
        await rename(moved, ctx.local('Docs'));
        ctx.engine.syncNow();
        await ctx.settle();
        expect(await readFile(ctx.local('Docs/a.txt'), 'utf8')).toBe('v2');
    });

    it('does not count links as deletions for the mass-deletion guard', async () => {
        const ctx = await setup({ maxDeletionsPerPass: 2 });
        const names = ['a.txt', 'b.txt', 'c.txt'];
        for (const name of names) {
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name, type: NodeType.File, content: name });
        }
        await ctx.engine.start();
        await ctx.settle();

        // What deduplication tools do.
        const elsewhere = await tempDir();
        for (const name of names) {
            await rename(ctx.local(name), path.join(elsewhere, name));
            await symlink(path.join(elsewhere, name), ctx.local(name));
        }
        ctx.engine.syncNow();
        await untilError(ctx.engine);

        expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', reason: 'links' });
        expect(names.map((name) => child(ctx.fake, ctx.fake.rootUid, name)?.trashed)).toEqual([undefined, undefined, undefined]);
    });

    it('does not download through a folder swapped for a link during the pass', async () => {
        const ctx = await setup();
        const docs = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Docs', type: NodeType.Folder });
        const file = ctx.fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'v1' });
        await ctx.engine.start();
        await ctx.settle();

        // Swapped after the pass checked /Docs for links, while the file downloads.
        const moved = path.join(await tempDir(), 'Docs');
        const downloadNode = ctx.drive.downloadNode.bind(ctx.drive);
        ctx.drive.downloadNode = async (...args) => {
            ctx.drive.downloadNode = downloadNode;
            await rename(ctx.local('Docs'), moved);
            await symlink(moved, ctx.local('Docs'));
            return downloadNode(...args);
        };
        ctx.fake.updateContent(file.uid, 'v2');
        await untilError(ctx.engine);

        expect(await readdir(moved)).toEqual(['a.txt']);
        expect(await readFile(path.join(moved, 'a.txt'), 'utf8')).toBe('v1');
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', reason: 'links' });
    });

    it('does not trash through a folder swapped for a link during the pass', async () => {
        const ctx = await setup();
        const docs = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Docs', type: NodeType.Folder });
        const file = ctx.fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'v1' });
        await ctx.engine.start();
        await ctx.settle();

        // Swapped after the pass scanned /Docs, while it lists the folder on Proton.
        const moved = path.join(await tempDir(), 'Docs');
        const list = ctx.fake.sdk.iterateFolderChildrenNodeUids;
        ctx.fake.sdk.iterateFolderChildrenNodeUids = async function* (...args) {
            ctx.fake.sdk.iterateFolderChildrenNodeUids = list;
            await rename(ctx.local('Docs'), moved);
            await symlink(moved, ctx.local('Docs'));
            yield* list(...args);
        };
        for await (const result of ctx.fake.sdk.trashNodes([file.uid])) {
            expect(result.ok).toBe(true);
        }
        await untilError(ctx.engine);

        expect(await readdir(moved)).toEqual(['a.txt']);
        expect(await ctx.trashed()).toEqual([]);
        expect(ctx.engine.getStatus()).toMatchObject({ state: 'error', reason: 'links' });
    });

    describe('over-long remote names', () => {
        const longName = `${'n'.repeat(296)}.txt`;

        it('skips a remote file whose name is too long, once, and stays up to date', async () => {
            const activity: string[] = [];
            const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`) });
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: longName, type: NodeType.File, content: 'long' });
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'normal.txt', type: NodeType.File, content: 'normal' });
            await ctx.engine.start();
            await ctx.settle();
            ctx.fake.remoteChange({ type: DriveEventType.NodeUpdated, uid: ctx.fake.rootUid });
            await ctx.settle();

            expect(await readFile(ctx.local('normal.txt'), 'utf8')).toBe('normal');
            expect(ctx.engine.getStatus().state).toBe('idle');
            expect(activity.filter((line) => line.startsWith('skipped'))).toEqual([`skipped /${longName} nameTooLong`]);
            expect((await readdir(ctx.root)).sort()).toEqual(['.kation-sync', 'normal.txt']);
        });

        it('skips a remote folder whose name is too long', async () => {
            const activity: string[] = [];
            const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`) });
            const folder = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: longName, type: NodeType.Folder });
            ctx.fake.add({ parentUid: folder.uid, name: 'inside.txt', type: NodeType.File, content: 'inside' });
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'normal.txt', type: NodeType.File, content: 'normal' });
            await ctx.engine.start();
            await ctx.settle();
            ctx.fake.remoteChange({ type: DriveEventType.NodeUpdated, uid: ctx.fake.rootUid });
            await ctx.settle();

            expect(ctx.engine.getStatus().state).toBe('idle');
            expect(activity.filter((line) => line.startsWith('skipped'))).toEqual([`skipped /${longName} nameTooLong`]);
            expect((await readdir(ctx.root)).sort()).toEqual(['.kation-sync', 'normal.txt']);
        });

        it('leaves out, without reporting, a refused name that could not be a file name', async () => {
            const activity: string[] = [];
            const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`) });
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: `${'a'.repeat(300)}\0x`, type: NodeType.File, content: 'nul' });
            ctx.fake.add({
                parentUid: ctx.fake.rootUid,
                name: `${'a'.repeat(300)}/../../etc/passwd`,
                type: NodeType.File,
                content: 'slash',
            });
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'ok.txt', type: NodeType.File, content: 'ok' });
            await ctx.engine.start();
            await ctx.settle();

            expect(await readFile(ctx.local('ok.txt'), 'utf8')).toBe('ok');
            expect(ctx.engine.getStatus().state).toBe('idle');
            expect(activity.filter((line) => !line.startsWith('downloaded'))).toEqual([]);
        });

        it('skips a name the SDK accepts but that is too long in bytes', async () => {
            const activity: string[] = [];
            const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`) });
            const accented = `${'é'.repeat(200)}.txt`;
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: accented, type: NodeType.File, content: 'long' });
            await ctx.engine.start();
            await ctx.settle();

            expect(ctx.engine.getStatus().state).toBe('idle');
            expect(activity).toEqual([`skipped /${accented} nameTooLong`]);
        });

        it('keeps the local copy of a synced file renamed to a name too long to list', async () => {
            const ctx = await setup();
            const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'a' });
            await ctx.engine.start();
            await ctx.settle();
            await ctx.fake.sdk.renameNode(file.uid, longName);
            await untilError(ctx.engine);

            expect(await readFile(ctx.local('a.txt'), 'utf8')).toBe('a');
            expect(await ctx.trashed()).toEqual([]);
        });

        it('skips a remote folder whose path is too long for the file system', async () => {
            const activity: string[] = [];
            const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`) });
            let parentUid = ctx.fake.rootUid;
            for (let depth = 0; depth < 20; depth++) {
                parentUid = ctx.fake.add({ parentUid, name: `${depth}`.padEnd(240, 'd'), type: NodeType.Folder }).uid;
            }
            await ctx.engine.start();
            await ctx.settle();

            expect(ctx.engine.getStatus().state).toBe('idle');
            expect(activity.filter((line) => line.startsWith('skipped'))).toHaveLength(1);
            expect(activity.filter((line) => line.startsWith('error'))).toEqual([]);
        });

        it('downloads names just under the limit, in ASCII and in multi-byte characters', async () => {
            const ctx = await setup();
            const ascii = `${'a'.repeat(246)}.txt`;
            const accented = `${'é'.repeat(123)}.txt`;
            expect([Buffer.byteLength(ascii), Buffer.byteLength(accented)]).toEqual([250, 250]);
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: ascii, type: NodeType.File, content: 'ascii' });
            ctx.fake.add({ parentUid: ctx.fake.rootUid, name: accented, type: NodeType.File, content: 'accented' });
            await ctx.engine.start();
            await ctx.settle();

            expect(await readFile(ctx.local(ascii), 'utf8')).toBe('ascii');
            expect(await readFile(ctx.local(accented), 'utf8')).toBe('accented');
            expect(ctx.engine.getStatus().state).toBe('idle');
        });

        it('syncs the item once it is renamed to a shorter name', async () => {
            const ctx = await setup();
            const file = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: longName, type: NodeType.File, content: 'long' });
            await ctx.engine.start();
            await ctx.settle();
            await ctx.fake.sdk.renameNode(file.uid, 'short.txt');
            await ctx.settle();

            expect(await readFile(ctx.local('short.txt'), 'utf8')).toBe('long');
            expect(ctx.engine.getStatus().state).toBe('idle');
        });
    });

    it('preserves modification times of downloads', async () => {
        const ctx = await setup();
        ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'dated.txt', type: NodeType.File, content: 'x' });
        await ctx.engine.start();
        await ctx.settle();
        const node = child(ctx.fake, ctx.fake.rootUid, 'dated.txt')!;
        expect(Math.floor((await stat(ctx.local('dated.txt'))).mtimeMs / 1000)).toBe(Math.floor(node.modified.getTime() / 1000));
    });
});

describe('foldersForLog', () => {
    it('lists up to 10 folders and counts the rest', () => {
        const folders = Array.from({ length: 25 }, (_, i) => `/f${i}`);
        expect(foldersForLog([])).toBe('-');
        expect(foldersForLog(folders.slice(0, 10))).toBe(folders.slice(0, 10).join(', '));
        expect(foldersForLog(folders)).toBe(`${folders.slice(0, 10).join(', ')}, … (+15 more)`);
    });
});

describe('the sync pass log line', () => {
    async function setupWithLog() {
        const lines: string[] = [];
        const log = (level: string) => (message: string) => void lines.push(`${level} ${message}`);
        const ctx = await setup({ logger: { ...silentLogger, info: log('INFO'), debug: log('DEBUG') } });
        const passLines = () => lines.filter((line) => /Sync pass|All folders/.test(line));
        return { ...ctx, lines, passLines };
    }

    it('names the kind of pass and its folders', async () => {
        const ctx = await setupWithLog();
        await mkdir(ctx.local('Project'), { recursive: true });
        await ctx.engine.start();
        await ctx.settle();
        expect(ctx.passLines()[0]).toBe('INFO Sync pass: full (fresh), folders -');

        ctx.lines.length = 0;
        ctx.engine.onLocalChange('/Project/draft.txt');
        await ctx.settle();
        expect(ctx.passLines()).toEqual(['INFO Sync pass: changes, folders /Project']);
    });

    it('lists every folder at the debug level only when the info line cuts the list', async () => {
        const ctx = await setupWithLog();
        const folders = Array.from({ length: 11 }, (_, i) => `/d${i}`);
        await Promise.all(folders.map((folder) => mkdir(ctx.local(folder), { recursive: true })));
        await ctx.engine.start();
        await ctx.settle();

        ctx.lines.length = 0;
        for (const folder of folders) {
            ctx.engine.onLocalChange(`${folder}/draft.txt`);
        }
        await ctx.settle();
        expect(ctx.passLines()).toEqual([
            `INFO Sync pass: changes, folders ${folders.slice(0, 10).join(', ')}, … (+1 more)`,
            `DEBUG All folders of the pass: ${folders.join(', ')}`,
        ]);
    });
});

describe('SyncEngine renames and moves', () => {
    async function synced() {
        const activity: string[] = [];
        const ctx = await setup({ onActivity: (item) => activity.push(`${item.kind} ${item.path} ${item.detail}`.trim()) });
        const docs = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Docs', type: NodeType.Folder });
        const file = ctx.fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'v1' });
        const other = ctx.fake.add({ parentUid: ctx.fake.rootUid, name: 'Other', type: NodeType.Folder });
        await ctx.engine.start();
        await ctx.settle();
        activity.length = 0;
        return { ...ctx, activity, docs, file, other };
    }

    it('renames a file on Proton when it is renamed here', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/b.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        ctx.engine.onLocalChange('/Docs/b.txt');
        await ctx.settle();

        expect([...ctx.fake.childrenOf(ctx.docs.uid).keys()]).toEqual(['b.txt']);
        expect(ctx.file).toMatchObject({ name: 'b.txt', revision: 1 });
        expect(ctx.file.trashed).toBeUndefined();
        expect(ctx.activity).toEqual(['moved /Docs/b.txt /Docs/a.txt']);
        expect(ctx.state.get('/Docs/a.txt')).toBeUndefined();
        expect(ctx.state.get('/Docs/b.txt')?.remoteUid).toBe(ctx.file.uid);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('moves a file on Proton when it is moved to another folder here, found by a full scan', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Other/renamed.txt'));
        ctx.engine.syncNow();
        await ctx.settle();

        expect(ctx.file).toMatchObject({ name: 'renamed.txt', parentUid: ctx.other.uid, revision: 1 });
        expect(ctx.file.trashed).toBeUndefined();
        expect(ctx.activity).toEqual(['moved /Other/renamed.txt /Docs/a.txt']);
    });

    it('renames a folder on Proton with everything in it, uploading nothing', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs'), ctx.local('Papers'));
        ctx.engine.onLocalChange('/Docs');
        ctx.engine.onLocalChange('/Papers');
        await ctx.settle();

        expect(ctx.docs.name).toBe('Papers');
        expect(ctx.docs.trashed).toBeUndefined();
        expect(ctx.file).toMatchObject({ parentUid: ctx.docs.uid, revision: 1 });
        expect(ctx.activity).toEqual(['moved /Papers /Docs']);
        expect(ctx.state.get('/Papers/a.txt')?.remoteUid).toBe(ctx.file.uid);
        expect(ctx.state.get('/Docs/a.txt')).toBeUndefined();
    });

    it('uploads a new version of the same file when it is renamed and edited', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/b.txt'));
        await edit(ctx.local('Docs/b.txt'), 'v2 longer');
        ctx.engine.onLocalChange('/Docs/b.txt');
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect(ctx.file.name).toBe('b.txt');
        expect(ctx.fake.contentOf(ctx.file.uid)).toBe('v2 longer');
        expect(ctx.fake.childrenOf(ctx.docs.uid).size).toBe(1);
        expect(ctx.activity).toEqual(['moved /Docs/b.txt /Docs/a.txt', 'uploaded /Docs/b.txt']);
    });

    it('moves a file into a folder created here at the same time', async () => {
        const ctx = await synced();
        await mkdir(ctx.local('Archive/2026'), { recursive: true });
        await rename(ctx.local('Docs/a.txt'), ctx.local('Archive/2026/a.txt'));
        await writeFile(ctx.local('Archive/2026/new.txt'), 'new');
        ctx.engine.onLocalChange('/Archive');
        ctx.engine.onLocalChange('/Archive/2026');
        ctx.engine.onLocalChange('/Archive/2026/a.txt');
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        const archive = child(ctx.fake, ctx.fake.rootUid, 'Archive')!;
        const year = child(ctx.fake, archive.uid, '2026')!;
        expect(ctx.file).toMatchObject({ parentUid: year.uid, revision: 1 });
        expect(ctx.file.trashed).toBeUndefined();
        expect([...ctx.fake.childrenOf(year.uid).keys()].sort()).toEqual(['a.txt', 'new.txt']);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('uploads a copy or a hard link as a new file', async () => {
        const ctx = await synced();
        await link(ctx.local('Docs/a.txt'), ctx.local('Docs/linked.txt'));
        await copyFile(ctx.local('Docs/a.txt'), ctx.local('Docs/copy.txt'));
        ctx.engine.onLocalChange('/Docs/linked.txt');
        await ctx.settle();

        expect(ctx.file.name).toBe('a.txt');
        expect([...ctx.fake.childrenOf(ctx.docs.uid).keys()].sort()).toEqual(['a.txt', 'copy.txt', 'linked.txt']);
        expect(ctx.activity.filter((line) => line.startsWith('moved'))).toEqual([]);
    });

    it('keeps the same file on Proton when an editor replaces it by renaming a new file over it', async () => {
        const ctx = await synced();
        await edit(ctx.local('Docs/a.txt.new'), 'v2 saved');
        await rename(ctx.local('Docs/a.txt.new'), ctx.local('Docs/a.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect(ctx.fake.contentOf(ctx.file.uid)).toBe('v2 saved');
        expect(ctx.fake.childrenOf(ctx.docs.uid).size).toBe(1);
    });

    it('keeps the file on Proton at its name when an editor renames it as a backup and writes a new one', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/a.txt.bak'));
        await edit(ctx.local('Docs/a.txt'), 'v2 saved');
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect(ctx.file.name).toBe('a.txt');
        expect(ctx.fake.contentOf(ctx.file.uid)).toBe('v2 saved');
        expect(ctx.fake.contentOf(child(ctx.fake, ctx.docs.uid, 'a.txt.bak')!.uid)).toBe('v1');
        expect(ctx.activity.filter((line) => line.startsWith('moved'))).toEqual([]);
    });

    it('syncs a file renamed over the old name of another renamed file as an edit', async () => {
        const ctx = await synced();
        await edit(ctx.local('Docs/draft.txt'), 'draft');
        ctx.engine.onLocalChange('/Docs/draft.txt');
        await ctx.settle();
        ctx.activity.length = 0;

        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/backup.txt'));
        await rename(ctx.local('Docs/draft.txt'), ctx.local('Docs/a.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect((await readdir(ctx.local('Docs'))).sort()).toEqual(['a.txt', 'backup.txt']);
        expect(await readFile(ctx.local('Docs/a.txt'), 'utf8')).toBe('draft');
        expect(await readFile(ctx.local('Docs/backup.txt'), 'utf8')).toBe('v1');
        expect([...ctx.fake.childrenOf(ctx.docs.uid).keys()].sort()).toEqual(['a.txt', 'backup.txt']);
        expect(ctx.fake.contentOf(ctx.file.uid)).toBe('draft');
        expect(ctx.activity.filter((line) => /^(downloaded|trashedLocal|moved)/.test(line))).toEqual([]);
        expect(await ctx.trashed()).toEqual([]);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    for (const fresh of [false, true]) {
        it(`follows a rename made here once the pass has started${fresh ? ', in a folder listed from Proton' : ''}`, async () => {
            const ctx = await synced();
            const internals = ctx.engine as unknown as { detectLocalMoves: (...args: unknown[]) => Promise<void> };
            const original = internals.detectLocalMoves.bind(ctx.engine);
            let renamed = false;
            internals.detectLocalMoves = async (...args) => {
                await original(...args);
                if (!renamed) {
                    renamed = true;
                    await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/0early.txt'));
                }
            };
            if (fresh) {
                ctx.fake.remoteChange({ type: DriveEventType.NodeUpdated, uid: ctx.file.uid });
            } else {
                ctx.engine.onLocalChange('/Docs/a.txt');
            }
            await ctx.settle();

            expect(await readdir(ctx.local('Docs'))).toEqual(['0early.txt']);
            expect([...ctx.fake.childrenOf(ctx.docs.uid).keys()]).toEqual(['0early.txt']);
            expect(ctx.file.trashed).toBeUndefined();
            expect(ctx.activity).toEqual(['moved /Docs/0early.txt /Docs/a.txt']);
            expect(await ctx.trashed()).toEqual([]);
            expect(ctx.state.get('/Docs/a.txt')).toBeUndefined();
            expect(ctx.engine.getStatus().state).toBe('idle');
        });
    }

    it('still syncs other changes when a move cannot be followed because of a link', async () => {
        const ctx = await synced();
        await rm(ctx.local('Other'), { recursive: true });
        await symlink(await tempDir(), ctx.local('Other'));
        // Without Drive events: only the local changes are looked at.
        ctx.stop();
        for await (const result of ctx.fake.sdk.moveNodes([ctx.file.uid], ctx.other.uid)) {
            expect(result.ok).toBe(true);
        }
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/b.txt'));
        await edit(ctx.local('Docs/new.txt'), 'new');
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect(ctx.fake.contentOf(child(ctx.fake, ctx.docs.uid, 'new.txt')!.uid)).toBe('new');
        expect(ctx.file.trashed).toBeUndefined();
        expect(await readFile(ctx.local('Docs/b.txt'), 'utf8')).toBe('v1');
    });

    it('trashes on Proton a file moved out of the sync folder', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs/a.txt'), path.join(await tempDir(), 'a.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();
        expect(ctx.file.trashed).toBeDefined();
    });

    it('syncs the item as new when its new name is already taken on Proton', async () => {
        const ctx = await synced();
        ctx.fake.add({ parentUid: ctx.docs.uid, name: 'b.txt', type: NodeType.File, content: 'v1' });
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/b.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect(ctx.file.trashed).toBeDefined();
        expect(await readFile(ctx.local('Docs/b.txt'), 'utf8')).toBe('v1');
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('recognises renames after an upgrade from a state without inodes', async () => {
        const ctx = await synced();
        ctx.state.setLocalIdentity('/Docs/a.txt', null as unknown as number, null as unknown as number);
        ctx.engine.syncNow();
        await ctx.settle();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/b.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();
        expect(ctx.file).toMatchObject({ name: 'b.txt' });
        expect(ctx.file.trashed).toBeUndefined();
    });

    for (const [title, from, to] of [
        ['renamed to a later name', 'a.txt', 'z.txt'],
        ['renamed to an earlier name', 'a.txt', '0.txt'],
    ] as const) {
        it(`renames the local file, without a download, when it is ${title} on Proton`, async () => {
            const ctx = await synced();
            const inode = (await stat(ctx.local('Docs/a.txt'))).ino;
            await ctx.fake.sdk.renameNode(ctx.file.uid, to);
            await ctx.settle();

            expect(await readdir(ctx.local('Docs'))).toEqual([to]);
            expect((await stat(ctx.local(`Docs/${to}`))).ino).toBe(inode);
            expect(await ctx.trashed()).toEqual([]);
            expect(ctx.activity).toEqual([`moved /Docs/${to} /Docs/${from}`]);
            expect(ctx.state.get(`/Docs/${to}`)?.remoteUid).toBe(ctx.file.uid);
            expect(ctx.engine.getStatus().state).toBe('idle');
        });
    }

    for (const [title, source, destination] of [
        ['to a later folder', 'Docs', 'Other'],
        ['to an earlier folder', 'Other', 'Docs'],
    ] as const) {
        it(`moves the local folder, with a file not synced yet, when it is moved ${title} on Proton`, async () => {
            const ctx = await synced();
            const parents = { Docs: ctx.docs, Other: ctx.other };
            const sub = ctx.fake.add({ parentUid: parents[source].uid, name: 'Sub', type: NodeType.Folder });
            ctx.fake.add({ parentUid: sub.uid, name: 'in.txt', type: NodeType.File, content: 'in' });
            ctx.fake.remoteChange({ type: DriveEventType.NodeCreated, uid: sub.uid });
            await ctx.settle();
            ctx.activity.length = 0;
            await edit(ctx.local(`${source}/Sub/mine.txt`), 'mine');

            for await (const result of ctx.fake.sdk.moveNodes([sub.uid], parents[destination].uid)) {
                expect(result.ok).toBe(true);
            }
            await ctx.settle();

            expect((await readdir(ctx.local(`${destination}/Sub`))).sort()).toEqual(['in.txt', 'mine.txt']);
            expect(await readdir(ctx.local(source))).not.toContain('Sub');
            expect(await ctx.trashed()).toEqual([]);
            expect(ctx.activity.filter((line) => line.startsWith('downloaded'))).toEqual([]);
            expect([...ctx.fake.childrenOf(sub.uid).keys()].sort()).toEqual(['in.txt', 'mine.txt']);
        });
    }

    it('moves the local file into a folder created on Proton at the same time', async () => {
        const ctx = await synced();
        const archive = ctx.fake.add({ parentUid: ctx.other.uid, name: 'Archive', type: NodeType.Folder });
        for await (const result of ctx.fake.sdk.moveNodes([ctx.file.uid], archive.uid)) {
            expect(result.ok).toBe(true);
        }
        ctx.fake.remoteChange({ type: DriveEventType.NodeCreated, uid: archive.uid });
        await ctx.settle();

        expect(await readFile(ctx.local('Other/Archive/a.txt'), 'utf8')).toBe('v1');
        expect(await readdir(ctx.local('Docs'))).toEqual([]);
        expect(await ctx.trashed()).toEqual([]);
        expect(ctx.activity.filter((line) => line.startsWith('downloaded'))).toEqual([]);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('uploads a local edit as a new version of a file renamed on Proton', async () => {
        const ctx = await synced();
        await edit(ctx.local('Docs/a.txt'), 'v2 local');
        await ctx.fake.sdk.renameNode(ctx.file.uid, 'b.txt');
        await ctx.settle();

        expect(await readdir(ctx.local('Docs'))).toEqual(['b.txt']);
        expect(ctx.fake.contentOf(ctx.file.uid)).toBe('v2 local');
        expect(ctx.fake.childrenOf(ctx.docs.uid).size).toBe(1);
    });

    it('lets Proton win when a file is renamed differently on both sides', async () => {
        const ctx = await synced();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Docs/local.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.fake.sdk.renameNode(ctx.file.uid, 'remote.txt');
        await ctx.settle();

        expect(await readdir(ctx.local('Docs'))).toEqual(['remote.txt']);
        expect([...ctx.fake.childrenOf(ctx.docs.uid).keys()]).toEqual(['remote.txt']);
        expect(ctx.file.trashed).toBeUndefined();
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('keeps on Proton a file deleted here but renamed there, and brings it back', async () => {
        const ctx = await synced();
        // Renamed on Proton, its event not received yet.
        ctx.stop();
        ctx.file.name = 'b.txt';
        await rm(ctx.local('Docs/a.txt'));
        ctx.engine.onLocalChange('/Docs/a.txt');
        await ctx.settle();

        expect(ctx.file.trashed).toBeUndefined();
        expect(await readFile(ctx.local('Docs/b.txt'), 'utf8')).toBe('v1');
        expect(ctx.activity).toEqual(['downloaded /Docs/b.txt']);
        expect(ctx.engine.getStatus().state).toBe('idle');
    });

    it('keeps both when a file replaced by a folder here is renamed on Proton', async () => {
        const ctx = await synced();
        await rm(ctx.local('Docs/a.txt'));
        await mkdir(ctx.local('Docs/a.txt'));
        await writeFile(ctx.local('Docs/a.txt/inner.txt'), 'inner');
        await ctx.fake.sdk.renameNode(ctx.file.uid, 'b.txt');
        await ctx.settle();

        expect(ctx.file.trashed).toBeUndefined();
        expect(await readFile(ctx.local('Docs/b.txt'), 'utf8')).toBe('v1');
        expect(await readFile(ctx.local('Docs/a.txt/inner.txt'), 'utf8')).toBe('inner');
        expect([...ctx.fake.childrenOf(ctx.docs.uid).keys()].sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('reports an item that Proton no longer lists but still has, without trashing it or listing in a loop', async () => {
        const ctx = await synced();
        ctx.stop();
        ctx.file.trashed = new Date();
        const getNode = ctx.sdk.getNode;
        ctx.sdk.getNode = async (nodeOrUid) => {
            const node = await getNode(nodeOrUid);
            return node.uid === ctx.file.uid ? { ...node, trashTime: undefined } : node;
        };
        const before = ctx.listings();
        ctx.engine.onRemoteEvent({
            type: DriveEventType.NodeUpdated,
            nodeUid: ctx.file.uid,
            parentNodeUid: ctx.docs.uid,
        } as Parameters<SyncEngine['onRemoteEvent']>[0]);
        await untilError(ctx.engine);
        await Bun.sleep(100);

        expect(ctx.engine.getStatus().state).toBe('error');
        expect(ctx.listings() - before).toBe(2);
        expect(await readdir(ctx.local('Docs'))).toEqual(['a.txt']);
        expect(await ctx.trashed()).toEqual([]);
    });

    it('trashes the local file when it is moved into an excluded folder on Proton', async () => {
        const ctx = await synced();
        await ctx.engine.stop();
        const again = await setup({ fake: ctx.fake, root: ctx.root, excluded: ['/Other'] });
        await again.engine.start();
        await again.settle();
        for await (const result of ctx.fake.sdk.moveNodes([ctx.file.uid], ctx.other.uid)) {
            expect(result.ok).toBe(true);
        }
        again.engine.onRemoteEvent({ type: DriveEventType.TreeRefresh } as Parameters<SyncEngine['onRemoteEvent']>[0]);
        await again.settle();
        expect(await readdir(again.local('Docs'))).toEqual([]);
        expect(await again.trashed()).toEqual(['a.txt']);
    });

    it('does not delete from Proton while a folder cannot be read', async () => {
        const ctx = await synced();
        await mkdir(ctx.local('Locked'));
        ctx.engine.onLocalChange('/Locked');
        await ctx.settle();
        await rename(ctx.local('Docs/a.txt'), ctx.local('Locked/a.txt'));
        await chmod(ctx.local('Locked'), 0o000);
        try {
            ctx.engine.syncNow();
            await untilError(ctx.engine);
            expect(ctx.file.trashed).toBeUndefined();
        } finally {
            await chmod(ctx.local('Locked'), 0o755);
        }
        ctx.engine.syncNow();
        await ctx.settle();
        expect(ctx.file.trashed).toBeUndefined();
        expect(ctx.file.parentUid).toBe(child(ctx.fake, ctx.fake.rootUid, 'Locked')!.uid);
    });
});
