// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Whether a folder is on a disk that is not mounted. Syncing into an empty mount
 * point would put the files on the system disk, hidden under the disk once it is
 * mounted.
 */
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
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
/** How long a check waits for an automount point to mount its disk. */
const TRIGGER_WAIT_MS = 2000;

/** Default for SyncEngineOptions.unmountedDisk. */
export function findUnmountedDisk(folder: string): Promise<string | undefined> {
    return checkMounts(folder, true);
}

/** The mount table from the text of /proc/self/mountinfo and /etc/fstab. */
export async function readMountTable(mountInfo: string, fstab: string): Promise<MountTable> {
    const { mounted, automount } = parseMountInfo(mountInfo);
    // mountinfo has resolved paths; fstab may go through symbolic links, up to and
    // including the mount point itself (systemd follows those too). A point mounted as
    // written is left alone: lstat on a hung network share would block.
    const declared = await Promise.all(
        parseFstab(fstab).map((point) => (mounted.has(point) ? point : resolveFolder(point, (dir) => automount.has(dir)))),
    );
    return { mounted, automount, declared };
}

async function checkMounts(folder: string, trigger: boolean): Promise<string | undefined> {
    const mountInfo = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
    if (parseMountInfo(mountInfo).mounted.size === 0) {
        // Cannot tell what is mounted: do not block sync on a guess.
        return undefined;
    }
    const table = await readMountTable(mountInfo, await readFile('/etc/fstab', 'utf8').catch(() => ''));
    const { mounted, automount, declared } = table;
    const notMounted = (dir: string) => (declared.includes(dir) || automount.has(dir)) && !mounted.has(dir);
    const absolute = path.isAbsolute(folder) ? folder : path.resolve(folder);
    const disk = unmountedMountPoint(await resolveFolder(absolute, notMounted), table, userName());
    if (trigger && disk && automount.has(disk) && (triggering.get(disk) ?? 0) < Date.now()) {
        // Accessing an automount point mounts its disk. One access at a time, and not
        // again soon after one that failed (disk absent).
        triggering.set(disk, Number.POSITIVE_INFINITY);
        const mounting = stat(`${disk}/.`).then(
            () => {
                triggering.delete(disk);
                return true;
            },
            () => {
                triggering.set(disk, Date.now() + TRIGGER_RETRY_MS);
                return false;
            },
        );
        // A disk that is there mounts within moments: not worth a "not mounted" pause.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waited = new Promise<false>((resolve) => {
            timer = setTimeout(resolve, TRIGGER_WAIT_MS, false);
        });
        const nowMounted = await Promise.race([mounting, waited]);
        clearTimeout(timer);
        if (nowMounted) {
            return checkMounts(folder, false);
        }
    }
    return disk;
}
