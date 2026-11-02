// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { RateLimiter } from '../src/service/rateLimiter';

describe('RateLimiter', () => {
    it('lets everything through without a limit', async () => {
        const limiter = new RateLimiter();
        const started = performance.now();
        await limiter.take(100 * 1024 * 1024);
        expect(performance.now() - started).toBeLessThan(50);
    });

    it('keeps the average speed under the limit, after a short burst', async () => {
        const limiter = new RateLimiter(undefined, 100);
        limiter.setLimit(100_000); // 100 kB/s
        const started = performance.now();
        for (let i = 0; i < 10; i++) {
            await limiter.take(5_000); // 50 kB in total: about 0.5 s minus the 0.1 s burst
        }
        const elapsed = performance.now() - started;
        expect(elapsed).toBeGreaterThan(350);
        expect(elapsed).toBeLessThan(800);
    });

    it('stops waiting when aborted', async () => {
        const limiter = new RateLimiter(undefined, 0);
        limiter.setLimit(1000);
        const abort = new AbortController();
        setTimeout(() => abort.abort(new Error('stop')), 20);
        await expect(limiter.take(1_000_000, abort.signal)).rejects.toThrow('stop');
    });

    it('throttles a stream', async () => {
        const limiter = new RateLimiter(undefined, 0);
        limiter.setLimit(200_000);
        const chunks = Array.from({ length: 4 }, () => new Uint8Array(10_000));
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
            },
        });
        const started = performance.now();
        let total = 0;
        for await (const chunk of limiter.throttle(source) as unknown as AsyncIterable<Uint8Array>) {
            total += chunk.length;
        }
        expect(total).toBe(40_000);
        expect(performance.now() - started).toBeGreaterThan(150); // 40 kB at 200 kB/s
    });
});
