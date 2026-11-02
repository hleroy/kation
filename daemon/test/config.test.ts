// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'bun:test';

import { LogLevel } from '@protontech/drive-sdk/telemetry';

import { CredentialsStoreType, getConfig } from '../src/config';

const base = { appVersion: 'external-drive-kation@0.1.0-alpha', sdkVersion: 'js@0.22.2', home: '/home/alice' };

describe('getConfig', () => {
    it('uses XDG defaults under the home folder', () => {
        const config = getConfig({ ...base, env: {} });
        expect(config.cacheDir).toBe('/home/alice/.cache/kation');
        expect(config.appDir).toBe('/home/alice/.local/share/kation');
        expect(config.logDir).toBe('/home/alice/.local/state/kation');
    });

    it('honours XDG variables', () => {
        const config = getConfig({
            ...base,
            env: { XDG_CACHE_HOME: '/c', XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' },
        });
        expect([config.cacheDir, config.appDir, config.logDir]).toEqual(['/c/kation', '/d/kation', '/s/kation']);
    });

    it('identifies as a third-party client on official endpoints', () => {
        const config = getConfig({ ...base, env: {} });
        expect(config.authClientId).toBe('external-drive');
        expect(config.baseUrl).toBe('drive-api.proton.me');
        expect(config.accountUrl).toBe('account.proton.me');
    });

    it('defaults to the system keyring and INFO logs', () => {
        const config = getConfig({ ...base, env: {} });
        expect(config.credentialsStore).toBe(CredentialsStoreType.Keychain);
        expect(config.logLevel).toBe(LogLevel.INFO);
        expect(config.unsafeCache).toBe(false);
    });

    it('accepts and validates KATION_CREDENTIALS_STORE', () => {
        expect(getConfig({ ...base, env: { KATION_CREDENTIALS_STORE: 'PASS' } }).credentialsStore).toBe(CredentialsStoreType.Pass);
        expect(() => getConfig({ ...base, env: { KATION_CREDENTIALS_STORE: 'nope' } })).toThrow('Invalid KATION_CREDENTIALS_STORE');
    });
});
