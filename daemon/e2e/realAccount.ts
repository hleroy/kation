#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * End-to-end tests against a real Proton test account, through the
 * installed, running kationd. See docs/e2e-test-plan.md.
 *
 *   cd daemon && bun e2e/realAccount.ts --expect-email you@proton.me
 *
 * Everything happens inside one new folder, /KationE2E-<timestamp>, in
 * "My files" and in the local sync folder. The run refuses to start unless
 * the signed-in account is the expected one.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { connectService, type ServiceClient, unwrap } from '../src/client';

const { values: options } = parseArgs({
    options: {
        'expect-email': { type: 'string' },
        'enable-sync': { type: 'boolean', default: false },
        'big-mb': { type: 'string', default: '150' },
        'remote-timeout': { type: 'string', default: '180' },
        only: { type: 'string' },
        skip: { type: 'string' },
        keep: { type: 'boolean', default: false },
        report: { type: 'string' },
        'fake-drive': { type: 'boolean', default: false },
    },
});

const LOCAL_TIMEOUT_MS = 90_000;
const REMOTE_TIMEOUT_MS = Number(options['remote-timeout']) * 1000;
const BIG_BYTES = Math.round(Number(options['big-mb']) * 1024 * 1024);
const only = options.only?.split(',').map((id) => id.trim().toUpperCase());
const skipped = new Set(options.skip?.split(',').map((id) => id.trim().toUpperCase()) ?? []);

type Result = { id: string; title: string; status: 'pass' | 'fail' | 'skip'; details: string; seconds: number };
const results: Result[] = [];

class Skip extends Error {}

// ---------------------------------------------------------------- helpers

let svc: ServiceClient;
let syncRoot = '';
let remoteDir = '';
let tmp = '';
let logFile = '';
let trashFiles = '';

function log(message: string): void {
    console.log(`  ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return (await svc.call(method, ...args)) as T;
}

async function status() {
    return unwrap(await call('GetStatus'));
}

async function syncStatus() {
    return unwrap(await call('GetSyncStatus'));
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await check().catch(() => false)) {
            return (Date.now() - start) / 1000;
        }
        await Bun.sleep(intervalMs);
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for: ${what}`);
}

async function waitIdle(timeoutMs = REMOTE_TIMEOUT_MS): Promise<void> {
    // Give the watcher and the debounce a moment to register recent changes.
    await Bun.sleep(3000);
    await waitFor(
        'sync to be idle',
        async () => {
            const s = await syncStatus();
            return s.state === 'idle' && s.pending === 0;
        },
        timeoutMs,
    );
}

function local(relative: string): string {
    return path.join(syncRoot, remoteDir.slice(1), relative);
}

function remote(relative: string): string {
    return relative ? `${remoteDir}/${relative}` : remoteDir;
}

async function remoteNames(drivePath: string): Promise<string[] | null> {
    try {
        const entries = (await call<unknown[]>('List', drivePath)).map((entry) => unwrap(entry));
        return entries.map((entry) => String(entry.name)).sort();
    } catch (error: unknown) {
        if (String(error).includes('Not found')) {
            return null;
        }
        throw error;
    }
}

async function remoteExists(drivePath: string): Promise<boolean> {
    const parent = drivePath.slice(0, drivePath.lastIndexOf('/')) || '/';
    const names = await remoteNames(parent);
    return !!names?.includes(drivePath.slice(drivePath.lastIndexOf('/') + 1));
}

async function remoteContent(drivePath: string): Promise<Buffer> {
    const target = path.join(tmp, `download-${crypto.randomUUID()}`);
    await call('Download', drivePath, target, crypto.randomUUID());
    const content = await readFile(target);
    await rm(target, { force: true });
    return content;
}

async function remoteUpload(drivePath: string, content: string | Buffer, overwrite = false): Promise<void> {
    const source = path.join(tmp, `upload-${crypto.randomUUID()}`);
    await writeFile(source, content);
    await call('Upload', source, drivePath, overwrite, crypto.randomUUID());
    await rm(source, { force: true });
}

async function localContent(file: string): Promise<string | null> {
    return readFile(file, 'utf8').catch(() => null);
}

async function logSize(): Promise<number> {
    return (await stat(logFile).catch(() => ({ size: 0 }))).size;
}

async function logSince(offset: number): Promise<string> {
    const content = await readFile(logFile).catch(() => Buffer.alloc(0));
    return content.subarray(offset).toString('utf8');
}

async function trashed(name: string): Promise<boolean> {
    return (await readdir(trashFiles).catch(() => [] as string[])).some((entry) => entry === name || entry.startsWith(`${name}.`));
}

function sha256(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex');
}

// biome-ignore lint/suspicious/noConfusingVoidType: a step returns its details, or nothing.
async function step(id: string, title: string, run: () => Promise<string | void>): Promise<void> {
    if ((only && !only.includes(id)) || skipped.has(id)) {
        results.push({ id, title, status: 'skip', details: 'not selected', seconds: 0 });
        return;
    }
    console.log(`\n${id} ${title}`);
    const start = Date.now();
    try {
        const details = (await run()) ?? '';
        const seconds = (Date.now() - start) / 1000;
        results.push({ id, title, status: 'pass', details, seconds });
        console.log(`  PASS (${seconds.toFixed(1)} s)${details ? ` ${details}` : ''}`);
    } catch (error: unknown) {
        const seconds = (Date.now() - start) / 1000;
        const skip = error instanceof Skip;
        const details = error instanceof Error ? error.message : String(error);
        results.push({ id, title, status: skip ? 'skip' : 'fail', details, seconds });
        console.log(`  ${skip ? 'SKIP' : 'FAIL'} (${seconds.toFixed(1)} s): ${details}`);
        if (!skip) {
            // Leave a known state for the next test.
            await call('SetSyncPaused', false).catch(() => {});
            await waitIdle().catch(() => {});
        }
    }
}

// ---------------------------------------------------------------- scenarios

async function preflight(): Promise<void> {
    const service = await connectService();
    if (!service) {
        throw new Error('The Kation service is not available. Is Kation installed (sudo cmake --install build)?');
    }
    svc = service;
    const account = await status();
    assert(account.loggedIn, 'Not signed in. Sign in with the Kation window first.');
    if (options['fake-drive']) {
        assert(account.email === 'tester@example.com', '--fake-drive only works against `kationd serve --fake-drive`');
    } else {
        assert(options['expect-email'], 'Pass --expect-email with the test account address.');
        assert(
            String(account.email).toLowerCase() === options['expect-email']!.toLowerCase(),
            `Signed in as ${account.email}, not ${options['expect-email']}: refusing to run on another account.`,
        );
    }
    let sync = await syncStatus();
    if (!sync.enabled) {
        assert(options['enable-sync'], 'Folder sync is off. Turn it on in the Kation window, or pass --enable-sync.');
        await call('SetSyncEnabled', true);
    }
    if (sync.paused) {
        await call('SetSyncPaused', false);
    }
    await waitIdle(10 * 60 * 1000);
    sync = await syncStatus();
    syncRoot = String(sync.folder);
    assert(existsSync(syncRoot), `Sync folder ${syncRoot} does not exist`);

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    remoteDir = `/KationE2E-${stamp}`;
    tmp = await mkdtemp(path.join(os.tmpdir(), 'kation-e2e-'));
    const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    logFile = path.join(stateHome, 'kation', 'kationd.log');
    trashFiles = path.join(dataHome, 'Trash', 'files');
    console.log(`Account ${account.email}, kationd ${account.appVersion}`);
    console.log(`Sync folder ${syncRoot}, test folder ${remoteDir}`);

    // The test folder exists on both sides before any test, so each test can run alone (--only).
    await mkdir(local(''), { recursive: true });
    await waitFor('the test folder on Proton', () => remoteExists(remoteDir), LOCAL_TIMEOUT_MS);
    await waitIdle();
}

async function main(): Promise<number> {
    await preflight();

    await step('E2E-01', 'Command line answers through the service', async () => {
        const kationd = Bun.which('kationd');
        if (!kationd) {
            throw new Skip('kationd is not on PATH');
        }
        const run = (args: string[]) => Bun.spawnSync([kationd, ...args], { stdout: 'pipe', stderr: 'pipe' });
        const statusOut = run(['status', '--json']);
        assert(statusOut.exitCode === 0, `kationd status failed: ${statusOut.stderr}`);
        assert(JSON.parse(statusOut.stdout.toString()).loggedIn === true, 'kationd status does not say signed in');
        const syncOut = run(['sync', '--json']);
        assert(syncOut.exitCode === 0, `kationd sync failed: ${syncOut.stderr}`);
        assert(JSON.parse(syncOut.stdout.toString()).enabled === true, 'kationd sync does not say enabled');
    });

    await step('E2E-02', 'Local folder and file reach Proton', async () => {
        await mkdir(local('Docs'), { recursive: true });
        await writeFile(local('Docs/hello.txt'), 'hello from disk');
        const seconds = await waitFor('Docs/hello.txt on Proton', () => remoteExists(remote('Docs/hello.txt')), LOCAL_TIMEOUT_MS);
        assert((await remoteContent(remote('Docs/hello.txt'))).toString() === 'hello from disk', 'remote content differs');
        return `after ${seconds.toFixed(0)} s`;
    });

    await step('E2E-03', 'File created on Proton appears locally', async () => {
        await remoteUpload(remote('from-proton.txt'), 'hello from proton');
        const seconds = await waitFor(
            'from-proton.txt locally',
            async () => (await localContent(local('from-proton.txt'))) === 'hello from proton',
            REMOTE_TIMEOUT_MS,
        );
        return `after ${seconds.toFixed(0)} s (Drive events)`;
    });

    await step('E2E-04', 'Local edit becomes a new version on Proton', async () => {
        await waitIdle();
        await writeFile(local('Docs/hello.txt'), 'edited on disk');
        await waitFor(
            'the edit on Proton',
            async () => (await remoteContent(remote('Docs/hello.txt'))).toString() === 'edited on disk',
            LOCAL_TIMEOUT_MS,
            3000,
        );
    });

    await step('E2E-05', 'Edit on Proton updates the local file', async () => {
        await waitIdle();
        await remoteUpload(remote('from-proton.txt'), 'edited on proton', true);
        const seconds = await waitFor(
            'the edit locally',
            async () => (await localContent(local('from-proton.txt'))) === 'edited on proton',
            REMOTE_TIMEOUT_MS,
        );
        return `after ${seconds.toFixed(0)} s`;
    });

    await step('E2E-06', 'Local deletion goes to the Proton trash', async () => {
        await waitIdle();
        await rm(local('Docs/hello.txt'));
        await waitFor('Docs/hello.txt gone from Proton', async () => !(await remoteExists(remote('Docs/hello.txt'))), LOCAL_TIMEOUT_MS);
        return 'check it is in the web app trash during the manual review';
    });

    await step('E2E-07', 'Deletion on Proton goes to the desktop Trash', async () => {
        await waitIdle();
        await call('Trash', remote('from-proton.txt'));
        await waitFor('from-proton.txt gone locally', async () => !existsSync(local('from-proton.txt')), REMOTE_TIMEOUT_MS);
        assert(await trashed('from-proton.txt'), `from-proton.txt is not in ${trashFiles}`);
    });

    await step('E2E-08', 'Pause holds local changes; resume sends them', async () => {
        await waitIdle();
        await call('SetSyncPaused', true);
        await waitFor('paused state', async () => (await syncStatus()).state === 'paused', 10_000);
        await writeFile(local('while-paused.txt'), 'written while paused');
        await Bun.sleep(30_000);
        assert(!(await remoteExists(remote('while-paused.txt'))), 'uploaded while sync was paused');
        await call('SetSyncPaused', false);
        await waitFor('while-paused.txt on Proton after resume', () => remoteExists(remote('while-paused.txt')), LOCAL_TIMEOUT_MS);
    });

    await step('E2E-09', 'Conflict while paused keeps both versions', async () => {
        await writeFile(local('notes.txt'), 'base');
        await waitFor('notes.txt on Proton', () => remoteExists(remote('notes.txt')), LOCAL_TIMEOUT_MS);
        await waitIdle();
        await call('SetSyncPaused', true);
        await waitFor('paused state', async () => (await syncStatus()).state === 'paused', 10_000);
        await writeFile(local('notes.txt'), 'local edit');
        await remoteUpload(remote('notes.txt'), 'remote edit', true);
        await Bun.sleep(5000);
        await call('SetSyncPaused', false);
        await waitFor(
            'a conflict copy locally and on Proton',
            async () => {
                const names = await remoteNames(remoteDir);
                return !!names?.some((name) => name.startsWith('notes (conflict '));
            },
            REMOTE_TIMEOUT_MS,
            3000,
        );
        await waitIdle();
        assert((await localContent(local('notes.txt'))) === 'remote edit', 'notes.txt should hold the Proton version');
        const copy = (await readdir(local(''))).find((name) => name.startsWith('notes (conflict '));
        assert(copy, 'no local conflict copy');
        assert((await localContent(local(copy))) === 'local edit', 'the conflict copy should hold the local version');
        return copy;
    });

    await step('E2E-10', 'Folder deleted on Proton keeps locally changed files', async () => {
        await mkdir(local('Project'), { recursive: true });
        await writeFile(local('Project/old.txt'), 'old');
        await writeFile(local('Project/draft.txt'), 'draft');
        await waitFor('Project files on Proton', async () => (await remoteNames(remote('Project')))?.length === 2, LOCAL_TIMEOUT_MS);
        await waitIdle();
        await call('SetSyncPaused', true);
        await waitFor('paused state', async () => (await syncStatus()).state === 'paused', 10_000);
        await Bun.sleep(2500);
        await writeFile(local('Project/draft.txt'), 'draft v2');
        await call('Trash', remote('Project'));
        await call('SetSyncPaused', false);
        await waitFor(
            'Project recreated on Proton with only draft.txt',
            async () => JSON.stringify(await remoteNames(remote('Project'))) === JSON.stringify(['draft.txt']),
            REMOTE_TIMEOUT_MS,
            3000,
        );
        await waitIdle();
        assert(!existsSync(local('Project/old.txt')), 'old.txt should have followed the deletion');
        assert((await remoteContent(remote('Project/draft.txt'))).toString() === 'draft v2', 'draft.txt should be the local version');
    });

    await step('E2E-11', 'Folder deleted locally is trashed on Proton', async () => {
        await mkdir(local('Old'), { recursive: true });
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
            await writeFile(local(`Old/${name}`), name);
        }
        await waitFor('Old on Proton', async () => (await remoteNames(remote('Old')))?.length === 3, LOCAL_TIMEOUT_MS);
        await waitIdle();
        await rm(local('Old'), { recursive: true });
        await waitFor('Old gone from Proton', async () => !(await remoteExists(remote('Old'))), LOCAL_TIMEOUT_MS);
    });

    await step('E2E-12', 'Renamed sync folder pauses sync and resumes when restored', async () => {
        await waitIdle();
        const before = await remoteNames(remoteDir);
        const moved = `${syncRoot}.e2e-renamed`;
        await rename(syncRoot, moved);
        try {
            await waitFor(
                'paused because the folder is missing',
                async () => {
                    const s = await syncStatus();
                    return s.state === 'paused' && String(s.message).includes('missing');
                },
                30_000,
            );
            await Bun.sleep(5000);
            assert(
                JSON.stringify(await remoteNames(remoteDir)) === JSON.stringify(before),
                'files changed on Proton while the folder was missing',
            );
        } finally {
            await rename(moved, syncRoot);
        }
        await waitFor('sync resumed by itself', async () => (await syncStatus()).state !== 'paused', 30_000);
        await waitIdle();
        await writeFile(local('after-restore.txt'), 'watcher works');
        await waitFor('after-restore.txt on Proton', () => remoteExists(remote('after-restore.txt')), LOCAL_TIMEOUT_MS);
    });

    await step('E2E-13', 'Excluded folder: no sync, safe to delete locally, comes back when included', async () => {
        await mkdir(local('Excl'), { recursive: true });
        await writeFile(local('Excl/keep.txt'), 'keep me');
        await waitFor('Excl on Proton', () => remoteExists(remote('Excl/keep.txt')), LOCAL_TIMEOUT_MS);
        await waitIdle();
        const folder = remote('Excl');
        await call('SetExcludedFolders', [folder]);
        await remoteUpload(remote('Excl/added-while-excluded.txt'), 'remote only');
        await Bun.sleep(45_000);
        assert(!existsSync(local('Excl/added-while-excluded.txt')), 'a file in an excluded folder was downloaded');
        await rm(local('Excl'), { recursive: true });
        await Bun.sleep(10_000);
        assert(await remoteExists(remote('Excl/keep.txt')), 'deleting the local copy of an excluded folder deleted it on Proton');
        await call('SetExcludedFolders', []);
        await waitFor(
            'Excl downloaded again',
            async () => existsSync(local('Excl/keep.txt')) && existsSync(local('Excl/added-while-excluded.txt')),
            REMOTE_TIMEOUT_MS,
        );
        assert(await remoteExists(remote('Excl/keep.txt')), 'Excl/keep.txt missing on Proton');
    });

    await step('E2E-14', 'Interrupted download continues instead of restarting', async () => {
        await waitIdle();
        const offset = await logSize();
        const content = randomBytes(BIG_BYTES);
        log(`uploading ${(BIG_BYTES / 1024 / 1024).toFixed(0)} MB to Proton`);
        await remoteUpload(remote('big.bin'), content);
        await waitFor(
            'the download of big.bin to start',
            async () => String((await syncStatus()).current) === remote('big.bin'),
            REMOTE_TIMEOUT_MS,
            200,
        );
        await Bun.sleep(500);
        await call('SetSyncPaused', true);
        await waitFor('paused state', async () => (await syncStatus()).state === 'paused', 15_000);
        const parts = (await readdir(local(''))).filter((name) => name.startsWith('.big.bin.') && name.endsWith('.kation-part'));
        const partSize = parts[0] ? (await stat(local(parts[0]))).size : 0;
        if (partSize === 0) {
            await call('SetSyncPaused', false);
            throw new Skip(
                `the download finished (or had not written anything) when paused; rerun with a larger --big-mb (now ${options['big-mb']})`,
            );
        }
        log(`paused with ${(partSize / 1024 / 1024).toFixed(1)} MB downloaded`);
        await Bun.sleep(3000);
        await call('SetSyncPaused', false);
        await waitFor('big.bin complete locally', async () => existsSync(local('big.bin')), REMOTE_TIMEOUT_MS * 2);
        assert(sha256(await readFile(local('big.bin'))) === sha256(content), 'big.bin differs from the upload');
        const newLog = await logSince(offset);
        assert(newLog.includes('Resuming download'), 'no "Resuming download" in the log: the download restarted from zero');
        assert(!newLog.includes('failed the checksum'), 'the resumed file failed the checksum');
        assert(
            (await readdir(local(''))).every((name) => !name.endsWith('.kation-part')),
            'a partial file was left behind',
        );
    });

    await step('E2E-15', 'Mass deletion pauses sync until resumed', async () => {
        const count = 105;
        await mkdir(local('Mass'), { recursive: true });
        for (let i = 0; i < count; i++) {
            await writeFile(local(`Mass/file-${String(i).padStart(3, '0')}.txt`), `file ${i}`);
        }
        await waitFor(`${count} files on Proton`, async () => (await remoteNames(remote('Mass')))?.length === count, 10 * 60_000, 5000);
        await waitIdle();
        for (let i = 0; i < count; i++) {
            await rm(local(`Mass/file-${String(i).padStart(3, '0')}.txt`));
        }
        await waitFor(
            'the deletion safety pause',
            async () => {
                const s = await syncStatus();
                return s.state === 'paused' && String(s.message).includes('deleted at once');
            },
            5 * 60_000,
            2000,
        );
        const left = (await remoteNames(remote('Mass')))?.length ?? 0;
        assert(left > 0, 'all files were deleted on Proton despite the safety pause');
        await call('SetSyncPaused', false);
        await waitFor('all files trashed after resuming', async () => (await remoteNames(remote('Mass')))?.length === 0, 5 * 60_000, 5000);
        return `${count - left} trashed before the pause, the rest after resuming`;
    });

    await step('E2E-16', 'Online view (KIO operations through D-Bus)', async () => {
        await call('CreateFolder', remote('Online'));
        await remoteUpload(remote('Online/kio.txt'), 'via online view');
        const entry = unwrap(await call('Stat', remote('Online/kio.txt')));
        assert(entry.type === 'file' && entry.size === 15 && entry.mimeType === 'text/plain', `unexpected Stat: ${JSON.stringify(entry)}`);
        await call('Move', remote('Online/kio.txt'), remote('Online/renamed.txt'), false);
        assert(JSON.stringify(await remoteNames(remote('Online'))) === '["renamed.txt"]', 'rename failed');
        assert((await remoteContent(remote('Online/renamed.txt'))).toString() === 'via online view', 'content changed');
        await waitFor('Online/renamed.txt synced locally', async () => existsSync(local('Online/renamed.txt')), REMOTE_TIMEOUT_MS);
        const kioclient = Bun.which('kioclient') ?? Bun.which('kioclient6');
        if (kioclient) {
            const out = Bun.spawnSync([kioclient, 'ls', `protondrive:${remote('Online')}`], { stdout: 'pipe', stderr: 'pipe' });
            assert(out.stdout.toString().includes('renamed.txt'), `kioclient ls did not list the file: ${out.stderr}`);
            return 'also checked with kioclient';
        }
        return 'kioclient not installed: KIO itself checked in the manual steps';
    });

    await step('E2E-19', 'Recent activity lists what sync did', async () => {
        await mkdir(local('Activity'), { recursive: true });
        await writeFile(local('Activity/a.txt'), 'activity');
        await waitFor('Activity/a.txt on Proton', () => remoteExists(remote('Activity/a.txt')), LOCAL_TIMEOUT_MS);
        await waitIdle();
        const activity = (await call<unknown[]>('GetRecentActivity')).map(unwrap);
        const mine = activity.filter((item) => String(item.path).startsWith(remoteDir));
        assert(
            mine.some(
                (item) => item.kind === 'uploaded' && item.path === remote('Activity/a.txt') && item.localPath === local('Activity/a.txt'),
            ),
            `no upload of Activity/a.txt in the activity: ${JSON.stringify(mine.slice(0, 5))}`,
        );
        const kinds = [...new Set(mine.map((item) => String(item.kind)))].sort();
        return `kinds seen in this run: ${kinds.join(', ')}`;
    });

    await step('E2E-20', 'Sync states for file manager emblems', async () => {
        const states = async (...paths: string[]) => unwrap(await call('GetItemStates', paths));
        const synced = await states(local('Activity/a.txt'), local(''), '/etc/hosts');
        assert(synced[local('Activity/a.txt')] === 'synced', `a.txt is ${synced[local('Activity/a.txt')]}, expected synced`);
        assert(synced['/etc/hosts'] === '', 'a file outside the sync folder has a state');
        await call('SetSyncPaused', true);
        try {
            await writeFile(local('Activity/b.txt'), 'waiting');
            const waiting = await states(local('Activity/b.txt'));
            assert(waiting[local('Activity/b.txt')] === 'paused', `b.txt is ${waiting[local('Activity/b.txt')]}, expected paused`);
        } finally {
            await call('SetSyncPaused', false);
        }
        await waitFor(
            'b.txt synced after resuming',
            async () => (await states(local('Activity/b.txt')))[local('Activity/b.txt')] === 'synced',
            LOCAL_TIMEOUT_MS,
        );
    });

    await step('E2E-21', 'Public link and web address of a file', async () => {
        const url = `protondrive:${remote('Activity/a.txt')}`;
        assert((await call<string>('GetShareLink', url, false)) === '', 'the new file already has a public link');
        const link = await call<string>('GetShareLink', url, true);
        assert(link.startsWith('https://drive.proton.me/'), `unexpected link: ${link.slice(0, 40)}…`);
        assert((await call<string>('GetShareLink', url, false)) === link, 'the link changed when read again');
        const viaLocal = await call<string>('GetShareLink', pathToFileURL(local('Activity/a.txt')).href, false);
        assert(viaLocal === link, 'the link differs when asked with the local path');
        const webUrl = await call<string>('GetWebUrl', url);
        assert(webUrl.startsWith('https://drive.proton.me/'), `unexpected web address: ${webUrl}`);
        return 'the link stops working when the test folder is trashed at the end';
    });

    await step('E2E-22', 'Download speed limit', async () => {
        const before = await syncStatus();
        const size = 2 * 1024 * 1024;
        await remoteUpload(remote('Activity/limit.bin'), Buffer.alloc(size, 7));
        await call('SetBandwidthLimits', Number(before.uploadLimit ?? 0), 512);
        try {
            const started = Date.now();
            const content = await remoteContent(remote('Activity/limit.bin'));
            const seconds = (Date.now() - started) / 1000;
            assert(content.length === size, `downloaded ${content.length} bytes, expected ${size}`);
            // 2048 KiB at 512 KiB/s: about 4 s (half a second of burst allowed).
            assert(seconds >= 3, `2 MiB took ${seconds.toFixed(1)} s with a 512 KiB/s limit`);
            return `2 MiB in ${seconds.toFixed(1)} s at 512 KiB/s`;
        } finally {
            await call('SetBandwidthLimits', Number(before.uploadLimit ?? 0), Number(before.downloadLimit ?? 0));
        }
    });

    await step('E2E-23', 'A local rename and move keep the file on Proton', async () => {
        await waitIdle();
        const link = await call<string>('GetShareLink', `protondrive:${remote('Activity/a.txt')}`, true);
        const offset = await logSize();
        await mkdir(local('Moved'), { recursive: true });
        await rename(local('Activity/a.txt'), local('Moved/renamed.txt'));
        await waitFor('Moved/renamed.txt on Proton', () => remoteExists(remote('Moved/renamed.txt')), LOCAL_TIMEOUT_MS);
        await waitFor('Activity/a.txt gone from Proton', async () => !(await remoteExists(remote('Activity/a.txt'))), LOCAL_TIMEOUT_MS);
        await waitIdle();
        const after = await call<string>('GetShareLink', `protondrive:${remote('Moved/renamed.txt')}`, false);
        assert(after === link, 'the public link did not follow the file: it was uploaded as a new file');
        const logged = await logSince(offset);
        assert(!logged.includes(`Uploading ${remote('Moved/renamed.txt')}`), 'the renamed file was uploaded again');
    });

    await step('E2E-24', 'A rename on Proton renames the local file', async () => {
        await waitIdle();
        const inode = (await stat(local('Moved/renamed.txt'))).ino;
        const offset = await logSize();
        await call('Move', remote('Moved/renamed.txt'), remote('Moved/from-proton.txt'), false);
        await waitFor('Moved/from-proton.txt locally', async () => existsSync(local('Moved/from-proton.txt')), REMOTE_TIMEOUT_MS);
        await waitIdle();
        assert(!existsSync(local('Moved/renamed.txt')), 'the old name is still there');
        assert((await stat(local('Moved/from-proton.txt'))).ino === inode, 'the local file was replaced, not renamed');
        assert(!(await trashed('renamed.txt')), 'the local file went to the desktop Trash');
        const logged = await logSince(offset);
        assert(!logged.includes(`Downloading ${remote('Moved/from-proton.txt')}`), 'the renamed file was downloaded again');
    });

    await step('E2E-17', 'Starts with the session (systemd user unit enabled and active)', async () => {
        if (options['fake-drive']) {
            throw new Skip('not applicable to the fake drive');
        }
        const enabled = Bun.spawnSync(['systemctl', '--user', 'is-enabled', 'kationd.service'], { stdout: 'pipe' })
            .stdout.toString()
            .trim();
        const active = Bun.spawnSync(['systemctl', '--user', 'is-active', 'kationd.service'], { stdout: 'pipe' }).stdout.toString().trim();
        assert(enabled === 'enabled', `kationd.service is ${enabled || 'unknown'}, expected enabled (turn sync off and on once)`);
        assert(active === 'active', `kationd.service is ${active || 'unknown'}, expected active`);
    });

    await step('E2E-18', 'No sync errors in the log during the run', async () => {
        const content = await readFile(logFile, 'utf8').catch(() => '');
        const errors = content
            .split('\n')
            .filter((line) => !line.startsWith('{') && /ERROR/.test(line) && line >= `${runStartedAt}`)
            .filter((line) => !line.includes('/events/'));
        assert(errors.length === 0, `${errors.length} error line(s), first: ${errors[0]?.slice(0, 300)}`);
    });

    if (!options.keep) {
        console.log(`\nCleaning up ${remoteDir}`);
        await call('SetSyncPaused', false).catch(() => {});
        await call('SetExcludedFolders', []).catch(() => {});
        await call('Trash', remoteDir).catch((error: unknown) => log(`could not trash ${remoteDir}: ${error}`));
        await waitFor('the test folder gone locally', async () => !existsSync(local('')), REMOTE_TIMEOUT_MS).catch(() =>
            log(`${local('')} is still there; delete it by hand`),
        );
    }
    await rm(tmp, { recursive: true, force: true });
    return writeReport();
}

const runStartedAt = new Date().toISOString();

async function writeReport(): Promise<number> {
    const failed = results.filter((result) => result.status === 'fail');
    const lines = [
        `# Kation end-to-end report`,
        '',
        `- Started: ${runStartedAt}`,
        `- Test folder: ${remoteDir} (${options.keep ? 'kept' : 'moved to the Proton trash'})`,
        `- Result: ${results.filter((r) => r.status === 'pass').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'skip').length} skipped`,
        '',
        '| Test | Result | Time | Details |',
        '|---|---|---|---|',
        ...results.map(
            (r) => `| ${r.id} ${r.title} | ${r.status.toUpperCase()} | ${r.seconds.toFixed(0)} s | ${r.details.replace(/\|/g, '\\|')} |`,
        ),
        '',
    ];
    const reportPath = options.report ?? path.resolve(import.meta.dir, '..', '..', 'build', 'e2e-report.md');
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, lines.join('\n'));
    console.log(`\n${lines.slice(4, 5).join('')}\nReport: ${reportPath}`);
    return failed.length === 0 ? 0 : 1;
}

try {
    process.exit(await main());
} catch (error: unknown) {
    console.error(`\nE2E run aborted: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
}
