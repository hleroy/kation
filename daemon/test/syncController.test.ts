// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeType } from '@protontech/drive-sdk';

import { getConfig } from '../src/config';
import { DriveService } from '../src/service/driveService';
import { FakeDrive } from '../src/service/fakeDrive';
import { DriveTree } from '../src/service/tree';
import { SyncController } from '../src/sync/controller';
import { normalizeExcluded, validateFolder } from '../src/sync/settings';
import { SyncState } from '../src/sync/state';
import { silentLogger, tempDir } from './helpers';

const controllers: SyncController[] = [];
afterEach(async () => {
    await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
});

async function setup(loggedIn = true, autostartCalls: boolean[] = []) {
    const home = await tempDir();
    const config = getConfig({ appVersion: 'a', sdkVersion: 's', home, env: {} });
    const fake = new FakeDrive();
    const tree = new DriveTree(fake.sdk, silentLogger);
    const drive = new DriveService(fake.sdk, tree, silentLogger);
    const state = { loggedIn };
    const controller = new SyncController({
        config,
        drive,
        tree,
        sdk: fake.sdk,
        logger: silentLogger,
        isLoggedIn: () => state.loggedIn,
        autostart: async (enabled) => {
            autostartCalls.push(enabled);
        },
        engineOptions: { watch: false, settleMs: 0, debounceMs: 0 },
    });
    controllers.push(controller);
    return { home, config, fake, controller, state, drive };
}

describe('SyncController', () => {
    it('is off by default and syncs ~/Proton Drive once turned on', async () => {
        const { home, fake, controller } = await setup();
        fake.add({ parentUid: fake.rootUid, name: 'hello.txt', type: NodeType.File, content: 'hi' });
        expect(controller.status()).toMatchObject({ enabled: false, state: 'disabled', folder: path.join(home, 'Proton Drive') });

        await controller.setEnabled(true);
        await Bun.sleep(50);
        expect(await readFile(path.join(home, 'Proton Drive', 'hello.txt'), 'utf8')).toBe('hi');
        expect(controller.status()).toMatchObject({ enabled: true, state: 'idle' });
    });

    it('starts with the session exactly while sync is on', async () => {
        const calls: boolean[] = [];
        const { controller } = await setup(true, calls);
        await controller.applyAutostart();
        await controller.setEnabled(true);
        await controller.setEnabled(false);
        expect(calls).toEqual([false, true, false]);
    });

    it('never trashes a folder that was excluded, emptied locally and included again', async () => {
        const { home, fake, controller } = await setup();
        const videos = fake.add({ parentUid: fake.rootUid, name: 'Videos', type: NodeType.Folder });
        fake.add({ parentUid: videos.uid, name: 'clip.mp4', type: NodeType.File, content: 'clip' });
        await controller.setEnabled(true);
        await Bun.sleep(50);
        const local = path.join(home, 'Proton Drive', 'Videos');
        expect(await readFile(path.join(local, 'clip.mp4'), 'utf8')).toBe('clip');

        await controller.setExcluded(['/Videos']);
        await rm(local, { recursive: true });
        await Bun.sleep(50);
        await controller.setExcluded([]);
        await Bun.sleep(100);

        expect(videos.trashed).toBeUndefined();
        expect(await readFile(path.join(local, 'clip.mp4'), 'utf8')).toBe('clip');
    });

    it('remembers its settings', async () => {
        const { config, controller } = await setup();
        await controller.setFolder(path.join(config.homeDir, 'Cloud'));
        await controller.setExcluded(['/Videos/', '/Music']);
        const settings = JSON.parse(await readFile(path.join(config.configDir, 'sync.json'), 'utf8'));
        expect(settings).toMatchObject({ enabled: false, folder: path.join(config.homeDir, 'Cloud'), excluded: ['/Music', '/Videos'] });
    });

    it('requires sign-in and refuses to change the folder while syncing', async () => {
        const signedOut = await setup(false);
        await expect(signedOut.controller.setEnabled(true)).rejects.toMatchObject({ code: 'NotLoggedIn' });

        const { config, controller } = await setup();
        await controller.setEnabled(true);
        await expect(controller.setFolder(path.join(config.homeDir, 'Other'))).rejects.toMatchObject({ code: 'InvalidArgument' });
    });

    it('stops on sign-out and keeps the files', async () => {
        const { home, fake, controller, state } = await setup();
        fake.add({ parentUid: fake.rootUid, name: 'kept.txt', type: NodeType.File, content: 'k' });
        await controller.setEnabled(true);
        await Bun.sleep(50);
        const part = path.join(home, 'Proton Drive', '.big.iso.0123abcd.kation-part');
        await writeFile(part, 'partial');
        state.loggedIn = false;
        await controller.onLogout();
        expect(controller.status()).toMatchObject({ enabled: true, state: 'disabled', message: 'Sign in to sync', reason: 'signedOut' });
        expect(await readFile(path.join(home, 'Proton Drive', 'kept.txt'), 'utf8')).toBe('k');
        expect(await Bun.file(part).exists()).toBe(false);
    });

    it('pauses after signing in to another account, and starts over when turned off and on', async () => {
        const { home, config, fake, controller, state } = await setup();
        fake.add({ parentUid: fake.rootUid, name: 'mine.txt', type: NodeType.File, content: 'a' });
        await controller.setEnabled(true);
        await Bun.sleep(50);
        state.loggedIn = false;
        await controller.onLogout();
        await writeFile(path.join(home, 'Proton Drive', 'only-here.txt'), 'b');

        // The account the folder was synced with is remembered; pretend the next one differs.
        const stored = new SyncState(path.join(config.appDir, 'sync.sqlite'));
        expect(stored.getMeta('rootUid')).toBe(fake.rootUid);
        stored.setMeta('rootUid', 'root-of-another-account');
        stored.close();

        state.loggedIn = true;
        await controller.apply();
        await Bun.sleep(50);
        expect(controller.status()).toMatchObject({ state: 'paused', reason: 'account' });
        expect(controller.status().message).toContain('different Proton account');
        expect(fake.childrenOf(fake.rootUid).has('only-here.txt')).toBe(false);

        await controller.setEnabled(false);
        await controller.setEnabled(true);
        await Bun.sleep(50);
        expect(controller.status().state).toBe('idle');
        expect(fake.childrenOf(fake.rootUid).has('only-here.txt')).toBe(true);
    });

    it('keeps the sync state when the session is lost, to resume after signing in', async () => {
        const { home, fake, controller, state, config } = await setup();
        fake.add({ parentUid: fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'a' });
        await controller.setEnabled(true);
        await Bun.sleep(50);
        state.loggedIn = false;
        await controller.onSessionLost();
        expect(controller.status()).toMatchObject({ enabled: true, state: 'disabled' });

        state.loggedIn = true;
        await controller.apply();
        await Bun.sleep(50);
        expect(controller.status().state).toBe('idle');
        expect(await readFile(path.join(home, 'Proton Drive', 'a.txt'), 'utf8')).toBe('a');
        void config;
    });
});

describe('SyncController activity and item states', () => {
    it('reports activity and the sync state of local paths', async () => {
        const { home, fake, controller } = await setup();
        fake.add({ parentUid: fake.rootUid, name: 'hello.txt', type: NodeType.File, content: 'hi' });
        const root = path.join(home, 'Proton Drive');
        expect(await controller.itemStates([path.join(root, 'hello.txt')])).toEqual(new Map([[path.join(root, 'hello.txt'), '']]));

        const until = async (check: () => boolean) => {
            for (let i = 0; i < 300 && !check(); i++) {
                await Bun.sleep(10);
            }
            expect(check()).toBe(true);
        };
        const idle = () => controller.status().state === 'idle';

        await controller.setEnabled(true);
        await until(() => idle() && controller.recentActivity().length > 0);
        expect(controller.recentActivity()).toEqual([
            expect.objectContaining({ kind: 'downloaded', path: '/hello.txt', localPath: path.join(root, 'hello.txt') }),
        ]);

        await controller.setExcluded(['/Private']);
        await mkdir(path.join(root, 'Private'));
        await until(idle);
        const states = await controller.itemStates([
            root,
            path.join(root, 'hello.txt'),
            path.join(root, 'Private'),
            path.join(root, '.kation-sync'),
            path.join(home, 'elsewhere.txt'),
        ]);
        expect([...states.values()]).toEqual(['synced', 'synced', 'excluded', '', '']);

        await controller.setPaused(true);
        await writeFile(path.join(root, 'new.txt'), 'local');
        expect((await controller.itemStates([path.join(root, 'new.txt')])).get(path.join(root, 'new.txt'))).toBe('paused');
        await controller.setPaused(false);
        // No file watcher in tests: scan, as the watcher would on the new file.
        controller.syncNow();
        await until(() => controller.recentActivity()[0]?.kind === 'uploaded');
        expect((await controller.itemStates([path.join(root, 'new.txt')])).get(path.join(root, 'new.txt'))).toBe('synced');
        expect(controller.recentActivity()[0]).toMatchObject({ kind: 'uploaded', path: '/new.txt' });
    });

    it('maps local paths to paths in My files', async () => {
        const { home, controller } = await setup();
        const root = path.join(home, 'Proton Drive');
        expect(controller.drivePathOf(root)).toBe('/');
        expect(controller.drivePathOf(`${root}/Docs/a b.txt`)).toBe('/Docs/a b.txt');
        expect(controller.drivePathOf(`${root} 2/a.txt`)).toBeUndefined();
        expect(controller.drivePathOf(`${root}/../x`)).toBeUndefined();
        expect(controller.drivePathOf('relative')).toBeUndefined();
    });

    it('stores and applies speed limits', async () => {
        const { config, controller, drive } = await setup();
        controller.setLimits(512, 2048);
        expect(controller.status()).toMatchObject({ uploadLimit: 512, downloadLimit: 2048 });
        expect(drive.uploadLimiter.limit).toBe(512 * 1024);
        expect(drive.downloadLimiter.limit).toBe(2048 * 1024);
        expect(() => controller.setLimits(-1, 0)).toThrow();
        expect(() => controller.setLimits(1.5, 0)).toThrow();
        expect(JSON.parse(await readFile(path.join(config.configDir, 'sync.json'), 'utf8'))).toMatchObject({ uploadLimit: 512 });
    });
});

describe('settings validation', () => {
    it('rejects dangerous sync folders', () => {
        expect(() => validateFolder('relative', '/home/a', [])).toThrow('absolute');
        expect(() => validateFolder('/home/a', '/home/a', [])).toThrow('dedicated folder');
        expect(() => validateFolder('/', '/home/a', [])).toThrow('dedicated folder');
        expect(() => validateFolder('/home/a/.local/share', '/home/a', ['/home/a/.local/share/kation'])).toThrow('overlap');
        expect(validateFolder('/home/a/Drive/', '/home/a', [])).toBe('/home/a/Drive');
    });

    it('normalises excluded folders', () => {
        expect(normalizeExcluded(['/b/', '/a', '/a'])).toEqual(['/a', '/b']);
        expect(() => normalizeExcluded(['relative'])).toThrow('Invalid');
        expect(() => normalizeExcluded(['/a/../b'])).toThrow('Invalid');
    });
});
