// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { homedir } from 'node:os';
import path from 'node:path';

import { ValidationError } from '@protontech/drive-sdk';
import { LogLevel } from '@protontech/drive-sdk/telemetry';

import { APP_DIR_NAME, CLIENT_UID_PREFIX } from './appInfo';
import { CredentialsStoreType, type Config as ProtonConfig } from './proton/config';

/**
 * Where the session is kept: `keychain` is the Secret Service (KWallet, GNOME
 * Keyring) through libsecret, `pass` a GPG-encrypted password-store entry,
 * `unsafe_file` a plaintext file for tests only.
 */
export { CredentialsStoreType };

/**
 * Runtime configuration: the Proton CLI's, which the modules in `src/proton`
 * read, plus Kation's own fields. Only the types of `proton/config.ts` are
 * used; its `getConfig` (the CLI's variables and folders) is not.
 */
export interface Config extends ProtonConfig {
    /** Settings (sync folder, exclusions). */
    configDir: string;
    /** User's home folder; the default sync folder lives there. */
    homeDir: string;
}

export type ConfigOptions = {
    appVersion: string;
    sdkVersion: string;
    enableConsoleLog?: boolean;
    env?: Record<string, string | undefined>;
    home?: string;
};

const DEFAULT_BASE_URL = 'drive-api.proton.me';
const DEFAULT_ACCOUNT_URL = 'account.proton.me';

export function getConfig(options: ConfigOptions): Config {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();

    const logLevelName = env.KATION_LOG_LEVEL?.toUpperCase() ?? 'INFO';
    const logLevel = LogLevel[logLevelName as keyof typeof LogLevel] ?? LogLevel.INFO;

    const xdgCache = env.XDG_CACHE_HOME || path.join(home, '.cache');
    const xdgData = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const xdgState = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
    const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');

    return {
        clientUidPrefix: CLIENT_UID_PREFIX,
        appVersion: options.appVersion,
        authClientId: 'external-drive',
        sdkVersion: options.sdkVersion,
        // Proton's guidelines only allow official endpoints, so these are not configurable.
        baseUrl: DEFAULT_BASE_URL,
        accountUrl: DEFAULT_ACCOUNT_URL,
        cacheDir: path.join(xdgCache, APP_DIR_NAME),
        appDir: path.join(xdgData, APP_DIR_NAME),
        logDir: path.join(xdgState, APP_DIR_NAME),
        configDir: path.join(xdgConfig, APP_DIR_NAME),
        homeDir: home,
        enablePersistedEvents: true,
        enableConsoleLog: options.enableConsoleLog ?? false,
        // Kation sends no metrics; the field belongs to the CLI's config.
        enableMetrics: false,
        logLevel,
        credentialsStore: parseCredentialsStore(env.KATION_CREDENTIALS_STORE),
        unsafeCache: false,
    };
}

function parseCredentialsStore(value: string | undefined): CredentialsStoreType {
    const normalized = value?.toLowerCase() ?? CredentialsStoreType.Keychain;
    const allowed = Object.values(CredentialsStoreType) as string[];
    if (allowed.includes(normalized)) {
        return normalized as CredentialsStoreType;
    }
    throw new ValidationError(`Invalid KATION_CREDENTIALS_STORE: ${value}. Expected one of: ${allowed.join(', ')}.`);
}
