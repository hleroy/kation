// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The kationd commands (status, ls, login, logout, sync) talk to the running
 * background service over D-Bus, so only one process ever uses the Proton
 * session: Proton's refresh tokens are single-use, and two processes
 * refreshing the same session would end it.
 */
import dbus from 'dbus-next';

import { BUS_NAME, INTERFACE_NAME, interfaceXml, OBJECT_PATH } from './service/dbusServer';

export type Row = { name: string; type: string; size: number | null; modified: string };

export type ServiceClient = {
    call(method: string, ...args: unknown[]): Promise<unknown>;
    // biome-ignore lint/suspicious/noExplicitAny: each signal has its own argument types; listeners declare them.
    on(signal: string, listener: (...args: any[]) => void): void;
    close(): void;
};

/**
 * Connects to kationd on the session bus, starting it through D-Bus
 * activation when installed. Returns undefined when no service is available
 * (not installed, or no session bus).
 */
export async function connectService(): Promise<ServiceClient | undefined> {
    let bus: dbus.MessageBus;
    try {
        bus = dbus.sessionBus();
    } catch {
        return undefined;
    }
    const failed = new Promise<undefined>((resolve) => bus.on('error', () => resolve(undefined)));
    try {
        const object = await bus.getProxyObject(BUS_NAME, OBJECT_PATH, interfaceXml);
        const iface = object.getInterface(INTERFACE_NAME);
        const ready = await Promise.race([iface.GetStatus().then(() => true), failed]);
        if (!ready) {
            return undefined;
        }
        return {
            call: async (method, ...args) => {
                try {
                    return await iface[method]!(...args);
                } catch (error: unknown) {
                    throw new Error(dbusErrorMessage(error), { cause: error });
                }
            },
            on: (signal, listener) => iface.on(signal, listener),
            close: () => bus.disconnect(),
        };
    } catch (error: unknown) {
        bus.disconnect();
        const name = (error as { type?: string }).type ?? '';
        if (name === 'org.freedesktop.DBus.Error.ServiceUnknown' || name === 'org.freedesktop.DBus.Error.Spawn.ChildExited') {
            return undefined;
        }
        throw new Error(`Cannot reach the Kation service: ${dbusErrorMessage(error)}`, { cause: error });
    }
}

/** Plain values from an a{sv} returned by dbus-next. */
export function unwrap(map: unknown): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, variant] of Object.entries((map ?? {}) as Record<string, { value: unknown }>)) {
        const value = variant?.value;
        result[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    return result;
}

export function entryToRow(entry: Record<string, unknown>): Row {
    const size = Number(entry.size ?? -1);
    return {
        name: String(entry.name ?? ''),
        type: String(entry.type ?? ''),
        size: entry.type === 'folder' || size < 0 ? null : size,
        modified: new Date(Number(entry.mtime ?? 0) * 1000).toISOString(),
    };
}

function dbusErrorMessage(error: unknown): string {
    const text = (error as { text?: string }).text;
    return text ?? (error instanceof Error ? error.message : String(error));
}
