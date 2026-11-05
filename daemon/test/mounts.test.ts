// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';

import { type MountTable, parseFstab, parseMountInfo, readMountTable, resolveFolder, unmountedMountPoint } from '../src/sync/mounts';
import { tempDir } from './helpers';

const mountinfo = [
    '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
    '35 22 259:1 / /boot/efi rw,relatime shared:2 - vfat /dev/nvme0n1p1 rw',
    '90 22 8:17 / /media/ana/My\\040Disk rw,nosuid shared:50 - exfat /dev/sdb1 rw',
    '95 22 0:50 / /mnt/nas rw,relatime shared:60 - autofs systemd-1 rw,fd=50,direct',
    '96 22 0:51 / /mnt/auto rw,relatime shared:61 - autofs systemd-1 rw,fd=51,direct',
    '98 22 0:52 / /home rw,relatime shared:63 - autofs auto.home rw,fd=52,indirect',
    '99 98 0:53 / /home/ana rw,relatime shared:64 - nfs4 server:/home/ana rw',
    '97 96 8:33 / /mnt/auto rw,relatime shared:62 - ext4 /dev/sdc1 rw',
    '',
].join('\n');

const fstab = [
    '# <file system> <mount point> <type> <options> <dump> <pass>',
    'UUID=1111 /               ext4    errors=remount-ro 0 1',
    'UUID=2222 /boot/efi       vfat    umask=0077        0 1',
    'UUID=3333 /mnt/data       ext4    noauto,nofail     0 2',
    'UUID=4444 /mnt/My\\040Backup ext4 noauto           0 2',
    'UUID=5555 /mnt/slash/     ext4    noauto            0 2',
    '/swapfile none            swap    sw                0 0',
    '',
].join('\n');

const table: MountTable = { ...parseMountInfo(mountinfo), declared: parseFstab(fstab) };

describe('mount table', () => {
    it('reads mount points, undoing the escapes', () => {
        expect([...table.mounted]).toEqual(['/', '/boot/efi', '/media/ana/My Disk', '/home/ana', '/mnt/auto']);
        expect([...table.automount]).toEqual(['/mnt/nas']);
        expect(table.declared).toEqual(['/', '/boot/efi', '/mnt/data', '/mnt/My Backup', '/mnt/slash']);
    });

    it('finds a disk declared in fstab that is not mounted', () => {
        expect(unmountedMountPoint('/mnt/data', table, 'ana')).toBe('/mnt/data');
        expect(unmountedMountPoint('/mnt/data/Proton Drive', table, 'ana')).toBe('/mnt/data');
        expect(unmountedMountPoint('/mnt/My Backup/Proton', table, 'ana')).toBe('/mnt/My Backup');
        expect(unmountedMountPoint('/mnt/slash/Proton', table, 'ana')).toBe('/mnt/slash');
        expect(unmountedMountPoint('/mnt/database', table, 'ana')).toBeUndefined();
    });

    it('waits for an automount point until its disk is mounted', () => {
        expect(unmountedMountPoint('/mnt/nas/Proton', table, 'ana')).toBe('/mnt/nas');
        expect(unmountedMountPoint('/mnt/auto/Proton', table, 'ana')).toBeUndefined();
    });

    it('accepts folders under an indirect automount map, such as NFS home folders', () => {
        expect(unmountedMountPoint('/home/ana/Proton Drive', table, 'ana')).toBeUndefined();
    });

    it('finds a removable disk that is not mounted', () => {
        expect(unmountedMountPoint('/media/ana/USB/Proton Drive', table, 'ana')).toBe('/media/ana/USB');
        expect(unmountedMountPoint('/run/media/ana/USB/Proton Drive', table, 'ana')).toBe('/run/media/ana/USB');
        expect(unmountedMountPoint('/media/ana/My Disk/Proton Drive', table, 'ana')).toBeUndefined();
    });

    it('accepts folders on mounted disks', () => {
        expect(unmountedMountPoint('/home/ana/Proton Drive', table, 'ana')).toBeUndefined();
        expect(unmountedMountPoint('/boot/efi/x', table, 'ana')).toBeUndefined();
        expect(unmountedMountPoint('/media/bob/USB/x', table, 'ana')).toBeUndefined();
    });
});

describe('mount point paths', () => {
    it('resolves symbolic links above a mount point and in the folder', async () => {
        // As on Fedora Kinoite, where /mnt is a link to var/mnt.
        const top = await realpath(await tempDir());
        await mkdir(path.join(top, 'var', 'mnt', 'data'), { recursive: true });
        await symlink('var/mnt', path.join(top, 'mnt'));
        expect(await resolveFolder(path.join(top, 'mnt', 'data'), () => false)).toBe(path.join(top, 'var', 'mnt', 'data'));
        expect(await resolveFolder(path.join(top, 'mnt', 'data', 'Proton'), () => false)).toBe(
            path.join(top, 'var', 'mnt', 'data', 'Proton'),
        );
    });

    it('resolves a mount point that is itself a link', async () => {
        // As /home -> var/home on Fedora Atomic, if fstab names /home.
        const top = await realpath(await tempDir());
        await mkdir(path.join(top, 'var', 'home'), { recursive: true });
        await symlink('var/home', path.join(top, 'home'));
        const mountInfo = `30 1 0:40 /home ${top}/var/home rw,relatime shared:2 - btrfs /dev/sda2 rw\n`;
        const table = await readMountTable(mountInfo, `UUID=abc ${top}/home btrfs subvol=home 0 0\n`);
        expect(table.declared).toEqual([path.join(top, 'var', 'home')]);
        const folder = await resolveFolder(path.join(top, 'home', 'ana', 'Proton'), () => false);
        expect(unmountedMountPoint(folder, table, 'ana')).toBeUndefined();
    });

    it('follows links one component at a time, as the kernel does', async () => {
        const top = await realpath(await tempDir());
        await mkdir(path.join(top, 'a'), { recursive: true });
        await mkdir(path.join(top, 'b', 'c'), { recursive: true });
        await symlink('../b/c', path.join(top, 'a', 'link'));
        expect(await resolveFolder(`${top}/a/link/../x`, () => false)).toBe(path.join(top, 'b', 'x'));
    });

    it('does not enter a not-mounted point reached through a link', async () => {
        const top = await realpath(await tempDir());
        const point = path.join(top, 'nas');
        await mkdir(path.join(top, 'home'));
        await symlink(point, path.join(top, 'home', 'NAS'));
        const asked: string[] = [];
        const folder = await resolveFolder(path.join(top, 'home', 'NAS', 'Proton'), (dir) => {
            asked.push(dir);
            return dir === point;
        });
        expect(folder).toBe(path.join(point, 'Proton'));
        expect(asked.at(-1)).toBe(point);
    });

    it('does not enter a mount point that is not mounted', async () => {
        const top = await realpath(await tempDir());
        const point = path.join(top, 'nas');
        const entered: string[] = [];
        const folder = await resolveFolder(path.join(point, 'link', 'Proton'), (dir) => {
            entered.push(dir);
            return dir === point;
        });
        expect(folder).toBe(path.join(point, 'link', 'Proton'));
        expect(entered.at(-1)).toBe(point);
    });
});
