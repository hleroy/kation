// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { TransferPool } from '../src/sync/transferPool';

/** A job that runs until released, counting how many run at once. */
function jobs() {
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const job = () => async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running--;
    };
    const releaseOne = async () => {
        releases.shift()?.();
        await Bun.sleep(1);
    };
    return { job, releaseOne, running: () => running, peak: () => peak, waiting: () => releases.length };
}

describe('TransferPool', () => {
    it('runs at most its limit of jobs at once', async () => {
        const pool = new TransferPool(3);
        const work = jobs();
        const feeding = (async () => {
            for (let i = 0; i < 10; i++) {
                await pool.run(work.job());
            }
        })();
        await Bun.sleep(1);
        expect(work.running()).toBe(3);
        while (work.waiting() > 0) {
            await work.releaseOne();
        }
        await feeding;
        await pool.drain();
        expect(work.peak()).toBe(3);
        expect(pool.size).toBe(0);
    });

    it('makes the caller wait for a free slot', async () => {
        const pool = new TransferPool(1);
        const work = jobs();
        await pool.run(work.job());
        let started = false;
        const second = pool.run(work.job()).then(() => {
            started = true;
        });
        await Bun.sleep(1);
        expect(started).toBe(false);
        await work.releaseOne();
        await second;
        expect(started).toBe(true);
        await work.releaseOne();
        await pool.drain();
    });

    it('returns before the job ends, and settles done as the job does', async () => {
        const pool = new TransferPool(2);
        const { done: ok } = await pool.run(async () => {
            await Bun.sleep(5);
            return 42;
        });
        const { done: failed } = await pool.run(async () => {
            throw new Error('boom');
        });
        await expect(failed).rejects.toThrow('boom');
        expect(await ok).toBe(42);
    });

    it('frees the slot of a failed job and keeps running the others', async () => {
        const pool = new TransferPool(1);
        const first = await pool.run(() => Promise.reject(new Error('first')));
        const second = await pool.run(async () => 'second');
        await expect(first.done).rejects.toThrow('first');
        expect(await second.done).toBe('second');
    });

    it('catches a job that throws before returning a promise', async () => {
        const pool = new TransferPool(1);
        const { done } = await pool.run((): Promise<void> => {
            throw new Error('sync');
        });
        await expect(done).rejects.toThrow('sync');
        expect(pool.size).toBe(0);
    });

    it('starts nothing once aborted, wakes callers waiting for a slot, and aborts the jobs signal', async () => {
        const pool = new TransferPool(1);
        const work = jobs();
        let seen: AbortSignal | undefined;
        await pool.run(async () => {
            seen = pool.signal;
            await work.job()();
        });
        const waiting = pool.run(work.job());
        const reason = new Error('stop');
        pool.abort(reason);
        await expect(waiting).rejects.toBe(reason);
        await expect(pool.run(work.job())).rejects.toBe(reason);
        expect(seen?.aborted).toBe(true);
        expect(work.peak()).toBe(1);
        // A running job is not stopped by the pool itself: drain waits for it.
        let drained = false;
        const draining = pool.drain().then(() => {
            drained = true;
        });
        await Bun.sleep(1);
        expect(drained).toBe(false);
        await work.releaseOne();
        await draining;
        expect(drained).toBe(true);
    });

    it('follows the signal it is given', async () => {
        const parent = new AbortController();
        const pool = new TransferPool(2, parent.signal);
        parent.abort(new Error('paused'));
        expect(pool.signal.aborted).toBe(true);
        await expect(pool.run(async () => {})).rejects.toThrow('paused');
    });

    it('drains jobs started while draining', async () => {
        const pool = new TransferPool(2);
        let second = false;
        await pool.run(async () => {
            await Bun.sleep(5);
            await pool.run(async () => {
                await Bun.sleep(5);
                second = true;
            });
        });
        await pool.drain();
        expect(second).toBe(true);
    });
});
