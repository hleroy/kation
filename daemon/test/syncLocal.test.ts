// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { conflictName, isIgnoredName, moveToTrash, scanFolder } from '../src/sync/local';
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

    it('splits paths', () => {
        expect(parentOf('/a')).toBe('/');
        expect(parentOf('/a/b')).toBe('/a');
        expect(nameOf('/a/b')).toBe('b');
        expect(childPath('/', 'a')).toBe('/a');
        expect(childPath('/a', 'b')).toBe('/a/b');
    });
});
