// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { type DriveEvent, DriveEventType } from '@protontech/drive-sdk';
import { getMockLogger } from '@protontech/drive-sdk/tests/logger';

import { EventPoller, type EventsSdk } from '../src/events';
import { MemoryEventsProvider, NoEventsProvider } from '../src/proton/events';

type Call = { scope: string; lastEventId?: string; signal?: AbortSignal };
type Reply = DriveEvent[] | Error | 'hang';

/** iterateEvents that answers from `reply` and records each call. */
function fakeSdk(reply: (call: Call) => Reply) {
    const calls: Call[] = [];
    const sdk: EventsSdk = {
        async *iterateEvents(scope: string, lastEventId?: string, signal?: AbortSignal) {
            const call = { scope, lastEventId, signal };
            calls.push(call);
            const answer = reply(call);
            if (answer === 'hang') {
                await new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('aborted')));
                });
                return;
            }
            if (answer instanceof Error) {
                throw answer;
            }
            yield* answer;
        },
    };
    return { sdk, calls };
}

function nodeCreated(scope: string, eventId: string): DriveEvent {
    return {
        type: DriveEventType.NodeCreated,
        nodeUid: 'n',
        parentNodeUid: 'p',
        isTrashed: false,
        isShared: false,
        treeEventScopeId: scope,
        eventId,
    };
}

const fast = { pollIntervalMs: 20, maxRetryDelayMs: 40 };

describe('EventPoller', () => {
    it('does nothing when another kationd holds the events lock', async () => {
        const { sdk, calls } = fakeSdk(() => []);
        const poller = new EventPoller(getMockLogger(), sdk, new NoEventsProvider(), undefined, fast);
        poller.start();
        poller.addScope('vol');
        await Bun.sleep(50);
        expect(calls).toEqual([]);
        expect(poller.running).toBe(false);
    });

    it('polls the stored volumes from their cursor, stores new cursors and passes events on', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'vol', 'e0');
        const seen: DriveEvent[] = [];
        let n = 0;
        const { sdk, calls } = fakeSdk(() => (n++ === 0 ? [nodeCreated('vol', 'e1'), nodeCreated('vol', 'e2')] : []));
        const poller = new EventPoller(getMockLogger(), sdk, provider, (event) => seen.push(event), fast);

        poller.start();
        await Bun.sleep(70);
        await poller.stop();

        expect(calls[0]).toMatchObject({ scope: 'vol', lastEventId: 'e0' });
        expect(calls[1]).toMatchObject({ scope: 'vol', lastEventId: 'e2' });
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(seen.map((event) => event.eventId)).toEqual(['e1', 'e2']);
        expect(await provider.getLatestEventId('vol')).toBe('e2');
    });

    it('starts a new volume from the latest event', async () => {
        const provider = new MemoryEventsProvider();
        const { sdk, calls } = fakeSdk(() => [{ type: DriveEventType.FastForward, treeEventScopeId: 'vol', eventId: 'latest' }]);
        const poller = new EventPoller(getMockLogger(), sdk, provider, undefined, fast);

        poller.start();
        poller.addScope('vol');
        await Bun.sleep(10);
        await poller.stop();

        expect(calls[0]).toMatchObject({ scope: 'vol', lastEventId: undefined });
        expect(await provider.getLatestEventId('vol')).toBe('latest');
    });

    it('ignores the core and Photos scopes of the older API', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'core', 'c');
        await provider.setLatestEventId('photos', 'pics', 'p');
        await provider.setLatestEventId('drive', 'vol', 'v');
        const { sdk, calls } = fakeSdk(() => []);
        const poller = new EventPoller(getMockLogger(), sdk, provider, undefined, fast);

        poller.start();
        await Bun.sleep(10);
        await poller.stop();

        expect(new Set(calls.map((call) => call.scope))).toEqual(new Set(['vol']));
    });

    it('stops polling, aborting the request in progress, and starts again', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'vol', 'e0');
        const { sdk, calls } = fakeSdk(() => 'hang');
        const poller = new EventPoller(getMockLogger(), sdk, provider, undefined, fast);

        poller.start();
        await Bun.sleep(10);
        expect(calls).toHaveLength(1);
        await poller.stop();
        expect(calls[0].signal?.aborted).toBe(true);
        expect(poller.running).toBe(false);

        await Bun.sleep(80);
        expect(calls).toHaveLength(1);

        poller.start();
        await Bun.sleep(10);
        await poller.stop();
        expect(calls).toHaveLength(2);
    });

    it('forgets the cursors on clear (sign-out)', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'vol', 'e0');
        const { sdk } = fakeSdk(() => []);
        const poller = new EventPoller(getMockLogger(), sdk, provider, undefined, fast);

        poller.start();
        await poller.clear();

        expect(await provider.getLatestEventId('vol')).toBeNull();
        expect(poller.running).toBe(false);
    });

    it('stops following a volume that is gone', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'vol', 'e0');
        const { sdk, calls } = fakeSdk(() => [{ type: DriveEventType.TreeRemove, treeEventScopeId: 'vol', eventId: 'none' }]);
        const poller = new EventPoller(getMockLogger(), sdk, provider, undefined, fast);

        poller.start();
        await Bun.sleep(70);
        await poller.stop();

        expect(calls).toHaveLength(1);
        expect(await provider.getLatestEventId('vol')).toBeNull();
    });

    it('keeps polling after errors, more slowly', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'vol', 'e0');
        const { sdk, calls } = fakeSdk(() => new Error('401 Unauthorized'));
        const poller = new EventPoller(getMockLogger(), sdk, provider, undefined, fast);

        poller.start();
        await Bun.sleep(150);
        await poller.stop();

        // Without backoff it would have polled every 20 ms.
        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls.length).toBeLessThanOrEqual(5);
    });

    it('keeps going when the observer throws', async () => {
        const provider = new MemoryEventsProvider();
        await provider.setLatestEventId('drive', 'vol', 'e0');
        const { sdk } = fakeSdk(() => [nodeCreated('vol', 'e1')]);
        const poller = new EventPoller(
            getMockLogger(),
            sdk,
            provider,
            () => {
                throw new Error('observer');
            },
            fast,
        );

        poller.start();
        await Bun.sleep(10);
        await poller.stop();

        expect(await provider.getLatestEventId('vol')).toBe('e1');
    });
});
