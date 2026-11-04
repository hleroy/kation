// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Whether a folder is on a disk that is not mounted. Syncing into an empty mount
 * point would put the files on the system disk, hidden under the disk once it is
 * mounted.
 */
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';

export type MountTable = {
    /** Mount points with a filesystem mounted (/proc/self/mountinfo), symbolic links resolved. */
    mounted: Set<string>;
    /** Automount points (autofs) whose filesystem is not mounted yet. */
    automount: Set<string>;
    /** Mount points declared in /etc/fstab, mounted or not. */
    declared: string[];
};

/** Undoes the octal escapes of mountinfo and fstab ("\040" for a space). */
function decodeOctal(field: string): string {
    return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function withoutTrailingSlash(point: string): string {
    return point.length > 1 ? point.replace(/\/+$/, '') : point;
}

/** Mounted points and automount points still waiting for their filesystem. */
export function parseMountInfo(text: string): Pick<MountTable, 'mounted' | 'automount'> {
    const mounted = new Set<string>();
    const autofs = new Set<string>();
    for (const line of text.split('\n')) {
        const fields = line.split(' ');
        const separator = fields.indexOf('-');
        if (fields.length <= 4 || separator < 0) {
            continue;
        }
        const point = decodeOctal(fields[4]);
        if (fields[separator + 1] !== 'autofs') {
            mounted.add(point);
        } else if (!(fields[separator + 3] ?? '').split(',').includes('indirect')) {
            // An indirect map (/home, /net) mounts its children, never the point itself.
            autofs.add(point);
        }
    }
    return { mounted, automount: new Set([...autofs].filter((point) => !mounted.has(point))) };
}

export function parseFstab(text: string): string[] {
    const points: string[] = [];
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 2 || fields[0].startsWith('#')) {
            continue;
        }
        const point = decodeOctal(fields[1]);
        // Skips "none" and "swap".
        if (path.isAbsolute(point)) {
            points.push(withoutTrailingSlash(path.normalize(point)));
        }
    }
    return points;
}

/**
 * The mount point that `folder` (absolute, symbolic links resolved) needs but that is
 * not mounted, or undefined. Covers disks declared in fstab, automount points, and
 * removable disks, which udisks mounts at /media/<user>/<label> or /run/media/<user>/<label>.
 */
export function unmountedMountPoint(folder: string, table: MountTable, user: string): string | undefined {
    const inside = (dir: string) => folder === dir || folder.startsWith(`${dir}/`);
    for (const point of [...table.declared, ...table.automount]) {
        if (point !== '/' && inside(point) && !table.mounted.has(point)) {
            return point;
        }
    }
    for (const base of user ? [`/media/${user}`, `/run/media/${user}`] : []) {
        if (folder.startsWith(`${base}/`)) {
            const point = `${base}/${folder.slice(base.length + 1).split('/')[0]}`;
            if (!table.mounted.has(point)) {
                return point;
            }
        }
    }
    return undefined;
}

/** `point` with the symbolic links above it resolved; the point itself is left alone (no automount). */
export async function resolveMountPoint(point: string): Promise<string> {
    const parent = await realpath(path.dirname(point)).catch(() => path.dirname(point));
    return path.join(parent, path.basename(point));
}

/**
 * The absolute `folder` with its symbolic links resolved, one component at a time as
 * the kernel does, without entering a mount point that is not mounted (entering an
 * automount point mounts it, and blocks while its disk is absent).
 */
export async function resolveFolder(folder: string, stopAt: (dir: string) => boolean): Promise<string> {
    let resolved = '/';
    const parts = folder.split('/').filter(Boolean);
    for (let links = 0; parts.length > 0; ) {
        const part = parts.shift() as string;
        if (part === '.' || part === '..') {
            resolved = part === '..' ? path.dirname(resolved) : resolved;
            continue;
        }
        const next = path.join(resolved, part);
        if (stopAt(next)) {
            return path.join(next, ...parts);
        }
        const info = await lstat(next).catch(() => undefined);
        if (!info) {
            return path.join(next, ...parts);
        }
        if (!info.isSymbolicLink()) {
            resolved = next;
            continue;
        }
        const target = links++ < 40 ? await readlink(next).catch(() => undefined) : undefined;
        if (target === undefined) {
            return path.join(next, ...parts);
        }
        parts.unshift(...target.split('/').filter(Boolean));
        if (path.isAbsolute(target)) {
            resolved = '/';
        }
    }
    return resolved;
}

function userName(): string {
    try {
        return userInfo().username;
    } catch {
        return process.env.USER ?? '';
    }
}

/** Automount points being mounted by an access, or when to try again after a failure. */
const triggering = new Map<string, number>();
const TRIGGER_RETRY_MS = 60 * 1000;

/** Default for SyncEngineOptions.unmountedDisk. */
export async function findUnmountedDisk(folder: string): Promise<string | undefined> {
    const { mounted, automount } = parseMountInfo(await readFile('/proc/self/mountinfo', 'utf8').catch(() => ''));
    if (mounted.size === 0) {
        // Cannot tell what is mounted: do not block sync on a guess.
        return undefined;
    }
    const fstab = parseFstab(await readFile('/etc/fstab', 'utf8').catch(() => ''));
    // mountinfo has resolved paths; fstab and the folder may go through symbolic links.
    const declared = await Promise.all(fstab.map(resolveMountPoint));
    const table: MountTable = { mounted, automount, declared };
    const notMounted = (dir: string) => (declared.includes(dir) || automount.has(dir)) && !mounted.has(dir);
    const absolute = path.isAbsolute(folder) ? folder : path.resolve(folder);
    const disk = unmountedMountPoint(await resolveFolder(absolute, notMounted), table, userName());
    if (disk && automount.has(disk) && (triggering.get(disk) ?? 0) < Date.now()) {
        // Accessing an automount point mounts its disk; the next check sees the result.
        // One access at a time, and not again soon after one that failed (disk absent).
        triggering.set(disk, Number.POSITIVE_INFINITY);
        void stat(`${disk}/.`).then(
            () => triggering.delete(disk),
            () => triggering.set(disk, Date.now() + TRIGGER_RETRY_MS),
        );
    }
    return disk;
}
