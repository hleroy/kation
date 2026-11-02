// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ProtonDriveClient } from '@protontech/drive-sdk';

/** The part of the Drive SDK client that Kation uses. Narrow so tests can fake it. */
export type DriveSdk = Pick<
    ProtonDriveClient,
    | 'getMyFilesRootFolder'
    | 'iterateFolderChildrenNodeUids'
    | 'iterateNodes'
    | 'getNode'
    | 'createFolder'
    | 'renameNode'
    | 'moveNodes'
    | 'trashNodes'
    | 'getFileDownloader'
    | 'getFileUploader'
    | 'getFileRevisionUploader'
    | 'getSharingInfo'
    | 'shareNode'
> & {
    experimental: Pick<ProtonDriveClient['experimental'], 'getNodeUrl'>;
};

/** Account operations Kation needs, implemented by the account module or a fake. */
export interface Account {
    isLoggedIn(): boolean;
    /** Primary address of the signed-in user. */
    getEmail(): Promise<string>;
    /** Browser sign-in. Calls onSignInUrl once the URL is known, resolves when signed in. */
    authViaWeb(onSignInUrl: (url: string) => void, signal: AbortSignal): Promise<void>;
    /** Revokes the session on the server (best effort) and deletes local session data. */
    logout(): Promise<void>;
    /**
     * Calls `listener` whenever the session changes, including when it ends
     * without logout() (e.g. Proton rejected it and the session refresh failed).
     */
    onSessionChanged(listener: () => void): void;
}
