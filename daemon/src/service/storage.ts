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

/** What DriveService needs to refuse uploads that would not fit (see DriveService.uploadFile). */
export type StorageReadings = {
    /** Free bytes by the latest reading (undefined: unknown, or no limit), and that reading's number (0: none yet). */
    latest(): { free: number | undefined; reading: number };
    /** The number the next reading will have: it counts the uploads that ended before it starts. */
    nextReading(): number;
    /** Something changed in Proton Drive: read the storage again soon. */
    changed(): void;
};

export type StorageMonitorOptions = {
    fetch: () => Promise<Storage>;
    logger: Logger;
    /** The storage changed; undefined once unknown (signed out). */
    onChange: (storage: Storage | undefined) => void;
    /** More space is free than when an upload was last refused for quota. */
    onSpaceFreed?: () => void;
    /** Bytes held by uploads that the readings do not count yet (DriveService.reservedBytes). */
    reserved?: () => number;
    /** Proton's Windows app also reads the user every 5 minutes. */
    intervalMs?: number;
    /** After a change: wait this long, so that a burst of changes makes one request. */
    debounceMs?: number;
    /** At most one request per this period for changes. */
    minGapMs?: number;
    now?: () => number;
};

export class StorageMonitor implements StorageReadings {
    private readonly options: Required<Omit<StorageMonitorOptions, 'onSpaceFreed' | 'reserved'>> &
        Pick<StorageMonitorOptions, 'onSpaceFreed' | 'reserved'>;
    private current?: Storage;
    private running = false;
    /** Bumped by start and stop: a request started before must not apply its answer. */
    private generation = 0;
    private interval?: ReturnType<typeof setInterval>;
    private timer?: ReturnType<typeof setTimeout>;
    private lastFetch = Number.NEGATIVE_INFINITY;
    private fetching?: Promise<void>;
    private fetchingGeneration = 0;
    /** A refresh was asked while a request was in flight: its answer may predate the change. */
    private refreshAgain = false;
    private quotaErrorPending = false;
    /** Free bytes, less those reserved, when an upload was refused for quota. */
    private availableAtQuotaError?: number;
    /** Readings started so far: each reading's number. */
    private readingsStarted = 0;
    /** The number of the reading `current` comes from. */
    private appliedReading = 0;

    constructor(options: StorageMonitorOptions) {
        this.options = { intervalMs: 5 * 60 * 1000, debounceMs: 2000, minGapMs: 30 * 1000, now: Date.now, ...options };
    }

    /** Undefined while unknown, or when the account has no limit. */
    get(): Storage | undefined {
        return this.current;
    }

    latest(): { free: number | undefined; reading: number } {
        return { free: this.current && this.current.max - this.current.used, reading: this.appliedReading };
    }

    nextReading(): number {
        return this.readingsStarted + 1;
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
        this.refreshAgain = false;
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

    /**
     * An upload was refused for lack of space: by Proton (the next reading tells how much
     * was free), or by DriveService before it started, with the bytes it counted as free.
     */
    quotaExceeded(available?: number): void {
        if (!this.running) {
            return;
        }
        if (available === undefined) {
            this.quotaErrorPending = true;
        } else {
            this.availableAtQuotaError = available;
        }
        this.changed();
    }

    /** For tests: resolves once no request is in progress, including a follow-up one. */
    async settled(): Promise<void> {
        while (this.fetching) {
            await this.fetching;
        }
    }

    private refresh(): Promise<void> {
        const generation = this.generation;
        // A request from before a stop belongs to another session: never reuse it.
        if (this.fetching && this.fetchingGeneration === generation) {
            this.refreshAgain = true;
            return this.fetching;
        }
        this.lastFetch = this.options.now();
        const quotaError = this.quotaErrorPending;
        this.quotaErrorPending = false;
        this.fetchingGeneration = generation;
        const reading = ++this.readingsStarted;
        const fetching: Promise<void> = this.fetchOnce(generation, quotaError, reading).finally(() => {
            if (this.fetching !== fetching) {
                return;
            }
            this.fetching = undefined;
            if (this.refreshAgain && generation === this.generation) {
                this.refreshAgain = false;
                void this.refresh();
            }
        });
        this.fetching = fetching;
        return fetching;
    }

    private async fetchOnce(generation: number, quotaError: boolean, reading: number): Promise<void> {
        try {
            const storage = await this.options.fetch();
            if (generation === this.generation) {
                this.apply(storage, quotaError, reading);
            }
        } catch (error: unknown) {
            if (generation === this.generation) {
                this.quotaErrorPending ||= quotaError;
            }
            this.options.logger.debug(`Failed to read the storage quota: ${error}`);
        }
    }

    private apply(storage: Storage, quotaError: boolean, reading: number): void {
        const known = storage.max > 0 ? storage : undefined;
        this.appliedReading = reading;
        if (known?.used !== this.current?.used || known?.max !== this.current?.max) {
            this.options.logger.debug(known ? `Storage: ${known.used} of ${known.max} bytes used` : 'Storage: no limit reported');
            this.current = known;
            this.options.onChange(known);
        }
        // Less what uploads hold: a reading made while they run does not count them yet.
        const available = known ? known.max - known.used - (this.options.reserved?.() ?? 0) : 0;
        if (quotaError) {
            this.availableAtQuotaError = available;
        } else if (this.availableAtQuotaError !== undefined && available > this.availableAtQuotaError) {
            this.availableAtQuotaError = undefined;
            this.options.logger.info('Storage space was freed; syncing again');
            this.options.onSpaceFreed?.();
        }
    }
}
