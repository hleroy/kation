// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { ReportingStore } from '../src/keyring';
import { silentLogger } from './helpers';

const snapshot = { userKeyPassword: 'k', session: { uid: 'u', accessToken: 'a' } };

describe('ReportingStore', () => {
    it('starts signed out and explains why when the keyring fails', async () => {
        const store = new ReportingStore(
            {
                load: async () => {
                    throw new Error('libsecret not available');
                },
                save: async () => {
                    throw new Error('libsecret not available');
                },
                remove: async () => {
                    throw new Error('libsecret not available');
                },
            },
            silentLogger,
        );
        expect(await store.load()).toBeNull();
        expect(store.problem).toMatchObject({ code: 'keyring', detail: 'libsecret not available' });
        expect(store.problem?.message).toContain('KDE Wallet');
        await expect(store.save(snapshot)).rejects.toMatchObject({ code: 'Failed' });
        await store.remove();
    });

    it('passes through a working keyring and clears the problem', async () => {
        let saved: unknown = null;
        const store = new ReportingStore(
            {
                load: async () => null,
                save: async (value) => {
                    saved = value;
                },
                remove: async () => {},
            },
            silentLogger,
        );
        store.problem = { code: 'keyring', message: 'old', detail: '' };
        await store.save(snapshot);
        expect(saved).toEqual(snapshot);
        expect(store.problem).toBeUndefined();
    });
});
