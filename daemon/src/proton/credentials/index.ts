import { Logger } from '@protontech/drive-sdk';

import type { Config } from '../config';
import { Credentials } from './credentials';
import { PlaintextFileSessionStore } from './fileCredentialsStore';
import type { CredentialsStore } from './interface';
import { PassSessionStore } from './passCredentialsStore';
import { SecretsSessionStore } from './secretCredentialsStore';

export type { Credentials } from './credentials';
export type { CredentialsStore } from './interface';

// Kation: optional wrapper around the store, used to report keyring problems.
export function initCredentials(
    config: Config,
    logger: Logger,
    wrapStore: (store: CredentialsStore) => CredentialsStore = (store) => store,
): Credentials {
    const credentialsStore = wrapStore(createAuthSessionStore(config, logger));
    return new Credentials(credentialsStore, logger);
}

function createAuthSessionStore(config: Config, logger: Logger): CredentialsStore {
    switch (config.credentialsStore) {
        case 'unsafe_file':
            return new PlaintextFileSessionStore(config.appDir, logger);
        case 'pass':
            return new PassSessionStore(logger);
        case 'keychain':
            return new SecretsSessionStore(logger);
        default:
            throw new Error(`Invalid credentials store: ${config.credentialsStore}`);
    }
}
