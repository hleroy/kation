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

function createMonitor(read: () => Storage | Promise<Storage>, options: { minGapMs?: number; reserved?: () => number } = {}) {
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
        reserved: options.reserved,
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

    it('says when space was freed after an upload was refused before it started', async () => {
        let storage = { used: 40, max: 100 };
        let reserved = 50;
        const ctx = createMonitor(() => storage, { reserved: () => reserved });
        ctx.monitor.start();
        await ctx.settle();
        expect(ctx.monitor.latest()).toEqual({ free: 60, reading: 1 });
        expect(ctx.monitor.nextReading()).toBe(2);

        // 60 free, 50 of them held by uploads in progress: a 20-byte file was refused with 10 left.
        ctx.monitor.quotaExceeded(10);
        await ctx.settle();
        expect(ctx.fetches()).toBe(2);
        expect(ctx.freed()).toBe(0);
        // The uploads ended and Proton counts them: nothing more is free.
        storage = { used: 90, max: 100 };
        reserved = 0;
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.freed()).toBe(0);

        // A file is deleted.
        storage = { used: 60, max: 100 };
        ctx.monitor.changed();
        await ctx.settle();
        expect(ctx.freed()).toBe(1);
    });

    it('reads again for a new session while a request of the previous session is still in flight', async () => {
        const first = Promise.withResolvers<Storage>();
        let calls = 0;
        const ctx = createMonitor(() => (++calls === 1 ? first.promise : { used: 2, max: 10 }));
        ctx.monitor.start();
        ctx.monitor.stop();
        ctx.monitor.start();
        await ctx.settle();
        expect(ctx.monitor.get()).toEqual({ used: 2, max: 10 });
        first.resolve({ used: 1, max: 10 });
        await ctx.settle();
        expect(ctx.monitor.get()).toEqual({ used: 2, max: 10 });
    });

    it('reads again after a request that was in flight when something changed', async () => {
        const slow = Promise.withResolvers<Storage>();
        let calls = 0;
        const ctx = createMonitor(() => (++calls === 1 ? slow.promise : { used: 7, max: 10 }));
        ctx.monitor.start();
        ctx.monitor.changed();
        await Bun.sleep(5);
        slow.resolve({ used: 1, max: 10 });
        await ctx.settle();
        await ctx.settle();
        expect(ctx.fetches()).toBe(2);
        expect(ctx.monitor.get()).toEqual({ used: 7, max: 10 });
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

describe('storage reservation', () => {
    /** A DriveService with storage readings it is told about, and the uploads that reach the fake drive. */
    async function reservationSetup(options: { free: number | undefined; chunkDelayMs?: number }) {
        const fake = new FakeDrive({ chunkDelayMs: options.chunkDelayMs });
        let uploaders = 0;
        const getFileUploader = fake.sdk.getFileUploader;
        fake.sdk.getFileUploader = (...args) => {
            uploaders++;
            return getFileUploader(...args);
        };
        const readings = { free: options.free, reading: 1, started: 1, changed: 0 };
        const refusals: (number | undefined)[] = [];
        const drive = new DriveService(fake.sdk, new DriveTree(fake.sdk, silentLogger), silentLogger, {
            onQuotaExceeded: (available) => refusals.push(available),
            storage: {
                latest: () => ({ free: readings.free, reading: readings.reading }),
                nextReading: () => readings.started + 1,
                changed: () => readings.changed++,
            },
        });
        const dir = await tempDir();
        const file = async (name: string, size: number) => {
            const localPath = path.join(dir, name);
            await writeFile(localPath, 'x'.repeat(size));
            return localPath;
        };
        /** A reading that starts now and is applied at once. */
        const read = (free: number) => {
            readings.started++;
            readings.reading = readings.started;
            readings.free = free;
        };
        return { fake, drive, file, readings, read, refusals, uploaders: () => uploaders };
    }

    it('refuses an upload from Dolphin that does not fit, without contacting Proton', async () => {
        const ctx = await reservationSetup({ free: 10 });
        await expect(ctx.drive.upload(await ctx.file('big.txt', 11), '/big.txt', false)).rejects.toMatchObject({
            code: 'QuotaExceeded',
        });
        expect(ctx.uploaders()).toBe(0);
        expect(ctx.refusals).toEqual([10]);
        expect(ctx.drive.reservedBytes()).toBe(0);
        await ctx.drive.upload(await ctx.file('small.txt', 10), '/small.txt', false);
        expect(ctx.uploaders()).toBe(1);
    });

    it('counts uploads in progress, and those that ended until a reading started after them is applied', async () => {
        const ctx = await reservationSetup({ free: 100, chunkDelayMs: 30 });
        const first = ctx.drive.upload(await ctx.file('a.txt', 40), '/a.txt', false);
        const second = ctx.drive.upload(await ctx.file('b.txt', 40), '/b.txt', false);
        await Bun.sleep(5);
        expect(ctx.drive.reservedBytes()).toBe(80);
        await expect(ctx.drive.upload(await ctx.file('c.txt', 30), '/c.txt', false)).rejects.toMatchObject({ code: 'QuotaExceeded' });
        expect(ctx.refusals).toEqual([20]);
        await Promise.all([first, second]);
        expect(ctx.readings.changed).toBe(2);
        // Ended, but the latest reading started before: still held.
        expect(ctx.drive.reservedBytes()).toBe(80);
        ctx.read(20);
        expect(ctx.drive.reservedBytes()).toBe(0);
        await ctx.drive.upload(await ctx.file('d.txt', 20), '/d.txt', false);
    });

    it('also holds the whole size for a new version of a file', async () => {
        const ctx = await reservationSetup({ free: 100 });
        await ctx.drive.upload(await ctx.file('a.txt', 60), '/a.txt', false);
        ctx.read(40);
        await expect(ctx.drive.upload(await ctx.file('a2.txt', 50), '/a.txt', true)).rejects.toMatchObject({ code: 'QuotaExceeded' });
        expect(ctx.uploaders()).toBe(1);
    });

    it('releases what a failed or cancelled upload held', async () => {
        const ctx = await reservationSetup({ free: 100, chunkDelayMs: 20 });
        const controller = new AbortController();
        const aborted = ctx.drive.upload(await ctx.file('a.txt', 60), '/a.txt', false, { signal: controller.signal });
        await Bun.sleep(5);
        expect(ctx.drive.reservedBytes()).toBe(60);
        controller.abort();
        await expect(aborted).rejects.toMatchObject({ code: 'Cancelled' });
        expect(ctx.drive.reservedBytes()).toBe(0);

        ctx.fake.maxStorage = 10;
        await expect(ctx.drive.upload(await ctx.file('b.txt', 60), '/b.txt', false)).rejects.toMatchObject({ code: 200001 });
        expect(ctx.drive.reservedBytes()).toBe(0);
        expect(ctx.readings.changed).toBe(0);
    });

    it('does not check while the storage is unknown or unlimited', async () => {
        const ctx = await reservationSetup({ free: undefined });
        await ctx.drive.upload(await ctx.file('a.txt', 1000), '/a.txt', false);
        expect(ctx.refusals).toEqual([]);
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
