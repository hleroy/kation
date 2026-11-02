// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Logger } from '@protontech/drive-sdk';

import type { CredentialsStore } from './proton/credentials';
import type { Credentials as StoredCredentials } from './proton/credentials/interface';
import { KationError } from './service/errors';
import type { Problem } from './service/session';

export const KEYRING_HELP =
    'Kation cannot use your keyring to keep you signed in. On Plasma, enable ' +
    'System Settings → KDE Wallet → “Use KWallet for the Secret Service interface”, then try again.';

/**
 * Wraps the session store so a missing or locked keyring does not stop
 * kationd from starting. Load failures leave you signed out and are reported
 * through `problem`; save failures make the sign-in fail with a clear message.
 */
export class ReportingStore implements CredentialsStore {
    problem?: Problem;

    constructor(
        private readonly inner: CredentialsStore,
        private readonly logger: Logger,
    ) {}

    async load(): Promise<StoredCredentials | null> {
        try {
            const credentials = await this.inner.load();
            this.problem = undefined;
            return credentials;
        } catch (error: unknown) {
            this.logger.error('Failed to load the session from the keyring', error);
            this.problem = keyringProblem(error);
            return null;
        }
    }

    async save(snapshot: StoredCredentials): Promise<void> {
        try {
            await this.inner.save(snapshot);
            this.problem = undefined;
        } catch (error: unknown) {
            this.logger.error('Failed to save the session to the keyring', error);
            this.problem = keyringProblem(error);
            throw new KationError('Failed', this.problem.message, { cause: error });
        }
    }

    async remove(): Promise<void> {
        try {
            await this.inner.remove();
        } catch (error: unknown) {
            this.logger.warn(`Failed to remove the session from the keyring: ${errorMessage(error)}`);
        }
    }
}

function keyringProblem(error: unknown): Problem {
    const detail = errorMessage(error);
    return { code: 'keyring', message: `${KEYRING_HELP} (${detail})`, detail };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
