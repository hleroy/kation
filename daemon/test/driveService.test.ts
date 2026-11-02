// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { NodeType } from '@protontech/drive-sdk';

import { mediaTypeOf } from '../src/service/driveService';
import { setup, tempDir } from './helpers';

describe('DriveService', () => {
    it('stats and lists', async () => {
        const { fake, drive } = setup();
        const docs = fake.add({ parentUid: fake.rootUid, name: 'Docs', type: NodeType.Folder });
        fake.add({ parentUid: docs.uid, name: 'a.txt', type: NodeType.File, content: 'hello' });
        expect(await drive.stat('/')).toMatchObject({ name: '', type: 'folder', size: -1, mimeType: 'inode/directory' });
        expect(await drive.list('/Docs')).toEqual([
            expect.objectContaining({ name: 'a.txt', type: 'file', size: 5, mimeType: 'text/plain' }),
        ]);
        await expect(drive.list('/Docs/a.txt')).rejects.toMatchObject({ code: 'NotAFolder' });
    });

    it('gets or creates public links, and web app addresses', async () => {
        const { fake, drive } = setup();
        const file = fake.add({ parentUid: fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'hello' });
        expect(await drive.shareLink('/a.txt', false)).toBe('');
        const link = await drive.shareLink('/a.txt', true);
        expect(link).toStartWith('https://drive.proton.me/urls/');
        expect(await drive.shareLink('/a.txt', false)).toBe(link);
        expect(await drive.shareLink('/a.txt', true)).toBe(link);
        expect(await drive.webUrl('/a.txt')).toContain(`/file/${file.uid}`);
        await expect(drive.shareLink('/', true)).rejects.toMatchObject({ code: 'InvalidArgument' });
        await expect(drive.webUrl('/missing')).rejects.toMatchObject({ code: 'NotFound' });
    });

    it('creates folders and refuses duplicates', async () => {
        const { fake, drive } = setup();
        await drive.createFolder('/New');
        expect(fake.childrenOf(fake.rootUid).get('New')?.type).toBe(NodeType.Folder);
        await expect(drive.createFolder('/New')).rejects.toMatchObject({ code: 'AlreadyExists' });
        await expect(drive.createFolder('/Missing/Sub')).rejects.toMatchObject({ code: 'NotFound' });
        await expect(drive.createFolder('/')).rejects.toMatchObject({ code: 'InvalidArgument' });
    });

    describe('move', () => {
        function tree() {
            const ctx = setup();
            const { fake } = ctx;
            const a = fake.add({ parentUid: fake.rootUid, name: 'A', type: NodeType.Folder });
            const b = fake.add({ parentUid: fake.rootUid, name: 'B', type: NodeType.Folder });
            const file = fake.add({ parentUid: a.uid, name: 'f.txt', type: NodeType.File, content: 'f' });
            return { ...ctx, a, b, file };
        }

        it('renames within a folder', async () => {
            const { fake, drive, a, file } = tree();
            await drive.move('/A/f.txt', '/A/g.txt', false);
            expect(fake.childrenOf(a.uid).get('g.txt')?.uid).toBe(file.uid);
        });

        it('moves, and moves with a new name', async () => {
            const { fake, drive, b, file } = tree();
            await drive.move('/A/f.txt', '/B/f.txt', false);
            expect(fake.childrenOf(b.uid).get('f.txt')?.uid).toBe(file.uid);
            await drive.move('/B/f.txt', '/A/h.txt', false);
            expect(await drive.stat('/A/h.txt')).toMatchObject({ name: 'h.txt' });
        });

        it('renames first when the destination folder has a child with the old name', async () => {
            const { fake, drive, a, b, file } = tree();
            fake.add({ parentUid: b.uid, name: 'f.txt', type: NodeType.File });
            await drive.move('/A/f.txt', '/B/g.txt', false);
            expect(fake.childrenOf(b.uid).get('g.txt')?.uid).toBe(file.uid);
            expect(fake.childrenOf(a.uid).size).toBe(0);
        });

        it('refuses to overwrite unless asked, then trashes the old destination', async () => {
            const { fake, drive, b, file } = tree();
            const old = fake.add({ parentUid: b.uid, name: 'f.txt', type: NodeType.File, content: 'old' });
            await expect(drive.move('/A/f.txt', '/B/f.txt', false)).rejects.toMatchObject({ code: 'AlreadyExists' });
            await drive.move('/A/f.txt', '/B/f.txt', true);
            expect(fake.childrenOf(b.uid).get('f.txt')?.uid).toBe(file.uid);
            expect(fake.childrenOf(b.uid).size).toBe(1); // the old file went to the trash
            expect(old.trashed).toBeDefined();
        });

        it('refuses to move a folder into itself', async () => {
            const { drive } = tree();
            await drive.createFolder('/A/Sub');
            await expect(drive.move('/A', '/A/Sub/A', false)).rejects.toMatchObject({ code: 'InvalidArgument' });
        });

        it('reports a missing source', async () => {
            const { drive } = tree();
            await expect(drive.move('/A/nope', '/B/nope', false)).rejects.toMatchObject({ code: 'NotFound' });
        });
    });

    describe('transfers', () => {
        it('uploads a new file with its size, type and modification time', async () => {
            const { fake, drive } = setup();
            const dir = await tempDir();
            const local = path.join(dir, 'Photo.JPG');
            await writeFile(local, 'jpeg bytes');
            const entry = await drive.upload(local, '/Photo.JPG', false);
            expect(entry).toMatchObject({ name: 'Photo.JPG', type: 'file', size: 10, mimeType: 'image/jpeg' });
            expect(entry.mtime).toBe(Math.floor((await stat(local)).mtimeMs / 1000));
            expect(fake.contentOf(fake.childrenOf(fake.rootUid).get('Photo.JPG')!.uid)).toBe('jpeg bytes');
        });

        it('takes the media type from the destination name, not the local file', async () => {
            const { fake, drive } = setup();
            const spool = path.join(await tempDir(), '0f8e2c4a-spool');
            await writeFile(spool, '%PDF-1.7');
            expect(await drive.upload(spool, '/report.pdf', false)).toMatchObject({ mimeType: 'application/pdf' });
            expect(fake.childrenOf(fake.rootUid).get('report.pdf')?.mediaType).toBe('application/pdf');
        });

        it('adds a revision when overwriting and refuses otherwise', async () => {
            const { fake, drive } = setup();
            const existing = fake.add({ parentUid: fake.rootUid, name: 'a.txt', type: NodeType.File, content: 'v1' });
            const local = path.join(await tempDir(), 'a.txt');
            await writeFile(local, 'v2');
            await expect(drive.upload(local, '/a.txt', false)).rejects.toMatchObject({ code: 'AlreadyExists' });
            await drive.upload(local, '/a.txt', true);
            expect(fake.contentOf(existing.uid)).toBe('v2');
        });

        it('refuses to upload over a folder or from a non-file', async () => {
            const { fake, drive } = setup();
            fake.add({ parentUid: fake.rootUid, name: 'Docs', type: NodeType.Folder });
            const dir = await tempDir();
            const local = path.join(dir, 'x');
            await writeFile(local, 'x');
            await expect(drive.upload(local, '/Docs', true)).rejects.toMatchObject({ code: 'IsAFolder' });
            await expect(drive.upload(dir, '/x', false)).rejects.toMatchObject({ code: 'InvalidArgument' });
            await expect(drive.upload('relative/x', '/x', false)).rejects.toMatchObject({ code: 'InvalidArgument' });
        });

        it('downloads atomically and keeps the modification time', async () => {
            const { fake, drive } = setup();
            const content = 'x'.repeat(200_000);
            fake.add({ parentUid: fake.rootUid, name: 'big.bin', type: NodeType.File, content });
            const dir = await tempDir();
            const local = path.join(dir, 'big.bin');
            await writeFile(local, 'previous');
            const progress: number[] = [];
            const entry = await drive.download('/big.bin', local, { onProgress: (bytes) => progress.push(bytes) });
            expect(await readFile(local, 'utf8')).toBe(content);
            expect(Math.floor((await stat(local)).mtimeMs / 1000)).toBe(entry.mtime);
            expect(progress.at(-1)).toBe(content.length);
            expect(await readdir(dir)).toEqual(['big.bin']);
        });

        it('refuses to download a folder', async () => {
            const { drive } = setup();
            await expect(drive.download('/', path.join(await tempDir(), 'x'))).rejects.toMatchObject({ code: 'IsAFolder' });
        });

        it('cancels a download and leaves no partial file', async () => {
            const { fake, drive } = setup({ chunkDelayMs: 20 });
            fake.add({ parentUid: fake.rootUid, name: 'big.bin', type: NodeType.File, content: 'x'.repeat(1_000_000) });
            const dir = await tempDir();
            const abort = new AbortController();
            setTimeout(() => abort.abort(), 50);
            await expect(drive.download('/big.bin', path.join(dir, 'big.bin'), { signal: abort.signal })).rejects.toMatchObject({
                code: 'Cancelled',
            });
            await Bun.sleep(50);
            expect(await readdir(dir)).toEqual([]);
        });

        it('cancels an upload without creating the file', async () => {
            const { fake, drive } = setup({ chunkDelayMs: 20 });
            const local = path.join(await tempDir(), 'big.bin');
            await writeFile(local, 'x'.repeat(1_000_000));
            const abort = new AbortController();
            setTimeout(() => abort.abort(), 50);
            await expect(drive.upload(local, '/big.bin', false, { signal: abort.signal })).rejects.toMatchObject({ code: 'Cancelled' });
            await Bun.sleep(200);
            expect(fake.childrenOf(fake.rootUid).size).toBe(0);
        });
    });
});

describe('mediaTypeOf', () => {
    it('detects common types regardless of extension case', () => {
        expect(mediaTypeOf('/x/a.pdf')).toBe('application/pdf');
        expect(mediaTypeOf('/x/A.PNG')).toBe('image/png');
        expect(mediaTypeOf('/x/notes.txt')).toBe('text/plain');
        expect(mediaTypeOf('/x/no-extension')).toBe('application/octet-stream');
    });
});

describe('resumable downloads', () => {
    it('continues an interrupted download from where it stopped', async () => {
        const { fake, drive } = setup({ chunkDelayMs: 15 });
        const content = 'abcdefghij'.repeat(100_000); // 1 MB, 16 chunks
        const file = fake.add({ parentUid: fake.rootUid, name: 'big.bin', type: NodeType.File, content });
        const dir = await tempDir();
        const local = path.join(dir, 'big.bin');

        const abort = new AbortController();
        setTimeout(() => abort.abort(), 100);
        await expect(
            drive.downloadNode(await fake.sdk.getNode(file.uid), local, { signal: abort.signal, resumable: true }),
        ).rejects.toMatchObject({
            code: 'Cancelled',
        });
        await Bun.sleep(50);
        const parts = (await readdir(dir)).filter((name) => name.endsWith('.kation-part'));
        expect(parts).toHaveLength(1);
        expect(parts[0]).toStartWith('.big.bin.');
        const kept = (await stat(path.join(dir, parts[0]!))).size;
        expect(kept).toBeGreaterThan(0);

        fake.bytesServed = 0;
        await drive.downloadNode(await fake.sdk.getNode(file.uid), local, { resumable: true });
        expect(await readFile(local, 'utf8')).toBe(content);
        expect(fake.bytesServed).toBe(content.length - kept);
        expect(await readdir(dir)).toEqual(['big.bin']);
    });

    it('downloads again when the resumed file fails the checksum', async () => {
        const { fake, drive } = setup();
        const content = 'x'.repeat(200_000);
        const file = fake.add({ parentUid: fake.rootUid, name: 'f.bin', type: NodeType.File, content });
        const node = await fake.sdk.getNode(file.uid);
        const dir = await tempDir();
        const local = path.join(dir, 'f.bin');
        const { resumablePartPath } = await import('../src/service/driveService');
        await writeFile(resumablePartPath(local, node.activeRevision!.uid), 'corrupted');

        await drive.downloadNode(node, local, { resumable: true });
        expect(await readFile(local, 'utf8')).toBe(content);
        expect(await readdir(dir)).toEqual(['f.bin']);
    });

    it('does not resume a partial file of an older version', async () => {
        const { fake, drive } = setup();
        const file = fake.add({ parentUid: fake.rootUid, name: 'f.txt', type: NodeType.File, content: 'version one' });
        const dir = await tempDir();
        const local = path.join(dir, 'f.txt');
        const { resumablePartPath } = await import('../src/service/driveService');
        await writeFile(resumablePartPath(local, (await fake.sdk.getNode(file.uid)).activeRevision!.uid), 'version');
        fake.updateContent(file.uid, 'version two', { silent: true });

        await drive.downloadNode(await fake.sdk.getNode(file.uid), local, { resumable: true });
        expect(await readFile(local, 'utf8')).toBe('version two');
        expect(await readdir(dir)).toEqual(['f.txt']);
    });

    it('deletes the partial file of a plain (non-resumable) download', async () => {
        const { fake, drive } = setup({ chunkDelayMs: 15 });
        const file = fake.add({ parentUid: fake.rootUid, name: 'big.bin', type: NodeType.File, content: 'y'.repeat(1_000_000) });
        const dir = await tempDir();
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 60);
        await expect(
            drive.downloadNode(await fake.sdk.getNode(file.uid), path.join(dir, 'big.bin'), { signal: abort.signal }),
        ).rejects.toBeDefined();
        await Bun.sleep(50);
        expect(await readdir(dir)).toEqual([]);
    });
});
