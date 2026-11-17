// SPDX-FileCopyrightText: 2026 Kation contributors
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, test } from 'bun:test';

import { replaceable } from '../src/replaceable';

class Client {
    private root?: string;

    constructor(readonly id: number) {}

    async getRoot(account: string): Promise<string> {
        this.root ??= `${account}-root`;
        return this.root;
    }

    async *iterate(): AsyncGenerator<number> {
        yield this.id;
        yield this.id * 10;
    }
}

describe('replaceable', () => {
    test('forwards calls with the instance as `this`', async () => {
        const { current } = replaceable(() => new Client(1));
        expect(current.id).toBe(1);
        expect(await current.getRoot('a')).toBe('a-root');
        expect('getRoot' in current).toBe(true);
    });

    test('a held reference uses the new instance after replace, without its in-memory state', async () => {
        let created = 0;
        const { current, replace } = replaceable(() => new Client(++created));
        const held = current;
        expect(await held.getRoot('first')).toBe('first-root');
        expect(await held.getRoot('second')).toBe('first-root');

        replace();

        expect(held.id).toBe(2);
        expect(await held.getRoot('second')).toBe('second-root');
    });

    test('forwards async generator methods', async () => {
        const { current } = replaceable(() => new Client(3));
        const values: number[] = [];
        for await (const value of current.iterate()) {
            values.push(value);
        }
        expect(values).toEqual([3, 30]);
    });
});
