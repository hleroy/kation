// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { KationError } from '../service/errors';

export type SyncSettings = {
    enabled: boolean;
    paused: boolean;
    /** Absolute path of the local folder. */
    folder: string;
    /** Folders inside "My files" that are not synced, e.g. "/Videos". */
    excluded: string[];
    /** Speed limits in KiB/s for all transfers; 0 means unlimited. */
    uploadLimit: number;
    downloadLimit: number;
};

export const DEFAULT_FOLDER_NAME = 'Proton Drive';

export function defaultSettings(homeDir: string): SyncSettings {
    return {
        enabled: false,
        paused: false,
        folder: path.join(homeDir, DEFAULT_FOLDER_NAME),
        excluded: [],
        uploadLimit: 0,
        downloadLimit: 0,
    };
}

/** Sync settings in ~/.config/kation/sync.json. */
export class SettingsStore {
    private readonly file: string;

    constructor(
        configDir: string,
        private readonly homeDir: string,
    ) {
        this.file = path.join(configDir, 'sync.json');
    }

    load(): SyncSettings {
        const defaults = defaultSettings(this.homeDir);
        try {
            const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SyncSettings>;
            return {
                enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
                paused: typeof saved.paused === 'boolean' ? saved.paused : defaults.paused,
                folder: typeof saved.folder === 'string' && path.isAbsolute(saved.folder) ? saved.folder : defaults.folder,
                excluded: Array.isArray(saved.excluded) ? saved.excluded.filter((item) => typeof item === 'string') : [],
                uploadLimit: validLimit(saved.uploadLimit),
                downloadLimit: validLimit(saved.downloadLimit),
            };
        } catch {
            return defaults;
        }
    }

    save(settings: SyncSettings): void {
        mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(settings, null, 4)}\n`, { mode: 0o600 });
        renameSync(temporary, this.file);
    }
}

/** Rejects folders that would be dangerous or impossible to sync. */
export function validateFolder(folder: string, homeDir: string, forbidden: string[]): string {
    if (!path.isAbsolute(folder)) {
        throw new KationError('InvalidArgument', 'The sync folder must be an absolute path');
    }
    const normalized = path.resolve(folder);
    if (normalized === '/' || normalized === path.resolve(homeDir)) {
        throw new KationError('InvalidArgument', 'Choose a dedicated folder, not your whole home folder or the root folder');
    }
    for (const other of forbidden) {
        const resolved = path.resolve(other);
        if (normalized === resolved || normalized.startsWith(`${resolved}/`) || resolved.startsWith(`${normalized}/`)) {
            throw new KationError('InvalidArgument', `The sync folder cannot overlap Kation's own data in ${resolved}`);
        }
    }
    return normalized;
}

/** Normalises excluded paths: absolute inside "My files", no duplicates or trailing slashes. */
export function normalizeExcluded(paths: string[]): string[] {
    const result = new Set<string>();
    for (const item of paths) {
        const parts = item.split('/').filter(Boolean);
        if (!item.startsWith('/') || parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
            throw new KationError('InvalidArgument', `Invalid folder to exclude: ${item}`);
        }
        result.add(`/${parts.join('/')}`);
    }
    return [...result].sort();
}

/** Largest accepted speed limit, in KiB/s (about 1 GiB/s). */
export const MAX_LIMIT = 1024 * 1024;

function validLimit(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LIMIT ? value : 0;
}

export function validateLimit(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT) {
        throw new KationError('InvalidArgument', `Speed limits are in KiB/s, from 0 (unlimited) to ${MAX_LIMIT}`);
    }
    return value;
}
