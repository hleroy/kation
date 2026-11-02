// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Wires the Proton Drive SDK together with the account module, session
 * storage, caches and event cursors. Adapted from the Proton Drive CLI's
 * `init.ts` (MIT), without telemetry upload and Photos.
 */
import { mkdir } from 'node:fs/promises';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { FeatureFlags, type Logger, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from '@protontech/drive-sdk';

import type { Config } from './config';
import { type EventObserver, EventPoller } from './events';
import { ReportingStore } from './keyring';
import { type ApiClient, initApi } from './proton/api';
import { createCaches } from './proton/cache';
import { getOrGenerateClientUid } from './proton/clientUid';
import { initCredentials } from './proton/credentials';
import { PersistedEventsProvider } from './proton/events';
import { initTelemetry } from './telemetry';

/** Same flags as the official CLI build. */
const FEATURE_FLAGS: Partial<Record<FeatureFlags, boolean>> = {
    [FeatureFlags.DriveSmallFileUpload]: true,
};

export type Drive = Awaited<ReturnType<typeof openDrive>>;

export async function openDrive(config: Config, options: { onEvent?: EventObserver } = {}) {
    await Promise.all([
        mkdir(config.cacheDir, { recursive: true, mode: 0o700 }),
        mkdir(config.appDir, { recursive: true, mode: 0o700 }),
        mkdir(config.logDir, { recursive: true, mode: 0o700 }),
    ]);

    const { telemetry, flush: flushTelemetry } = initTelemetry(config);
    const logger: Logger = telemetry.getLogger('kationd');
    logger.info(`Starting: app=${config.appVersion} sdk=${config.sdkVersion}`);

    const openPGPCryptoModule = initOpenPGPCryptoModule();
    let store: ReportingStore | undefined;
    const credentials = initCredentials(config, logger, (inner) => (store = new ReportingStore(inner, logger)));
    const { auth, addresses, srp, httpClient, apiClient } = await initApi(config, credentials, logger, CryptoProxy);

    const clientUid = await getOrGenerateClientUid(config, logger);
    const caches = createCaches(config, credentials, logger);
    const eventsProvider = await PersistedEventsProvider.open(logger, config.appDir);

    const sdkDependencies = {
        config: { baseUrl: config.baseUrl, clientUid },
        httpClient,
        entitiesCache: caches.entitiesCache,
        cryptoCache: caches.cryptoCache,
        telemetry,
        openPGPCryptoModule,
        account: addresses,
        srpModule: srp,
        latestEventIdProvider: eventsProvider,
        featureFlagProvider: {
            isEnabled: (flag: FeatureFlags) => Promise.resolve(FEATURE_FLAGS[flag] ?? false),
        },
    };
    const sdk = new ProtonDriveClient(sdkDependencies);
    // Started by `kationd serve` while signed in; other commands do not poll.
    const events = new EventPoller(logger, sdk, eventsProvider, options.onEvent);

    return {
        config,
        logger,
        auth,
        addresses,
        sdk,
        events,
        telemetry,
        /** Calls `listener` when the session changes, including when Proton ends it. */
        onSessionChanged: (listener: () => void) => credentials.on('sessionInfoChanged', listener),
        /** Why kationd cannot work right now (e.g. no keyring), if anything. */
        problem: () => store?.problem,
        async signOut() {
            // Stop polling first: requests made after the revocation fail with 401.
            await events.stop();
            await revokeSession(apiClient, config, logger);
            await auth.logout();
            await Promise.allSettled([events.clear(), caches.cryptoCache.clear(), caches.entitiesCache.clear()]);
        },
        async dispose() {
            await events.stop();
            await eventsProvider.dispose();
            await flushTelemetry();
        },
    };
}

function initOpenPGPCryptoModule() {
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

/**
 * Ends the session on Proton's servers, as Proton's own apps do on sign-out.
 * Best effort: local data is deleted even if this fails (e.g. offline).
 */
async function revokeSession(apiClient: ApiClient, config: Config, logger: Logger): Promise<void> {
    try {
        await apiClient.authenticatedRequest.delete(`${apiClient.baseUrlWithProtocol}/core/v4/auth`, {
            timeout: 10_000,
            retry: 0,
        });
        logger.info('Session revoked on the server');
    } catch (error: unknown) {
        logger.warn(`Failed to revoke the session on the server (${config.baseUrl}): ${error}`);
    }
}
