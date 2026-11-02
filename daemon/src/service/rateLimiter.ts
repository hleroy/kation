// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Limits the average speed of transfers in one direction. Shared by every
 * transfer in that direction, so the limit holds for the total.
 */
export class RateLimiter {
    private bytesPerSecond = 0;
    /** Time (ms) at which the bytes already let through will have "drained". */
    private next = 0;

    constructor(
        private readonly now: () => number = () => performance.now(),
        /** Up to this much time's worth of data may pass at once. */
        private readonly burstMs = 500,
    ) {}

    /** Sets the limit in bytes per second; 0 means unlimited. */
    setLimit(bytesPerSecond: number): void {
        this.bytesPerSecond = Math.max(0, Math.floor(bytesPerSecond));
        this.next = 0;
    }

    get limit(): number {
        return this.bytesPerSecond;
    }

    /** Waits until `bytes` may be sent or written. */
    async take(bytes: number, signal?: AbortSignal): Promise<void> {
        if (this.bytesPerSecond <= 0 || bytes <= 0) {
            return;
        }
        const now = this.now();
        this.next = Math.max(this.next, now) + (bytes * 1000) / this.bytesPerSecond;
        const delay = this.next - now - this.burstMs;
        if (delay > 0) {
            await sleep(delay, signal);
        }
    }

    /** Wraps a stream so its chunks pass at the limited speed. */
    throttle(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): ReadableStream<Uint8Array> {
        return stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                transform: async (chunk, controller) => {
                    await this.take(chunk.length, signal);
                    controller.enqueue(chunk);
                },
            }),
        );
    }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal!.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
