// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Signs kationd in once the keyring gives the saved session. At login, kationd
 * can start before the keyring is unlocked, and a locked keyring reads as "no
 * session" without an error.
 */

import type { Logger } from '@protontech/drive-sdk';
import dbus from 'dbus-next';

const { Message, MessageType } = dbus;

const SECRETS_NAME = 'org.freedesktop.secrets';
const SECRETS_PATH = '/org/freedesktop/secrets';

/** Calls `onChange` on each change until the returned function is called. */
export type Watch = (onChange: () => void) => Promise<() => Promise<void>>;

/** Watches the Secret Service appearing on the bus and its signals (a collection unlocked, created or changed). */
export function watchSecretService(bus: dbus.MessageBus): Watch {
    const rules = [
        `type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${SECRETS_NAME}'`,
        `type='signal',sender='${SECRETS_NAME}',path_namespace='${SECRETS_PATH}'`,
    ];
    const busCall = (member: 'AddMatch' | 'RemoveMatch', rule: string) =>
        bus.call(
            new Message({
                destination: 'org.freedesktop.DBus',
                path: '/org/freedesktop/DBus',
                interface: 'org.freedesktop.DBus',
                member,
                signature: 's',
                body: [rule],
            }),
        );

    return async (onChange) => {
        const onMessage = (msg: dbus.Message) => {
            if (msg.type !== MessageType.SIGNAL) {
                return;
            }
            const appeared = msg.member === 'NameOwnerChanged' && msg.body[0] === SECRETS_NAME && msg.body[2] !== '';
            const fromService = msg.path === SECRETS_PATH || !!msg.path?.startsWith(`${SECRETS_PATH}/`);
            if (appeared || fromService) {
                onChange();
            }
        };
        bus.on('message', onMessage);
        try {
            for (const rule of rules) {
                await busCall('AddMatch', rule);
            }
        } catch (error: unknown) {
            bus.removeListener('message', onMessage);
            throw error;
        }
        return async () => {
            bus.removeListener('message', onMessage);
            // Not awaited: when the bus is closing, the reply never comes, and the rules end with the connection anyway.
            for (const rule of rules) {
                try {
                    busCall('RemoveMatch', rule).catch(() => {});
                } catch {}
            }
        };
    };
}

export type SessionRestorerOptions = {
    /** Reads the saved session; resolves to whether kationd is now signed in. */
    restore: () => Promise<boolean>;
    watch: Watch;
    logger: Logger;
    /** Tries after start, for a keyring that becomes readable without a signal. */
    retryDelaysMs?: number[];
    /** Signals come in bursts (one per collection and property). */
    debounceMs?: number;
};

export class SessionRestorer {
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private debounce?: ReturnType<typeof setTimeout>;
    private unwatch?: () => Promise<void>;
    private running = false;
    private again = false;
    private stopped = false;

    constructor(private readonly options: SessionRestorerOptions) {}

    async start(): Promise<void> {
        for (const delay of this.options.retryDelaysMs ?? [5_000, 15_000, 60_000]) {
            const timer = setTimeout(() => {
                this.timers.delete(timer);
                this.attempt();
            }, delay);
            this.timers.add(timer);
        }
        try {
            const unwatch = await this.options.watch(() => this.onChange());
            if (this.stopped) {
                await unwatch();
            } else {
                this.unwatch = unwatch;
            }
        } catch (error: unknown) {
            this.options.logger.warn(`Cannot watch the keyring for changes: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
        clearTimeout(this.debounce);
        const unwatch = this.unwatch;
        this.unwatch = undefined;
        await unwatch?.();
    }

    private onChange(): void {
        if (this.stopped) {
            return;
        }
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.attempt(), this.options.debounceMs ?? 1_000);
    }

    private attempt(): void {
        if (this.stopped) {
            return;
        }
        if (this.running) {
            this.again = true;
            return;
        }
        this.running = true;
        void this.run().finally(() => {
            this.running = false;
        });
    }

    private async run(): Promise<void> {
        do {
            this.again = false;
            let restored = false;
            try {
                restored = await this.options.restore();
            } catch (error: unknown) {
                this.options.logger.error('Failed to read the saved session again', error);
            }
            if (restored) {
                await this.stop();
                return;
            }
        } while (this.again && !this.stopped);
    }
}
