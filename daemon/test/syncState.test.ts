// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { type BaseEntry, SyncState } from '../src/sync/state';
import { tempDir } from './helpers';

function entry(itemPath: string, type: 'file' | 'folder', ino: number): BaseEntry {
    return {
        path: itemPath,
        type,
        localSize: type === 'file' ? 1 : null,
        localMtime: type === 'file' ? 1000 : null,
        remoteUid: `uid${itemPath}`,
        remoteRevision: null,
        remoteSha1: null,
        localIno: ino,
        localBtime: 5,
    };
}

describe('SyncState', () => {
    it('moves an entry with everything below it, and its pending folders', async () => {
        const state = new SyncState(path.join(await tempDir(), 'sync.sqlite'));
        state.put(entry('/A', 'folder', 1));
        state.put(entry('/A/Sub', 'folder', 2));
        state.put(entry('/A/Sub/f.txt', 'file', 3));
        state.put(entry('/AB', 'folder', 4));
        state.put(entry('/B', 'folder', 5));
        state.put(entry('/B/old.txt', 'file', 6));
        state.addPending('/A/Sub');

        state.moveTree('/A', '/B');

        expect(state.get('/A')).toBeUndefined();
        expect(state.get('/AB')?.remoteUid).toBe('uid/AB');
        expect(state.get('/B')?.remoteUid).toBe('uid/A');
        expect(state.get('/B/old.txt')).toBeUndefined();
        expect([...state.children('/B/Sub').keys()]).toEqual(['f.txt']);
        expect(state.get('/B/Sub/f.txt')?.remoteUid).toBe('uid/A/Sub/f.txt');
        expect(state.pending()).toEqual(['/B/Sub']);
        expect(state.count()).toBe(4);
    });

    it('moves and removes the items of a folder whose name has an emoji', async () => {
        const state = new SyncState(path.join(await tempDir(), 'sync.sqlite'));
        state.put(entry('/😀 Photos', 'folder', 1));
        state.put(entry('/😀 Photos/a.jpg', 'file', 2));
        state.moveTree('/😀 Photos', '/Pics 🎉');
        expect([...state.children('/Pics 🎉').keys()]).toEqual(['a.jpg']);
        state.removeTree('/Pics 🎉');
        expect(state.count()).toBe(0);
    });

    it('finds entries by inode', async () => {
        const state = new SyncState(path.join(await tempDir(), 'sync.sqlite'));
        state.put(entry('/a.txt', 'file', 7));
        state.put(entry('/b.txt', 'file', 8));
        expect(state.byLocalIno(7).map((found) => found.path)).toEqual(['/a.txt']);
        state.setLocalIdentity('/b.txt', 7, 9);
        expect(
            state
                .byLocalIno(7)
                .map((found) => found.path)
                .sort(),
        ).toEqual(['/a.txt', '/b.txt']);
        expect(state.get('/b.txt')).toMatchObject({ localIno: 7, localBtime: 9 });
    });

    it('upgrades a database made before inodes were recorded', async () => {
        const file = path.join(await tempDir(), 'sync.sqlite');
        const old = new Database(file, { create: true });
        old.run(`CREATE TABLE entries (
            path TEXT PRIMARY KEY, parent TEXT NOT NULL, type TEXT NOT NULL, local_size INTEGER, local_mtime REAL,
            remote_uid TEXT NOT NULL, remote_revision TEXT, remote_sha1 TEXT)`);
        old.run("INSERT INTO entries VALUES ('/a.txt', '/', 'file', 1, 1000, 'uid', 'rev', NULL)");
        old.close();

        const state = new SyncState(file);
        expect(state.get('/a.txt')).toMatchObject({ remoteUid: 'uid', localIno: null, localBtime: null });
        state.setLocalIdentity('/a.txt', 3, 4);
        expect(state.byLocalIno(3)).toHaveLength(1);
        state.close();
        new SyncState(file).close();
    });
});
