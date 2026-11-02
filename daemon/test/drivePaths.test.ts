// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { type NodeEntity, NodeType } from '@protontech/drive-sdk';

import { listFolder, nodeName, resolvePath, splitDrivePath } from '../src/drivePaths';

function node(uid: string, name: string, type = NodeType.Folder): NodeEntity {
    return { uid, name: { ok: true, value: name }, type } as unknown as NodeEntity;
}

/** In-memory tree: root -> Documents -> Taxes, plus a file and a node the server reports missing. */
function fakeSdk() {
    const nodes = new Map<string, NodeEntity>([
        ['root', node('root', 'root')],
        ['docs', node('docs', 'Documents')],
        ['taxes', node('taxes', 'Taxes')],
        ['note', node('note', 'note.txt', NodeType.File)],
    ]);
    const children: Record<string, string[]> = { root: ['docs', 'note', 'gone'], docs: ['taxes'], taxes: [] };
    const batches: string[][] = [];
    const sdk = {
        getMyFilesRootFolder: async () => nodes.get('root')!,
        async *iterateFolderChildrenNodeUids(parent: NodeEntity | string) {
            const uid = typeof parent === 'string' ? parent : parent.uid;
            yield* children[uid] ?? [];
        },
        async *iterateNodes(uids: (NodeEntity | string)[]) {
            batches.push(uids as string[]);
            for (const uid of uids as string[]) {
                yield nodes.get(uid) ?? { missingUid: uid };
            }
        },
    };
    return { sdk: sdk as never, batches };
}

describe('splitDrivePath', () => {
    it('normalises slashes', () => {
        expect(splitDrivePath('/')).toEqual([]);
        expect(splitDrivePath('Documents//Taxes/')).toEqual(['Documents', 'Taxes']);
    });

    it('rejects parent references', () => {
        expect(() => splitDrivePath('/Documents/../../etc')).toThrow('Invalid path');
    });
});

describe('listFolder', () => {
    it('loads children in one batch and skips missing nodes', async () => {
        const { sdk, batches } = fakeSdk();
        const names = (await listFolder(sdk, 'root')).map(nodeName);
        expect(names).toEqual(['Documents', 'note.txt']);
        expect(batches).toEqual([['docs', 'note', 'gone']]);
    });
});

describe('resolvePath', () => {
    it('walks the tree from My files', async () => {
        const { sdk } = fakeSdk();
        expect((await resolvePath(sdk, '/')).uid).toBe('root');
        expect((await resolvePath(sdk, '/Documents/Taxes')).uid).toBe('taxes');
    });

    it('reports the first missing component', async () => {
        const { sdk } = fakeSdk();
        await expect(resolvePath(sdk, '/Documents/Nope/Deeper')).rejects.toThrow('Not found: /Documents/Nope');
    });
});

describe('nodeName', () => {
    it('falls back to the UID when the name cannot be decrypted', () => {
        const broken = { uid: 'x', name: { ok: false, error: new Error('bad') } } as unknown as NodeEntity;
        expect(nodeName(broken)).toBe('x');
    });
});
