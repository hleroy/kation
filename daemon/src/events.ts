// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Polls Drive events for the volumes kationd follows ("My files"), from the
 * cursors kept by the events provider, and passes each event on.
 *
 * Built on the SDK's iterateEvents, which takes an abort signal, so polling
 * really ends at sign-out. The SDK's older subscribe API (and its
 * EventScheduler) keep polling once started, with requests that fail with 401
 * after the session is gone.
 */

import { type DriveEvent, DriveEventType, type Logger, type ProtonDriveClient } from '@protontech/drive-sdk';

import type { EventsProvider } from './proton/events';

/** Same rate as the SDK uses for your own volume. */
const POLL_INTERVAL_MS = 30 * 1000;
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;
const JITTER_MS = 1000;

export type EventsSdk = Pick<ProtonDriveClient, 'iterateEvents'>;
export type EventObserver = (event: DriveEvent) => void;

export type EventPollerOptions = {
    pollIntervalMs?: number;
    maxRetryDelayMs?: number;
};

type Scope = { timer?: ReturnType<typeof setTimeout>; failures: number };

export class EventPoller {
    private readonly scopes = new Map<string, Scope>();
    private readonly polls = new Set<Promise<void>>();
    private abort?: AbortController;
    private readonly pollIntervalMs: number;
    private readonly maxRetryDelayMs: number;

    constructor(
        private readonly logger: Logger,
        private readonly sdk: EventsSdk,
        private readonly provider: EventsProvider,
        private readonly observer?: EventObserver,
        options: EventPollerOptions = {},
    ) {
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        this.maxRetryDelayMs = options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    }

    get running(): boolean {
        return !!this.abort;
    }

    /**
     * Starts polling the Drive volumes that have a stored cursor. Does nothing
     * when another kationd holds the events lock, or when already running.
     */
    start(): void {
        if (this.abort || !this.provider.canListenForEvents()) {
            return;
        }
        this.abort = new AbortController();
        for (const { context, treeEventScopeIds } of this.provider.getInitialSubscriptionScopeIds()) {
            // Kation follows Drive volumes only; "core" was used by the SDK's older API.
            if (context !== 'drive') {
                continue;
            }
            for (const scopeId of treeEventScopeIds) {
                if (scopeId !== 'core') {
                    this.addScope(scopeId);
                }
            }
        }
    }

    /** Follows one more volume, polled at once. Ignored when not running. */
    addScope(treeEventScopeId: string): void {
        if (!this.abort || this.scopes.has(treeEventScopeId)) {
            return;
        }
        this.scopes.set(treeEventScopeId, { failures: 0 });
        this.schedule(treeEventScopeId, 0);
    }

    /** Stops polling and waits for running requests to end. Cursors are kept. */
    async stop(): Promise<void> {
        if (!this.abort) {
            return;
        }
        this.abort.abort();
        this.abort = undefined;
        for (const scope of this.scopes.values()) {
            clearTimeout(scope.timer);
        }
        this.scopes.clear();
        await Promise.allSettled([...this.polls]);
    }

    /** Stops polling and forgets the cursors (sign-out). */
    async clear(): Promise<void> {
        await this.stop();
        await this.provider.clear();
    }

    private schedule(scopeId: string, delayMs: number): void {
        const scope = this.scopes.get(scopeId);
        const signal = this.abort?.signal;
        if (!scope || !signal) {
            return;
        }
        scope.timer = setTimeout(() => {
            const poll = this.pollScope(scopeId, scope, signal);
            this.polls.add(poll);
            void poll.finally(() => this.polls.delete(poll));
        }, delayMs);
    }

    private async pollScope(scopeId: string, scope: Scope, signal: AbortSignal): Promise<void> {
        let removed = false;
        try {
            removed = await this.readEvents(scopeId, signal);
            scope.failures = 0;
        } catch (error: unknown) {
            if (signal.aborted) {
                return;
            }
            scope.failures++;
            this.logger.warn(`Failed to read Drive events for ${scopeId}: ${error instanceof Error ? error.message : error}`);
        }
        if (signal.aborted || removed) {
            return;
        }
        const delay =
            scope.failures === 0 ? this.pollIntervalMs : Math.min(this.pollIntervalMs * 2 ** scope.failures, this.maxRetryDelayMs);
        this.schedule(scopeId, delay + Math.random() * Math.min(JITTER_MS, this.pollIntervalMs));
    }

    /** Reads the new events of one volume. Returns true when the volume is gone. */
    private async readEvents(scopeId: string, signal: AbortSignal): Promise<boolean> {
        const lastEventId = (await this.provider.getLatestEventId(scopeId)) ?? undefined;
        for await (const event of this.sdk.iterateEvents(scopeId, lastEventId, signal)) {
            if (signal.aborted) {
                return false;
            }
            if (event.type === DriveEventType.TreeRemove) {
                this.logger.info(`Drive events for ${scopeId} are no longer available`);
                this.scopes.delete(scopeId);
                await this.provider.removeScope('drive', scopeId);
                return true;
            }
            await this.provider.setLatestEventId('drive', scopeId, event.eventId);
            try {
                this.observer?.(event);
            } catch (error: unknown) {
                this.logger.error(`Event observer failed for ${event.type}`, error);
            }
        }
        return false;
    }
}
