// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { FakeAccount } from '../src/service/fakeDrive';
import { Session, type Status } from '../src/service/session';
import { silentLogger } from './helpers';

const versions = { appVersion: 'external-drive-kation@0.1.0-alpha', sdkVersion: 'js@0.22.2' };

function createSession(loggedIn: boolean) {
    const account = new FakeAccount(loggedIn, 30);
    const events: string[] = [];
    const statuses: Status[] = [];
    const finished: [boolean, string][] = [];
    const session = new Session(account, versions, silentLogger, {
        statusChanged: (status) => statuses.push(status),
        loginFinished: (success, message) => finished.push([success, message]),
        afterLogin: async () => {
            events.push('afterLogin');
        },
        afterLogout: async () => {
            events.push('afterLogout');
        },
        sessionLost: async () => {
            events.push('sessionLost');
        },
    });
    return { session, account, events, statuses, finished };
}

describe('Session', () => {
    it('signs in through the browser flow', async () => {
        const { session, events, statuses, finished } = createSession(false);
        await session.init();
        expect(() => session.requireLogin()).toThrow('Not signed in');

        const url = await session.startLogin();
        expect(url).toStartWith('https://account.proton.me/');
        expect(session.status()).toMatchObject({ loginPending: true, signInUrl: url, loggedIn: false });
        expect(await session.startLogin()).toBe(url);

        await Bun.sleep(60);
        expect(finished).toEqual([[true, '']]);
        expect(events).toEqual(['afterLogin']);
        expect(session.status()).toMatchObject({ loggedIn: true, email: 'tester@example.com', loginPending: false, signInUrl: '' });
        expect(statuses.at(-1)?.loggedIn).toBe(true);
    });

    it('can cancel a pending sign-in', async () => {
        const { session, finished } = createSession(false);
        await session.startLogin();
        session.cancelLogin();
        await Bun.sleep(10);
        expect(finished).toEqual([[false, 'Sign-in cancelled']]);
        expect(session.status()).toMatchObject({ loggedIn: false, loginPending: false });
    });

    it('refuses to sign in twice and signs out', async () => {
        const { session, events, statuses } = createSession(true);
        await session.init();
        expect(session.status().email).toBe('tester@example.com');
        await expect(session.startLogin()).rejects.toMatchObject({ code: 'InvalidArgument' });
        await session.logout();
        expect(events).toEqual(['afterLogout']);
        expect(statuses.at(-1)).toMatchObject({ loggedIn: false, email: '' });
    });

    it('reports a session that Proton ended, and clears it after signing in again', async () => {
        const { session, account, events, statuses } = createSession(true);
        await session.init();
        account.expireSession();
        expect(events).toEqual(['sessionLost']);
        expect(statuses.at(-1)).toMatchObject({ loggedIn: false, email: '' });
        expect(statuses.at(-1)?.problem).toContain('session ended');
        expect(statuses.at(-1)).toMatchObject({ problemCode: 'sessionLost', problemDetail: '' });
        expect(() => session.requireLogin()).toThrow('Not signed in');

        await session.startLogin();
        await Bun.sleep(60);
        expect(session.status()).toMatchObject({ loggedIn: true, problem: '', problemCode: '' });
    });

    it('does not report an explicit sign-out as a lost session', async () => {
        const { session, events } = createSession(true);
        await session.init();
        await session.logout();
        expect(events).toEqual(['afterLogout']);
        expect(session.status().problem).toBe('');
    });
});
