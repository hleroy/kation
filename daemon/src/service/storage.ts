// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Keeps the account's Drive storage (used and maximum bytes) up to date while
 * signed in, for the status, the tray and Dolphin.
 */
import type { Logger } from '@protontech/drive-sdk';

export type Storage = { used: number; max: number };

/** The fields of Proton's /core/v4/users User that describe storage. */
export type StorageFields = { UsedSpace?: number; MaxSpace?: number; UsedDriveSpace?: number; MaxDriveSpace?: number };

/**
 * Drive's storage as Proton's apps compute it: free plans have separate Mail and
 * Drive quotas (the Drive fields), paid plans one pool for all products.
 */
export function driveStorageOf(user: StorageFields): Storage {
    return { used: user.UsedDriveSpace ?? user.UsedSpace ?? 0, max: user.MaxDriveSpace ?? user.MaxSpace ?? 0 };
}

export type StorageMonitorOptions = {
    fetch: () => Promise<Storage>;
    logger: Logger;
    /** The storage changed; undefined once unknown (signed out). */
    onChange: (storage: Storage | undefined) => void;
    /** More space is free than when Proton last refused an upload for quota. */
    onSpaceFreed?: () => void;
    /** Proton's Windows app also reads the user every 5 minutes. */
    intervalMs?: number;
    /** After a change: wait this long, so that a burst of changes makes one request. */
    debounceMs?: number;
    /** At most one request per this period for changes. */
    minGapMs?: number;
    now?: () => number;
};

export class StorageMonitor {
    private readonly options: Required<Omit<StorageMonitorOptions, 'onSpaceFreed'>> & Pick<StorageMonitorOptions, 'onSpaceFreed'>;
    private current?: Storage;
    private running = false;
    /** Bumped by start and stop: a request started before must not apply its answer. */
    private generation = 0;
    private interval?: ReturnType<typeof setInterval>;
    private timer?: ReturnType<typeof setTimeout>;
    private lastFetch = Number.NEGATIVE_INFINITY;
    private fetching?: Promise<void>;
    private quotaErrorPending = false;
    /** Free bytes read after Proton refused an upload for quota. */
    private availableAtQuotaError?: number;

    constructor(options: StorageMonitorOptions) {
        this.options = { intervalMs: 5 * 60 * 1000, debounceMs: 2000, minGapMs: 30 * 1000, now: Date.now, ...options };
    }

    /** Undefined while unknown, or when the account has no limit. */
    get(): Storage | undefined {
        return this.current;
    }

    /** Reads the storage now, then periodically. Called when signed in. */
    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.generation++;
        this.interval = setInterval(() => void this.refresh(), this.options.intervalMs);
        void this.refresh();
    }

    /** Called when signed out: the storage is unknown again. */
    stop(): void {
        this.dispose();
        if (this.current) {
            this.current = undefined;
            this.options.onChange(undefined);
        }
    }

    /** Stops without reporting a change (kationd is stopping). */
    dispose(): void {
        this.running = false;
        this.generation++;
        clearInterval(this.interval);
        clearTimeout(this.timer);
        this.interval = undefined;
        this.timer = undefined;
        this.lastFetch = Number.NEGATIVE_INFINITY;
        this.quotaErrorPending = false;
        this.availableAtQuotaError = undefined;
    }

    /** Something changed in Proton Drive: read the storage again soon. */
    changed(): void {
        if (!this.running || this.timer) {
            return;
        }
        const delay = Math.max(this.options.debounceMs, this.lastFetch + this.options.minGapMs - this.options.now());
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
        }, delay);
    }

    /** Proton refused an upload for lack of space. */
    quotaExceeded(): void {
        if (!this.running) {
            return;
        }
        this.quotaErrorPending = true;
        this.changed();
    }

    /** For tests: resolves once the request in progress, if any, is done. */
    async settled(): Promise<void> {
        await this.fetching;
    }

    private refresh(): Promise<void> {
        if (this.fetching) {
            return this.fetching;
        }
        const generation = this.generation;
        this.lastFetch = this.options.now();
        const quotaError = this.quotaErrorPending;
        this.quotaErrorPending = false;
        this.fetching = (async () => {
            try {
                const storage = await this.options.fetch();
                if (generation === this.generation) {
                    this.apply(storage, quotaError);
                }
            } catch (error: unknown) {
                if (generation === this.generation) {
                    this.quotaErrorPending ||= quotaError;
                }
                this.options.logger.debug(`Failed to read the storage quota: ${error}`);
            } finally {
                this.fetching = undefined;
            }
        })();
        return this.fetching;
    }

    private apply(storage: Storage, quotaError: boolean): void {
        const known = storage.max > 0 ? storage : undefined;
        if (known?.used !== this.current?.used || known?.max !== this.current?.max) {
            this.options.logger.debug(known ? `Storage: ${known.used} of ${known.max} bytes used` : 'Storage: no limit reported');
            this.current = known;
            this.options.onChange(known);
        }
        const available = known ? known.max - known.used : 0;
        if (quotaError) {
            this.availableAtQuotaError = available;
        } else if (this.availableAtQuotaError !== undefined && available > this.availableAtQuotaError) {
            this.availableAtQuotaError = undefined;
            this.options.logger.info('Storage space was freed; syncing again');
            this.options.onSpaceFreed?.();
        }
    }
}
