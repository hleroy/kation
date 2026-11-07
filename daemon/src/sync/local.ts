// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/** Local side of sync: folder scans, ignored names and the desktop trash. */
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type LocalItem = {
    name: string;
    type: 'file' | 'folder';
    size: number;
    /** Modification time in ms. */
    mtime: number;
};

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
    const topDir = await topDirectoryOf(absolutePath);
    const uid = process.getuid?.() ?? 0;
    // Paths in a $topdir trash are relative to $topdir.
    await moveIntoTrash(absolutePath, path.join(topDir, `.Trash-${uid}`), path.relative(topDir, absolutePath));
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
