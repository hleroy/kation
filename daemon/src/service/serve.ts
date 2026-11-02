// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * `kationd serve`: the long-running D-Bus service the KDE components use.
 * Normally started by D-Bus activation on first use.
 */

import type { DriveEvent, Logger } from '@protontech/drive-sdk';
import dbus from 'dbus-next';

import type { Config } from '../config';
import { openDrive } from '../drive';
import { Autostart } from '../sync/autostart';
import { SyncController } from '../sync/controller';
import { initTelemetry } from '../telemetry';
import { DriveDbusServer } from './dbusServer';
import { DriveService } from './driveService';
import { FakeAccount, FakeDrive } from './fakeDrive';
import type { Account, DriveSdk } from './sdk';
import { type Problem, Session } from './session';
import { DriveTree } from './tree';

export type ServeOptions = {
    config: Config;
    /** Serve an in-memory drive instead of Proton Drive. For tests only. */
    fakeDrive?: boolean;
};

type Backend = {
    sdk: DriveSdk;
    account: Account;
    logger: Logger;
    problem: () => Problem | undefined;
    /** Called after sign-in, and at start when already signed in. */
    startEvents: () => Promise<void>;
    /** Called when Proton ends the session: nothing can be read until the next sign-in. */
    stopEvents: () => Promise<void>;
    clearLocalData: () => Promise<void>;
    dispose: () => Promise<void>;
};

export async function serve(options: ServeOptions): Promise<void> {
    let onEvent: (event: DriveEvent) => void = () => {};
    const backend = options.fakeDrive
        ? createFakeBackend(options.config, (event) => onEvent(event))
        : await createProtonBackend(options.config, (event) => onEvent(event));
    const { logger } = backend;

    const tree = new DriveTree(backend.sdk, logger);
    const drive = new DriveService(backend.sdk, tree, logger);
    const bus = dbus.sessionBus();
    let server: DriveDbusServer | undefined;
    const sync = new SyncController({
        config: options.config,
        drive,
        tree,
        sdk: backend.sdk,
        logger,
        isLoggedIn: () => backend.account.isLoggedIn(),
        onStatus: (status) => server?.emitSyncStatusChanged(status),
        onActivity: (activity) => server?.emitSyncActivity(activity),
        onItemsChanged: (paths) => server?.emitItemStatesChanged(paths),
        // The fake drive is for tests: never touch the real login setup.
        autostart: options.fakeDrive
            ? undefined
            : (enabled) =>
                  new Autostart({ configDir: options.config.configDir, runtimeDir: process.env.XDG_RUNTIME_DIR, logger }).set(enabled),
        engineOptions: options.fakeDrive ? { settleMs: Number(process.env.KATION_FAKE_SETTLE_MS ?? 2000) } : {},
    });

    const session = new Session(
        backend.account,
        { appVersion: options.config.appVersion, sdkVersion: options.config.sdkVersion ?? '' },
        logger,
        {
            statusChanged: (status) => server?.emitStatusChanged(status),
            loginFinished: (success, message) => server?.emitLoginFinished(success, message),
            afterLogin: async () => {
                tree.clear();
                await backend.startEvents();
                await sync.apply();
            },
            afterLogout: async () => {
                await sync.onLogout();
                tree.clear();
                await backend.clearLocalData();
            },
            sessionLost: async () => {
                // Keep the sync state and event cursors: signing in again to the same account resumes where it stopped.
                await backend.stopEvents();
                await sync.onSessionLost();
                tree.clear();
            },
            problem: backend.problem,
        },
    );
    await session.init();

    server = new DriveDbusServer(bus, session, drive, sync, logger);
    onEvent = (event) => {
        const changed = tree.applyEvent(event);
        if (changed.length > 0) {
            server?.notifyFolderChanged(changed);
        }
        sync.onRemoteEvent(event);
    };
    await server.start();
    if (session.isLoggedIn()) {
        await backend.startEvents().catch((error: unknown) => logger.error('Failed to start Drive events', error));
    }
    await sync.applyAutostart();
    await sync.apply();

    const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
    let busClosed = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => stop());
    }
    bus.on('error', (error: unknown) => {
        logger.error('Session bus error', error);
        stop();
    });
    // MessageBus does not forward the end of its connection; without this,
    // kationd would keep running (and spinning) after the session ends.
    const connection = (bus as unknown as { _connection?: NodeJS.EventEmitter })._connection;
    connection?.on('end', () => {
        logger.info('Session bus connection closed');
        busClosed = true;
        stop();
    });

    await stopped;
    logger.info('Stopping');
    await server.stop(busClosed);
    await sync.dispose();
    await backend.dispose();
    if (!busClosed) {
        bus.disconnect();
    }
}

async function createProtonBackend(config: Config, onEvent: (event: DriveEvent) => void): Promise<Backend> {
    const drive = await openDrive(config, { onEvent });
    return {
        sdk: drive.sdk,
        logger: drive.logger,
        problem: drive.problem,
        account: {
            isLoggedIn: () => drive.auth.isLoggedIn(),
            getEmail: async () => (await drive.addresses.getOwnPrimaryAddress()).email,
            authViaWeb: async (onSignInUrl, signal) => {
                await drive.auth.authViaWeb(onSignInUrl, signal);
            },
            logout: () => drive.signOut(),
            onSessionChanged: (listener) => drive.onSessionChanged(listener),
        },
        startEvents: async () => {
            drive.events.start();
            // Changes inside "My files" arrive on its volume's event scope.
            const root = await drive.sdk.getMyFilesRootFolder();
            drive.events.addScope(root.treeEventScopeId);
        },
        stopEvents: () => drive.events.stop(),
        // signOut (via logout) already clears the SDK caches and event cursors.
        clearLocalData: async () => {},
        dispose: () => drive.dispose(),
    };
}

function createFakeBackend(config: Config, onEvent: (event: DriveEvent) => void): Backend {
    const { telemetry, flush } = initTelemetry(config);
    const logger = telemetry.getLogger('kationd');
    logger.warn('Serving a fake in-memory drive (--fake-drive). No data reaches Proton.');
    const fake = new FakeDrive({ chunkDelayMs: Number(process.env.KATION_FAKE_CHUNK_DELAY_MS) || 0, onEvent });
    return {
        sdk: fake.sdk,
        logger,
        // Tests set a problem: KATION_FAKE_PROBLEM (message), _CODE (default "keyring") and _DETAIL.
        problem: () =>
            process.env.KATION_FAKE_PROBLEM
                ? {
                      code: (process.env.KATION_FAKE_PROBLEM_CODE as Problem['code']) || 'keyring',
                      message: process.env.KATION_FAKE_PROBLEM,
                      detail: process.env.KATION_FAKE_PROBLEM_DETAIL ?? '',
                  }
                : undefined,
        account: new FakeAccount(process.env.KATION_FAKE_LOGGED_IN !== '0', Number(process.env.KATION_FAKE_LOGIN_DELAY_MS) || 1000),
        startEvents: async () => {},
        stopEvents: async () => {},
        clearLocalData: async () => {},
        dispose: flush,
    };
}
