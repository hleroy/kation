// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/** kationd's own folders (caches, data, log, settings): readable by the user only. */
import { chmod, lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import type { Config } from './config';

export function privateDirsOf(config: Config): string[] {
    return [config.cacheDir, config.appDir, config.logDir, config.configDir];
}

/**
 * Creates each folder with mode 0700, or sets an existing one to 0700, and its
 * files to 0600 and subfolders to 0700. Never follows links. Files created
 * later by the code copied from the Proton CLI get the umask's mode until the
 * next start; their folder keeps others out meanwhile. Returns warnings to log.
 */
export async function securePrivateDirs(dirs: string[]): Promise<string[]> {
    const warnings: string[] = [];
    const uid = process.getuid?.();
    for (const dir of dirs) {
        try {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const info = await lstat(dir);
            if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
                warnings.push(`${dir} is not a folder of yours; its permissions were left as they are`);
                continue;
            }
            await tighten(dir, warnings);
        } catch (error: unknown) {
            warnings.push(`Cannot make ${dir} private: ${error}`);
        }
    }
    return warnings;
}

async function tighten(folder: string, warnings: string[]): Promise<void> {
    await chmod(folder, 0o700);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        const entryPath = path.join(folder, entry.name);
        try {
            if (entry.isDirectory()) {
                await tighten(entryPath, warnings);
            } else if (entry.isFile()) {
                await chmod(entryPath, 0o600);
            }
        } catch (error: unknown) {
            warnings.push(`Cannot make ${entryPath} private: ${error}`);
        }
    }
}

/**
 * After sign-out: deletes the spool files and the log (it names synced files).
 * The sync state and partial downloads are SyncController's (forgetSyncedFiles).
 */
export async function clearAfterSignOut(cacheDir: string, clearLog: () => Promise<void>, logger: Logger): Promise<void> {
    await removeSpoolFiles(cacheDir);
    await clearLog();
    logger.info('Signed out; log cleared');
}

/** Deletes the files the KIO worker left in `<cacheDir>/spool` (data of transfers in flight). */
export async function removeSpoolFiles(cacheDir: string): Promise<void> {
    const spool = path.join(cacheDir, 'spool');
    const entries = await readdir(spool, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (entry.isFile()) {
            await unlink(path.join(spool, entry.name)).catch(() => {});
        }
    }
}
