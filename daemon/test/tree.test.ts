// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { DriveEventType, NodeType } from '@protontech/drive-sdk';

import { DriveTree, splitParent, splitPath } from '../src/service/tree';
import { countingSdk, setup, silentLogger } from './helpers';

describe('splitPath', () => {
    it('splits absolute paths', () => {
        expect(splitPath('/')).toEqual([]);
        expect(splitPath('/a//b/')).toEqual(['a', 'b']);
    });

    it('rejects relative paths and dot components', () => {
        expect(() => splitPath('a/b')).toThrow('Path must be absolute');
        expect(() => splitPath('/a/../b')).toThrow('Invalid path');
        expect(() => splitPath('/a/./b')).toThrow('Invalid path');
    });

    it('refuses to split the root', () => {
        expect(() => splitParent('/')).toThrow('root folder');
        expect(splitParent('/a/b')).toEqual([['a'], 'b']);
    });
});

describe('DriveTree', () => {
    it('resolves nested paths and reports what is missing', async () => {
        const { fake, tree } = setup();
        const docs = fake.add({ parentUid: fake.rootUid, name: 'Docs', type: NodeType.Folder });
        const file = fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'x' });
        expect((await tree.resolve('/Docs/a.txt')).uid).toBe(file.uid);
        await expect(tree.resolve('/Docs/b.txt')).rejects.toThrow('Not found: /Docs/b.txt');
        await expect(tree.resolve('/Docs/a.txt/c')).rejects.toThrow('Not a folder: /Docs/a.txt');
    });

    it('lists each folder once while it is cached', async () => {
        const { fake, tree, listings } = setup();
        const docs = fake.add({ parentUid: fake.rootUid, name: 'Docs', type: NodeType.Folder });
        fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File });
        await tree.resolve('/Docs/a.txt');
        await tree.resolve('/Docs/a.txt');
        await tree.list(await tree.resolve('/Docs'));
        expect(listings()).toBe(2); // root and Docs
    });

    it('shares one listing between concurrent lookups', async () => {
        const { fake, tree, listings } = setup();
        fake.add({ parentUid: fake.rootUid, name: 'a', type: NodeType.File });
        fake.add({ parentUid: fake.rootUid, name: 'b', type: NodeType.File });
        await Promise.all([tree.resolve('/a'), tree.resolve('/b'), tree.list(await tree.root())]);
        expect(listings()).toBe(1);
    });

    it('does not cache a listing that was loading when the folder changed', async () => {
        const { fake, tree, listings } = setup();
        fake.add({ parentUid: fake.rootUid, name: 'a', type: NodeType.File });
        const loading = tree.list(await tree.root());
        tree.invalidate(fake.rootUid);
        await loading;
        await tree.list(await tree.root());
        expect(listings()).toBe(2);
    });

    it('hides trashed nodes', async () => {
        const { fake, drive } = setup();
        fake.add({ parentUid: fake.rootUid, name: 'a.txt', type: NodeType.File });
        await drive.trash('/a.txt');
        expect(await drive.list('/')).toEqual([]);
    });

    it('expires listings after the safety TTL', async () => {
        const { fake } = setup();
        const counting = countingSdk(fake.sdk);
        let now = 0;
        const tree = new DriveTree(counting.sdk, silentLogger, () => now);
        await tree.resolve('/');
        await tree.list(await tree.root());
        now += 11 * 60 * 1000;
        await tree.list(await tree.root());
        expect(counting.listings()).toBe(2);
    });

    it('invalidates listings and reports changed folders on Drive events', async () => {
        const { fake, tree, listings } = setup();
        const docs = fake.add({ parentUid: fake.rootUid, name: 'Docs', type: NodeType.Folder });
        const file = fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File });
        await tree.resolve('/Docs/a.txt');
        expect(listings()).toBe(2);

        const changed = tree.applyEvent({
            type: DriveEventType.NodeUpdated,
            nodeUid: file.uid,
            parentNodeUid: docs.uid,
            isTrashed: false,
            isShared: false,
            treeEventScopeId: 'fake-volume',
            eventId: 'e1',
        });
        expect(changed).toEqual(['/Docs']);
        await tree.resolve('/Docs/a.txt');
        expect(listings()).toBe(3);
    });

    it('reports both folders when a node moves between them', async () => {
        const { fake, tree } = setup();
        const a = fake.add({ parentUid: fake.rootUid, name: 'A', type: NodeType.Folder });
        const b = fake.add({ parentUid: fake.rootUid, name: 'B', type: NodeType.Folder });
        const file = fake.add({ parentUid: a.uid, name: 'f', type: NodeType.File });
        await tree.list(await tree.resolve('/A'));
        await tree.list(await tree.resolve('/B'));
        const changed = tree.applyEvent({
            type: DriveEventType.NodeUpdated,
            nodeUid: file.uid,
            parentNodeUid: b.uid,
            isTrashed: false,
            isShared: false,
            treeEventScopeId: 'fake-volume',
            eventId: 'e2',
        });
        expect(changed.sort()).toEqual(['/A', '/B']);
    });

    it('drops everything on a tree refresh', async () => {
        const { fake, tree, listings } = setup();
        fake.add({ parentUid: fake.rootUid, name: 'a', type: NodeType.File });
        await tree.list(await tree.root());
        expect(tree.applyEvent({ type: DriveEventType.TreeRefresh, treeEventScopeId: 'fake-volume', eventId: 'e3' })).toEqual(['/']);
        await tree.list(await tree.root());
        expect(listings()).toBe(2);
    });
});
