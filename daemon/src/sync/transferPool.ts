// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Runs at most `limit` async jobs at once. `run` waits for a free slot before
 * starting a job, so whoever feeds the pool never gets far ahead of it.
 */
export class TransferPool {
    private readonly active = new Set<Promise<unknown>>();
    private readonly slotWaiters: (() => void)[] = [];
    private readonly controller = new AbortController();
    /** Aborted by `abort`, or when the signal given to the constructor is. Jobs pass it on to their transfers. */
    readonly signal: AbortSignal;

    constructor(
        private readonly limit: number,
        parent?: AbortSignal,
    ) {
        this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
        this.signal.addEventListener('abort', () => this.wakeAll(), { once: true });
    }

    /**
     * Waits for a free slot, then starts `job` and returns without waiting for it:
     * `done` settles as the job does. Once the pool is aborted, starts nothing and
     * throws the signal's reason.
     */
    async run<T>(job: () => Promise<T>): Promise<{ done: Promise<T> }> {
        while (this.active.size >= this.limit && !this.signal.aborted) {
            await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
        }
        this.signal.throwIfAborted();
        const done = (async () => job())();
        const tracked = done.then(
            () => {},
            () => {},
        );
        this.active.add(tracked);
        void tracked.then(() => {
            this.active.delete(tracked);
            this.slotWaiters.shift()?.();
        });
        return { done };
    }

    /** Aborts the pool's signal: no new job starts, and running jobs see their signal aborted. */
    abort(reason: unknown): void {
        this.controller.abort(reason);
    }

    /** Resolves once no job is running, including jobs that start meanwhile. Never rejects. */
    async drain(): Promise<void> {
        while (this.active.size > 0) {
            await Promise.all(this.active);
        }
    }

    /** Jobs running now. */
    get size(): number {
        return this.active.size;
    }

    private wakeAll(): void {
        for (const wake of this.slotWaiters.splice(0)) {
            wake();
        }
    }
}
