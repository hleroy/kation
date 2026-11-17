// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * An object that can be swapped for a new instance while everyone keeps the
 * same reference: `current` forwards every property to the latest `create()`.
 * Only reads and `in` are forwarded: `instanceof`, `Object.keys` and assignments do not reach the instance.
 */
export function replaceable<T extends object>(create: () => T): { current: T; replace: () => void } {
    let instance = create();
    const current = new Proxy({} as T, {
        get(_target, property) {
            const value = Reflect.get(instance, property, instance);
            return typeof value === 'function' ? value.bind(instance) : value;
        },
        has: (_target, property) => property in instance,
    });
    return {
        current,
        replace: () => {
            instance = create();
        },
    };
}
