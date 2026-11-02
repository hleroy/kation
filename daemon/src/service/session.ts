// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Logger } from '@protontech/drive-sdk';

import { KationError, toKationError } from './errors';
import type { Account } from './sdk';

export type Status = {
    loggedIn: boolean;
    email: string;
    loginPending: boolean;
    signInUrl: string;
    appVersion: string;
    sdkVersion: string;
    /** Why Kation cannot work right now, in English (e.g. no keyring), or "". */
    problem: string;
    /** The same problem as a code, for the KDE side to word: see Problem. */
    problemCode: '' | Problem['code'];
    /** The underlying error, or "". */
    problemDetail: string;
};

/** Why Kation cannot work right now. */
export type Problem = {
    /** "keyring": the keyring cannot keep you signed in. "sessionLost": Proton ended the session. */
    code: 'keyring' | 'sessionLost';
    /** English text, for logs and the command line. */
    message: string;
    /** The underlying error, or "". */
    detail: string;
};

export type SessionHooks = {
    statusChanged?: (status: Status) => void;
    loginFinished?: (success: boolean, message: string) => void;
    /** Runs after a successful sign-in, before LoginFinished (e.g. start event subscriptions). */
    afterLogin?: () => Promise<void>;
    /** Runs after sign-out (e.g. clear caches). */
    afterLogout?: () => Promise<void>;
    /** Current problem to report in the status, if any. */
    problem?: () => Problem | undefined;
    /** Runs when the session ends without a sign-out (e.g. Proton rejected it). */
    sessionLost?: () => Promise<void>;
};

export const SESSION_LOST_MESSAGE = 'Your Proton session ended (it expired or was signed out elsewhere). Sign in again to continue.';

type PendingLogin = {
    abort: AbortController;
    url: Promise<string>;
    resolvedUrl?: string;
};

/** Tracks the sign-in state and runs the browser sign-in. */
export class Session {
    private email = '';
    private pending?: PendingLogin;
    private wasLoggedIn = false;
    private loggingOut = false;
    private sessionLost = false;

    constructor(
        private readonly account: Account,
        private readonly versions: { appVersion: string; sdkVersion: string },
        private readonly logger: Logger,
        private readonly hooks: SessionHooks = {},
    ) {}

    /** Loads the email of an existing session and starts watching it. */
    async init(): Promise<void> {
        this.wasLoggedIn = this.account.isLoggedIn();
        if (this.wasLoggedIn) {
            await this.loadEmail();
        }
        this.account.onSessionChanged(() => this.onSessionChanged());
    }

    private onSessionChanged(): void {
        const loggedIn = this.account.isLoggedIn();
        const lost = this.wasLoggedIn && !loggedIn && !this.loggingOut;
        this.wasLoggedIn = loggedIn;
        if (!lost) {
            return;
        }
        this.logger.warn('The Proton session ended without a sign-out; sign in again');
        this.sessionLost = true;
        this.email = '';
        this.notifyStatus();
        void this.hooks.sessionLost?.().catch((error: unknown) => this.logger.error('Failed to handle the end of the session', error));
    }

    isLoggedIn(): boolean {
        return this.account.isLoggedIn();
    }

    requireLogin(): void {
        if (!this.account.isLoggedIn()) {
            throw new KationError('NotLoggedIn', 'Not signed in to Proton Drive. Open Kation to sign in.');
        }
    }

    status(): Status {
        const sessionLost: Problem | undefined =
            this.sessionLost && !this.account.isLoggedIn() ? { code: 'sessionLost', message: SESSION_LOST_MESSAGE, detail: '' } : undefined;
        const problem = this.hooks.problem?.() ?? sessionLost;
        return {
            loggedIn: this.account.isLoggedIn(),
            email: this.account.isLoggedIn() ? this.email : '',
            loginPending: !!this.pending,
            signInUrl: this.pending?.resolvedUrl ?? '',
            ...this.versions,
            problem: problem?.message ?? '',
            problemCode: problem?.code ?? '',
            problemDetail: problem?.detail ?? '',
        };
    }

    /** Starts the browser sign-in, or returns the URL of the one in progress. */
    startLogin(): Promise<string> {
        if (this.account.isLoggedIn()) {
            return Promise.reject(new KationError('InvalidArgument', 'Already signed in. Sign out first.'));
        }
        if (this.pending) {
            return this.pending.url;
        }

        const abort = new AbortController();
        const { promise: url, resolve: resolveUrl, reject: rejectUrl } = Promise.withResolvers<string>();
        const pending: PendingLogin = { abort, url };
        this.pending = pending;

        const run = async () => {
            await this.account.authViaWeb((signInUrl) => {
                pending.resolvedUrl = signInUrl;
                resolveUrl(signInUrl);
                this.notifyStatus();
            }, abort.signal);
            this.sessionLost = false;
            this.wasLoggedIn = true;
            await this.loadEmail();
            await this.hooks.afterLogin?.();
        };

        run().then(
            () => {
                this.logger.info('Signed in');
                this.finishLogin(pending, true, '');
            },
            (error: unknown) => {
                const kationError = toKationError(error);
                if (kationError.code !== 'Cancelled') {
                    this.logger.error('Sign-in failed', error);
                }
                rejectUrl(kationError);
                this.finishLogin(pending, false, kationError.code === 'Cancelled' ? 'Sign-in cancelled' : kationError.message);
            },
        );
        return url;
    }

    cancelLogin(): void {
        this.pending?.abort.abort();
    }

    async logout(): Promise<void> {
        this.cancelLogin();
        this.loggingOut = true;
        try {
            await this.account.logout();
        } finally {
            this.loggingOut = false;
            this.wasLoggedIn = this.account.isLoggedIn();
        }
        this.sessionLost = false;
        this.email = '';
        await this.hooks.afterLogout?.();
        this.logger.info('Signed out');
        this.notifyStatus();
    }

    private finishLogin(pending: PendingLogin, success: boolean, message: string): void {
        if (this.pending === pending) {
            this.pending = undefined;
        }
        this.notifyStatus();
        this.hooks.loginFinished?.(success, message);
    }

    private async loadEmail(): Promise<void> {
        try {
            this.email = await this.account.getEmail();
        } catch (error: unknown) {
            this.logger.warn(`Failed to load account address: ${error}`);
        }
    }

    private notifyStatus(): void {
        this.hooks.statusChanged?.(this.status());
    }
}
