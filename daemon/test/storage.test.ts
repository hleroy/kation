// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterEach, describe, expect, it } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ValidationError } from '@protontech/drive-sdk';

import { formatStorage } from '../src/client';
import { DriveService } from '../src/service/driveService';
import { toKationError } from '../src/service/errors';
import { FakeAccount, FakeDrive } from '../src/service/fakeDrive';
import { Session } from '../src/service/session';
import { driveStorageOf, type Storage, StorageMonitor } from '../src/service/storage';
import { DriveTree } from '../src/service/tree';
import { silentLogger, tempDir } from './helpers';

const GiB = 1024 ** 3;
const monitors: StorageMonitor[] = [];
afterEach(() => {
    for (const monitor of monitors.splice(0)) {
        monitor.dispose();
    }
});

function createMonitor(read: () => Storage | Promise<Storage>, options: { minGapMs?: number } = {}) {
    let fetches = 0;
    const changes: (Storage | undefined)[] = [];
    let freed = 0;
    const monitor = new StorageMonitor({
        fetch: async () => {
            fetches++;
            return read();
        },
        logger: silentLogger,
        onChange: (storage) => changes.push(storage),
        onSpaceFreed: () => freed++,
        intervalMs: 60_000,
        debounceMs: 0,
        minGapMs: options.minGapMs ?? 0,
    });
    monitors.push(monitor);
    const settle = async () => {
        await Bun.sleep(5);
        await monitor.settled();
    };
    return { monitor, changes, settle, fetches: () => fetches, freed: () => freed };
}

describe('driveStorageOf', () => {
    it('uses the Drive quota of split storage (free plans)', () => {
        expect(driveStorageOf({ UsedSpace: 600, MaxSpace: 1000, UsedDriveSpace: 100, MaxDriveSpace: 500 })).toEqual({
            used: 100,
            max: 500,
        });
    });

    it('uses the shared pool otherwise', () => {
        expect(driveStorageOf({ UsedSpace: 600, MaxSpace: 1000 })).toEqual({ used: 600, max: 1000 });
    });
});

describe('StorageMonitor', () => {
    it('reads the storage at start, reports changes only, and forgets it at stop', async () => {
        let storage = { used: 1, max: 10 };
        const ctx = createMonitor(() => storage);
        ctx.monitor.start();
        await ctx.settle();
        expect(ctx.monitor.get()).toEqual({ used: 1, max: 10 });

        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.fetches()).toBe(2);
        expect(ctx.changes).toEqual([{ used: 1, max: 10 }]);

        storage = { used: 4, max: 10 };
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.changes).toEqual([
            { used: 1, max: 10 },
            { used: 4, max: 10 },
        ]);

        ctx.monitor.stop();
        expect(ctx.monitor.get()).toBeUndefined();
        expect(ctx.changes.at(-1)).toBeUndefined();
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.fetches()).toBe(3);
    });

    it('makes one request for a burst of changes, at most once per period', async () => {
        const ctx = createMonitor(() => ({ used: 1, max: 10 }), { minGapMs: 60_000 });
        ctx.monitor.start();
        await ctx.settle();
        for (let i = 0; i < 5; i++) {
            ctx.monitor.changed();
        }
        await ctx.settle();
        expect(ctx.fetches()).toBe(1);
    });

    it('treats an account without a limit as unknown, and keeps the last value when a request fails', async () => {
        let answer: () => Storage = () => ({ used: 5, max: 0 });
        const ctx = createMonitor(() => answer());
        ctx.monitor.start();
        await ctx.settle();
        expect(ctx.monitor.get()).toBeUndefined();

        answer = () => ({ used: 5, max: 10 });
        ctx.monitor.changed();
        await ctx.settle();
        answer = () => {
            throw new Error('offline');
        };
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.monitor.get()).toEqual({ used: 5, max: 10 });
    });

    it('says when space was freed after Proton refused an upload', async () => {
        let storage = { used: 95, max: 100 };
        const ctx = createMonitor(() => storage);
        ctx.monitor.start();
        await ctx.settle();

        ctx.monitor.quotaExceeded();
        await ctx.settle();
        // Still the same space: the file did not fit, nothing to retry.
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.freed()).toBe(0);

        storage = { used: 50, max: 100 };
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.freed()).toBe(1);
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.freed()).toBe(1);
    });

    it('ignores an answer that arrives after a stop', async () => {
        const { promise, resolve } = Promise.withResolvers<Storage>();
        const ctx = createMonitor(() => promise);
        ctx.monitor.start();
        ctx.monitor.stop();
        resolve({ used: 1, max: 10 });
        await ctx.settle();
        expect(ctx.monitor.get()).toBeUndefined();
        expect(ctx.changes).toEqual([]);
    });
});

describe('quota errors', () => {
    it('maps Proton storage errors to QuotaExceeded', () => {
        for (const code of [200001, 200002, 200100]) {
            expect(toKationError(new ValidationError('Insufficient space', code)).code).toBe('QuotaExceeded');
        }
        expect(toKationError(new ValidationError('Bad name', 2001)).code).toBe('InvalidArgument');
    });

    it('tells the storage monitor when Proton refuses an upload', async () => {
        const fake = new FakeDrive({ maxStorage: 3 });
        const tree = new DriveTree(fake.sdk, silentLogger);
        let refused = 0;
        const drive = new DriveService(fake.sdk, tree, silentLogger, { onQuotaExceeded: () => refused++ });
        const file = path.join(await tempDir(), 'big.txt');
        await writeFile(file, 'too big');
        await expect(drive.upload(file, '/big.txt', false)).rejects.toMatchObject({ name: 'ValidationError', code: 200001 });
        expect(refused).toBe(1);
        fake.maxStorage = undefined;
        await drive.upload(file, '/big.txt', false);
        expect(refused).toBe(1);
        expect(fake.usedStorage()).toBe(7);
    });
});

describe('status', () => {
    it('reports the storage only while signed in', async () => {
        let storage: Storage | undefined = { used: GiB, max: 5 * GiB };
        const account = new FakeAccount(true, 0);
        const session = new Session(
            account,
            { appVersion: 'a', sdkVersion: 's', storageUrl: 'https://account.proton.me/drive/dashboard' },
            silentLogger,
            {
                storage: () => storage,
            },
        );
        await session.init();
        expect(session.status()).toMatchObject({
            storageUsed: GiB,
            storageMax: 5 * GiB,
            storageUrl: 'https://account.proton.me/drive/dashboard',
        });
        storage = undefined;
        expect(session.status()).toMatchObject({ storageUsed: -1, storageMax: -1 });
        storage = { used: 1, max: 2 };
        await account.logout();
        expect(session.status()).toMatchObject({ storageUsed: -1, storageMax: -1 });
    });

    it('formats the storage for the command line', () => {
        expect(formatStorage(1.5 * GiB, 5 * GiB)).toBe('Storage: 1.5 GiB of 5 GiB used (30%)');
        expect(formatStorage(512, 1024)).toBe('Storage: 512 B of 1 KiB used (50%)');
        expect(formatStorage(-1, -1)).toBe('');
    });
});
