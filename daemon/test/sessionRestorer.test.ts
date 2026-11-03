// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { FakeAccount } from '../src/service/fakeDrive';
import { type Problem, Session } from '../src/service/session';
import { SessionRestorer, type Watch } from '../src/service/sessionRestorer';
import { silentLogger } from './helpers';

const versions = { appVersion: 'external-drive-kation@0.1.0-alpha', sdkVersion: 'js@0.22.2' };

function fakeWatch() {
    let onChange: (() => void) | undefined;
    let watching = false;
    const watch: Watch = async (listener) => {
        onChange = listener;
        watching = true;
        return async () => {
            watching = false;
        };
    };
    return { watch, change: () => onChange?.(), watching: () => watching };
}

describe('SessionRestorer', () => {
    it('tries again when the keyring changes, and stops once signed in', async () => {
        const keyring = fakeWatch();
        let unlocked = false;
        let attempts = 0;
        const restorer = new SessionRestorer({
            restore: async () => {
                attempts++;
                return unlocked;
            },
            watch: keyring.watch,
            logger: silentLogger,
            retryDelaysMs: [],
            debounceMs: 5,
        });
        await restorer.start();
        expect(keyring.watching()).toBe(true);

        keyring.change();
        keyring.change();
        await Bun.sleep(20);
        expect(attempts).toBe(1);

        unlocked = true;
        keyring.change();
        await Bun.sleep(20);
        expect(attempts).toBe(2);
        expect(keyring.watching()).toBe(false);

        keyring.change();
        await Bun.sleep(20);
        expect(attempts).toBe(2);
    });

    it('retries on a schedule, and keeps retrying when watching fails', async () => {
        let attempts = 0;
        const restorer = new SessionRestorer({
            restore: async () => ++attempts === 2,
            watch: async () => {
                throw new Error('no session bus');
            },
            logger: silentLogger,
            retryDelaysMs: [5, 10, 15],
        });
        await restorer.start();
        await Bun.sleep(40);
        expect(attempts).toBe(2);
    });

    it('does nothing after stop', async () => {
        const keyring = fakeWatch();
        let attempts = 0;
        const restorer = new SessionRestorer({
            restore: async () => {
                attempts++;
                return false;
            },
            watch: keyring.watch,
            logger: silentLogger,
            retryDelaysMs: [5],
            debounceMs: 5,
        });
        await restorer.start();
        await restorer.stop();
        keyring.change();
        await Bun.sleep(20);
        expect(attempts).toBe(0);
        expect(keyring.watching()).toBe(false);
    });
});

describe('Session.restore', () => {
    it('signs in with a session that the keyring gives later', async () => {
        const account = new FakeAccount(false, 30);
        const events: string[] = [];
        const statuses: boolean[] = [];
        const session = new Session(account, versions, silentLogger, {
            statusChanged: (status) => statuses.push(status.loggedIn),
            afterRestore: async () => {
                events.push('afterRestore');
            },
        });
        await session.init();

        expect(await session.restore()).toBe(false);
        expect(events).toEqual([]);

        account.savedSession = true;
        expect(await session.restore()).toBe(true);
        expect(events).toEqual(['afterRestore']);
        expect(statuses).toEqual([true]);
        expect(session.status()).toMatchObject({ loggedIn: true, email: 'tester@example.com', problem: '' });

        expect(await session.restore()).toBe(true);
        expect(events).toEqual(['afterRestore']);
    });

    it('leaves a pending browser sign-in alone', async () => {
        const account = new FakeAccount(false, 30);
        const session = new Session(account, versions, silentLogger);
        await session.init();
        await session.startLogin();
        account.savedSession = true;
        expect(await session.restore()).toBe(false);
        session.cancelLogin();
    });

    it('cancels a browser sign-in that started while the keyring was read', async () => {
        const account = new FakeAccount(false, 30);
        const finished: [boolean, string][] = [];
        const session = new Session(account, versions, silentLogger, {
            loginFinished: (success, message) => finished.push([success, message]),
        });
        await session.init();
        account.savedSession = true;
        const load = account.loadSession.bind(account);
        account.loadSession = async () => {
            await session.startLogin();
            await load();
        };
        expect(await session.restore()).toBe(true);
        await Bun.sleep(10);
        expect(finished).toEqual([[false, 'Sign-in cancelled']]);
        expect(session.status()).toMatchObject({ loggedIn: true, loginPending: false });
    });

    it('reports a keyring problem that a retry sets or clears', async () => {
        const account = new FakeAccount(false, 30);
        let problem: Problem | undefined = { code: 'keyring', message: 'locked', detail: '' };
        const statuses: string[] = [];
        const session = new Session(account, versions, silentLogger, {
            statusChanged: (status) => statuses.push(status.problemCode),
            problem: () => problem,
        });
        await session.init();
        account.loadSession = async () => {
            problem = undefined;
        };
        expect(await session.restore()).toBe(false);
        expect(statuses).toEqual(['']);
        expect(await session.restore()).toBe(false);
        expect(statuses).toEqual(['']);
    });
});
