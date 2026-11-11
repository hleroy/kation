// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    conflictName,
    isIgnoredName,
    isLinkOrSpecial,
    moveToTopDirTrash,
    moveToTrash,
    removeResumableParts,
    scanFolder,
} from '../src/sync/local';
import { childPath, nameOf, parentOf, SyncState } from '../src/sync/state';
import { tempDir } from './helpers';

describe('local helpers', () => {
    it('ignores temporary, lock and system files', () => {
        for (const name of [
            'a.kation-part',
            'x.part',
            '.~lock.doc.odt#',
            'notes.txt~',
            '.directory',
            '.kation-sync',
            '.goutputstream-AB12',
        ]) {
            expect(isIgnoredName(name)).toBe(true);
        }
        for (const name of ['report.pdf', '.bashrc', 'part', 'tmp']) {
            expect(isIgnoredName(name)).toBe(false);
        }
    });

    it('scans files and folders, skipping links and ignored names', async () => {
        const dir = await tempDir();
        await writeFile(path.join(dir, 'a.txt'), 'abc');
        await mkdir(path.join(dir, 'sub'));
        await writeFile(path.join(dir, 'b.kation-part'), 'x');
        await symlink(path.join(dir, 'a.txt'), path.join(dir, 'link'));
        const items = await scanFolder(dir);
        expect([...items.keys()].sort()).toEqual(['a.txt', 'sub']);
        expect(items.get('a.txt')).toMatchObject({ type: 'file', size: 3 });
        expect(items.get('sub')).toMatchObject({ type: 'folder' });
        expect((await scanFolder(path.join(dir, 'missing'))).size).toBe(0);
    });

    it('tells symbolic links from files, folders and missing paths', async () => {
        const dir = await tempDir();
        await writeFile(path.join(dir, 'a.txt'), 'abc');
        await mkdir(path.join(dir, 'sub'));
        await symlink(path.join(dir, 'sub'), path.join(dir, 'link'));
        expect(await isLinkOrSpecial(path.join(dir, 'link'))).toBe(true);
        expect(await isLinkOrSpecial(path.join(dir, 'a.txt'))).toBe(false);
        expect(await isLinkOrSpecial(path.join(dir, 'sub'))).toBe(false);
        expect(await isLinkOrSpecial(path.join(dir, 'missing'))).toBe(false);
        expect(await isLinkOrSpecial(path.join(dir, 'a.txt', 'below'))).toBe(false);
    });

    it('moves items to the freedesktop trash with restore information', async () => {
        const home = await tempDir();
        const dir = await tempDir();
        const file = path.join(dir, 'my file.txt');
        await writeFile(file, 'x');
        await moveToTrash(file, home);
        await writeFile(file, 'y');
        await moveToTrash(file, home);
        expect((await readdir(path.join(home, 'Trash', 'files'))).sort()).toEqual(['my file.txt', 'my file.txt.1']);
        const info = await readFile(path.join(home, 'Trash', 'info', 'my file.txt.trashinfo'), 'utf8');
        expect(info).toContain(`Path=${dir.split('/').map(encodeURIComponent).join('/')}/my%20file.txt`);
        expect(info).toMatch(/DeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    });

    describe('trash on another disk', () => {
        const trashName = `.Trash-${process.getuid!()}`;

        it('creates a private trash folder and moves the item into it', async () => {
            const topDir = await tempDir();
            const file = path.join(topDir, 'sub', 'a.txt');
            await mkdir(path.dirname(file));
            await writeFile(file, 'x');
            await moveToTopDirTrash(file, topDir);
            const trash = path.join(topDir, trashName);
            for (const folder of [trash, path.join(trash, 'files'), path.join(trash, 'info')]) {
                expect((await stat(folder)).mode & 0o777).toBe(0o700);
            }
            expect(await readdir(path.join(trash, 'files'))).toEqual(['a.txt']);
            expect(await readFile(path.join(trash, 'info', 'a.txt.trashinfo'), 'utf8')).toContain('Path=sub/a.txt');
        });

        it('refuses a trash folder that is a symbolic link', async () => {
            const topDir = await tempDir();
            const elsewhere = await tempDir();
            await chmod(elsewhere, 0o700);
            await symlink(elsewhere, path.join(topDir, trashName));
            const file = path.join(topDir, 'a.txt');
            await writeFile(file, 'x');
            await expect(moveToTopDirTrash(file, topDir)).rejects.toThrow('cannot be trusted');
            expect(await readFile(file, 'utf8')).toBe('x');
            expect(await readdir(elsewhere)).toEqual([]);
        });

        it('refuses a trash folder that others can write to', async () => {
            const topDir = await tempDir();
            const trash = path.join(topDir, trashName);
            await mkdir(trash);
            await chmod(trash, 0o777);
            const file = path.join(topDir, 'a.txt');
            await writeFile(file, 'x');
            await expect(moveToTopDirTrash(file, topDir)).rejects.toThrow('cannot be trusted');
            expect(await readFile(file, 'utf8')).toBe('x');
            expect(await readdir(trash)).toEqual([]);
        });

        it('refuses a files folder that is a symbolic link', async () => {
            const topDir = await tempDir();
            const trash = path.join(topDir, trashName);
            await mkdir(trash, { mode: 0o700 });
            const elsewhere = await tempDir();
            await symlink(elsewhere, path.join(trash, 'files'));
            const file = path.join(topDir, 'a.txt');
            await writeFile(file, 'x');
            await expect(moveToTopDirTrash(file, topDir)).rejects.toThrow('cannot be trusted');
            expect((await lstat(file)).isFile()).toBe(true);
            expect(await readdir(elsewhere)).toEqual([]);
        });
    });

    it('deletes resumable partial downloads, and only those', async () => {
        const root = await tempDir();
        await mkdir(path.join(root, 'Docs', 'Deep'), { recursive: true });
        await mkdir(path.join(root, 'Videos'));
        const parts = [
            path.join(root, '.a.txt.0123abcd.kation-part'),
            path.join(root, 'Docs', 'Deep', '.b c.pdf.deadbeef.kation-part'),
            // The form used when the name is too long for the other one.
            path.join(root, 'Docs', '.kation-0123456789abcdef.0123abcd.kation-part'),
        ];
        for (const part of parts) {
            await writeFile(part, 'partial');
        }
        const kept = [
            path.join(root, 'a.txt'),
            path.join(root, 'report.kation-part'),
            path.join(root, '.a.txt.nothex12.kation-part'),
            path.join(root, 'Videos', '.v.mp4.0123abcd.kation-part'),
        ];
        for (const file of kept) {
            await writeFile(file, 'keep');
        }
        const outside = path.join(await tempDir(), 'target');
        await writeFile(outside, 'keep');
        await symlink(outside, path.join(root, 'Docs', '.l.txt.0123abcd.kation-part'));
        await symlink(path.dirname(outside), path.join(root, 'Docs', 'linked'));

        await removeResumableParts(root, ['/Videos']);
        for (const part of parts) {
            expect(await Bun.file(part).exists()).toBe(false);
        }
        for (const file of kept) {
            expect(await readFile(file, 'utf8')).toBe('keep');
        }
        expect((await lstat(path.join(root, 'Docs', '.l.txt.0123abcd.kation-part'))).isSymbolicLink()).toBe(true);
        expect(await readFile(outside, 'utf8')).toBe('keep');
        await removeResumableParts(path.join(root, 'missing'), []);
    });

    it('names conflict copies', () => {
        const date = new Date(2026, 10, 1, 10, 42);
        expect(conflictName('report.pdf', date)).toBe('report (conflict 2026-11-01 1042).pdf');
        expect(conflictName('report.pdf', date, 1)).toBe('report (conflict 2026-11-01 1042 2).pdf');
        expect(conflictName('Folder', date)).toBe('Folder (conflict 2026-11-01 1042)');
        expect(conflictName('.env', date)).toBe('.env (conflict 2026-11-01 1042)');
    });
});

describe('SyncState', () => {
    it('stores entries by path and finds children and remote UIDs', async () => {
        const state = new SyncState(path.join(await tempDir(), 'sync.sqlite'));
        expect(state.isEmpty()).toBe(true);
        const file = { type: 'file' as const, localSize: 1, localMtime: 2, remoteUid: 'u1', remoteRevision: 'r1', remoteSha1: 's' };
        state.put({
            path: '/A',
            type: 'folder',
            localSize: null,
            localMtime: null,
            remoteUid: 'fa',
            remoteRevision: null,
            remoteSha1: null,
        });
        state.put({ path: '/A/x.txt', ...file });
        state.put({
            path: '/A/B',
            type: 'folder',
            localSize: null,
            localMtime: null,
            remoteUid: 'fb',
            remoteRevision: null,
            remoteSha1: null,
        });
        state.put({ path: '/A/B/y.txt', ...file, remoteUid: 'u2' });
        state.put({ path: '/AB', ...file, remoteUid: 'u3' });
        expect([...state.children('/A').keys()].sort()).toEqual(['B', 'x.txt']);
        expect(state.byRemoteUid('fb')?.path).toBe('/A/B');
        state.removeTree('/A');
        expect(state.count()).toBe(1);
        expect(state.get('/AB')).toBeDefined();
    });

    it('keeps metadata and pending folders', async () => {
        const state = new SyncState(path.join(await tempDir(), 'sync.sqlite'));
        state.setMeta('rootUid', 'r');
        state.addPending('/A');
        state.addPending('/A');
        expect(state.getMeta('rootUid')).toBe('r');
        expect(state.pending()).toEqual(['/A']);
        state.removePending('/A');
        state.clear();
        expect(state.getMeta('rootUid')).toBeUndefined();
    });

    it('keeps its database files private', async () => {
        const file = path.join(await tempDir(), 'sync.sqlite');
        const state = new SyncState(file);
        for (const name of [file, `${file}-wal`, `${file}-shm`]) {
            expect((await stat(name)).mode & 0o777).toBe(0o600);
        }
        state.close();
    });

    it('leaves no trace of cleared entries in its files', async () => {
        const file = path.join(await tempDir(), 'sync.sqlite');
        const state = new SyncState(file);
        const secret = '/Very Secret Folder/tax-return-2026.pdf';
        for (let i = 0; i < 50; i++) {
            state.put({
                path: `${secret}.${i}`,
                type: 'file',
                localSize: 1,
                localMtime: 2,
                remoteUid: `u${i}`,
                remoteRevision: 'r',
                remoteSha1: 's',
            });
        }
        state.setMeta('rootUid', 'root-1');
        state.setMeta('lastSync', '123');
        expect(state.clear(['rootUid'])).toBe(true);
        expect(state.getMeta('rootUid')).toBe('root-1');
        expect(state.getMeta('lastSync')).toBeUndefined();
        expect(state.count()).toBe(0);
        for (const name of [file, `${file}-wal`]) {
            const bytes = Buffer.from(await readFile(name).catch(() => Buffer.alloc(0)));
            expect(bytes.includes('tax-return-2026')).toBe(false);
        }
        state.close();
    });

    it('splits paths', () => {
        expect(parentOf('/a')).toBe('/');
        expect(parentOf('/a/b')).toBe('/a');
        expect(nameOf('/a/b')).toBe('b');
        expect(childPath('/', 'a')).toBe('/a');
        expect(childPath('/a', 'b')).toBe('/a/b');
    });
});
