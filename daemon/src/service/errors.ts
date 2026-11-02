// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import {
    AbortError,
    ConnectionError,
    DecryptionError,
    IntegrityError,
    NodeWithSameNameExistsValidationError,
    RateLimitedError,
    ValidationError,
} from '@protontech/drive-sdk';

/** Error codes of the D-Bus interface, see dbus/com.hleroy.Kation.Drive1.xml. */
export type ErrorCode =
    | 'NotLoggedIn'
    | 'NotFound'
    | 'AlreadyExists'
    | 'NotAFolder'
    | 'IsAFolder'
    | 'InvalidArgument'
    | 'RateLimited'
    | 'Connection'
    | 'Integrity'
    | 'Cancelled'
    | 'Failed';

export const ERROR_PREFIX = 'com.hleroy.Kation.Error.';

export class KationError extends Error {
    constructor(
        readonly code: ErrorCode,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = 'KationError';
    }

    get dbusName(): string {
        return `${ERROR_PREFIX}${this.code}`;
    }
}

/** Maps SDK and runtime errors to the codes the KDE side understands. */
export function toKationError(error: unknown): KationError {
    if (error instanceof KationError) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const options = { cause: error };
    if (error instanceof NodeWithSameNameExistsValidationError) {
        return new KationError('AlreadyExists', message, options);
    }
    if (error instanceof AbortError || (error instanceof Error && error.name === 'AbortError')) {
        return new KationError('Cancelled', message || 'Cancelled', options);
    }
    if (error instanceof RateLimitedError) {
        return new KationError('RateLimited', message, options);
    }
    if (error instanceof ConnectionError) {
        return new KationError('Connection', message, options);
    }
    if (error instanceof IntegrityError || error instanceof DecryptionError) {
        return new KationError('Integrity', message, options);
    }
    if (isProtonNotFound(error)) {
        return new KationError('NotFound', message, options);
    }
    if (error instanceof ValidationError) {
        return new KationError('InvalidArgument', message, options);
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
        return new KationError('NotFound', message, options);
    }
    return new KationError('Failed', message, options);
}

/** Proton's "does not exist" API error (code 2501), a ValidationError subclass the SDK does not export. */
const PROTON_NOT_EXISTS = 2501;
function isProtonNotFound(error: unknown): boolean {
    return (
        error instanceof ValidationError && (error.name === 'NotFoundAPIError' || (error as { code?: unknown }).code === PROTON_NOT_EXISTS)
    );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}
