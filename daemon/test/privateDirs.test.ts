// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { chmod, mkdir, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { removeSpoolFiles, securePrivateDirs } from '../src/privateDirs';
import { tempDir } from './helpers';

const modeOf = async (file: string) => (await stat(file)).mode & 0o777;

describe('securePrivateDirs', () => {
    it('creates missing folders for the owner only', async () => {
        const home = await tempDir();
        const dirs = [path.join(home, 'cache', 'kation'), path.join(home, 'state', 'kation')];
        expect(await securePrivateDirs(dirs)).toEqual([]);
        for (const dir of dirs) {
            expect(await modeOf(dir)).toBe(0o700);
        }
    });

    it('tightens existing folders, their subfolders and files', async () => {
        const dir = path.join(await tempDir(), 'kation');
        await mkdir(path.join(dir, 'sub'), { recursive: true });
        await writeFile(path.join(dir, 'a.json'), '{}');
        await writeFile(path.join(dir, 'sub', 'b.sqlite'), 'x');
        await chmod(dir, 0o755);
        await chmod(path.join(dir, 'sub'), 0o755);
        await chmod(path.join(dir, 'a.json'), 0o644);
        await chmod(path.join(dir, 'sub', 'b.sqlite'), 0o644);

        expect(await securePrivateDirs([dir])).toEqual([]);
        expect(await modeOf(dir)).toBe(0o700);
        expect(await modeOf(path.join(dir, 'sub'))).toBe(0o700);
        expect(await modeOf(path.join(dir, 'a.json'))).toBe(0o600);
        expect(await modeOf(path.join(dir, 'sub', 'b.sqlite'))).toBe(0o600);
    });

    it('neither follows nor changes symbolic links inside', async () => {
        const dir = path.join(await tempDir(), 'kation');
        await mkdir(dir);
        const outside = await tempDir();
        const target = path.join(outside, 'target.txt');
        await writeFile(target, 'x');
        await chmod(target, 0o644);
        await chmod(outside, 0o755);
        await symlink(target, path.join(dir, 'file-link'));
        await symlink(outside, path.join(dir, 'folder-link'));

        await securePrivateDirs([dir]);
        expect(await modeOf(target)).toBe(0o644);
        expect(await modeOf(outside)).toBe(0o755);
    });

    it('leaves a private folder that is a symbolic link alone', async () => {
        const outside = await tempDir();
        await chmod(outside, 0o755);
        const dir = path.join(await tempDir(), 'kation');
        await symlink(outside, dir);
        const warnings = await securePrivateDirs([dir]);
        expect(warnings).toHaveLength(1);
        expect(await modeOf(outside)).toBe(0o755);
    });
});

describe('removeSpoolFiles', () => {
    it('deletes the files in the spool folder, and nothing a link points to', async () => {
        const cacheDir = await tempDir();
        const spool = path.join(cacheDir, 'spool');
        await mkdir(spool);
        await writeFile(path.join(spool, 'transfer-1'), 'secret');
        const outside = path.join(await tempDir(), 'keep.txt');
        await writeFile(outside, 'keep');
        await symlink(outside, path.join(spool, 'link'));
        await mkdir(path.join(spool, 'folder'));

        await removeSpoolFiles(cacheDir);
        expect((await readdir(spool)).sort()).toEqual(['folder', 'link']);
        expect(await Bun.file(outside).text()).toBe('keep');
        await removeSpoolFiles(path.join(cacheDir, 'missing'));
    });
});
