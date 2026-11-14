// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/** Local side of sync: folder scans, ignored names and the desktop trash. */
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type LocalItem = {
    name: string;
    type: 'file' | 'folder';
    size: number;
    /** Modification time in ms. */
    mtime: number;
    /** Inode and birth time (ms, 0 when the file system has none): the same after a rename or move. */
    ino: number;
    btime: number;
};

/** What the base recorded about a local item (see BaseEntry). */
export type LocalIdentity = {
    type: 'file' | 'folder';
    localSize: number | null;
    localMtime: number | null;
    localIno?: number | null;
    localBtime?: number | null;
};

/**
 * Whether a local item found at a new path is the synced item `base`, renamed or
 * moved. Inode numbers are reused after a deletion, so the inode alone is not enough:
 * a file must also be unchanged or have the same birth time, a folder the same birth
 * time when known. The caller checks that the old path no longer holds that inode.
 */
export function isSameLocalItem(item: LocalItem, base: LocalIdentity): boolean {
    if (!item.ino || base.localIno !== item.ino || base.type !== item.type) {
        return false;
    }
    const sameBirth = !!item.btime && item.btime === base.localBtime;
    if (item.type === 'file') {
        return sameBirth || (item.size === base.localSize && item.mtime === base.localMtime);
    }
    return sameBirth || !item.btime || !base.localBtime;
}

/** Marker file in the sync folder root; if it disappears, the folder was replaced or unmounted. */
export const MARKER_NAME = '.kation-sync';

const IGNORED_SUFFIXES = ['.kation-part', '.part', '.crdownload', '.swp', '.tmp', '~'];
const IGNORED_PREFIXES = ['.~lock.', '.goutputstream-', '.Trash-', '.kation-'];
const IGNORED_NAMES = new Set(['.directory', MARKER_NAME, '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Temporary, lock and system files that are never synced, in either direction. */
export function isIgnoredName(name: string): boolean {
    return (
        IGNORED_NAMES.has(name) ||
        IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
        IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
}

/**
 * Lists a local folder. Symbolic links and special files are skipped (and
 * logged by the caller if needed); a missing folder lists as empty.
 */
export async function scanFolder(absolutePath: string): Promise<Map<string, LocalItem>> {
    const items = new Map<string, LocalItem>();
    let entries: Dirent[];
    try {
        entries = await readdir(absolutePath, { withFileTypes: true });
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
            return items;
        }
        throw error;
    }
    for (const entry of entries) {
        if (isIgnoredName(entry.name) || !(entry.isFile() || entry.isDirectory())) {
            continue;
        }
        const item = await statItem(path.join(absolutePath, entry.name));
        if (item) {
            items.set(entry.name, item);
        }
    }
    return items;
}

/** Current state of one local file or folder, or undefined if gone or special. */
export async function statItem(absolutePath: string): Promise<LocalItem | undefined> {
    try {
        const info = await lstat(absolutePath);
        if (!info.isFile() && !info.isDirectory()) {
            return undefined;
        }
        return {
            name: path.basename(absolutePath),
            type: info.isDirectory() ? 'folder' : 'file',
            size: info.isDirectory() ? 0 : info.size,
            mtime: info.mtimeMs,
            ino: info.ino,
            btime: info.birthtimeMs || 0,
        };
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
}

/** Whether a path is a symbolic link or a special file (false if nothing is there). */
export async function isLinkOrSpecial(absolutePath: string): Promise<boolean> {
    try {
        const info = await lstat(absolutePath);
        return !info.isFile() && !info.isDirectory();
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return false;
        }
        throw error;
    }
}

/** `.<name>.<tag>.kation-part`, see resumablePartPath. */
const RESUMABLE_PART = /^\..+\.[0-9a-f]{8}\.kation-part$/;

/**
 * Deletes the resumable partial downloads sync left in a sync folder, except in
 * excluded folders (paths inside "My files"). Never follows links; anything
 * unreadable is skipped.
 */
export async function removeResumableParts(root: string, excluded: string[], folder = '/'): Promise<void> {
    const absolute = folder === '/' ? root : path.join(root, folder);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
        const itemPath = folder === '/' ? `/${entry.name}` : `${folder}/${entry.name}`;
        if (entry.isFile() && RESUMABLE_PART.test(entry.name)) {
            await unlink(path.join(absolute, entry.name)).catch(() => {});
        } else if (entry.isDirectory() && !isIgnoredName(entry.name) && !excluded.includes(itemPath)) {
            await removeResumableParts(root, excluded, itemPath);
        }
    }
}

/**
 * Moves a file or folder to the desktop trash (freedesktop.org Trash
 * specification), so it can be restored from Dolphin: the home trash, or the
 * trash at the top of the item's file system when it is on another one (for
 * example a sync folder on a second disk). Never deletes: if neither trash
 * can take the item, this throws and the item stays where it is.
 */
export async function moveToTrash(absolutePath: string, dataHome = defaultDataHome()): Promise<void> {
    const homeTrash = path.join(dataHome, 'Trash');
    try {
        await moveIntoTrash(absolutePath, homeTrash, absolutePath);
        return;
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
            throw error;
        }
    }
    await moveToTopDirTrash(absolutePath, await topDirectoryOf(absolutePath));
}

/**
 * Moves an item to `<topDir>/.Trash-<uid>`, the trash of the file system mounted
 * at `topDir`. Exported for tests.
 */
export async function moveToTopDirTrash(absolutePath: string, topDir: string): Promise<void> {
    const uid = process.getuid?.() ?? 0;
    const trash = path.join(topDir, `.Trash-${uid}`);
    // Other users may write at the top of a shared disk: use only folders that are ours alone.
    for (const folder of [trash, path.join(trash, 'files'), path.join(trash, 'info')]) {
        await ensurePrivateFolder(folder, uid);
    }
    // Paths in a $topdir trash are relative to $topdir.
    await moveIntoTrash(absolutePath, trash, path.relative(topDir, absolutePath));
}

/** Creates a folder only its owner can use, or checks that the existing one is such a folder. */
async function ensurePrivateFolder(folder: string, uid: number): Promise<void> {
    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) {
        throw new Error(`The trash folder ${folder} cannot be trusted: it must be a folder of yours that others cannot write to`);
    }
}

async function moveIntoTrash(absolutePath: string, trash: string, infoPath: string): Promise<void> {
    const filesDir = path.join(trash, 'files');
    const infoDir = path.join(trash, 'info');
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    await mkdir(infoDir, { recursive: true, mode: 0o700 });

    const base = path.basename(absolutePath);
    for (let attempt = 0; attempt < 1000; attempt++) {
        const name = attempt === 0 ? base : `${base}.${attempt}`;
        const infoFile = path.join(infoDir, `${name}.trashinfo`);
        const info = `[Trash Info]\nPath=${encodeTrashPath(infoPath)}\nDeletionDate=${trashDate(new Date())}\n`;
        try {
            // Creating the info file first and exclusively reserves the name.
            await writeFile(infoFile, info, { flag: 'wx', mode: 0o600 });
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                continue;
            }
            throw error;
        }
        try {
            await rename(absolutePath, path.join(filesDir, name));
            return;
        } catch (error: unknown) {
            await rm(infoFile, { force: true });
            throw error;
        }
    }
    throw new Error(`Could not find a free name in the trash for ${absolutePath}`);
}

/** The mount point of the file system holding `absolutePath`. */
async function topDirectoryOf(absolutePath: string): Promise<string> {
    const device = (await lstat(absolutePath)).dev;
    let current = path.dirname(absolutePath);
    while (current !== '/') {
        const parent = path.dirname(current);
        if ((await stat(parent)).dev !== device) {
            return current;
        }
        current = parent;
    }
    return current;
}

/** "report.pdf" -> "report (conflict 2026-11-01 1042).pdf" (with a counter if taken). */
export function conflictName(name: string, date: Date, attempt = 0): string {
    const extension = name.startsWith('.') ? '' : path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
    const counter = attempt > 0 ? ` ${attempt + 1}` : '';
    return `${stem} (conflict ${stamp}${counter})${extension}`;
}

function defaultDataHome(): string {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function encodeTrashPath(trashPath: string): string {
    return trashPath.split('/').map(encodeURIComponent).join('/');
}

function trashDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
